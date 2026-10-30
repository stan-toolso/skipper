import { AppError, NotFoundError } from '../errors.js';
import { pubSub } from '../pubsub.js';
import { resumeDigest } from './history.js';
import { sessionRepository } from './repository.js';
import { sessionService } from './service.js';
import type { Session, SessionCleanup } from './types.js';

/** Délai maximal d'une compaction de conversation. */
const COMPACT_TIMEOUT_MS = 10 * 60_000;
/** Délai laissé à une session en attente d'instructions pour se terminer avant une remise à zéro. */
const END_TIMEOUT_MS = 60_000;
/** Seuil minimal de contexte acceptable (en tokens) : en dessous, la compaction tournerait en boucle. */
const MIN_CONTEXT_TOKENS = 10_000;
/** Providers qui savent compacter leur conversation (commande /compact). */
const COMPACT_PROVIDERS = new Set(['claude', 'opencode']);

async function emit(sessionId: string, payload: Record<string, unknown>): Promise<void> {
  const event = await sessionRepository.addEvent(sessionId, 'cleanup', payload);
  pubSub.publish('sessionEvent', sessionId, event);
}

async function publish(id: string): Promise<Session> {
  const session = await sessionRepository.findById(id);
  if (!session) throw new NotFoundError('Session introuvable');
  pubSub.publish('sessionUpdated', session);
  return session;
}

async function load(id: string): Promise<Session> {
  const session = await sessionRepository.findById(id);
  if (!session) throw new NotFoundError('Session introuvable');
  return session;
}

/** Valide et normalise des réglages de nettoyage (les champs absents ou null désactivent l'option). */
export function normalizeCleanup(input: SessionCleanup): SessionCleanup {
  const out: SessionCleanup = {};
  if (input.retentionDays !== null && input.retentionDays !== undefined) {
    const days = Number(input.retentionDays);
    if (!Number.isInteger(days) || days < 1) throw new AppError('La durée de conservation du transcript doit être un nombre entier de jours, au moins 1');
    out.retentionDays = days;
  }
  if (input.contextAction === 'fresh') {
    out.contextAction = 'fresh';
  } else if (input.contextAction) {
    if (input.contextAction !== 'compact' && input.contextAction !== 'reset') throw new AppError("L'action sur la conversation doit être « compact », « reset » ou « fresh »");
    const max = Number(input.contextMaxTokens);
    if (!Number.isInteger(max) || max < MIN_CONTEXT_TOKENS) throw new AppError(`Le seuil de contexte doit être un nombre entier de tokens, au moins ${MIN_CONTEXT_TOKENS}`);
    out.contextAction = input.contextAction;
    out.contextMaxTokens = max;
  }
  return out;
}

/**
 * Si la session tourne mais attend des instructions, la termine proprement (la conversation du modèle ne peut
 * être oubliée que session arrêtée). Renvoie l'état obtenu, ou null si l'agent travaille encore.
 */
async function settle(session: Session): Promise<Session | null> {
  // Pas de processus en mémoire : rien à arrêter, quel que soit le statut enregistré.
  if (!sessionService.isRunning(session.id)) return session;
  if (session.activity !== 'idle') return null;
  await sessionService.end(session.id);
  const after = await sessionService.waitForIdle(session.id, END_TIMEOUT_MS);
  return after.status === 'running' || sessionService.isRunning(session.id) ? null : after;
}

/**
 * Oublie la conversation du modèle : le prochain démarrage repart de zéro (le transcript affiché est conservé).
 * `summary` : les derniers échanges accompagneront la première instruction de la conversation neuve.
 */
async function reset(session: Session, extra: Record<string, unknown>, summary: boolean): Promise<Session | null> {
  const settled = await settle(session);
  if (!settled) {
    await emit(session.id, { action: 'skipped', reason: "l'agent travaille encore : la conversation repartira de zéro à son prochain lancement", before: session.contextTokens });
    return null;
  }
  const digest = summary ? await resumeDigest(settled) : null;
  await sessionRepository.update(session.id, { externalId: null, contextTokens: null, resumeDigest: digest });
  await emit(session.id, { action: 'reset', before: session.contextTokens, summary: Boolean(digest), ...extra });
  return publish(session.id);
}

/** Envoie /compact à la session (relancée au besoin) et attend la fin du tour. */
async function compact(session: Session, extra: Record<string, unknown>): Promise<Session | null> {
  const before = session.contextTokens;
  if (!COMPACT_PROVIDERS.has(session.provider)) {
    await emit(session.id, { action: 'skipped', reason: `la compaction n'existe pas pour le provider ${session.provider}`, before });
    return null;
  }
  if (session.status === 'running' && session.activity !== 'idle') {
    await emit(session.id, { action: 'skipped', reason: "l'agent travaille encore", before });
    return null;
  }
  await emit(session.id, { action: 'compacting', before, ...extra });
  await sessionService.sendMessage(session.id, '/compact');
  const after = await sessionService.waitForIdle(session.id, COMPACT_TIMEOUT_MS);
  await emit(session.id, { action: 'compacted', before, after: after.contextTokens });
  return after;
}

/**
 * Nettoyage de l'historique d'une session : purge du transcript au-delà d'une durée de conservation, et
 * compaction ou remise à zéro de la conversation de l'agent (au-delà d'une taille de contexte, ou avant chaque
 * exécution planifiée). Appliqué avant chaque exécution planifiée, par un balayage horaire (purge), à la demande
 * depuis les réglages, et depuis le bandeau de contexte d'une session (compaction ou remise à zéro immédiates).
 */
export const cleanupService = {
  async set(id: string, input: SessionCleanup): Promise<Session> {
    await load(id);
    const cleanup = normalizeCleanup(input);
    await sessionRepository.update(id, { cleanup });
    await emit(id, { action: 'set', ...cleanup });
    return publish(id);
  },

  /** Supprime les événements du transcript plus vieux que la durée de conservation ; renvoie le nombre supprimé. */
  async applyRetention(session: Session): Promise<number> {
    const days = session.cleanup.retentionDays;
    if (!days) return 0;
    const deleted = await sessionRepository.deleteEventsBefore(session.id, new Date(Date.now() - days * 86_400_000));
    if (deleted > 0) await emit(session.id, { action: 'purged', deleted, retentionDays: days });
    return deleted;
  },

  /**
   * Avant une instruction planifiée : selon le réglage, repart d'une conversation neuve à chaque fois (« fresh »),
   * ou, si le contexte dépasse le seuil, compacte la conversation (« compact ») ou l'oublie (« reset »).
   * Renvoie l'action faite, ou null.
   */
  async prepareContext(id: string): Promise<'compacted' | 'reset' | null> {
    const session = await load(id);
    const { contextAction, contextMaxTokens } = session.cleanup;
    if (!contextAction) return null;
    if (contextAction === 'fresh') {
      // Rien à oublier tant que la session n'a jamais tourné (ou vient d'être remise à zéro).
      if (!session.externalId) return null;
      return (await reset(session, { reason: 'fresh' }, false)) ? 'reset' : null;
    }
    if (!contextMaxTokens || session.contextTokens === null || session.contextTokens < contextMaxTokens) return null;
    if (contextAction === 'reset') return (await reset(session, { threshold: contextMaxTokens }, false)) ? 'reset' : null;
    return (await compact(session, { threshold: contextMaxTokens })) ? 'compacted' : null;
  },

  /** Compaction immédiate, demandée depuis l'interface (bandeau de contexte), quel que soit le réglage. */
  async compactNow(id: string): Promise<Session> {
    const session = await load(id);
    if (!COMPACT_PROVIDERS.has(session.provider)) throw new AppError(`La compaction n'existe pas pour le provider ${session.provider}`);
    if (session.status === 'running' && session.activity !== 'idle') throw new AppError("L'agent travaille encore : attendez la fin de son tour");
    if (session.contextTokens === null) throw new AppError("La taille du contexte est inconnue : rien à compacter pour l'instant");
    await compact(session, { manual: true });
    return publish(id);
  },

  /**
   * Remise à zéro immédiate de la conversation, demandée depuis l'interface. Une session qui attend des
   * instructions est d'abord terminée ; l'agent ne doit pas être au travail. `summary` : les derniers échanges
   * seront transmis au modèle avec la prochaine instruction.
   */
  async resetNow(id: string, summary: boolean): Promise<Session> {
    const session = await load(id);
    if (session.status === 'running' && session.activity !== 'idle') throw new AppError("L'agent travaille encore : attendez la fin de son tour");
    if (!session.externalId && !session.contextTokens) throw new AppError("Cette session n'a pas encore de conversation à oublier");
    const result = await reset(session, { manual: true }, summary);
    if (!result) throw new AppError("La session n'a pas pu être arrêtée : réessayez dans quelques instants");
    return result;
  },

  /** Applique tout de suite les réglages de la session (purge, puis conversation). */
  async applyNow(id: string): Promise<Session> {
    const session = await load(id);
    if (!session.cleanup.retentionDays && !session.cleanup.contextAction) throw new AppError("Cette session n'a pas de réglage de nettoyage");
    const deleted = await this.applyRetention(session);
    const action = await this.prepareContext(id);
    if (!deleted && !action) await emit(id, { action: 'nothing' });
    return publish(id);
  },

  /** Balayage périodique : purge du transcript de toutes les sessions qui ont une durée de conservation. */
  async sweep(): Promise<{ sessions: number; deleted: number }> {
    let sessions = 0;
    let deleted = 0;
    for (const session of await sessionRepository.listWithRetention()) {
      try {
        const n = await this.applyRetention(session);
        if (n > 0) {
          sessions += 1;
          deleted += n;
        }
      } catch (err) {
        console.error(`[cleanup] purge de la session ${session.id}`, err);
      }
    }
    return { sessions, deleted };
  },
};
