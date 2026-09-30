import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { pubSub } from '../pubsub.js';
import { sessionRepository } from '../sessions/repository.js';
import { scheduledRuns } from '../sessions/scheduledRuns.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { settingsService } from '../settings/service.js';
import { CronError, isValidTimeZone, nextRun, nextRuns, parseCron } from './cron.js';
import { scheduleRepository } from './repository.js';
import type { SessionSchedule, SessionScheduleInput } from './types.js';

/** Fréquence de vérification des échéances. */
const TICK_MS = 30_000;
/** Une échéance manquée (serveur arrêté) est encore exécutée si elle date de moins de dix minutes ; au-delà, on attend la suivante. */
const MISSED_GRACE_MS = 10 * 60_000;
/** Durée maximale d'attente de la fin d'une exécution avant de conclure. */
const RUN_TIMEOUT_MS = 4 * 3_600_000;
const DEFAULT_TIMEZONE = 'UTC';

let timer: NodeJS.Timeout | null = null;
let ticking = false;

function formatUsd(usd: number): string {
  return `${usd.toFixed(usd < 0.1 ? 3 : 2).replace('.', ',')} $`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function emit(sessionId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  const event = await sessionRepository.addEvent(sessionId, type, payload);
  pubSub.publish('sessionEvent', sessionId, event);
  return event.id;
}

/** Compte rendu d'une exécution : ce que l'agent a consommé depuis l'événement `schedule` qui l'a lancée. */
async function summarizeRun(sessionId: string, afterEventId: string): Promise<{ cost: number; durationMs: number | null; error: string | null }> {
  const events = await sessionRepository.listEvents(sessionId, { after: afterEventId, limit: 2000 });
  let cost = 0;
  let durationMs: number | null = null;
  let error: string | null = null;
  for (const e of events) {
    if (e.type === 'usage' && typeof e.payload.deltaUsd === 'number') cost += e.payload.deltaUsd;
    if (e.type === 'claude.result') {
      if (typeof e.payload.duration_ms === 'number') durationMs = (durationMs ?? 0) + e.payload.duration_ms;
      if (e.payload.is_error) error = Array.isArray(e.payload.errors) && e.payload.errors.length ? e.payload.errors.join(' ; ') : String(e.payload.subtype ?? 'erreur');
    }
    if (e.type === 'status' && e.payload.status === 'failed' && typeof e.payload.error === 'string') error = e.payload.error;
  }
  return { cost, durationMs, error };
}

export const scheduleService = {
  get: (sessionId: string) => scheduleRepository.findBySession(sessionId),

  /** Les prochaines échéances d'une expression (aperçu pour l'interface). Lève AppError si l'expression est invalide. */
  preview(cron: string, timezone: string | null | undefined, count = 5): Date[] {
    const tz = timezone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(tz)) throw new AppError(`Fuseau horaire inconnu : ${tz}`);
    try {
      return nextRuns(parseCron(cron), new Date(), tz, Math.min(Math.max(count, 1), 20));
    } catch (err) {
      if (err instanceof CronError) throw new AppError(err.message);
      throw err;
    }
  },

  /** Crée ou remplace la planification d'une session. L'échéance est calculée à partir de maintenant. */
  async set(sessionId: string, input: SessionScheduleInput): Promise<SessionSchedule> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    const prompt = input.prompt.trim();
    if (!prompt) throw new AppError("L'instruction à envoyer à chaque exécution est vide");
    const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) throw new AppError(`Fuseau horaire inconnu : ${timezone}`);
    let spec;
    try {
      spec = parseCron(input.cron);
    } catch (err) {
      if (err instanceof CronError) throw new AppError(err.message);
      throw err;
    }
    const enabled = input.enabled ?? true;
    const schedule = await scheduleRepository.upsert(sessionId, {
      cron: spec.source,
      timezone,
      prompt,
      enabled,
      endAfterRun: input.endAfterRun ?? true,
      nextRunAt: enabled ? nextRun(spec, new Date(), timezone) : null,
    });
    await emit(sessionId, 'schedule', { action: enabled ? 'set' : 'disabled', cron: schedule.cron, timezone, nextRunAt: schedule.nextRunAt });
    pubSub.publish('sessionUpdated', session);
    return schedule;
  },

  async remove(sessionId: string): Promise<Session> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    if (await scheduleRepository.delete(sessionId)) await emit(sessionId, 'schedule', { action: 'removed' });
    pubSub.publish('sessionUpdated', session);
    return session;
  },

  /** Exécution immédiate, hors échéance (la prochaine échéance est inchangée). */
  async runNow(sessionId: string): Promise<Session> {
    const schedule = await scheduleRepository.findBySession(sessionId);
    if (!schedule) throw new AppError("Cette session n'a pas de planification");
    await this.run(schedule, true);
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    return session;
  },

  /**
   * Exécute la planification : envoie l'instruction à la session (relancée si elle est terminée), puis,
   * en tâche de fond, attend la fin du tour, termine la session si demandé et notifie avec le coût.
   * `manual` : lancée depuis l'interface, les erreurs sont renvoyées à l'appelant.
   */
  async run(schedule: SessionSchedule, manual = false): Promise<void> {
    const id = schedule.sessionId;
    const session = await sessionRepository.findById(id);
    if (!session) return;
    const project = await projectService.get(id ? session.projectId : '').catch(() => null);
    const skip = async (reason: string) => {
      await scheduleRepository.setResult(id, `Ignorée : ${reason}`);
      await emit(id, 'schedule', { action: 'skipped', reason });
      if (manual) throw new AppError(`Exécution impossible : ${reason}`);
      void notificationService.notify({
        type: 'schedule.skipped',
        title: `Exécution planifiée de « ${session.name} » ignorée`,
        message: reason,
        link: `/sessions/${id}`,
        projectId: session.projectId,
        sessionId: id,
      });
    };

    if (session.status === 'running' && session.activity !== 'idle') return skip("l'agent travaillait encore");
    if (scheduledRuns.has(id)) return skip("l'exécution précédente n'est pas terminée");
    if (session.status !== 'running') {
      try {
        await settingsService.assertBudgetAvailable();
      } catch (err) {
        return skip((err as Error).message);
      }
      const runningCount = (await sessionRepository.list({ status: 'running', limit: 200 })).length;
      if (runningCount >= config.maxRunningSessions) return skip(`${runningCount} sessions tournent déjà (limite : ${config.maxRunningSessions})`);
    }

    const startedAt = Date.now();
    const eventId = await emit(id, 'schedule', { action: 'run', cron: schedule.cron, timezone: schedule.timezone, manual });
    scheduledRuns.add(id);
    try {
      await sessionService.sendMessage(id, schedule.prompt);
    } catch (err) {
      scheduledRuns.delete(id);
      const message = (err as Error).message;
      await scheduleRepository.setResult(id, `Erreur : ${message}`);
      if (manual) throw err;
      void notificationService.notify({ type: 'schedule.failed', title: `Exécution planifiée de « ${session.name} » en erreur`, message, link: `/sessions/${id}`, projectId: session.projectId, sessionId: id });
      return;
    }

    // Suivi en tâche de fond : fin du tour, fin de session si demandé, compte rendu et notification.
    void (async () => {
      try {
        let current = await sessionService.waitForIdle(id, RUN_TIMEOUT_MS);
        if (current.status === 'running' && current.activity === 'idle' && schedule.endAfterRun) {
          await sessionService.end(id).catch(() => undefined);
          current = await sessionService.waitForIdle(id, 60_000);
        }
        const { cost, durationMs, error } = await summarizeRun(id, eventId);
        const stillBusy = current.status === 'running' && current.activity !== 'idle';
        const outcome = error ? `Erreur : ${error}` : stillBusy ? "Toujours en cours après le délai d'attente" : 'Terminée';
        const details = [durationMs !== null ? formatDuration(durationMs) : formatDuration(Date.now() - startedAt), formatUsd(cost)].join(' · ');
        await scheduleRepository.setResult(id, `${outcome} · ${details}`);
        await emit(id, 'schedule', { action: 'done', outcome, cost, durationMs });
        void notificationService.notify({
          type: error ? 'schedule.failed' : 'schedule.run',
          title: error ? `Exécution planifiée de « ${session.name} » en erreur` : `Exécution planifiée de « ${session.name} » terminée`,
          message: error ? `${error} · ${details}` : `${details}${project ? ` · ${project.name}` : ''}`,
          link: `/sessions/${id}`,
          projectId: session.projectId,
          sessionId: id,
          payload: { cost, durationMs },
        });
      } catch (err) {
        console.error('[schedules] suivi de l\'exécution', err);
      } finally {
        scheduledRuns.delete(id);
        const fresh = await sessionRepository.findById(id);
        if (fresh) pubSub.publish('sessionUpdated', fresh);
      }
    })();
  },

  /** Un passage de l'ordonnanceur : réserve puis exécute chaque échéance passée. */
  async tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      for (const due of await scheduleRepository.listDue(now)) {
        if (!due.nextRunAt) continue;
        let next: Date | null = null;
        try {
          next = nextRun(parseCron(due.cron), now, due.timezone);
        } catch (err) {
          console.error(`[schedules] expression invalide pour la session ${due.sessionId} : ${(err as Error).message}`);
        }
        // Réservation atomique : une seule instance du serveur exécute l'échéance.
        const claimed = await scheduleRepository.claim(due.sessionId, due.nextRunAt, next, now);
        if (!claimed) continue;
        if (now.getTime() - due.nextRunAt.getTime() > MISSED_GRACE_MS) {
          await scheduleRepository.setResult(due.sessionId, `Échéance du ${due.nextRunAt.toISOString()} manquée (serveur arrêté), non rattrapée`);
          continue;
        }
        await this.run(claimed).catch((err) => console.error('[schedules] exécution', err));
      }
    } finally {
      ticking = false;
    }
  },

  /**
   * Démarrage du serveur : les échéances manquées depuis plus de dix minutes sont recalculées (pas de
   * rattrapage en rafale), puis l'ordonnanceur vérifie les échéances toutes les trente secondes.
   */
  async start(): Promise<number> {
    const now = new Date();
    let skipped = 0;
    for (const s of await scheduleRepository.listEnabled()) {
      if (s.nextRunAt && now.getTime() - s.nextRunAt.getTime() <= MISSED_GRACE_MS) continue;
      try {
        await scheduleRepository.setNextRunAt(s.sessionId, nextRun(parseCron(s.cron), now, s.timezone));
        if (s.nextRunAt) {
          skipped += 1;
          await scheduleRepository.setResult(s.sessionId, `Échéance du ${s.nextRunAt.toISOString()} manquée (serveur arrêté), non rattrapée`);
        }
      } catch (err) {
        console.error(`[schedules] expression invalide pour la session ${s.sessionId} : ${(err as Error).message}`);
      }
    }
    timer = setInterval(() => void this.tick().catch((err) => console.error('[schedules] ordonnanceur', err)), TICK_MS);
    timer.unref?.();
    return skipped;
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
