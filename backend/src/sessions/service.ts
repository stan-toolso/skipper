import type { Actor } from '../context/types.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { worktreeService } from '../worktrees/service.js';
import { pubSub } from '../pubsub.js';
import { notificationService } from '../notifications/service.js';
import { requestService } from '../requests/service.js';
import { removeSessionAttachments, storeAttachments } from './attachments.js';
import { sessionRepository } from './repository.js';
import { scheduledRuns } from './scheduledRuns.js';
import { getProvider } from './providers/registry.js';
import type { RunningHandle } from './providers/provider.js';
import type { Attachment, AttachmentInput, CreateSessionInput, Session, SessionFilter } from './types.js';

/** Texte d'une instruction sans texte : les fichiers joints sont l'instruction. */
const ATTACHMENTS_ONLY_TEXT = 'Voir les fichiers joints.';

/** Processus en cours, indexés par id de session (mémoire du serveur). */
const running = new Map<string, RunningHandle>();
/** Traitement de fin de session (mise à jour du statut) en cours, par id de session. */
const finishing = new Map<string, Promise<void>>();

/** Profondeur maximale d'imbrication des sessions lancées par des agents : une session humaine peut lancer des sessions, qui peuvent en lancer à leur tour, puis c'est fini. */
const MAX_AGENT_DEPTH = 2;
/** Nombre maximal de sessions en cours lancées par une même session d'agent (le serveur a peu de mémoire). */
const MAX_RUNNING_CHILDREN = 3;

/** Nombre d'ancêtres d'une session (0 pour une session lancée par un humain). */
async function depthOf(sessionId: string): Promise<number> {
  let depth = 0;
  let current = await sessionRepository.findById(sessionId);
  while (current?.parentSessionId && depth <= MAX_AGENT_DEPTH) {
    depth += 1;
    current = await sessionRepository.findById(current.parentSessionId);
  }
  return depth;
}

async function publishSession(session: Session | null): Promise<Session> {
  if (!session) throw new NotFoundError('Session introuvable');
  pubSub.publish('sessionUpdated', session);
  return session;
}

/**
 * Enregistre des changements de configuration d'une session (fusion clé par clé, null retire la clé), publie la
 * session et journalise un événement `config`. `applied` : clés prises en compte à chaud ; les autres vaudront au
 * prochain lancement. Les valeurs déjà en place sont ignorées ; renvoie null si la session n'existe plus.
 */
async function persistConfig(id: string, changes: Record<string, unknown>, applied: string[]): Promise<Session | null> {
  const session = await sessionRepository.findById(id);
  if (!session) return null;
  const config: Record<string, unknown> = { ...session.config };
  const effective: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === null ? session.config[key] === undefined : session.config[key] === value) continue;
    effective[key] = value;
    if (value === null) delete config[key];
    else config[key] = value;
  }
  if (!Object.keys(effective).length) return session;
  const updated = await publishSession(await sessionRepository.update(id, { config }));
  const event = await sessionRepository.addEvent(id, 'config', { changes: effective, applied });
  pubSub.publish('sessionEvent', id, event);
  return updated;
}

export const sessionService = {
  list: (filter?: SessionFilter) => sessionRepository.list(filter),
  get: (id: string) => sessionRepository.findById(id),
  events: (sessionId: string, opts?: { after?: string; limit?: number }) => sessionRepository.listEvents(sessionId, opts),
  isRunning: (id: string) => running.has(id),

  /**
   * Crée une session, éventuellement dans un worktree créé pour l'occasion (`newWorktree`).
   * `actor` agent : la session est rattachée à la session qui la lance (profondeur et nombre limités) et les membres sont notifiés.
   */
  async create(input: CreateSessionInput & { autoStart?: boolean }, actor: Actor = { type: 'human' }): Promise<Session> {
    const provider = getProvider(input.provider);
    provider.validateConfig?.(input.config ?? {});
    const project = await projectService.get(input.projectId); // lève NotFoundError si le projet n'existe pas
    if (input.worktreeId && input.newWorktree) throw new AppError('Choisissez un worktree existant ou un nouveau worktree, pas les deux');
    if (input.worktreeId) await worktreeService.resolveCwd(project, input.worktreeId); // vérifie l'appartenance et l'existence

    let parentSessionId: string | null = null;
    if (actor.type === 'agent' && actor.sessionId) {
      const parent = await sessionRepository.findById(actor.sessionId);
      if (!parent) throw new NotFoundError('Session parente introuvable');
      if (parent.projectId !== project.id) throw new AppError('Un agent ne peut lancer des sessions que dans son propre projet');
      if ((await depthOf(parent.id)) >= MAX_AGENT_DEPTH) throw new AppError(`Imbrication maximale atteinte : une session lancée par un agent lancé par un agent ne peut pas en lancer d'autres`);
      const children = await sessionRepository.list({ parentSessionId: parent.id, status: 'running', limit: MAX_RUNNING_CHILDREN + 1 });
      if (children.length >= MAX_RUNNING_CHILDREN) {
        throw new AppError(`Au plus ${MAX_RUNNING_CHILDREN} sessions lancées par cette session peuvent tourner en même temps : termine-en une (sessions.end) avant d'en lancer une autre`);
      }
      parentSessionId = parent.id;
    }

    let worktreeId = input.worktreeId ?? null;
    let createdWorktreeId: string | null = null;
    if (input.newWorktree) {
      const worktree = await worktreeService.create(project.id, input.newWorktree);
      worktreeId = createdWorktreeId = worktree.id;
    }
    let session: Session;
    try {
      const prompt = input.prompt?.trim() || (input.attachments?.length ? ATTACHMENTS_ONLY_TEXT : input.prompt);
      session = await sessionRepository.create({ ...input, prompt, worktreeId, parentSessionId });
    } catch (err) {
      if (createdWorktreeId) await worktreeService.delete(createdWorktreeId, true).catch(() => undefined);
      throw err;
    }
    if (input.attachments?.length) {
      // Les fichiers joints à la première instruction sont enregistrés sous l'identifiant de la session : ils
      // restent disponibles jusqu'au démarrage (session créée sans démarrage automatique) et pour le transcript.
      try {
        const attachments = await storeAttachments(project, session.id, input.attachments);
        session = (await sessionRepository.update(session.id, { promptAttachments: attachments })) ?? session;
      } catch (err) {
        await removeSessionAttachments(project, session.id).catch(() => undefined);
        await sessionRepository.delete(session.id).catch(() => undefined);
        if (createdWorktreeId) await worktreeService.delete(createdWorktreeId, true).catch(() => undefined);
        throw err;
      }
    }
    pubSub.publish('sessionUpdated', session);
    if (parentSessionId) {
      void notificationService.notify({
        type: 'session.created',
        title: 'Session lancée par un agent',
        message: `${session.name} · ${project.name}`,
        link: `/sessions/${session.id}`,
        projectId: project.id,
        sessionId: parentSessionId,
        payload: { childSessionId: session.id },
      });
    }
    // Sans consigne ni fichier joint, la session attend sa première instruction (envoyée depuis sa page) pour démarrer.
    return input.autoStart === false || !session.prompt ? session : this.start(session.id);
  },

  /**
   * Attend que la session ait fini son tour (agent en attente d'instructions) ou ne tourne plus,
   * au plus `timeoutMs`. Renvoie l'état courant de la session dans tous les cas.
   */
  async waitForIdle(id: string, timeoutMs: number): Promise<Session> {
    const settled = (s: Session) => s.status !== 'running' || s.activity === 'idle';
    const current = await sessionRepository.findById(id);
    if (!current) throw new NotFoundError('Session introuvable');
    if (settled(current)) return current;
    const updates = pubSub.subscribe('sessionUpdated');
    let timerHandle: NodeJS.Timeout | undefined;
    const timer = new Promise<null>((resolve) => {
      timerHandle = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      // Relit l'état après l'abonnement : la mise à jour a pu survenir entre les deux.
      const fresh = await sessionRepository.findById(id);
      if (fresh && settled(fresh)) return fresh;
      while (true) {
        const next = await Promise.race([updates.next(), timer]);
        if (next === null || next.done) break;
        if (next.value.id === id && settled(next.value)) return next.value;
      }
    } finally {
      clearTimeout(timerHandle);
      await updates.return?.(undefined);
    }
    return (await sessionRepository.findById(id)) ?? current;
  },

  /**
   * Démarre (ou relance) la session. `initialMessage` (et ses `attachments`) remplace le prompt de la session
   * comme première instruction, typiquement pour reprendre une session terminée avec une nouvelle consigne.
   */
  async start(id: string, initialMessage?: string, attachments: Attachment[] = []): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.status === 'running') throw new AppError('La session est déjà en cours');
    if (!(initialMessage ?? session.prompt)) throw new AppError('Envoyez une première instruction pour démarrer la session');
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
        initialAttachments: initialMessage === undefined ? session.promptAttachments : attachments,
        emit,
        setExternalId: async (externalId) => {
          await publishSession(await sessionRepository.update(id, { externalId }));
        },
        setActivity: async (activity) => {
          await publishSession(await sessionRepository.update(id, { activity }));
        },
        recordConfig: async (changes) => {
          await persistConfig(id, changes, Object.keys(changes));
        },
        ask: async (input, signal) => {
          await emit('request', { type: input.type, title: input.title, payload: input.payload ?? {} });
          // La notification porte l'identifiant de la demande : elle sera marquée lue quand la demande sera réglée.
          const response = await requestService.ask(id, input, signal, (request) => {
            void notificationService.notify({
              type: 'request.created',
              title: input.type === 'question' ? `Question de l'agent « ${session.name} »` : `« ${session.name} » attend votre autorisation`,
              message: input.title,
              link: `/sessions/${id}`,
              projectId: session.projectId,
              sessionId: id,
              payload: { requestType: input.type, requestId: request.id },
            });
          });
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
      // Une exécution planifiée a sa propre notification de fin (avec le coût), émise par l'ordonnanceur.
      if ((status === 'completed' || status === 'failed') && !scheduledRuns.has(id)) {
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
  async sendMessage(id: string, text: string, files?: AttachmentInput[] | null): Promise<Session> {
    const trimmed = text.trim() || (files?.length ? ATTACHMENTS_ONLY_TEXT : '');
    if (!trimmed) throw new AppError('Le message est vide');
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    const handle = running.get(id);
    if (handle && !handle.sendMessage) throw new AppError("Ce type de session n'accepte pas d'instructions en cours d'exécution");
    const attachments = files?.length ? await storeAttachments(await projectService.get(session.projectId), id, files) : [];
    if (!handle) return this.start(id, trimmed, attachments);
    await handle.sendMessage!(trimmed, attachments);
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

  /**
   * Modifie la configuration de la session (fusion clé par clé ; une valeur null ou une chaîne vide retire la clé).
   * La configuration est validée dans son ensemble par le provider, appliquée à chaud si la session est en cours
   * (ce que le provider sait changer : modèle, autorisations...), puis enregistrée pour les prochains lancements.
   */
  async updateConfig(id: string, patch: Record<string, unknown>): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    const changes: Record<string, unknown> = {};
    const config: Record<string, unknown> = { ...session.config };
    for (const [key, value] of Object.entries(patch)) {
      const cleared = value === null || value === undefined || value === '';
      if (cleared ? session.config[key] === undefined : session.config[key] === value) continue;
      changes[key] = cleared ? null : value;
      if (cleared) delete config[key];
      else config[key] = value;
    }
    if (!Object.keys(changes).length) return session;
    getProvider(session.provider).validateConfig?.(config);
    const handle = running.get(id);
    // Appliquer d'abord à la session en cours : si le provider refuse, rien n'est enregistré.
    const applied = handle?.updateConfig ? await handle.updateConfig(changes) : [];
    return (await persistConfig(id, changes, applied)) ?? session;
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
    const session = await sessionRepository.findById(id);
    if (session) {
      const project = await projectService.get(session.projectId).catch(() => null);
      if (project) await removeSessionAttachments(project, id).catch((err) => console.warn('[sessions] pièces jointes non supprimées', err));
    }
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
