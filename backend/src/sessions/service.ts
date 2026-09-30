import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { worktreeService } from '../worktrees/service.js';
import { pubSub } from '../pubsub.js';
import { notificationService } from '../notifications/service.js';
import { requestService } from '../requests/service.js';
import { sessionRepository } from './repository.js';
import { getProvider } from './providers/registry.js';
import type { RunningHandle } from './providers/provider.js';
import { serverSettings } from '../settings/server.js';
import type { CreateSessionInput, Session, SessionFilter, SessionStatus } from './types.js';

/** Processus en cours, indexés par id de session (mémoire du serveur). */
const running = new Map<string, RunningHandle>();
/** Traitement de fin de session (mise à jour du statut) en cours, par id de session. */
const finishing = new Map<string, Promise<void>>();
/**
 * Arrêt du serveur en cours. Posé de façon synchrone dès la réception du signal : pm2 signale tout
 * l'arbre de processus, donc les agents peuvent mourir avant que leur `stop()` ne soit appelé ; leur
 * fin doit alors donner une session « interrompue », pas « en erreur ».
 */
let stopping = false;

/** Délai laissé aux sessions pour se clôturer à l'arrêt (pm2 tue le processus après 1,6 s par défaut). */
const SHUTDOWN_TIMEOUT_MS = 1200;
/** Reprise automatique : sessions interrompues depuis moins d'une heure, trois au plus (mémoire du serveur). */
const AUTO_RESUME_WINDOW_MS = 60 * 60 * 1000;
const AUTO_RESUME_MAX = 3;
const AUTO_RESUME_MESSAGE =
  "Le serveur Skipper a redémarré pendant ton tour et l'a interrompu. Reprends là où tu en étais : vérifie l'état des fichiers et des commandes en cours avant de continuer.";

async function emitEvent(sessionId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const event = await sessionRepository.addEvent(sessionId, type, payload);
  pubSub.publish('sessionEvent', sessionId, event);
}

/**
 * Clôture d'une session par l'arrêt du serveur : statut « interrupted » (sans erreur ni code de
 * sortie, activité conservée), événement explicite dans le transcript, demandes en attente expirées.
 * Sans effet si la session n'était plus « running ». Aucune notification : ce n'est pas un échec.
 */
async function interruptForShutdown(id: string): Promise<void> {
  const session = await sessionRepository.markInterrupted(id);
  if (!session) return;
  await emitEvent(id, 'system', {
    message: session.activity === 'busy' ? 'Session interrompue par un redémarrage du serveur, pendant que l\'agent travaillait' : 'Session interrompue par un redémarrage du serveur',
    notice: true,
    reason: 'server_shutdown',
    activity: session.activity,
  });
  await emitEvent(id, 'status', { status: 'interrupted', activity: session.activity });
  pubSub.publish('sessionUpdated', session);
  await requestService.cancelAllForSession(id, 'expired');
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function publishSession(session: Session | null): Promise<Session> {
  if (!session) throw new NotFoundError('Session introuvable');
  pubSub.publish('sessionUpdated', session);
  return session;
}

export const sessionService = {
  list: (filter?: SessionFilter) => sessionRepository.list(filter),
  get: (id: string) => sessionRepository.findById(id),
  events: (sessionId: string, opts?: { after?: string; limit?: number }) => sessionRepository.listEvents(sessionId, opts),
  isRunning: (id: string) => running.has(id),

  async create(input: CreateSessionInput & { autoStart?: boolean }): Promise<Session> {
    serverSettings.assertNotInMaintenance();
    const provider = getProvider(input.provider);
    provider.validateConfig?.(input.config ?? {});
    const project = await projectService.get(input.projectId); // lève NotFoundError si le projet n'existe pas
    if (input.worktreeId) await worktreeService.resolveCwd(project, input.worktreeId); // vérifie l'appartenance et l'existence
    const session = await sessionRepository.create(input);
    pubSub.publish('sessionUpdated', session);
    return input.autoStart === false ? session : this.start(session.id);
  },

  /**
   * Démarre (ou relance) la session. `initialMessage` remplace le prompt de la session
   * comme première instruction, typiquement pour reprendre une session terminée avec une nouvelle consigne.
   */
  async start(id: string, initialMessage?: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.status === 'running') throw new AppError('La session est déjà en cours');
    if (stopping) throw new AppError('Le serveur redémarre : réessayez dans quelques secondes', 'MAINTENANCE');
    serverSettings.assertNotInMaintenance();
    const provider = getProvider(session.provider);
    const project = await projectService.get(session.projectId);

    const started = await publishSession(
      await sessionRepository.update(id, { status: 'running', activity: 'busy', startedAt: new Date(), endedAt: null, exitCode: null, error: null }),
    );

    const emit = (type: string, payload: Record<string, unknown> = {}) => emitEvent(id, type, payload);

    let handle: RunningHandle;
    try {
      // La session s'exécute dans le worktree choisi, sinon dans le checkout principal du projet.
      const cwd = await worktreeService.resolveCwd(project, session.worktreeId);
      handle = await provider.start({
        session: started,
        project,
        cwd,
        initialMessage: initialMessage ?? session.prompt,
        emit,
        setExternalId: async (externalId) => {
          await publishSession(await sessionRepository.update(id, { externalId }));
        },
        setActivity: async (activity) => {
          await publishSession(await sessionRepository.update(id, { activity }));
        },
        ask: async (input, signal) => {
          await emit('request', { type: input.type, title: input.title, payload: input.payload ?? {} });
          void notificationService.notify({
            type: 'request.created',
            title: input.type === 'question' ? `Question de l'agent « ${session.name} »` : `« ${session.name} » attend votre autorisation`,
            message: input.title,
            link: `/sessions/${id}`,
            projectId: session.projectId,
            sessionId: id,
            payload: { requestType: input.type },
          });
          const response = await requestService.ask(id, input, signal);
          await emit('request.answered', { type: input.type, title: input.title, response });
          return response;
        },
        isServerStopping: () => stopping,
      });
    } catch (err) {
      const message = (err as Error).message;
      await emit('status', { status: 'failed', error: message });
      return publishSession(await sessionRepository.update(id, { status: 'failed', activity: null, error: message, endedAt: new Date() }));
    }

    running.set(id, handle);
    // Fin du processus gérée en tâche de fond : la mutation `start` rend la main immédiatement.
    const finished = handle.wait().then(async (result) => {
      running.delete(id);
      const current = await sessionRepository.findById(id);
      // Arrêt du serveur : la session est « interrompue », quelle que soit la façon dont son flux s'est
      // terminé (fermé par `stop()`, ou agent tué par le signal de pm2 avant). Statut peut-être déjà posé par `shutdown()`.
      if (stopping || current?.status === 'interrupted') {
        await interruptForShutdown(id);
        return;
      }
      await requestService.cancelAllForSession(id);
      // Si `stop()` a déjà posé le statut "stopped", on le conserve.
      const status: SessionStatus =
        current?.status === 'stopped' || result.closedByServer ? 'stopped' : result.error || result.exitCode !== 0 ? 'failed' : 'completed';
      const error = status === 'failed' ? result.error ?? `Code de sortie ${result.exitCode}` : null;
      await emit('status', { status, exitCode: result.exitCode, error });
      await publishSession(await sessionRepository.update(id, { status, activity: null, exitCode: result.exitCode, error, endedAt: new Date() }));
      if (status === 'completed' || status === 'failed') {
        void notificationService.notify({
          type: `session.${status}`,
          title: status === 'completed' ? `Session « ${session.name} » terminée` : `Session « ${session.name} » en erreur`,
          message: status === 'failed' ? error : `Projet ${project.name}`,
          link: `/sessions/${id}`,
          projectId: session.projectId,
          sessionId: id,
        });
      }
    });
    finishing.set(id, finished.catch((err) => console.error('[sessions] fin de session', err)).finally(() => finishing.delete(id)));

    return started;
  },

  /**
   * Envoie une instruction à la session. Si elle est en cours, l'instruction est transmise à
   * l'agent ; si elle est terminée, la session est relancée avec cette instruction (reprise).
   */
  async sendMessage(id: string, text: string): Promise<Session> {
    const trimmed = text.trim();
    if (!trimmed) throw new AppError('Le message est vide');
    const handle = running.get(id);
    if (!handle) return this.start(id, trimmed);
    if (!handle.sendMessage) throw new AppError("Ce type de session n'accepte pas d'instructions en cours d'exécution");
    await handle.sendMessage(trimmed);
    return publishSession(await sessionRepository.findById(id));
  },

  /** Fin propre : l'agent termine son tour en cours, puis la session se termine. */
  async end(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle) throw new AppError("La session n'est pas en cours d'exécution");
    if (!handle.end) return this.stop(id);
    await handle.end();
    return publishSession(await sessionRepository.findById(id));
  },

  /** Interrompt le tour en cours (l'agent s'arrête et attend une nouvelle instruction). */
  async interrupt(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle) throw new AppError("La session n'est pas en cours d'exécution");
    if (!handle.interrupt) throw new AppError("Ce type de session ne peut pas être interrompu sans être arrêté");
    await requestService.cancelAllForSession(id);
    await handle.interrupt();
    return publishSession(await sessionRepository.findById(id));
  },

  async stop(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle) throw new AppError("La session n'est pas en cours d'exécution");
    await publishSession(await sessionRepository.update(id, { status: 'stopped', activity: null, endedAt: new Date() }));
    await requestService.cancelAllForSession(id);
    await handle.stop();
    return publishSession(await sessionRepository.findById(id));
  },

  async delete(id: string): Promise<boolean> {
    if (running.has(id)) await this.stop(id);
    // La mise à jour finale du statut (tâche de fond) doit être terminée avant de supprimer la ligne.
    await finishing.get(id);
    return sessionRepository.delete(id);
  },

  /**
   * À appeler au démarrage : les sessions "running" en base ne le sont plus réellement. Normalement
   * `shutdown()` les a déjà clôturées ; il en reste après un arrêt brutal (SIGKILL, plantage, délai dépassé).
   */
  async recoverAfterRestart(): Promise<{ sessions: number; requests: number }> {
    const sessions = await sessionRepository.markRunningAsInterrupted();
    for (const session of sessions) {
      await sessionRepository.addEvent(session.id, 'system', {
        message: "Session interrompue : le serveur s'est arrêté sans pouvoir la clôturer (arrêt brutal)",
        notice: true,
        reason: 'server_crash',
        activity: session.activity,
      });
      await sessionRepository.addEvent(session.id, 'status', { status: 'interrupted', activity: session.activity });
    }
    const requests = await requestService.expireAllPending();
    return { sessions: sessions.length, requests };
  },

  /**
   * Reprise automatique (réglage du serveur, désactivé par défaut) : relance les sessions interrompues
   * au milieu d'un tour par l'arrêt récent du serveur, avec une instruction qui explique la coupure.
   * Les sessions qui attendaient des instructions restent interrompues : un message suffit à les reprendre.
   */
  async resumeInterruptedAfterRestart(): Promise<string[]> {
    if (!serverSettings.current.autoResumeInterrupted) return [];
    const sessions = await sessionRepository.listInterruptedMidTurn(new Date(Date.now() - AUTO_RESUME_WINDOW_MS), AUTO_RESUME_MAX);
    const resumed: string[] = [];
    for (const session of sessions) {
      try {
        await emitEvent(session.id, 'system', { message: 'Reprise automatique après le redémarrage du serveur', notice: true, reason: 'auto_resume' });
        await this.start(session.id, AUTO_RESUME_MESSAGE);
        resumed.push(session.id);
      } catch (err) {
        console.error(`[sessions] reprise automatique de ${session.id} impossible`, err);
        await emitEvent(session.id, 'system', { message: `Reprise automatique impossible : ${(err as Error).message}`, notice: true, reason: 'auto_resume' }).catch(() => undefined);
      }
    }
    return resumed;
  },

  /** Sessions actives sur ce serveur (à consulter avant un redémarrage). */
  async activeSummary(): Promise<{ active: number; busy: number; idle: number }> {
    const ids = [...running.keys()];
    return { active: ids.length, ...(await sessionRepository.countByActivity(ids)) };
  },

  /**
   * Début de l'arrêt du serveur, à appeler de façon synchrone dès la réception du signal : à partir
   * de là, toute fin de session est une interruption et aucune session ne démarre plus.
   */
  beginShutdown(): void {
    stopping = true;
  },

  /**
   * Arrêt propre du serveur : les sessions en cours passent à « interrupted » (avant tout, pour que
   * l'état en base soit juste même si pm2 tue le processus), puis leurs flux sont fermés. Borné dans le temps.
   */
  async shutdown(): Promise<number> {
    stopping = true;
    const ids = [...running.keys()];
    const work = (async () => {
      await Promise.all(ids.map((id) => interruptForShutdown(id).catch((err) => console.error(`[sessions] interruption de ${id}`, err))));
      await Promise.all(ids.map((id) => running.get(id)?.stop().catch(() => undefined)));
      await Promise.all([...finishing.values()]);
    })();
    await Promise.race([work, delay(SHUTDOWN_TIMEOUT_MS)]);
    return ids.length;
  },
};
