import { AppError, NotFoundError } from '../errors.js';
import { pubSub } from '../pubsub.js';
import { sessionRepository } from './repository.js';
import { sessionService } from './service.js';
import type { Session, SessionCleanup } from './types.js';

/** Délai maximal d'une compaction de conversation. */
const COMPACT_TIMEOUT_MS = 10 * 60_000;
/** Seuil minimal de contexte acceptable (en tokens) : en dessous, la compaction tournerait en boucle. */
const MIN_CONTEXT_TOKENS = 10_000;

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

/** Valide et normalise des réglages de nettoyage (les champs absents ou null désactivent l'option). */
export function normalizeCleanup(input: SessionCleanup): SessionCleanup {
  const out: SessionCleanup = {};
  if (input.retentionDays !== null && input.retentionDays !== undefined) {
    const days = Number(input.retentionDays);
    if (!Number.isInteger(days) || days < 1) throw new AppError('La durée de conservation du transcript doit être un nombre entier de jours, au moins 1');
    out.retentionDays = days;
  }
  if (input.contextAction) {
    if (input.contextAction !== 'compact' && input.contextAction !== 'reset') throw new AppError("L'action sur la conversation doit être « compact » ou « reset »");
    const max = Number(input.contextMaxTokens);
    if (!Number.isInteger(max) || max < MIN_CONTEXT_TOKENS) throw new AppError(`Le seuil de contexte doit être un nombre entier de tokens, au moins ${MIN_CONTEXT_TOKENS}`);
    out.contextAction = input.contextAction;
    out.contextMaxTokens = max;
  }
  return out;
}

/**
 * Nettoyage automatique de l'historique d'une session : purge du transcript au-delà d'une durée de
 * conservation, et compaction ou remise à zéro de la conversation de l'agent au-delà d'une taille de
 * contexte. Appliqué avant chaque exécution planifiée, par un balayage horaire (purge) et à la demande.
 */
export const cleanupService = {
  async set(id: string, input: SessionCleanup): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
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
   * Avant une instruction : si le contexte de l'agent dépasse le seuil, compacte la conversation
   * (commande /compact, la session est relancée au besoin) ou repart d'une conversation neuve
   * (identifiant de conversation oublié : le prochain démarrage repart de zéro, sans l'historique du modèle).
   * Renvoie l'action faite, ou null.
   */
  async prepareContext(id: string): Promise<'compacted' | 'reset' | null> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    const { contextAction, contextMaxTokens } = session.cleanup;
    if (!contextAction || !contextMaxTokens || session.contextTokens === null || session.contextTokens < contextMaxTokens) return null;
    const before = session.contextTokens;
    if (contextAction === 'reset') {
      if (sessionService.isRunning(id)) {
        await emit(id, { action: 'skipped', reason: 'la session est en cours : la conversation repartira de zéro à son prochain lancement', before });
        return null;
      }
      await sessionRepository.update(id, { externalId: null, contextTokens: null });
      await emit(id, { action: 'reset', before, threshold: contextMaxTokens });
      await publish(id);
      return 'reset';
    }
    if (session.provider !== 'claude') {
      await emit(id, { action: 'skipped', reason: `la compaction n'existe pas pour le provider ${session.provider}`, before });
      return null;
    }
    if (session.status === 'running' && session.activity !== 'idle') {
      await emit(id, { action: 'skipped', reason: "l'agent travaille encore", before });
      return null;
    }
    await emit(id, { action: 'compacting', before, threshold: contextMaxTokens });
    await sessionService.sendMessage(id, '/compact');
    const after = await sessionService.waitForIdle(id, COMPACT_TIMEOUT_MS);
    await emit(id, { action: 'compacted', before, after: after.contextTokens });
    return 'compacted';
  },

  /** Applique tout de suite les réglages de la session (purge, puis conversation). */
  async applyNow(id: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
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
