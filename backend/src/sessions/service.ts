import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { worktreeService } from '../worktrees/service.js';
import { pubSub } from '../pubsub.js';
import { notificationService } from '../notifications/service.js';
import { requestService } from '../requests/service.js';
import { sessionRepository } from './repository.js';
import { getProvider } from './providers/registry.js';
import type { RunningHandle } from './providers/provider.js';
import type { CreateSessionInput, Session, SessionFilter } from './types.js';

/** Processus en cours, indexés par id de session (mémoire du serveur). */
const running = new Map<string, RunningHandle>();
/** Traitement de fin de session (mise à jour du statut) en cours, par id de session. */
const finishing = new Map<string, Promise<void>>();

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
    const provider = getProvider(session.provider);
    const project = await projectService.get(session.projectId);

    const started = await publishSession(
      await sessionRepository.update(id, { status: 'running', activity: 'busy', startedAt: new Date(), endedAt: null, exitCode: null, error: null }),
    );

    const emit = async (type: string, payload: Record<string, unknown> = {}) => {
      const event = await sessionRepository.addEvent(id, type, payload);
      pubSub.publish('sessionEvent', id, event);
    };

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
      await requestService.cancelAllForSession(id);
      const current = await sessionRepository.findById(id);
      // Si `stop()` a déjà posé le statut "stopped", on le conserve.
      const status = current?.status === 'stopped' ? 'stopped' : result.error || result.exitCode !== 0 ? 'failed' : 'completed';
      const error = result.error ?? (status === 'failed' ? `Code de sortie ${result.exitCode}` : null);
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
    return sessionRepository.delete(id);
  },

  /** À appeler au démarrage : les sessions "running" en base ne le sont plus réellement. */
  async recoverAfterRestart(): Promise<{ sessions: number; requests: number }> {
    const sessions = await sessionRepository.markRunningAsInterrupted();
    const requests = await requestService.expireAllPending();
    return { sessions, requests };
  },

  /** Arrêt propre du serveur : tue les processus encore en cours et attend la mise à jour de leur statut. */
  async shutdown(): Promise<void> {
    await Promise.all([...running.keys()].map((id) => this.stop(id).catch(() => undefined)));
    await Promise.all([...finishing.values()]);
  },
};
