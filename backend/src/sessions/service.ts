import type { Actor } from '../context/types.js';
import { sessionSecretService } from '../vault/sessionSecrets.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { namesFromText } from '../worksessions/names.js';
import { worksessionService } from '../worksessions/service.js';
import { pubSub } from '../pubsub.js';
import { notificationService } from '../notifications/service.js';
import { userRepository } from '../users/repository.js';
import { selfTurnExcerpt, selfTurnNotice } from './providers/selfTurn.js';
import { backgroundCommands, describeBackgroundCommands } from './providers/subagents.js';
import { ANSWERED_BY, requestService } from '../requests/service.js';
import { removeSessionAttachments, storeAttachments } from './attachments.js';
import { sessionRepository } from './repository.js';
import { parseAuthor, promptAuthor, SYSTEM_AUTHOR, type InstructionAuthor } from './instructionAuthor.js';
import { scheduledRuns } from './scheduledRuns.js';
import { relaunchPrompt } from './history.js';
import { getProvider } from './providers/registry.js';
import type { RunningHandle } from './providers/provider.js';
import { serverSettings } from '../settings/server.js';
import { headCommitOf } from '../git/service.js';
import { containerMonitor } from '../runners/monitor.js';
import { isPersonalProject, type Project } from '../projects/types.js';
import { userService } from '../users/service.js';
import { ROLE_RANK } from '../users/types.js';
import { instanceRegistry } from '../instances/registry.js';
import { callInstance } from '../instances/client.js';
import type { Attachment, AttachmentInput, CreateSessionInput, RelaunchInput, Session, SessionFilter, SessionStatus } from './types.js';
import { log } from '../log.js';
import { claudeSettings } from '../settings/claude.js';
import { reviewOf } from '../reviews/types.js';
import { pullRequestRepository } from '../pullRequests/repository.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { agentService } from '../agents/service.js';
import { normalizeContextLimit } from './context.js';
import { AUTO_ARCHIVE_KEY, archivesWhenIdle, withoutAutoArchive } from './autoArchive.js';
import { autoTitleConfig, autoTitleService, withoutAutoTitle } from './autoTitle.js';

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
/** Sessions terminées par le serveur (inactivité, remise à zéro de la conversation à la limite de contexte) : leur fin n'est pas notifiée. */
const endedForIdle = new Set<string>();
/**
 * Sessions à terminer à la fin de leur tour, avec le message du transcript : leur tâche est passée à « terminée »
 * pendant qu'elles travaillaient (`sessionService.endForTask`). En mémoire, comme le processus.
 */
const endAfterTurn = new Map<string, string>();
/** Traitement de fin de session (mise à jour du statut) en cours, par id de session. */
const finishing = new Map<string, Promise<void>>();
/**
 * Sessions à archiver dès la fin de leur processus (`sessionService.archiveWhenDone`, outil `sessions.archive`) :
 * l'agent finit son tour, puis la session est archivée par l'écouteur `onArchiveWhenDone` (archivage en cascade
 * avec son dossier). En mémoire : le processus et sa fin vivent sur cette instance ; un redémarrage l'oublie.
 */
const archiveWhenDone = new Set<string>();
let archiveWhenDoneListener: ((id: string) => Promise<unknown>) | null = null;

/**
 * Personne à prévenir quand l'agent reprend de lui-même : celle qui a pris la main, sinon celle qui a demandé le travail,
 * sinon la propriétaire quand c'est une personne. Personne pour un agent qui travaille seul.
 */
async function selfTurnRecipient(session: Pick<Session, 'takenOverById' | 'requestedById' | 'ownerId'>): Promise<string | null> {
  if (session.takenOverById) return session.takenOverById;
  if (session.requestedById) return session.requestedById;
  if (!session.ownerId) return null;
  const owner = await userRepository.findById(session.ownerId);
  return owner && owner.kind !== 'agent' ? owner.id : null;
}

/** Fin d'une session (processus terminé : terminée, arrêtée ou en erreur ; ni garée ni interrompue). */
export interface SessionEnd {
  session: Session;
  /** Fin décidée par le serveur sans notification (inactivité, remise à zéro, archivage, prise en main). */
  quiet: boolean;
}
/** Écouteurs de fin de session (`sessionService.onEnded`), appelés en tâche de fond : une erreur n'empêche pas les autres. */
const endedListeners = new Map<string, (end: SessionEnd) => Promise<void> | void>();
function notifyEnded(end: SessionEnd): void {
  for (const [name, fn] of endedListeners) {
    void Promise.resolve()
      .then(() => fn(end))
      .catch((err) => log.warn(`[sessions] écouteur de fin « ${name} » (session ${end.session.id})`, err));
  }
}
/**
 * Arrêt du serveur en cours. Posé de façon synchrone dès la réception du signal : pm2 signale tout
 * l'arbre de processus, donc les agents peuvent mourir avant que leur `stop()` ne soit appelé ; leur
 * fin doit alors donner une session « interrompue », pas « en erreur ».
 */
let stopping = false;
/**
 * Instance en drainage (déploiement bleu/vert, SIGUSR2) : elle ne démarre plus de session (le démarrage est transmis à
 * l'instance qui la remplace), finit les tours en cours et gare chaque session à la fin de son tour (`parking`).
 */
let drainingInstance = false;
/** Sessions en train d'être garées : leur processus s'arrête, la session reste « running »/« idle » sans processus. */
const parking = new Set<string>();

/** Délai laissé aux sessions pour se clôturer à l'arrêt (pm2 tue le processus après 1,6 s par défaut). */
const SHUTDOWN_TIMEOUT_MS = 1200;
/** Après la recréation du conteneur : délai maximal d'attente de la fin de l'ancien processus d'une session avant de la relancer. */
const RESUME_AFTER_RUNNER_TIMEOUT_MS = 10_000;
/** Redémarrage (`sessionService.restart`) : attente maximale de la fin de l'ancien processus avant d'en lancer un neuf. */
const RESTART_TIMEOUT_MS = 15_000;
/**
 * Sessions dont le processus est arrêté pour être redémarré (`sessionService.restart`) : leur fin n'est ni un arrêt ni
 * une fin ordinaire (pas d'événement de statut, pas de notification). En mémoire, comme le processus.
 */
const restarting = new Set<string>();
/**
 * Sessions relancées pour une instruction arrivée pendant leur fin (`relaunchWithMessage`) : les instructions suivantes
 * attendent la relance, puis vont au nouveau processus.
 */
const relaunching = new Map<string, Promise<unknown>>();
/** Instruction de reprise d'une session redémarrée au milieu d'un tour. */
export const RESTART_RESUME_MESSAGE =
  "La session vient d'être redémarrée pour recharger tes outils (serveurs MCP, coffre, réglages) : ta conversation est intacte, mais ton tour en cours a été coupé. Reprends le travail là où il s'est arrêté.";
/**
 * Reprise automatique : sessions interrompues depuis moins d'une heure, toutes. La limite de sessions
 * simultanées s'applique comme à tout démarrage : celles qui la dépassent passent en file d'attente.
 */
const AUTO_RESUME_WINDOW_MS = 60 * 60 * 1000;

/**
 * Pourquoi une session a été interrompue : arrêt du serveur (signal reçu, ou arrêt brutal constaté au
 * démarrage suivant), ou bien environnement d'exécution du projet (conteneur) recréé ou arrêté depuis
 * la page du projet. La cause change le message du transcript et l'instruction de reprise.
 */
export type InterruptionReason = 'server_shutdown' | 'server_crash' | 'runner_reset' | 'runner_stop';

/** Ce qui est arrivé, du point de vue de l'agent, dans l'instruction de reprise. */
const INTERRUPTION_CAUSES: Record<InterruptionReason, string> = {
  server_shutdown: 'Le serveur Skipper a redémarré',
  server_crash: 'Le serveur Skipper a redémarré',
  runner_reset: "L'environnement d'exécution du projet (son conteneur) a été recréé",
  runner_stop: "L'environnement d'exécution du projet (son conteneur) a été arrêté puis relancé",
};

/** Ce qui est arrivé, pour le transcript (événement `system`). */
const INTERRUPTION_NOTICES: Record<InterruptionReason, string> = {
  server_shutdown: 'Session interrompue par un redémarrage du serveur',
  server_crash: "Session interrompue : le serveur s'est arrêté sans pouvoir la clôturer (arrêt brutal)",
  runner_reset: "Session interrompue par la recréation de l'environnement d'exécution du projet",
  runner_stop: "Session interrompue par l'arrêt de l'environnement d'exécution du projet",
};

/** Instruction de reprise d'un tour coupé : l'agent reprend son travail, les demandes en attente ont été annulées. */
const resumeMessage = (reason: InterruptionReason) =>
  `${INTERRUPTION_CAUSES[reason]} pendant ton tour et l'a interrompu. Reprends là où tu en étais : vérifie l'état des fichiers et des commandes en cours avant de continuer. Les demandes d'autorisation ou questions en attente ont été annulées : refais l'action ou repose la question si elle est encore utile.`;


/** Ce qu'une session interrompue en attente devient à la reprise (transcript). */
const IDLE_SETTLED_NOTICE = "Session prête à reprendre : elle attendait des instructions, aucun tour n'est relancé. Envoyez un message pour la continuer.";

/**
 * Cause de l'interruption des sessions interrompues par ce serveur (mémoire du serveur) : après un
 * redémarrage, elle n'est plus connue et la reprise suppose un redémarrage, ce qui est alors le cas.
 */
const interruptionReasons = new Map<string, InterruptionReason>();
const reasonOf = (id: string): InterruptionReason => interruptionReasons.get(id) ?? 'server_shutdown';

async function emitEvent(sessionId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const event = await sessionRepository.addEvent(sessionId, type, payload);
  pubSub.publish('sessionEvent', sessionId, event);
}

/**
 * Clôture d'une session par l'arrêt du serveur ou de l'environnement du projet : statut « interrupted »
 * (sans erreur ni code de sortie, activité conservée), événement explicite dans le transcript, demandes
 * en attente expirées. Sans effet si la session n'était plus « running » (renvoie null). Aucune
 * notification : ce n'est pas un échec.
 */
async function interruptSession(id: string, reason: InterruptionReason): Promise<Session | null> {
  const session = await sessionRepository.markInterrupted(id);
  if (!session) return null;
  interruptionReasons.set(id, reason);
  await emitEvent(id, 'system', {
    message: session.activity === 'busy' ? `${INTERRUPTION_NOTICES[reason]}, pendant que l'agent travaillait` : INTERRUPTION_NOTICES[reason],
    notice: true,
    reason,
    activity: session.activity,
  });
  await emitEvent(id, 'status', { status: 'interrupted', activity: session.activity });
  pubSub.publish('sessionUpdated', session);
  await requestService.cancelAllForSession(id, 'expired');
  return session;
}

/**
 * « Reprise » d'une session interrompue alors qu'elle attendait des instructions : aucun tour n'est lancé (il réécrirait
 * tout le contexte, cache expiré, pour un « Prêt » sans travail). Elle passe à « terminée », comme après le délai d'inactivité :
 * sa conversation est conservée et le prochain message la relance. Null si elle n'est plus interrompue.
 */
async function settleIdleInterrupted(id: string, message: string, reason: string): Promise<Session | null> {
  const current = await sessionRepository.findById(id);
  if (current?.status !== 'interrupted') return null;
  await emitEvent(id, 'system', { message, notice: true, reason, activity: current.activity });
  await emitEvent(id, 'status', { status: 'completed' });
  return publishSession(await sessionRepository.update(id, { status: 'completed', activity: null }));
}

/**
 * Instruction arrivée pendant la fin d'une session dont le processus vit encore (il ne lit plus ses instructions) :
 * l'ancien processus est arrêté comme pour un redémarrage, puis la session est relancée sur la même conversation avec
 * l'instruction. Sans cela, l'instruction était journalisée puis perdue (session Curso 56fd4c13 du 17/11/2026 : terminée
 * à la fin de sa tâche alors qu'une commande Bash de fond attendait une publication Android, deux messages perdus).
 */
async function relaunchWithMessage(id: string, handle: RunningHandle, text: string, attachments: Attachment[], author: InstructionAuthor): Promise<Session> {
  if (restarting.has(id) || archiveWhenDone.has(id) || parking.has(id) || stopping) {
    throw new AppError('La session est en train de se terminer : réessayez dans quelques secondes');
  }
  restarting.add(id);
  try {
    await requestService.cancelAllForSession(id);
    await handle.stop();
    await awaitFinished([id], RESTART_TIMEOUT_MS);
  } catch (err) {
    restarting.delete(id);
    throw err;
  }
  if (running.has(id)) throw new AppError("L'ancien processus de la session ne s'est pas arrêté à temps : réessayez dans quelques secondes");
  await emitEvent(id, 'system', { message: 'La session se terminait : elle est relancée (même conversation) avec votre message.', notice: true, reason: 'relaunch_for_message' });
  return sessionService.start(id, text, attachments, { author });
}

/** Attend la fin de session de ces sessions (mise à jour finale du statut), sans jamais bloquer plus de `timeoutMs`. */
async function awaitFinished(ids: string[], timeoutMs: number): Promise<void> {
  const pending = ids.map((id) => finishing.get(id)).filter((p): p is Promise<void> => Boolean(p));
  if (pending.length) await Promise.race([Promise.all(pending), delay(timeoutMs)]);
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
/** Reprise automatique des sessions interrompues en cours (une seule à la fois). */
let resuming: Promise<string[]> | null = null;
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
 * Session dont le processus tourne sur une autre instance vivante du backend (déploiement bleu/vert) : l'action y est
 * transmise et la session relue est renvoyée ; null si la session tourne ici ou n'est tenue par aucune autre instance.
 */
async function forwardToHolder(id: string, action: string, body: Record<string, unknown> = {}): Promise<Session | null> {
  if (running.has(id) || !instanceRegistry.hasPeers()) return null;
  const holder = await instanceRegistry.holder((await sessionRepository.findById(id))?.instanceId);
  if (!holder) return null;
  await callInstance(holder, action, { id, ...body });
  return sessionRepository.findById(id);
}

/** Fin d'une session garée (sans processus) : arrêt, fin demandée ou inactivité. null si elle n'est pas garée. */
async function endParked(id: string, status: 'completed' | 'stopped'): Promise<Session | null> {
  const session = await sessionRepository.findById(id);
  if (!session?.parkedAt || session.status !== 'running') return null;
  await emitEvent(id, 'status', { status });
  return publishSession(await sessionRepository.update(id, { status, activity: null, parkedAt: null, instanceId: null, endedAt: new Date() }));
}

/**
 * Gare une session de cette instance en drainage dont le tour est fini : son processus s'arrête (la conversation est
 * enregistrée), la session reste « running »/« idle » et la prochaine instruction la relance sur l'instance qui la
 * reçoit (voir la fin de session dans `start`).
 */
async function park(id: string): Promise<void> {
  const handle = running.get(id);
  if (!handle || parking.has(id) || stopping) return;
  parking.add(id);
  log.info(`[instances] session ${id} garée : tour terminé pendant le drainage`);
  await handle.stop().catch(() => undefined);
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

/** Une session archivée ne démarre plus : il faut la restaurer ou en relancer une nouvelle. */
function assertNotArchived(session: Session): void {
  if (session.archivedAt) throw new AppError("Cette session est archivée : restaurez-la d'abord, ou relancez une nouvelle session depuis son historique", 'ARCHIVED');
}

/**
 * Session active (hors revue de code) qui occupe le dossier d'une session archivée : une work session n'héberge
 * qu'une session active, la session archivée ne peut pas être restaurée tant que celle-ci y travaille. Null pour une
 * session de revue (elle se restaure à côté) ou sans dossier.
 */
async function activeSuccessorInFolder(session: Session): Promise<Session | null> {
  if (!session.worksessionId || reviewOf(session)) return null;
  const others = await sessionRepository.list({ worksessionId: session.worksessionId, archived: 'exclude', limit: 50 });
  return others.find((s) => s.id !== session.id && !reviewOf(s)) ?? null;
}

/**
 * Une session (hors chat) ne s'exécute que dans sa work session : sans elle (dossier supprimé à la fusion de sa PR,
 * retiré depuis l'interface ou l'outil `worksessions.delete`, session d'avant les work sessions), elle ne démarre pas,
 * et surtout pas dans le checkout principal du projet, où l'agent se croirait sur sa branche alors qu'il est sur la
 * branche principale (conversation neuve, le transcript étant rangé par dossier). Elle se relance dans un nouveau
 * dossier (`relaunch`) ou reste archivée.
 */
export function assertHasWorksession(session: Pick<Session, 'kind' | 'worksessionId' | 'formerWorksession'>): void {
  if (session.kind === 'chat' || session.worksessionId) return;
  const former = session.formerWorksession;
  throw new AppError(
    former
      ? `Le dossier de travail de cette session (branche ${former.branch}) a été supprimé, par exemple à la fusion de sa pull request : elle ne peut plus reprendre. Relancez-la (nouvelle session dans un nouveau dossier, avec cette conversation en contexte), ou laissez-la archivée.`
      : "Cette session n'a pas de dossier de travail : elle ne peut plus reprendre. Relancez-la (nouvelle session dans un nouveau dossier, avec cette conversation en contexte), ou archivez-la.",
    'NO_WORKSESSION',
  );
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
async function enqueue(session: Session, blocker: string, initialMessage: string | undefined, attachments: Attachment[], author: InstructionAuthor | null): Promise<Session> {
  const queued = await publishSession(
    await sessionRepository.update(session.id, {
      status: 'queued',
      activity: null,
      exitCode: null,
      error: null,
      queuedAt: session.queuedAt ?? new Date(),
      queuedStart: { message: initialMessage ?? null, attachments: initialMessage === undefined ? [] : attachments, ...(author ? { author } : {}) },
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
  if (stopping || drainingInstance || serverSettings.maintenance) return;
  const max = serverSettings.current.maxConcurrentSessions;
  if (max > 0 && slots.size >= max) return;
  for (const session of await sessionRepository.listQueued()) {
    if (stopping || drainingInstance || serverSettings.maintenance) return;
    if (max > 0 && slots.size >= max) return;
    const project = await projectService.get(session.projectId).catch(() => null);
    if (!project || slotBlocker(project)) continue;
    try {
      await sessionService.start(session.id, session.queuedStart?.message ?? undefined, session.queuedStart?.attachments ?? [], { fromQueue: true, author: parseAuthor(session.queuedStart?.author) });
    } catch (err) {
      const message = (err as Error).message;
      log.error(`[sessions] démarrage de ${session.id} depuis la file d'attente`, err);
      await emitEvent(session.id, 'status', { status: 'failed', error: message }).catch(() => undefined);
      await sessionRepository
        .update(session.id, { status: 'failed', activity: null, error: message, endedAt: new Date(), queuedAt: null, queuedStart: null })
        .then((s) => s && pubSub.publish('sessionUpdated', s))
        .catch(() => undefined);
    }
  }
}

/** Modèle fixé par la configuration d'une session (chaîne non vide), sinon null. */
const configModel = (config: Record<string, unknown> | null | undefined): string | null => (typeof config?.model === 'string' && config.model.trim() ? config.model.trim() : null);

/** Le compte Claude qui servira la session de ce propriétaire (le sien, ou celui prêté à un agent) autorise-t-il ce modèle ? */
async function modelAllowedForOwner(ownerId: string | null, model: string): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const accounts = await agentService.accountsForOwner(ownerId);
    const settings = await claudeSettings.forUser(accounts?.claudeUserId ?? ownerId);
    settings.assertModelAllowed(model);
    return true;
  } catch {
    log.info(`[sessions] modèle du projet ${model} ignoré : non autorisé pour le propriétaire ${ownerId}`);
    return false;
  }
}

/**
 * PR encore ouverte du dossier de travail d'une session. Une session d'agent qui porte une PR ouverte ne s'archive pas
 * (ni par l'outil `sessions.archive`, ni d'office en fin de tour) : elle garde son contexte et son dossier pour les
 * retours de revue, la CI ou les conflits, et Skipper la range quand la PR est fusionnée ou fermée
 * (`archiveAgentSessionsOfPullRequest`, projects/cleanup.ts). Les archivages par une personne ne sont pas concernés.
 */
async function openPullRequestOf(session: Pick<Session, 'worksessionId'>): Promise<TrackedPullRequest | null> {
  if (!session.worksessionId) return null;
  return pullRequestRepository.findOpenByWorksession(session.worksessionId).catch((err) => {
    log.warn(`[sessions] PR ouverte du dossier ${session.worksessionId} non lue`, err);
    return null;
  });
}

export const openPullRequestRefusal = (pr: Pick<TrackedPullRequest, 'number'>) =>
  `La PR #${pr.number} de ce dossier est encore ouverte : la session reste active jusqu'à sa fusion ou sa fermeture, pour traiter les retours de revue, la CI ou les conflits avec son contexte. Skipper l'archivera alors d'elle-même ; termine simplement ta réponse.`;

export const sessionService = {
  list: (filter?: SessionFilter) => sessionRepository.list(filter),
  get: (id: string) => sessionRepository.findById(id),
  events: (sessionId: string, opts?: { after?: string; limit?: number; toolUseId?: string }) => sessionRepository.listEvents(sessionId, opts),
  isRunning: (id: string) => running.has(id),
  /** Sessions du projet dont le processus tourne sur ce serveur. */
  runningCountByProject: (projectId: string) => [...running.keys()].filter((id) => slots.get(id) === projectId).length,
  /** Places occupées dans le projet : sessions en cours ou en train de démarrer (voir `slots`). */
  slotsOfProject,

  /**
   * Crée une session dans une work session existante (`worksessionId`) ou créée pour l'occasion (`newWorksession`).
   * `actor` agent : la session est rattachée à la session qui la lance (profondeur et nombre limités) et les membres sont notifiés.
   */
  async create(input: CreateSessionInput & { autoStart?: boolean }, actor: Actor = { type: 'human' }): Promise<Session> {
    serverSettings.assertNotInMaintenance();
    const provider = getProvider(input.provider);
    const project = await projectService.get(input.projectId); // lève NotFoundError si le projet n'existe pas
    // Session jouée par un agent de projet (propriétaire agent) : ses réglages par défaut s'appliquent avant ceux du projet.
    const agentOwner = input.ownerId ? await agentService.forUser(input.ownerId) : null;
    if (agentOwner) {
      if (agentOwner.projectId !== project.id) throw new AppError(`L'agent ${agentOwner.name} n'appartient pas à ce projet`);
      if (agentOwner.archivedAt) throw new AppError(`L'agent ${agentOwner.name} a été retiré du projet`);
      input = { ...input, config: agentService.sessionConfig(agentOwner, input.config) };
    } else {
      input = { ...input, requestedById: null };
    }
    // Sans mode d'autorisation précisé (sessions de tâches, sessions sans formulaire), celui du projet s'applique.
    if (!input.config?.permissionMode && provider.describe().configFields.some((f) => f.key === 'permissionMode')) {
      input = { ...input, config: { ...input.config, permissionMode: project.defaultPermissionMode } };
    }
    provider.validateConfig?.(input.config ?? {});
    // Nom provisoire : drapeau du titre généré après le premier tour ; un nom explicite ne le porte jamais (pas même hérité).
    const { autoTitle, ...withoutFlag } = input;
    input = { ...withoutFlag, config: autoTitle ? { ...(input.config ?? {}), ...autoTitleConfig() } : withoutAutoTitle(input.config ?? {}) };
    // Limite de contexte : celle choisie au lancement (objet vide : aucune), sinon le défaut du projet (sessions de
    // tâches, lancées par un agent…). Jamais d'autre limite que celle qu'une personne a choisie.
    input = { ...input, cleanup: (input.cleanup ? normalizeContextLimit(input.cleanup) : project.defaultContextCleanup) ?? {} };
    if (input.worksessionId && input.newWorksession) throw new AppError('Choisissez une work session existante ou une nouvelle, pas les deux');
    if (input.kind === 'chat') {
      // Un chat est une session légère d'un espace personnel : pas de work session (il n'a pas de dossier de travail), provider Claude.
      if (!isPersonalProject(project)) throw new AppError("Un chat ne s'ouvre que dans un espace personnel");
      if (input.worksessionId || input.newWorksession) throw new AppError("Un chat n'a pas de work session");
      if (input.provider !== 'claude') throw new AppError('Un chat est toujours une conversation Claude');
    } else if (!input.worksessionId && !input.newWorksession) {
      // Une session s'exécute toujours dans une work session : rien ne tourne dans le checkout principal.
      throw new AppError('Une session travaille dans une work session : choisissez-en une ou créez-en une');
    }
    if (input.worksessionId) {
      // Vérifie l'appartenance et l'archivage, puis la règle « une seule session active par work session » :
      // le dossier (et sa branche) appartient à sa session ; une autre doit être archivée avant d'y travailler.
      // Une session de relecture (lecture seule, reviews/) n'y écrit rien : elle s'ajoute à côté et ne bloque personne.
      const wt = await worksessionService.assertUsable(project, input.worksessionId);
      const busy = reviewOf(input) ? null : (await sessionRepository.list({ worksessionId: wt.id, archived: 'exclude', limit: 50 })).find((s) => !reviewOf(s));
      if (busy) throw new AppError(`La session « ${busy.name} » travaille déjà sur la branche ${wt.branch} : archivez-la d'abord, ou lancez la nouvelle session sur une autre branche`);
    }

    let parentSessionId: string | null = null;
    let ownerId = input.ownerId ?? null;
    if (actor.type === 'agent' && actor.sessionId) {
      const parent = await sessionRepository.findById(actor.sessionId);
      if (!parent) throw new NotFoundError('Session parente introuvable');
      if (parent.projectId !== project.id) {
        // Seule une session d'un espace personnel lance des sessions ailleurs : dans les projets de son propriétaire, avec ses droits.
        const parentProject = await projectService.get(parent.projectId);
        if (!isPersonalProject(parentProject) || !parent.ownerId) throw new AppError('Un agent ne peut lancer des sessions que dans son propre projet');
        const role = await userService.memberRoleFor(parent.ownerId, project.id);
        if (!role || ROLE_RANK[role] < ROLE_RANK.member) throw new AppError(`Lancer une session dans « ${project.name} » demande le rôle membre sur ce projet`);
      }
      // La session lancée par un agent appartient à la personne qui pilote la session parente, sauf quand elle est confiée à
      // un agent du projet (propriétaire agent) ; la personne qui a demandé la session parente reste celle qui demande.
      ownerId = agentOwner ? agentOwner.id : parent.ownerId;
      if (agentOwner && !input.requestedById) input = { ...input, requestedById: parent.requestedById ?? parent.ownerId };
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

    // Modèle : celui choisi (ou celui de l'agent), sinon celui que le projet propose pour ce lancement (priorité de la
    // tâche, puis défaut du projet), pourvu que le compte Claude du propriétaire l'autorise ; sinon rien n'est fixé et le
    // modèle par défaut du propriétaire s'applique au démarrage.
    if (input.provider === 'claude' && !configModel(input.config)) {
      const proposed = input.defaultModel?.trim() || project.defaultModel;
      if (proposed && (await modelAllowedForOwner(ownerId, proposed))) input = { ...input, config: { ...input.config, model: proposed } };
    }

    let worksessionId = input.worksessionId ?? null;
    let createdWorksessionId: string | null = null;
    if (input.newWorksession) {
      // Sans nom ni branche ni libellé, la work session est nommée d'après la consigne (ou le nom de la session).
      const names = namesFromText(input.prompt?.trim() || input.name);
      const nw = input.newWorksession;
      // Sans branche choisie, la branche est dérivée : suffixée si elle existe déjà plutôt que d'échouer ou de reprendre un autre travail.
      const uniqueBranch = !nw.branch?.trim();
      const worksession = await worksessionService.create(project.id, { ...(nw.name?.trim() || nw.branch?.trim() || nw.label?.trim() ? nw : { ...nw, ...names }), uniqueBranch }, ownerId);
      worksessionId = createdWorksessionId = worksession.id;
    }
    let session: Session;
    try {
      const prompt = input.prompt?.trim() || (input.attachments?.length ? ATTACHMENTS_ONLY_TEXT : input.prompt);
      session = await sessionRepository.create({ ...input, prompt, worksessionId, parentSessionId, ownerId });
    } catch (err) {
      if (createdWorksessionId) await worksessionService.delete(createdWorksessionId, true).catch(() => undefined);
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
        if (createdWorksessionId) await worksessionService.delete(createdWorksessionId, true).catch(() => undefined);
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
   * par la file d'attente elle-même (sans place, la session y reste à son rang). `author` : qui écrit l'instruction
   * (Skipper par défaut) ; la consigne de la session est attribuée à qui l'a lancée ou demandée (`promptAuthor`).
   */
  async start(id: string, initialMessage?: string, attachments: Attachment[] = [], opts: { fromQueue?: boolean; fromParked?: boolean; author?: InstructionAuthor | null } = {}): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    assertNotArchived(session);
    assertHasWorksession(session);
    // `fromParked` : session garée, réservée pour cette instance par `sendMessage`, qui reprend son processus.
    if (session.status === 'running' && !opts.fromParked) throw new AppError('La session est déjà en cours');
    if (session.status === 'queued' && !opts.fromQueue) throw queuedError();
    if (opts.fromQueue && session.status !== 'queued') return session;
    if (stopping) throw new AppError('Le serveur redémarre : réessayez dans quelques secondes', 'MAINTENANCE');
    if (drainingInstance) {
      // Instance en cours de remplacement : la session démarre sur celle qui la remplace.
      const peer = await instanceRegistry.activePeer();
      if (!peer) throw new AppError('Le serveur redémarre : réessayez dans quelques secondes', 'MAINTENANCE');
      await callInstance(peer, 'session.start', { id, message: initialMessage ?? null, attachments, author: opts.author ?? null });
      return publishSession(await sessionRepository.findById(id));
    }
    serverSettings.assertNotInMaintenance();
    if (!(initialMessage ?? session.prompt)) throw new AppError('Envoyez une première instruction pour démarrer la session');
    const provider = getProvider(session.provider);
    const project = await projectService.get(session.projectId);
    // Session d'un agent : un modèle qui n'est plus parmi ses modèles autorisés (fiche modifiée depuis) est remplacé.
    const agentOwner = await agentService.forUser(session.ownerId);
    const constrainedConfig = agentOwner ? agentService.constrainModel(agentOwner, session.config) : null;

    // Pas d'await entre la vérification et la réservation de la place (une place déjà prise : démarrage concurrent).
    if (slots.has(id)) throw new AppError('La session est déjà en cours');
    const blocker = slotBlocker(project);
    if (blocker) return opts.fromQueue ? session : enqueue(session, blocker, initialMessage, attachments, opts.author ?? null);
    slots.set(id, project.id);
    idleSince.delete(id);

    const emit = (type: string, payload: Record<string, unknown> = {}) => emitEvent(id, type, payload);

    let started: Session;
    try {
      if (session.status === 'queued') {
        await emit('system', { message: `Place libérée : la session démarre après ${formatWait(Date.now() - (session.queuedAt?.getTime() ?? Date.now()))} d'attente`, notice: true, reason: 'queue_start' });
      }
      started = await publishSession(
        await sessionRepository.update(id, { status: 'running', activity: 'busy', startedAt: new Date(), endedAt: null, exitCode: null, error: null, queuedAt: null, queuedStart: null, resumeDigest: null, instanceId: instanceRegistry.id, parkedAt: null, ...(constrainedConfig ? { config: constrainedConfig } : {}) }),
      );
    } catch (err) {
      slots.delete(id);
      this.drainQueue();
      throw err;
    }

    let handle: RunningHandle;
    try {
      // La session s'exécute dans sa work session (les sessions d'avant les work sessions : dans le checkout principal).
      const cwd = await worksessionService.resolveCwd(project, session.worksessionId);
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
        // Conversation remise à zéro « en gardant un résumé » : le résumé accompagne la première instruction (une seule fois).
        initialPreamble: session.externalId ? null : session.resumeDigest,
        initialAuthor: opts.author ?? (initialMessage === undefined ? await promptAuthor(session) : SYSTEM_AUTHOR),
        emit,
        setExternalId: async (externalId) => {
          await publishSession(await sessionRepository.update(id, { externalId }));
        },
        setContextTokens: async (contextTokens) => {
          await publishSession(await sessionRepository.update(id, { contextTokens }));
        },
        setSubagents: async (subagents) => {
          await publishSession(await sessionRepository.update(id, { subagents }));
        },
        setActivity: async (activity) => {
          if (activity === 'idle') idleSince.set(id, Date.now());
          else idleSince.delete(id);
          await publishSession(await sessionRepository.update(id, { activity }));
          const endNotice = activity === 'idle' ? endAfterTurn.get(id) : undefined;
          if (endNotice !== undefined) endAfterTurn.delete(id);
          // Fin du premier tour d'une session au nom provisoire : titre court généré en arrière-plan.
          if (activity === 'idle') void autoTitleService.afterTurn(id, publishSession);
          if (activity === 'idle' && drainingInstance) void park(id);
          // Fin d'un tour ordinaire : la limite de contexte choisie pour la session s'applique (rien sans limite). Les
          // exécutions planifiées appliquent la leur avant de démarrer (schedules/service.ts).
          // Une session lancée sans personne (autoArchive) est rangée d'office à la place.
          else if (activity === 'idle' && !stopping && !scheduledRuns.has(id)) {
            void sessionService
              .archiveAfterTurn(id)
              .then(async (archived) => {
                if (archived) return;
                // Sa tâche est terminée depuis le début du tour : la session se termine plutôt que d'attendre le délai d'inactivité.
                if (endNotice !== undefined) {
                  await sessionService.endForTask(id, endNotice);
                  return;
                }
                const { cleanupService } = await import('./cleanup.js');
                await cleanupService.afterTurn(id);
              })
              .catch((err) => log.error(`[sessions] fin de tour de la session ${id}`, err));
          }
        },
        recordConfig: async (changes) => {
          await persistConfig(id, changes, Object.keys(changes));
        },
        ask: async (input, signal) => {
          await emit('request', { type: input.type, title: input.title, ...(input.message ? { message: input.message } : {}), payload: input.payload ?? {} });
          // La notification porte l'identifiant de la demande : elle sera marquée lue quand la demande sera réglée.
          const response = await requestService.ask(id, input, signal, (request) => {
            void notificationService.notify({
              type: 'request.created',
              title:
                input.type === 'question' ? `Question de l'agent « ${session.name} »` : input.type === 'secrets' ? `« ${session.name} » vous demande des secrets` : `« ${session.name} » attend votre autorisation`,
              message: input.title,
              link: `/sessions/${id}`,
              projectId: session.projectId,
              sessionId: id,
              payload: { requestType: input.type, requestId: request.id },
            });
          });
          // Qui a répondu reste dans la table des demandes ; le transcript garde la réponse seule.
          const { [ANSWERED_BY]: _answeredBy, ...shown } = response;
          await emit('request.answered', { type: input.type, title: input.title, response: shown });
          return response;
        },
        isServerStopping: () => stopping,
        onSelfTurnEnded: async ({ trigger, text }) => {
          // Exécution planifiée : son compte rendu de fin a sa propre notification.
          if (scheduledRuns.has(id)) return;
          const current = (await sessionRepository.findById(id)) ?? started;
          const userId = await selfTurnRecipient(current);
          if (!userId) return;
          await notificationService.notify({
            type: 'session.self_turn',
            title: `« ${current.name} » a repris de lui-même`,
            message: selfTurnExcerpt(text) ?? selfTurnNotice(trigger),
            link: `/sessions/${id}`,
            projectId: current.projectId,
            sessionId: id,
            userId,
            payload: { trigger },
          });
        },
      });
    } catch (err) {
      slots.delete(id);
      this.drainQueue();
      const message = (err as Error).message;
      await emit('status', { status: 'failed', error: message });
      const failed = await publishSession(await sessionRepository.update(id, { status: 'failed', activity: null, error: message, endedAt: new Date(), instanceId: null }));
      notifyEnded({ session: failed, quiet: false });
      return failed;
    }

    running.set(id, handle);
    // Fin du processus gérée en tâche de fond : la mutation `start` rend la main immédiatement.
    const finished = handle.wait().then(async (result) => {
      running.delete(id);
      slots.delete(id);
      idleSince.delete(id);
      endAfterTurn.delete(id);
      const idleEnd = endedForIdle.delete(id);
      const restart = restarting.delete(id);
      // La place libérée revient à la première session de la file d'attente.
      this.drainQueue();
      const current = await sessionRepository.findById(id);
      // Garée par le drainage : ni fin ni interruption, la session attend sa prochaine instruction sans processus.
      if (parking.delete(id) && current?.status === 'running') {
        await publishSession(await sessionRepository.update(id, { instanceId: null, parkedAt: new Date(), activity: 'idle' }));
        return;
      }
      // Arrêt du serveur : la session est « interrompue », quelle que soit la façon dont son flux s'est
      // terminé (fermé par `stop()`, ou agent tué par le signal de pm2 avant). Statut peut-être déjà posé par `shutdown()`.
      if (stopping || current?.status === 'interrupted') {
        await interruptSession(id, reasonOf(id));
        return;
      }
      await requestService.cancelAllForSession(id);
      // Redémarrage : la session attend sans processus ; `restart` en relance un neuf (ou le prochain message).
      if (restart) {
        await publishSession(await sessionRepository.update(id, { status: 'completed', activity: null, exitCode: result.exitCode, error: null, endedAt: new Date(), instanceId: null }));
        return;
      }
      // Si `stop()` a déjà posé le statut "stopped", on le conserve.
      const status: SessionStatus =
        current?.status === 'stopped' || result.closedByServer ? 'stopped' : result.error || result.exitCode !== 0 ? 'failed' : 'completed';
      let error = status === 'failed' ? result.error ?? `Code de sortie ${result.exitCode}` : null;
      // Processus tué faute de mémoire dans le conteneur : message explicite plutôt que « exited with code 137 ».
      if (status === 'failed') {
        // Borné : un Docker qui ne répond pas ne doit pas retarder la fin de la session.
        const oom = await Promise.race([
          containerMonitor.explainFailure(project, result).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref()),
        ]);
        if (oom) error = `${oom} (détail : ${error})`;
      }
      await emit('status', { status, exitCode: result.exitCode, error });
      const ended = await publishSession(await sessionRepository.update(id, { status, activity: null, exitCode: result.exitCode, error, endedAt: new Date(), instanceId: null }));
      notifyEnded({ session: ended, quiet: idleEnd });
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
    finishing.set(
      id,
      finished
        .catch((err) => log.error('[sessions] fin de session', err))
        .finally(() => {
          finishing.delete(id);
          // Après `finishing.delete` : l'archivage attend la fin de session (`archive` lit `finishing`).
          if (archiveWhenDone.delete(id) && !parking.has(id) && !stopping) {
            void archiveWhenDoneListener?.(id).catch((err) => log.warn('[sessions] archivage en fin de session', id, err));
          }
        }),
    );

    return started;
  },

  /**
   * Envoie une instruction à la session. Si elle est en cours, l'instruction est transmise à
   * l'agent ; si elle est terminée, la session est relancée avec cette instruction (reprise). `author` : qui écrit
   * (personne, session d'agent), journalisé et annoncé au modèle ; Skipper à défaut.
   */
  async sendMessage(
    id: string,
    text: string,
    files?: AttachmentInput[] | null,
    opts: { attachments?: Attachment[]; byPerson?: boolean; author?: InstructionAuthor | null; unarchive?: boolean } = {},
  ): Promise<Session> {
    const author = opts.author ?? SYSTEM_AUTHOR;
    const trimmed = text.trim() || (files?.length || opts.attachments?.length ? ATTACHMENTS_ONLY_TEXT : '');
    if (!trimmed) throw new AppError('Le message est vide');
    let session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.archivedAt) {
      // Une personne qui écrit dans une session archivée la restaure (avec son dossier) puis la relance avec son
      // message. Refusé comme la restauration si le dossier a disparu ou si une autre session y travaille.
      if (!opts.unarchive) assertNotArchived(session);
      // Une autre session travaille désormais dans ce dossier (l'agent reconvoqué sur la tâche en ouvre une nouvelle
      // dans le même dossier) : le message lui est transmis plutôt que refusé. Renvoie cette session, que
      // l'interface ouvre à la place.
      const successor = await activeSuccessorInFolder(session);
      if (successor) {
        await emitEvent(id, 'system', { message: `Message transmis à la session « ${successor.name} », qui travaille désormais dans ce dossier`, notice: true, reason: 'forwarded_to_successor', sessionId: successor.id });
        const note = `[Message écrit dans la session archivée « ${session.name} » (${id}), qui travaillait avant toi dans ce dossier ; \`sessions.get\` avec cet id montre sa dernière réponse]`;
        return this.sendMessage(successor.id, `${note}\n\n${trimmed}`, files, { ...opts, unarchive: false });
      }
      await this.unarchive(id);
      await emitEvent(id, 'system', { message: 'Session restaurée par un nouveau message', notice: true, reason: 'unarchived_by_message' });
      session = (await sessionRepository.findById(id))!;
    }
    if (session.status === 'queued') throw queuedError();
    // Sans processus, l'instruction relancerait la session : refusée d'emblée si son dossier n'existe plus.
    if (!running.has(id) && session.status !== 'running') assertHasWorksession(session);
    // Une personne écrit directement dans la session : elle la pilote désormais, la session ne se range plus d'office.
    if (opts.byPerson && session.config?.[AUTO_ARCHIVE_KEY] !== undefined) {
      await publishSession(await sessionRepository.update(id, { config: withoutAutoArchive(session.config) }));
      await emitEvent(id, 'system', { message: "Une personne écrit dans cette session : elle ne sera plus archivée d'office à la fin de ses tours", notice: true, reason: 'auto_archive_off' });
    }
    const handle = running.get(id);
    if (handle && !handle.sendMessage) throw new AppError("Ce type de session n'accepte pas d'instructions en cours d'exécution");
    // `opts.attachments` : fichiers déjà enregistrés par l'instance qui a reçu l'instruction et nous l'a transmise.
    const store = async () => opts.attachments ?? (files?.length ? await storeAttachments(await projectService.get(session.projectId), id, files) : []);
    if (!handle && instanceRegistry.hasPeers()) {
      // Processus tenu par une autre instance (déploiement bleu/vert), ou instance en drainage qui ne relance plus
      // rien elle-même : l'instruction est transmise.
      const target = (await instanceRegistry.holder(session.instanceId)) ?? (drainingInstance ? await instanceRegistry.activePeer() : null);
      if (target) {
        await callInstance(target, 'session.message', { id, text: trimmed, attachments: await store(), author });
        return publishSession(await sessionRepository.findById(id));
      }
    }
    const attachments = await store();
    const pendingRelaunch = relaunching.get(id);
    if (pendingRelaunch) {
      await pendingRelaunch.catch(() => undefined);
      return this.sendMessage(id, trimmed, null, { ...opts, attachments, author });
    }
    // Processus encore vivant mais qui n'accepte plus d'instructions (fin demandée : tâche terminée, inactivité, remise à
    // zéro ; le CLI attend une commande de fond avant de sortir) : la session est relancée avec l'instruction.
    if (handle && handle.acceptsMessages?.() === false) {
      const relaunch = relaunchWithMessage(id, handle, trimmed, attachments, author);
      relaunching.set(id, relaunch);
      try {
        return await relaunch;
      } finally {
        relaunching.delete(id);
      }
    }
    // Session garée par une instance en drainage : celle-ci la réserve puis relance son processus avec l'instruction.
    if (!handle && session.status === 'running' && session.parkedAt && (await sessionRepository.claimParked(id, instanceRegistry.id))) {
      return this.start(id, trimmed, attachments, { fromParked: true, author });
    }
    if (!handle) return this.start(id, trimmed, attachments, { author });
    await handle.sendMessage!(trimmed, attachments, author);
    return publishSession(await sessionRepository.findById(id));
  },

  /**
   * Note discrète pour l'agent (changement d'une tâche reliée qui ne s'adresse pas à lui) : elle ne lui ouvre pas de
   * tour ; le provider la remet avec le résultat de ses prochains outils ou avec sa prochaine instruction. Le
   * transcript en garde un événement `task_note`, replié dans l'interface. Sans processus (session terminée, garée),
   * la note est perdue : la session relira ses tâches au prochain démarrage (prompt système). Un provider qui ne sait
   * pas prendre de note reçoit le texte comme une instruction.
   */
  async notify(id: string, text: string): Promise<void> {
    const handle = running.get(id);
    if (!handle) {
      if (!instanceRegistry.hasPeers()) return;
      const holder = await instanceRegistry.holder((await sessionRepository.findById(id))?.instanceId);
      if (holder) await callInstance(holder, 'session.notify', { id, text });
      return;
    }
    if (!handle.notify) {
      if (handle.sendMessage) await this.sendMessage(id, text);
      return;
    }
    await handle.notify(text);
    await emitEvent(id, 'task_note', { text });
  },

  /**
   * Prise en main de la session d'un agent par une personne (`userId`), ou restitution à l'agent (null) : les comptes et
   * les droits de la session changent, ce qui ne s'applique qu'au lancement de son processus. En cours, l'agent finit
   * son tour puis la session se termine sans notification ; la prochaine instruction la relance (conversation reprise)
   * avec les nouveaux comptes. Les droits de l'appelant sont vérifiés par `agentService.takeOver` / `handBack`.
   */
  async setTakenOver(id: string, userId: string | null, notice: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    assertNotArchived(session);
    await sessionRepository.update(id, { takenOverById: userId, takenOverAt: userId ? new Date() : null });
    await emitEvent(id, 'system', { message: notice, notice: true, reason: userId ? 'taken_over' : 'handed_back' });
    if (session.status === 'running') {
      await this.end(id, { quiet: true }).catch((err) => log.warn(`[sessions] prise en main de ${id} : fin du processus impossible`, err));
    }
    return publishSession(await sessionRepository.findById(id));
  },

  /** Renomme la session. */
  async rename(id: string, name: string): Promise<Session> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('Le nom est vide');
    if (trimmed.length > 120) throw new AppError('Le nom dépasse 120 caractères');
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    // Un nom choisi par une personne n'est jamais remplacé par un titre généré.
    return publishSession(await sessionRepository.update(id, { name: trimmed, config: withoutAutoTitle(session.config) }));
  },

  /**
   * Archive la session dès qu'elle a fini : en cours, l'agent termine son tour (`end`), puis l'écouteur
   * `onArchiveWhenDone` l'archive ; sinon elle l'est tout de suite. Sert à une session qui s'archive elle-même
   * (outil `sessions.archive`) : l'archiver immédiatement couperait l'outil qui le demande. Renvoie `true` si
   * l'archivage est différé à la fin du tour. Refusé tant que la PR du dossier est ouverte (`openPullRequestOf`), sauf
   * `force` (Skipper range la session à la fin de sa PR).
   */
  async archiveWhenDone(id: string, reason: string | null = null, opts: { auto?: boolean; force?: boolean; schedule?: boolean; waitingFor?: string | null } = {}): Promise<boolean> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.archivedAt) return false;
    if (archiveWhenDone.has(id)) return true; // déjà demandé : la fin du tour l'archivera
    if (!archiveWhenDoneListener) throw new AppError("L'archivage n'est pas disponible");
    const open = opts.force ? null : await openPullRequestOf(session);
    if (open) throw new AppError(openPullRequestRefusal(open));
    const deferred = running.has(id);
    const message = opts.schedule
      ? `Session archivée par sa planification${deferred ? ' à la fin de ce tour' : ''}${reason ? ` : ${reason}` : ''}`
      : opts.auto && opts.waitingFor
      ? `Session lancée sans personne : elle sera archivée d'office quand l'agent aura fini. Il attend ${opts.waitingFor} et reprendra de lui-même ensuite.`
      : opts.auto
      ? "Session archivée d'office à la fin de son tour : lancée sans personne pour la piloter, elle se range seule (le fil de sa tâche ou de son canal rappellera l'agent)"
      : opts.force
        ? `Session archivée par Skipper${deferred ? ' à la fin de ce tour' : ''}${reason ? ` : ${reason}` : ''}`
        : `${deferred ? 'Session archivée par son agent à la fin de ce tour' : 'Session archivée par un agent'}${reason ? ` : ${reason}` : ''}`;
    await emitEvent(id, 'system', { message, notice: true, reason: opts.schedule ? 'schedule_archive' : opts.auto ? 'auto_archive' : opts.force ? 'pr_ended_archive' : 'agent_archive' });
    if (deferred) {
      archiveWhenDone.add(id);
      try {
        // Sans notification de fin : la session est rangée, pas « terminée » à suivre.
        await this.end(id, { quiet: true });
      } catch (err) {
        archiveWhenDone.delete(id);
        throw err;
      }
      return true;
    }
    await archiveWhenDoneListener(id);
    return false;
  },

  /**
   * Fin de tour d'une session lancée sans personne (`archivesWhenIdle`, voir autoArchive.ts) : elle est archivée d'office,
   * sauf si l'agent attend encore une session qu'il a lancée ou si un nouveau tour a déjà commencé. Renvoie `true` si
   * l'archivage est engagé (la limite de contexte ne s'applique alors pas).
   */
  async archiveAfterTurn(id: string): Promise<boolean> {
    if (archiveWhenDone.has(id)) return true;
    if (!archiveWhenDoneListener || !running.has(id)) return false;
    const session = await sessionRepository.findById(id);
    if (!session || !archivesWhenIdle(session) || session.status !== 'running' || session.activity !== 'idle') return false;
    const [runningChildren, queuedChildren] = await Promise.all([
      sessionRepository.list({ parentSessionId: id, status: 'running', archived: 'exclude', limit: 1 }),
      sessionRepository.list({ parentSessionId: id, status: 'queued', archived: 'exclude', limit: 1 }),
    ]);
    if (runningChildren.length || queuedChildren.length) {
      log.info(`[sessions] session ${id} non archivée d'office : une session qu'elle a lancée tourne encore`);
      return false;
    }
    const open = await openPullRequestOf(session);
    if (open) {
      log.info(`[sessions] session ${id} non archivée d'office : sa PR #${open.number} est encore ouverte`);
      return false;
    }
    // Commandes de fond encore vivantes : le CLI réveillera l'agent à leur fin, l'archivage n'aura lieu qu'après ce tour-là.
    const commands = backgroundCommands(session.subagents);
    await this.archiveWhenDone(id, null, { auto: true, waitingFor: commands.length ? describeBackgroundCommands(commands) : null });
    log.info(`[sessions] session ${id} archivée d'office à la fin de son tour`);
    return true;
  },

  /**
   * Écouteur appelé quand le processus d'une session se termine (terminée, arrêtée, en erreur), branché au démarrage
   * (index.ts : tâches « agent arrêté »). Ni les sessions garées par le drainage ni les interrompues (reprises d'office) ne passent ici.
   */
  onEnded(name: string, listener: (end: SessionEnd) => Promise<void> | void): void {
    endedListeners.set(name, listener);
  },

  /** Écouteur qui archive une session (en cascade avec son dossier), branché au démarrage (index.ts : archiveSessionCascade). */
  onArchiveWhenDone(listener: (id: string) => Promise<unknown>): void {
    archiveWhenDoneListener = listener;
  },

  /**
   * Fin propre : l'agent termine son tour en cours, puis la session se termine. `quiet` : fin décidée par le serveur
   * (remise à zéro de la conversation), sans notification de fin.
   */
  async end(id: string, opts: { quiet?: boolean } = {}): Promise<Session> {
    const handle = running.get(id);
    if (handle && opts.quiet) endedForIdle.add(id);
    if (!handle) {
      const elsewhere = (await forwardToHolder(id, 'session.end')) ?? (await endParked(id, 'completed'));
      if (elsewhere) return elsewhere;
    }
    if (!handle && (await sessionRepository.findById(id))?.status === 'queued') return dequeue(id);
    if (!handle) throw new AppError("La session n'est pas en cours d'exécution");
    if (!handle.end) return this.stop(id);
    await handle.end();
    return publishSession(await sessionRepository.findById(id));
  },

  /** Interrompt le tour en cours (l'agent s'arrête et attend une nouvelle instruction). */
  async interrupt(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle) {
      const forwarded = await forwardToHolder(id, 'session.interrupt');
      if (forwarded) return forwarded;
      // Session garée : son tour est fini, il n'y a rien à interrompre.
      const session = await sessionRepository.findById(id);
      if (session?.parkedAt && session.status === 'running') return session;
    }
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
    // Session d'un agent : seulement ses modèles autorisés ; revenir au modèle « par défaut » prend le sien.
    const agentOwner = 'model' in changes ? await agentService.forUser(session.ownerId) : null;
    if (agentOwner) {
      agentService.assertModelAllowed(agentOwner, changes.model);
      const constrained = agentService.constrainModel(agentOwner, config);
      if (constrained) config.model = changes.model = constrained.model;
    }
    getProvider(session.provider).validateConfig?.(config);
    const forwarded = await forwardToHolder(id, 'session.config', { patch });
    if (forwarded) return forwarded;
    const handle = running.get(id);
    // Appliquer d'abord à la session en cours : si le provider refuse, rien n'est enregistré.
    const applied = handle?.updateConfig ? await handle.updateConfig(changes) : [];
    return (await persistConfig(id, changes, applied)) ?? session;
  },

  async stop(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle) {
      const elsewhere = (await forwardToHolder(id, 'session.stop')) ?? (await endParked(id, 'stopped'));
      if (elsewhere) return elsewhere;
    }
    if (!handle && (await sessionRepository.findById(id))?.status === 'queued') return dequeue(id);
    if (!handle) throw new AppError("La session n'est pas en cours d'exécution");
    await publishSession(await sessionRepository.update(id, { status: 'stopped', activity: null, endedAt: new Date() }));
    await requestService.cancelAllForSession(id);
    await handle.stop();
    return publishSession(await sessionRepository.findById(id));
  },

  /**
   * Archive la session : arrêtée si elle tourne, demandes annulées, cachée des listes actives. Tout son
   * historique est conservé ; elle se consulte et se relance depuis l'historique du projet.
   */
  async archive(id: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.archivedAt) return session;
    if (session.status === 'running' || session.status === 'queued') await this.stop(id);
    await finishing.get(id);
    await requestService.cancelAllForSession(id);
    // Secrets saisis « pour cette session seulement » (vault/sessionSecrets.ts) : effacés avec son archivage.
    await sessionSecretService.clearSession(id).catch((err) => log.warn('[sessions] secrets de session non effacés', id, err));
    return publishSession(await sessionRepository.update(id, { archivedAt: new Date() }));
  },

  /**
   * Restaure une session archivée avec son dossier de travail (sa work session, restaurée si elle l'était). Refusé
   * si une autre session y a été ouverte entre-temps (relance, nouvelle session de la tâche) : une work session
   * n'héberge qu'une session active.
   */
  async unarchive(id: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (!session.archivedAt) return session;
    // Dossier supprimé depuis : restaurée, elle resterait active sans pouvoir reprendre.
    assertHasWorksession(session);
    if (session.worksessionId) {
      const other = await activeSuccessorInFolder(session);
      if (other) throw new AppError(`La session « ${other.name} » travaille déjà dans le dossier de cette session : archivez-la d'abord, ou relancez celle-ci`);
      await worksessionService.restore(session.worksessionId);
    }
    return publishSession(await sessionRepository.update(id, { archivedAt: null }));
  },

  /**
   * Libère une work session pour une nouvelle session : ses sessions actives (celle qu'on relance, la précédente
   * session d'une tâche) sont arrêtées et archivées. Une work session n'héberge qu'une session active ; la nouvelle
   * reprend le dossier et la branche. Renvoie les identifiants des sessions archivées.
   */
  async vacateWorksession(worksessionId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const s of await sessionRepository.list({ worksessionId, archived: 'exclude', limit: 50 })) {
      await this.archive(s.id);
      ids.push(s.id);
    }
    return ids;
  },

  /** Nouvelle session qui reprend la conversation d'une session (archivée ou non) comme contexte. */
  async relaunch(id: string, input: RelaunchInput): Promise<Session> {
    const source = await sessionRepository.findById(id);
    if (!source) throw new NotFoundError('Session introuvable');
    const prompt = await relaunchPrompt(source, input.instruction);
    // La nouvelle session reprend le dossier et la branche de la session d'origine (sa work session, libérée de
    // toute session active — l'origine comprise — et restaurée si elle était archivée) ; si ce dossier a été
    // supprimé, une nouvelle work session nommée d'après la session. Un chat relancé reste un chat : sans work session.
    const chat = source.kind === 'chat';
    let worksessionId = chat ? null : (source.worksessionId ?? null);
    if (worksessionId && !(await worksessionService.get(worksessionId).catch(() => null))) worksessionId = null;
    if (worksessionId) {
      await this.vacateWorksession(worksessionId);
      await worksessionService.restore(worksessionId);
    }
    const newWorksession = chat || worksessionId ? null : { label: source.name, name: namesFromText(source.name).name };
    return this.create({
      projectId: source.projectId,
      kind: source.kind,
      worksessionId,
      newWorksession,
      ownerId: input.ownerId ?? null,
      name: input.name?.trim() || source.name,
      provider: source.provider,
      prompt,
      // Relancée par une personne : elle la pilote, la nouvelle session ne se range pas d'office.
      config: withoutAutoArchive(source.config),
      // La session relancée garde la limite de contexte de l'origine (aucune si elle n'en avait pas).
      cleanup: source.cleanup.contextAction === 'compact' || source.cleanup.contextAction === 'reset' ? source.cleanup : {},
    });
  },

  async delete(id: string): Promise<boolean> {
    if (running.has(id)) await this.stop(id);
    // Processus sur une autre instance, ou session garée : arrêtée là où elle est.
    else if ((await sessionRepository.findById(id))?.status === 'running') await this.stop(id).catch(() => undefined);
    // La mise à jour finale du statut (tâche de fond) doit être terminée avant de supprimer la ligne.
    await finishing.get(id);
    const session = await sessionRepository.findById(id);
    if (session) {
      const project = await projectService.get(session.projectId).catch(() => null);
      if (project) await removeSessionAttachments(project, id).catch((err) => log.warn('[sessions] pièces jointes non supprimées', err));
    }
    return sessionRepository.delete(id);
  },

  /**
   * À appeler au démarrage, puis régulièrement par l'instance qui tient les tâches périodiques : les sessions
   * "running" en base dont aucune instance vivante (`liveInstanceIds`) ne tient le processus ne tournent plus.
   * Normalement `shutdown()` les a déjà clôturées ; il en reste après un arrêt brutal (SIGKILL, plantage, délai
   * dépassé). Les sessions d'une autre instance vivante (déploiement bleu/vert) et les sessions garées sont laissées.
   */
  async recoverAfterRestart(liveInstanceIds: string[] = []): Promise<{ sessions: number; requests: number }> {
    const sessions = await sessionRepository.markRunningAsInterrupted(liveInstanceIds);
    for (const session of sessions) {
      await emitEvent(session.id, 'system', {
        message: INTERRUPTION_NOTICES.server_crash,
        notice: true,
        reason: 'server_crash',
        activity: session.activity,
      });
      await emitEvent(session.id, 'status', { status: 'interrupted', activity: session.activity });
      pubSub.publish('sessionUpdated', session);
    }
    const requests = await requestService.expireAllPending(liveInstanceIds);
    return { sessions: sessions.length, requests };
  },

  /**
   * Termine les sessions garées (sans processus depuis le drainage d'une instance) restées sans instruction plus
   * longtemps que le délai d'inactivité, comme `endIdleSessions` le fait pour les sessions de l'instance. Fin
   * silencieuse : seul « Session terminée » apparaît dans le fil.
   */
  async endParkedIdle(now = Date.now()): Promise<string[]> {
    const minutes = serverSettings.current.idleSessionTimeoutMinutes;
    if (!minutes || stopping) return [];
    const ended: string[] = [];
    for (const session of await sessionRepository.listParkedBefore(new Date(now - minutes * 60_000))) {
      if (await endParked(session.id, 'completed')) ended.push(session.id);
    }
    return ended;
  },

  /**
   * Reprise manuelle d'une session interrompue par un redémarrage (bouton « Reprendre ») : si l'agent
   * travaillait, il reprend son tour avec l'instruction de reprise ; sinon aucun tour n'est lancé (rien n'est
   * facturé) : la session passe à « terminée » et le prochain message la relance. Les demandes expirées ne sont pas rejouées.
   */
  async resume(id: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    assertNotArchived(session);
    if (session.status !== 'interrupted') throw new AppError("Seule une session interrompue peut être reprise ainsi : envoyez-lui un message");
    const reason = reasonOf(id);
    if (session.activity !== 'busy') {
      return (await settleIdleInterrupted(id, IDLE_SETTLED_NOTICE, 'manual_resume')) ?? publishSession(await sessionRepository.findById(id));
    }
    await emitEvent(id, 'system', { message: reason.startsWith('runner_') ? "Reprise après la recréation de l'environnement d'exécution" : 'Reprise après le redémarrage du serveur', notice: true, reason: 'manual_resume', activity: session.activity });
    return this.start(id, resumeMessage(reason));
  },

  /**
   * Redémarre la session (bouton « Redémarrer ») : son processus est arrêté puis relancé sur la même conversation,
   * pour prendre en compte ce qui n'est lu qu'au lancement (serveurs MCP, éléments du coffre, fichiers d'environnement,
   * réglages, prompt système). Si l'agent travaillait, son tour est coupé puis repris avec une instruction qui
   * l'explique ; s'il attendait, aucun tour n'est lancé (rien n'est facturé) : la session attend sans processus et le
   * prochain message en démarre un neuf. Une session interrompue est reprise ; une session sans processus (terminée,
   * arrêtée, garée) n'a rien à redémarrer : sa prochaine instruction démarre déjà un processus neuf.
   */
  async restart(id: string, author: InstructionAuthor | null = null): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    assertNotArchived(session);
    if (session.status === 'interrupted') return this.resume(id);
    if (!running.has(id)) {
      const forwarded = await forwardToHolder(id, 'session.restart', { author });
      if (forwarded) return forwarded;
    }
    const handle = running.get(id);
    if (!handle) {
      if (session.status === 'queued') throw new AppError("La session attend une place : elle démarrera avec ses outils à jour");
      if (session.status === 'running' && session.parkedAt) {
        await emitEvent(id, 'system', { message: 'Session redémarrée : sa prochaine instruction relance l\'agent sur la même conversation, avec ses outils à jour.', notice: true, reason: 'restart' });
        return session;
      }
      throw new AppError("La session ne tourne pas : son prochain message la relancera, sur la même conversation et avec ses outils à jour");
    }
    if (restarting.has(id) || endedForIdle.has(id) || archiveWhenDone.has(id) || parking.has(id) || stopping) throw new AppError('La session est déjà en train de se terminer');
    const busy = session.activity === 'busy';
    restarting.add(id);
    try {
      await requestService.cancelAllForSession(id);
      await handle.stop();
      await awaitFinished([id], RESTART_TIMEOUT_MS);
    } catch (err) {
      restarting.delete(id);
      throw err;
    }
    if (running.has(id)) throw new AppError("L'ancien processus de la session ne s'est pas arrêté à temps : réessayez dans quelques secondes");
    await emitEvent(id, 'system', {
      message: busy
        ? "Session redémarrée (même conversation) : l'agent reprend son tour avec ses outils à jour."
        : "Session redémarrée (même conversation) : votre prochain message relance l'agent avec ses outils à jour.",
      notice: true,
      reason: 'restart',
    });
    if (!busy) return publishSession(await sessionRepository.findById(id));
    return this.start(id, RESTART_RESUME_MESSAGE, [], { author });
  },

  /**
   * Interrompt les sessions du projet qui tournent sur ce serveur, avant d'arrêter ou de recréer son
   * environnement d'exécution : leur processus va mourir avec le conteneur, et cette mort ne doit pas
   * passer pour une erreur (« code 137, faute de mémoire »). Même clôture qu'à l'arrêt du serveur :
   * statut « interrupted », activité conservée, demandes expirées. Renvoie les sessions interrompues,
   * à reprendre une fois l'environnement prêt (`resumeAfterRunner`).
   */
  async interruptForRunner(projectId: string, reason: 'runner_reset' | 'runner_stop'): Promise<Session[]> {
    const ids = [...running.keys()].filter((id) => slots.get(id) === projectId);
    const interrupted: Session[] = [];
    for (const id of ids) {
      const session = await interruptSession(id, reason).catch((err) => {
        log.error(`[sessions] interruption de ${id}`, err);
        return null;
      });
      if (session) interrupted.push(session);
    }
    await Promise.all(ids.map((id) => running.get(id)?.stop().catch(() => undefined)));
    await awaitFinished(ids, SHUTDOWN_TIMEOUT_MS);
    return interrupted;
  },

  /**
   * Reprise de toutes les sessions interrompues par `interruptForRunner`, une fois l'environnement
   * recréé : l'agent qui travaillait reprend son tour ; celle qui attendait passe à « terminée » sans tour (le
   * prochain message la relance). Une reprise impossible (limite, maintenance…) laisse la session interrompue, avec
   * l'explication dans son transcript : le bouton « Reprendre » reste disponible.
   */
  async resumeAfterRunner(sessions: Session[]): Promise<string[]> {
    const resumed: string[] = [];
    for (const session of sessions) {
      const reason = reasonOf(session.id);
      try {
        // La fin de l'ancien processus (tué avec le conteneur) doit être traitée avant de relancer : sinon elle
        // retirerait des tables le nouveau processus.
        await awaitFinished([session.id], RESUME_AFTER_RUNNER_TIMEOUT_MS);
        const current = await sessionRepository.findById(session.id);
        if (current?.status !== 'interrupted' || current.archivedAt) continue;
        // Elle attendait des instructions : pas de tour à relancer, le prochain message la reprendra.
        if (session.activity !== 'busy') {
          if (await settleIdleInterrupted(session.id, IDLE_SETTLED_NOTICE, 'auto_resume')) resumed.push(session.id);
          continue;
        }
        await emitEvent(session.id, 'system', { message: "Reprise automatique après la recréation de l'environnement d'exécution", notice: true, reason: 'auto_resume' });
        await this.start(session.id, resumeMessage(reason));
        resumed.push(session.id);
      } catch (err) {
        log.error(`[sessions] reprise de ${session.id} après recréation de l'environnement impossible`, err);
        await emitEvent(session.id, 'system', { message: `Reprise automatique impossible : ${(err as Error).message}`, notice: true, reason: 'auto_resume' }).catch(() => undefined);
      }
    }
    return resumed;
  },

  /**
   * Reprise automatique (réglage du serveur, activé par défaut) : relance les sessions interrompues
   * au milieu d'un tour par l'arrêt récent du serveur, avec une instruction qui explique la coupure.
   * Toutes sont relancées, la plus anciennement coupée d'abord : au-delà de la limite de sessions simultanées,
   * elles attendent dans la file (avec la même instruction de reprise) au lieu de rester interrompues.
   * Les sessions qui attendaient des instructions restent interrompues : un message suffit à les reprendre.
   */
  resumeInterruptedAfterRestart(): Promise<string[]> {
    // Un seul passage à la fois (démarrage, arrêt d'une autre instance, reprise des sessions orphelines).
    resuming ??= this.resumeInterruptedOnce().finally(() => {
      resuming = null;
    });
    return resuming;
  },

  async resumeInterruptedOnce(): Promise<string[]> {
    if (!serverSettings.current.autoResumeInterrupted || drainingInstance) return [];
    const sessions = await sessionRepository.listInterruptedMidTurn(new Date(Date.now() - AUTO_RESUME_WINDOW_MS));
    const resumed: string[] = [];
    for (const session of sessions) {
      try {
        await emitEvent(session.id, 'system', { message: 'Reprise automatique après le redémarrage du serveur', notice: true, reason: 'auto_resume' });
        await this.start(session.id, resumeMessage('server_shutdown'));
        resumed.push(session.id);
      } catch (err) {
        log.error(`[sessions] reprise automatique de ${session.id} impossible`, err);
        await emitEvent(session.id, 'system', { message: `Reprise automatique impossible : ${(err as Error).message}`, notice: true, reason: 'auto_resume' }).catch(() => undefined);
      }
    }
    return resumed;
  },

  /** Places occupées sur cette instance (sessions en cours ou en train de démarrer) : le drainage attend qu'il n'y en ait plus. */
  localCount: () => slots.size,

  /**
   * Drainage de l'instance (déploiement bleu/vert) : plus aucune session ne démarre ici (le démarrage est transmis à
   * l'instance qui la remplace), les sessions qui attendent une instruction sont garées tout de suite, les autres à
   * la fin de leur tour.
   */
  beginDrain(): void {
    if (drainingInstance) return;
    drainingInstance = true;
    for (const id of running.keys()) if (idleSince.has(id)) void park(id);
  },

  /** Sessions actives sur ce serveur (à consulter avant un redémarrage) : au travail et en attente, avec processus. */
  async activeSummary(): Promise<{ active: number; busy: number; idle: number }> {
    const ids = [...running.keys()];
    return { active: ids.length, ...(await sessionRepository.countByActivity(ids)) };
  },

  /** Sessions sans processus mais reprenables : garées, et terminées-reprenables depuis 24 h (voir `countResumable`). */
  resumableSummary: (now = Date.now()) => sessionRepository.countResumable(new Date(now - 24 * 60 * 60 * 1000)),

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
      .catch((err) => log.error("[sessions] file d'attente", err))
      .finally(() => {
        draining = null;
      });
    return draining;
  },

  /**
   * Termine proprement les sessions qui attendent des instructions depuis plus que le délai d'inactivité
   * (réglage du serveur) : leur place et leur mémoire reviennent aux autres. Un message les relance. Fin silencieuse :
   * pas d'avertissement dans le fil, seul « Session terminée » y apparaît (que la session tourne ou non change peu).
   */
  async endIdleSessions(now = Date.now()): Promise<string[]> {
    const minutes = serverSettings.current.idleSessionTimeoutMinutes;
    if (!minutes || stopping) return [];
    const ended: string[] = [];
    for (const [id, since] of idleSince) {
      if (now - since < minutes * 60_000 || !running.has(id) || endedForIdle.has(id)) continue;
      try {
        endedForIdle.add(id);
        await this.end(id);
        ended.push(id);
      } catch (err) {
        endedForIdle.delete(id);
        log.error(`[sessions] arrêt de la session inactive ${id}`, err);
      }
    }
    return ended;
  },

  /**
   * La tâche dont la session est en charge est terminée : une session qui attend des instructions (avec processus, ou
   * garée) se termine tout de suite, sans attendre le délai d'inactivité ; une session au travail se terminera à la fin
   * de son tour. Fin silencieuse (pas de notification) ; sa conversation est conservée et un message la relance.
   * Renvoie ce qui a été fait ('none' : la session ne tourne pas, ou se termine déjà).
   */
  async endForTask(id: string, notice: string): Promise<'ended' | 'deferred' | 'none'> {
    const handle = running.get(id);
    if (!handle) {
      if (instanceRegistry.hasPeers()) {
        const holder = await instanceRegistry.holder((await sessionRepository.findById(id))?.instanceId);
        if (holder) return callInstance<'ended' | 'deferred' | 'none'>(holder, 'session.endForTask', { id, notice });
      }
      const session = await sessionRepository.findById(id);
      if (!session?.parkedAt || session.status !== 'running') return 'none';
      await emitEvent(id, 'system', { message: notice, notice: true, reason: 'task_done' });
      return (await endParked(id, 'completed')) ? 'ended' : 'none';
    }
    if (endedForIdle.has(id) || archiveWhenDone.has(id) || parking.has(id) || stopping) return 'none';
    if (!idleSince.has(id)) {
      endAfterTurn.set(id, notice);
      return 'deferred';
    }
    await emitEvent(id, 'system', { message: notice, notice: true, reason: 'task_done' });
    await this.end(id, { quiet: true });
    return 'ended';
  },

  /** Lance la minuterie de la file d'attente et de l'arrêt des sessions inactives (au démarrage du serveur). */
  startHousekeeping(): void {
    if (housekeeping) return;
    housekeeping = setInterval(() => {
      void this.endIdleSessions()
        .then((ids) => ids.length && log.info(`[sessions] ${ids.length} session(s) inactive(s) terminée(s)`))
        .catch((err) => log.error('[sessions] sessions inactives', err));
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
    const all = [...running.keys()];
    // Fin du drainage (délai dépassé) : les sessions qui attendent une instruction sont garées, pas interrompues.
    if (drainingInstance) for (const id of all) if (idleSince.has(id)) parking.add(id);
    const ids = all.filter((id) => !parking.has(id));
    const work = (async () => {
      const parked = Promise.all(all.filter((id) => parking.has(id)).map((id) => running.get(id)?.stop().catch(() => undefined)));
      await Promise.all(ids.map((id) => interruptSession(id, 'server_shutdown').catch((err) => log.error(`[sessions] interruption de ${id}`, err))));
      await Promise.all(ids.map((id) => running.get(id)?.stop().catch(() => undefined)));
      await parked;
      await Promise.all([...finishing.values()]);
    })();
    await Promise.race([work, delay(SHUTDOWN_TIMEOUT_MS)]);
    return ids.length;
  },
};
