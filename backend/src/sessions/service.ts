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
import { serverSettings } from '../settings/server.js';
import { headCommitOf } from '../git/service.js';
import { containerMonitor } from '../runners/monitor.js';
import type { Project } from '../projects/types.js';
import type { Attachment, AttachmentInput, CreateSessionInput, Session, SessionFilter, SessionStatus } from './types.js';

/** Texte d'une instruction sans texte : les fichiers joints sont l'instruction. */
const ATTACHMENTS_ONLY_TEXT = 'Voir les fichiers joints.';

/** Processus en cours, indexés par id de session (mémoire du serveur). */
const running = new Map<string, RunningHandle>();
/**
 * Places occupées : sessions en cours ou en train de démarrer, avec leur projet. Tenu de façon synchrone
 * (réservé avant le premier await du démarrage) pour que deux démarrages simultanés ne dépassent pas la limite.
 */
const slots = new Map<string, string>();
/** Depuis quand chaque session en cours attend des instructions (ms), pour l'arrêt des sessions inactives. */
const idleSince = new Map<string, number>();
/** Sessions terminées par le serveur pour inactivité : leur fin n'est pas notifiée. */
const endedForIdle = new Set<string>();
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
  "Le serveur Skipper a redémarré pendant ton tour et l'a interrompu. Reprends là où tu en étais : vérifie l'état des fichiers et des commandes en cours avant de continuer. Les demandes d'autorisation ou questions en attente ont été annulées : refais l'action ou repose la question si elle est encore utile.";

/** Reprise manuelle d'une session qui attendait des instructions : rouvrir la conversation sans lui donner de travail. */
const IDLE_RESUME_MESSAGE =
  "Le serveur Skipper a redémarré pendant que tu attendais une instruction ; la conversation reprend. Ne fais rien d'autre que répondre « Prêt » et attends la suite.";

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

/** Limite propre au projet (runner_config.maxSessions), 0 : aucune. */
function projectLimit(project: Pick<Project, 'runnerConfig'>): number {
  const n = Number((project.runnerConfig as { maxSessions?: unknown } | null)?.maxSessions ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const slotsOfProject = (projectId: string) => [...slots.values()].filter((p) => p === projectId).length;

/** Raison pour laquelle une session du projet ne peut pas démarrer maintenant (limite atteinte), null s'il reste une place. */
function slotBlocker(project: Pick<Project, 'id' | 'runnerConfig'>): string | null {
  const max = serverSettings.current.maxConcurrentSessions;
  if (max > 0 && slots.size >= max) return `${slots.size} session${slots.size > 1 ? 's' : ''} en cours sur le serveur (limite : ${max})`;
  const projectMax = projectLimit(project);
  const inProject = slotsOfProject(project.id);
  if (projectMax > 0 && inProject >= projectMax) return `${inProject} session${inProject > 1 ? 's' : ''} en cours dans ce projet (limite : ${projectMax})`;
  return null;
}

/** Durée lisible (minutes ou heures). */
function formatWait(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "moins d'une minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** Vidage de la file d'attente en cours (un seul à la fois) ; `drainAgain` : une place s'est libérée entre-temps. */
let draining: Promise<void> | null = null;
let drainAgain = false;
/** Minuterie de la file d'attente et de l'arrêt des sessions inactives. */
let housekeeping: NodeJS.Timeout | null = null;
/** Intervalle de la minuterie : filet de sécurité (la file est aussi vidée à chaque fin de session). */
const HOUSEKEEPING_INTERVAL_MS = 60_000;

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

/** Instruction refusée à une session en file d'attente. */
const queuedError = () =>
  new AppError(
    "La session est en file d'attente (limite de sessions simultanées atteinte) : elle démarrera dès qu'une place se libère. Arrêtez-la pour la retirer de la file.",
    'SESSIONS_LIMIT',
  );

/**
 * Met la session en file d'attente avec son instruction de démarrage (consigne de la session si
 * `initialMessage` est absent). Une session déjà en file garde son rang.
 */
async function enqueue(session: Session, blocker: string, initialMessage: string | undefined, attachments: Attachment[]): Promise<Session> {
  const queued = await publishSession(
    await sessionRepository.update(session.id, {
      status: 'queued',
      activity: null,
      exitCode: null,
      error: null,
      queuedAt: session.queuedAt ?? new Date(),
      queuedStart: { message: initialMessage ?? null, attachments: initialMessage === undefined ? [] : attachments },
    }),
  );
  const position = await sessionRepository.queuePosition(session.id);
  await emitEvent(session.id, 'system', {
    message: `Session en file d'attente : ${blocker}. Elle démarrera dès qu'une place se libère${position ? ` (rang ${position})` : ''}.`,
    notice: true,
    reason: 'queued',
  });
  return queued;
}

/** Retire une session de la file d'attente (arrêt demandé avant son démarrage). */
async function dequeue(id: string): Promise<Session> {
  const session = await publishSession(await sessionRepository.update(id, { status: 'stopped', activity: null, queuedAt: null, queuedStart: null, endedAt: new Date() }));
  await emitEvent(id, 'system', { message: "Session retirée de la file d'attente", notice: true, reason: 'queue_cancel' });
  await emitEvent(id, 'status', { status: 'stopped' });
  return session;
}

/** Un passage sur la file d'attente : démarre les sessions qui ont une place, dans l'ordre d'arrivée. */
async function drainOnce(): Promise<void> {
  if (stopping || serverSettings.maintenance) return;
  const max = serverSettings.current.maxConcurrentSessions;
  if (max > 0 && slots.size >= max) return;
  for (const session of await sessionRepository.listQueued()) {
    if (stopping || serverSettings.maintenance) return;
    if (max > 0 && slots.size >= max) return;
    const project = await projectService.get(session.projectId).catch(() => null);
    if (!project || slotBlocker(project)) continue;
    try {
      await sessionService.start(session.id, session.queuedStart?.message ?? undefined, session.queuedStart?.attachments ?? [], { fromQueue: true });
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[sessions] démarrage de ${session.id} depuis la file d'attente`, err);
      await emitEvent(session.id, 'status', { status: 'failed', error: message }).catch(() => undefined);
      await sessionRepository
        .update(session.id, { status: 'failed', activity: null, error: message, endedAt: new Date(), queuedAt: null, queuedStart: null })
        .then((s) => s && pubSub.publish('sessionUpdated', s))
        .catch(() => undefined);
    }
  }
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
    serverSettings.assertNotInMaintenance();
    const provider = getProvider(input.provider);
    const project = await projectService.get(input.projectId); // lève NotFoundError si le projet n'existe pas
    // Sans mode d'autorisation précisé (sessions de tâches, sessions sans formulaire), celui du projet s'applique.
    if (!input.config?.permissionMode && provider.describe().configFields.some((f) => f.key === 'permissionMode')) {
      input = { ...input, config: { ...input.config, permissionMode: project.defaultPermissionMode } };
    }
    provider.validateConfig?.(input.config ?? {});
    if (input.worktreeId && input.newWorktree) throw new AppError('Choisissez un worktree existant ou un nouveau worktree, pas les deux');
    if (input.worktreeId) await worktreeService.resolveCwd(project, input.worktreeId); // vérifie l'appartenance et l'existence

    let parentSessionId: string | null = null;
    if (actor.type === 'agent' && actor.sessionId) {
      const parent = await sessionRepository.findById(actor.sessionId);
      if (!parent) throw new NotFoundError('Session parente introuvable');
      if (parent.projectId !== project.id) throw new AppError('Un agent ne peut lancer des sessions que dans son propre projet');
      if ((await depthOf(parent.id)) >= MAX_AGENT_DEPTH) throw new AppError(`Imbrication maximale atteinte : une session lancée par un agent lancé par un agent ne peut pas en lancer d'autres`);
      const children = [
        ...(await sessionRepository.list({ parentSessionId: parent.id, status: 'running', limit: MAX_RUNNING_CHILDREN + 1 })),
        ...(await sessionRepository.list({ parentSessionId: parent.id, status: 'queued', limit: MAX_RUNNING_CHILDREN + 1 })),
      ];
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
    // Une session en file d'attente n'a pas encore commencé son tour.
    const settled = (s: Session) => (s.status !== 'running' && s.status !== 'queued') || s.activity === 'idle';
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
   * Si la limite de sessions simultanées (serveur ou projet) est atteinte, la session passe en file d'attente
   * (statut « queued ») avec cette instruction et démarre dès qu'une place se libère. `fromQueue` : démarrage
   * par la file d'attente elle-même (sans place, la session y reste à son rang).
   */
  async start(id: string, initialMessage?: string, attachments: Attachment[] = [], opts: { fromQueue?: boolean } = {}): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.status === 'running') throw new AppError('La session est déjà en cours');
    if (session.status === 'queued' && !opts.fromQueue) throw queuedError();
    if (opts.fromQueue && session.status !== 'queued') return session;
    if (stopping) throw new AppError('Le serveur redémarre : réessayez dans quelques secondes', 'MAINTENANCE');
    serverSettings.assertNotInMaintenance();
    if (!(initialMessage ?? session.prompt)) throw new AppError('Envoyez une première instruction pour démarrer la session');
    const provider = getProvider(session.provider);
    const project = await projectService.get(session.projectId);

    // Pas d'await entre la vérification et la réservation de la place (une place déjà prise : démarrage concurrent).
    if (slots.has(id)) throw new AppError('La session est déjà en cours');
    const blocker = slotBlocker(project);
    if (blocker) return opts.fromQueue ? session : enqueue(session, blocker, initialMessage, attachments);
    slots.set(id, project.id);
    idleSince.delete(id);

    const emit = (type: string, payload: Record<string, unknown> = {}) => emitEvent(id, type, payload);

    let started: Session;
    try {
      if (session.status === 'queued') {
        await emit('system', { message: `Place libérée : la session démarre après ${formatWait(Date.now() - (session.queuedAt?.getTime() ?? Date.now()))} d'attente`, notice: true, reason: 'queue_start' });
      }
      started = await publishSession(
        await sessionRepository.update(id, { status: 'running', activity: 'busy', startedAt: new Date(), endedAt: null, exitCode: null, error: null, queuedAt: null, queuedStart: null }),
      );
    } catch (err) {
      slots.delete(id);
      this.drainQueue();
      throw err;
    }

    let handle: RunningHandle;
    try {
      // La session s'exécute dans le worktree choisi, sinon dans le checkout principal du projet.
      const cwd = await worktreeService.resolveCwd(project, session.worktreeId);
      // Premier démarrage : le commit courant sert de référence à l'onglet « Modifications » (commits de l'agent compris).
      if (!session.baseCommit) {
        const baseCommit = await headCommitOf(cwd);
        if (baseCommit) await sessionRepository.update(id, { baseCommit });
      }
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
        setContextTokens: async (contextTokens) => {
          await publishSession(await sessionRepository.update(id, { contextTokens }));
        },
        setActivity: async (activity) => {
          if (activity === 'idle') idleSince.set(id, Date.now());
          else idleSince.delete(id);
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
        isServerStopping: () => stopping,
      });
    } catch (err) {
      slots.delete(id);
      this.drainQueue();
      const message = (err as Error).message;
      await emit('status', { status: 'failed', error: message });
      return publishSession(await sessionRepository.update(id, { status: 'failed', activity: null, error: message, endedAt: new Date() }));
    }

    running.set(id, handle);
    // Fin du processus gérée en tâche de fond : la mutation `start` rend la main immédiatement.
    const finished = handle.wait().then(async (result) => {
      running.delete(id);
      slots.delete(id);
      idleSince.delete(id);
      const idleEnd = endedForIdle.delete(id);
      // La place libérée revient à la première session de la file d'attente.
      this.drainQueue();
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
      let error = status === 'failed' ? result.error ?? `Code de sortie ${result.exitCode}` : null;
      // Processus tué faute de mémoire dans le conteneur : message explicite plutôt que « exited with code 137 ».
      if (status === 'failed') {
        const oom = await containerMonitor.explainFailure(project, result).catch(() => null);
        if (oom) error = `${oom} (détail : ${error})`;
      }
      await emit('status', { status, exitCode: result.exitCode, error });
      await publishSession(await sessionRepository.update(id, { status, activity: null, exitCode: result.exitCode, error, endedAt: new Date() }));
      // Une exécution planifiée a sa propre notification de fin (avec le coût), émise par l'ordonnanceur.
      // Une session terminée pour inactivité n'est pas notifiée : un événement l'explique dans le transcript.
      if ((status === 'completed' || status === 'failed') && !scheduledRuns.has(id) && !idleEnd) {
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
    if (session.status === 'queued') throw queuedError();
    const handle = running.get(id);
    if (handle && !handle.sendMessage) throw new AppError("Ce type de session n'accepte pas d'instructions en cours d'exécution");
    const attachments = files?.length ? await storeAttachments(await projectService.get(session.projectId), id, files) : [];
    if (!handle) return this.start(id, trimmed, attachments);
    await handle.sendMessage!(trimmed, attachments);
    return publishSession(await sessionRepository.findById(id));
  },

  /** Renomme la session. */
  async rename(id: string, name: string): Promise<Session> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('Le nom est vide');
    if (trimmed.length > 120) throw new AppError('Le nom dépasse 120 caractères');
    return publishSession(await sessionRepository.update(id, { name: trimmed }));
  },

  /** Fin propre : l'agent termine son tour en cours, puis la session se termine. */
  async end(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle && (await sessionRepository.findById(id))?.status === 'queued') return dequeue(id);
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
    if (!handle && (await sessionRepository.findById(id))?.status === 'queued') return dequeue(id);
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
   * Reprise manuelle d'une session interrompue par un redémarrage (bouton « Reprendre ») : si l'agent
   * travaillait, il reprend son tour avec l'instruction de reprise ; sinon la conversation est rouverte
   * et l'agent attend la suite. Les demandes expirées ne sont pas rejouées.
   */
  async resume(id: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.status !== 'interrupted') throw new AppError("Seule une session interrompue par un redémarrage peut être reprise ainsi : envoyez-lui un message");
    const midTurn = session.activity === 'busy';
    await emitEvent(id, 'system', { message: 'Reprise après le redémarrage du serveur', notice: true, reason: 'manual_resume', activity: session.activity });
    return this.start(id, midTurn ? AUTO_RESUME_MESSAGE : IDLE_RESUME_MESSAGE);
  },

  /**
   * Reprise automatique (réglage du serveur, activé par défaut) : relance les sessions interrompues
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

  /** Places occupées (sessions en cours ou en train de démarrer), au total et par projet. */
  slotUsage(): { total: number; byProject: Map<string, number> } {
    const byProject = new Map<string, number>();
    for (const projectId of slots.values()) byProject.set(projectId, (byProject.get(projectId) ?? 0) + 1);
    return { total: slots.size, byProject };
  },

  /** Rang d'une session dans la file d'attente (1 : la prochaine), null si elle n'y est pas. */
  queuePosition: (id: string) => sessionRepository.queuePosition(id),

  /**
   * Démarre les sessions en file d'attente tant qu'il reste des places, dans l'ordre d'arrivée (une session
   * bloquée par la limite de son projet laisse passer les suivantes). Sans effet pendant la maintenance ou
   * l'arrêt. Renvoie la promesse du vidage en cours (un seul à la fois).
   */
  drainQueue(): Promise<void> {
    if (draining) {
      drainAgain = true;
      return draining;
    }
    draining = (async () => {
      do {
        drainAgain = false;
        await drainOnce();
      } while (drainAgain);
    })()
      .catch((err) => console.error("[sessions] file d'attente", err))
      .finally(() => {
        draining = null;
      });
    return draining;
  },

  /**
   * Termine proprement les sessions qui attendent des instructions depuis plus que le délai d'inactivité
   * (réglage du serveur) : leur place et leur mémoire reviennent aux autres. Un message les relance.
   */
  async endIdleSessions(now = Date.now()): Promise<string[]> {
    const minutes = serverSettings.current.idleSessionTimeoutMinutes;
    if (!minutes || stopping) return [];
    const ended: string[] = [];
    for (const [id, since] of idleSince) {
      if (now - since < minutes * 60_000 || !running.has(id) || endedForIdle.has(id)) continue;
      try {
        endedForIdle.add(id);
        await emitEvent(id, 'system', {
          message: `Session terminée après ${formatWait(now - since)} sans instruction, pour libérer sa place et sa mémoire. Envoyez un message pour la reprendre.`,
          notice: true,
          reason: 'idle_timeout',
        });
        await this.end(id);
        ended.push(id);
      } catch (err) {
        endedForIdle.delete(id);
        console.error(`[sessions] arrêt de la session inactive ${id}`, err);
      }
    }
    return ended;
  },

  /** Lance la minuterie de la file d'attente et de l'arrêt des sessions inactives (au démarrage du serveur). */
  startHousekeeping(): void {
    if (housekeeping) return;
    housekeeping = setInterval(() => {
      void this.endIdleSessions()
        .then((ids) => ids.length && console.log(`[sessions] ${ids.length} session(s) inactive(s) terminée(s)`))
        .catch((err) => console.error('[sessions] sessions inactives', err));
      void this.drainQueue();
    }, HOUSEKEEPING_INTERVAL_MS);
    housekeeping.unref();
  },

  /**
   * Début de l'arrêt du serveur, à appeler de façon synchrone dès la réception du signal : à partir
   * de là, toute fin de session est une interruption et aucune session ne démarre plus.
   */
  beginShutdown(): void {
    stopping = true;
    if (housekeeping) clearInterval(housekeeping);
    housekeeping = null;
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
