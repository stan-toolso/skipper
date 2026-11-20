import { describeCost } from '../billing/display.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { pubSub } from '../pubsub.js';
import { requestRepository } from '../requests/repository.js';
import { cleanupService } from '../sessions/cleanup.js';
import { sessionRepository } from '../sessions/repository.js';
import { scheduledRuns } from '../sessions/scheduledRuns.js';
import { serverSettings } from '../settings/server.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { claudeSettings } from '../settings/claude.js';
import { projectBudget } from '../projects/budget.js';
import { currentMonthStart } from '../settings/usage.js';
import { capReached, launchRefusal, normalizeBudgetAmount, providerCap, runCap } from './budget.js';
import { CronError, isValidTimeZone, nextRun, nextRuns, parseCron } from './cron.js';
import { RUN_STATUS_LABELS, runOutcome, summarizeEvents } from './outcome.js';
import { forgetScheduleRules } from './activeRules.js';
import { runSessionName, validArchive } from './archive.js';
import { MAX_SCHEDULE_RULES, normalizeRules, suggestionsFromPrompt, suggestionsFromRuns, type PastRun, type ToolSuggestion } from './permissions.js';
import { vaultService } from '../vault/service.js';
import { scheduleRepository } from './repository.js';
import { type CreateScheduleInput, type ScheduleRun, type ScheduleRunStatus, type SessionSchedule, type SessionScheduleInput } from './types.js';
import { log } from '../log.js';
import { systemAuthor } from '../sessions/instructionAuthor.js';

/** Fréquence de vérification des échéances. */
const TICK_MS = 30_000;
/** Une échéance manquée (serveur arrêté) est encore exécutée si elle date de moins de dix minutes ; au-delà, on attend la suivante. */
const MISSED_GRACE_MS = 10 * 60_000;
/** Durée maximale d'attente de la fin d'une exécution avant de conclure. */
const RUN_TIMEOUT_MS = 4 * 3_600_000;
/** Pas de l'attente de fin d'une exécution : entre deux pas, on regarde si l'agent attend un humain. */
const WAIT_STEP_MS = 60_000;
/**
 * Une demande (autorisation, question) restée sans réponse aussi longtemps pendant une exécution planifiée la rend
 * « bloquée » : personne ne surveille une exécution planifiée, on prévient au lieu d'attendre des heures.
 */
const BLOCKED_AFTER_MS = 10 * 60_000;
/** Une exécution encore « en cours » sans suivi local depuis ce délai, session au repos, est close par la reprise. */
const ORPHAN_AFTER_MS = 5 * 60_000;
/** Exécution close « bloquée » ou « délai dépassé » : sa session est archivée (« dès la fin ») après ce silence du transcript. */
const SETTLED_QUIET_MINUTES = 5;
/** Fréquence du balayage de purge des transcripts (durée de conservation). */
const SWEEP_MS = 3_600_000;
const DEFAULT_TIMEZONE = 'UTC';

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let lastSweep = 0;

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

/** Nom affiché d'une planification : le sien, sinon le début de l'instruction. */
export function scheduleLabel(schedule: Pick<SessionSchedule, 'name' | 'prompt'>): string {
  const own = schedule.name?.trim();
  if (own) return own;
  const line = (schedule.prompt.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line ? (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) : 'Planification';
}

function parseOrThrow(cron: string) {
  try {
    return parseCron(cron);
  } catch (err) {
    if (err instanceof CronError) throw new AppError(err.message);
    throw err;
  }
}

/** Titre et type de la notification de fin d'une exécution, selon son issue. */
function notificationOf(status: ScheduleRunStatus, label: string): { type: string; title: string } {
  if (status === 'blocked') return { type: 'schedule.blocked', title: `« ${label} » bloquée : autorisation refusée ou demande sans réponse` };
  if (status === 'failed') return { type: 'schedule.failed', title: `« ${label} » en erreur` };
  if (status === 'timeout') return { type: 'schedule.failed', title: `« ${label} » toujours en cours après le délai d'attente` };
  return { type: 'schedule.run', title: `« ${label} » terminée` };
}

/** Champs de configuration déclarés par un provider (mode d'autorisation, modèle…) ; lève AppError s'il est inconnu. */
async function providerConfigKeys(provider: string): Promise<string[]> {
  // Import tardif : le registre des providers tire tout le moteur des sessions (inutile aux modules qui n'exécutent rien).
  const { getProvider } = await import('../sessions/providers/registry.js');
  try {
    return getProvider(provider).describe().configFields.map((f) => f.key);
  } catch {
    throw new AppError(`Provider inconnu : ${provider}`);
  }
}

/**
 * Réglages du provider d'une planification, gardés seulement pour les champs qu'il déclare (pas de drapeau interne
 * de session) ; une valeur vide retire le réglage (le défaut du projet ou du propriétaire s'applique).
 */
export function pickConfig(config: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = config?.[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/** Archive la session d'une exécution ; une PR encore ouverte de son dossier (ou une erreur) la laisse active. */
async function archiveRunSession(runSessionId: string, reason: string): Promise<boolean> {
  try {
    const session = await sessionRepository.findById(runSessionId);
    if (!session || session.archivedAt) return false;
    await sessionService.archiveWhenDone(runSessionId, reason, { schedule: true });
    return true;
  } catch (err) {
    log.warn(`[schedules] session d'exécution ${runSessionId} non archivée : ${(err as Error).message}`);
    return false;
  }
}

/** Règles d'une planification validées pour l'enregistrement ; undefined : inchangées. */
function validRules(list: string[] | null | undefined): string[] | undefined {
  if (list === undefined || list === null) return undefined;
  const { rules, invalid } = normalizeRules(list);
  if (invalid.length) throw new AppError(`Règle d'autorisation illisible : ${invalid.join(', ')} (forme attendue : Outil ou Outil(motif), ex. Bash(git status *))`);
  if (rules.length > MAX_SCHEDULE_RULES) throw new AppError(`Au plus ${MAX_SCHEDULE_RULES} outils pré-autorisés par planification`);
  return rules;
}

/** Exécutions suivies par cette instance (identifiant d'exécution par session d'exécution). */
const localRuns = new Map<string, string>();

/**
 * Clôt une exécution : historique, compte rendu texte (compatibilité), jalon du transcript, notification.
 * Ne fait rien si l'exécution était déjà close (une seule clôture, donc une seule notification).
 */
async function finish(run: ScheduleRun, session: Session, schedule: SessionSchedule, opts: { stillBusy: boolean; startedAt: number; pendingRequest?: string | null; budgetStop?: string | null }): Promise<ScheduleRun | null> {
  // `session` : celle de l'exécution.
  const id = session.id;
  const scheduleId = schedule.id;
  const events = run.startEventId ? await sessionRepository.listEvents(id, { after: run.startEventId, limit: 2000 }) : [];
  const summary = summarizeEvents(events);
  const outcome = runOutcome(summary, { stillBusy: opts.stillBusy, pendingRequest: opts.pendingRequest ?? null });
  // Plafond de coût atteint : l'exécution est en échec, quelle que soit la façon dont l'agent s'est arrêté.
  const { status, message } = opts.budgetStop ? { status: 'failed' as const, message: opts.budgetStop } : outcome;
  const durationMs = summary.durationMs ?? Date.now() - opts.startedAt;
  const closed = await scheduleRepository.finishRun(run.id, { status, costUsd: summary.cost, durationMs, message, answer: summary.answer });
  forgetScheduleRules(id);
  if (!closed) return null;
  const cost = await describeCost(summary.cost);
  const details = [formatDuration(durationMs), cost].join(' · ');
  await scheduleRepository.setResult(scheduleId, `${RUN_STATUS_LABELS[status]}${message ? ` : ${message}` : ''} · ${details}`);
  await emit(id, 'schedule', { action: 'done', runId: run.id, status, outcome: RUN_STATUS_LABELS[status], message, cost: summary.cost, durationMs, name: schedule.name });
  const label = scheduleLabel(schedule);
  const n = opts.budgetStop ? { type: 'schedule.budget_exceeded', title: `« ${label} » arrêtée : plafond de coût atteint` } : notificationOf(status, label);
  void notificationService.notify({
    ...n,
    message: message ? `${message} · ${details}` : details,
    // Bloquée : la notification ouvre la planification, où l'on pré-autorise les outils refusés.
    link: status === 'blocked' ? `/projects/${session.projectId}/schedules?edit=${scheduleId}` : `/sessions/${id}`,
    projectId: session.projectId,
    sessionId: id,
    payload: { runId: run.id, status, cost: summary.cost, durationMs, ...(status === 'blocked' ? { denied: summary.denied, sessionLink: `/sessions/${id}` } : {}) },
  });
  // « Dès la fin de l'exécution » : sauf demande encore en attente (on la laisse à portée de réponse).
  if (schedule.archivePolicy === 'on_finish' && !opts.pendingRequest && !opts.stillBusy) {
    await archiveRunSession(id, 'exécution terminée');
  }
  return closed;
}

export const scheduleService = {
  get: (id: string) => scheduleRepository.findById(id),
  /** Planification qui a lancé chacune de ces sessions d'exécution. */
  findByRunSessions: (sessionIds: string[]) => scheduleRepository.findByRunSessions(sessionIds),
  listForProjects: (projectIds: string[]) => scheduleRepository.listForProjects(projectIds),
  listRuns: (scheduleId: string, limit?: number) => scheduleRepository.listRuns(scheduleId, limit),
  listRecentRuns: (scheduleIds: string[], perSchedule: number) => scheduleRepository.listRecentRuns(scheduleIds, perSchedule),

  /** Planification existante ; NotFoundError sinon. */
  async require(id: string): Promise<SessionSchedule> {
    const schedule = await scheduleRepository.findById(id);
    if (!schedule) throw new NotFoundError('Planification introuvable');
    return schedule;
  },

  /**
   * Outils à pré-autoriser pour une planification : refusés ou demandés pendant ses dernières exécutions, et
   * éléments du coffre « avec approbation » que cite l'instruction. Sans planification (nouvelle) : seulement ceux
   * de l'instruction.
   */
  async permissionSuggestions(opts: { scheduleId?: string | null; projectId: string; ownerId: string | null; prompt?: string | null; runs?: number }): Promise<ToolSuggestion[]> {
    const past: PastRun[] = [];
    if (opts.scheduleId) {
      const runs = (await scheduleRepository.listRuns(opts.scheduleId, opts.runs ?? 10)).filter((r) => r.startEventId && r.runSessionId);
      for (const run of runs) {
        const [events, requests] = await Promise.all([
          scheduleRepository.runResultEvents(run.runSessionId!, run.startEventId!, run.finishedAt),
          scheduleRepository.runPermissionRequests(run.runSessionId!, run.startedAt, run.finishedAt),
        ]);
        past.push({ startedAt: run.startedAt, events, requests });
      }
    }
    const fromRuns = suggestionsFromRuns(past);
    const prompt = opts.prompt?.trim();
    const items = prompt ? await vaultService.agentItems(opts.projectId, opts.ownerId).catch(() => []) : [];
    const fromPrompt = prompt ? suggestionsFromPrompt(prompt, items).filter((s) => !fromRuns.some((r) => r.rule.toLowerCase() === s.rule.toLowerCase())) : [];
    return [...fromRuns, ...fromPrompt];
  },

  /** Les prochaines échéances d'une expression (aperçu pour l'interface). Lève AppError si l'expression est invalide. */
  preview(cron: string, timezone: string | null | undefined, count = 5): Date[] {
    const tz = timezone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(tz)) throw new AppError(`Fuseau horaire inconnu : ${tz}`);
    return nextRuns(parseOrThrow(cron), new Date(), tz, Math.min(Math.max(count, 1), 20));
  },

  /** Champs communs à la création et à la mise à jour, validés. */
  validate(input: SessionScheduleInput) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new AppError("L'instruction à envoyer à chaque exécution est vide");
    const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) throw new AppError(`Fuseau horaire inconnu : ${timezone}`);
    const spec = parseOrThrow(input.cron);
    const name = input.name === undefined ? undefined : input.name?.trim().slice(0, 120) || null;
    const enabled = input.enabled ?? true;
    let budget: { maxRunUsd?: number | null; monthlyBudgetUsd?: number | null };
    try {
      budget = { maxRunUsd: normalizeBudgetAmount(input.maxRunUsd, 'Plafond par exécution'), monthlyBudgetUsd: normalizeBudgetAmount(input.monthlyBudgetUsd, 'Budget mensuel') };
    } catch (err) {
      throw new AppError((err as Error).message);
    }
    return { prompt, timezone, spec, name, enabled, allowedTools: validRules(input.allowedTools), archive: validArchive(input), budget };
  },

  /**
   * Nouvelle planification d'un projet. Elle ne crée aucune session : chaque exécution (échéance, « Exécuter
   * maintenant », ou tout de suite si `runNow`) lance la sienne, avec ces réglages et ce propriétaire.
   */
  async create(input: CreateScheduleInput, owner: { ownerId: string; requestedById?: string | null }): Promise<SessionSchedule> {
    if (!input.name?.trim()) throw new AppError('Donnez un nom à la planification');
    const v = this.validate(input);
    const provider = input.provider?.trim() || 'claude';
    const config = pickConfig(input.config, await providerConfigKeys(provider));
    const schedule = await scheduleRepository.create({
      projectId: input.projectId,
      ownerId: owner.ownerId,
      requestedById: owner.requestedById ?? null,
      provider,
      config,
      name: v.name ?? null,
      cron: v.spec.source,
      timezone: v.timezone,
      prompt: v.prompt,
      enabled: v.enabled,
      endAfterRun: input.endAfterRun ?? true,
      nextRunAt: v.enabled ? nextRun(v.spec, new Date(), v.timezone) : null,
      allowedTools: v.allowedTools,
      archive: v.archive,
      maxRunUsd: v.budget.maxRunUsd ?? null,
      monthlyBudgetUsd: v.budget.monthlyBudgetUsd ?? null,
    });
    if (input.runNow) await this.run(schedule, { manual: true, userId: owner.requestedById ?? owner.ownerId });
    return schedule;
  },

  /** Modifie une planification. L'échéance est recalculée à partir de maintenant. */
  /** `owner` : nouveau propriétaire des exécutions (personne ou agent, résolu par l'appelant) ; absent : inchangé. */
  async update(id: string, input: SessionScheduleInput, owner?: { ownerId: string; requestedById: string | null }): Promise<SessionSchedule> {
    const existing = await this.require(id);
    const v = this.validate(input);
    // Réglages du provider : fusionnés (une valeur vide retire le réglage).
    const config = input.config ? pickConfig({ ...existing.config, ...input.config }, await providerConfigKeys(existing.provider)) : undefined;
    const schedule = await scheduleRepository.update(id, {
      name: v.name,
      cron: v.spec.source,
      timezone: v.timezone,
      prompt: v.prompt,
      enabled: v.enabled,
      endAfterRun: input.endAfterRun ?? existing.endAfterRun,
      nextRunAt: v.enabled ? nextRun(v.spec, new Date(), v.timezone) : null,
      allowedTools: v.allowedTools,
      archive: v.archive,
      config,
      maxRunUsd: v.budget.maxRunUsd,
      monthlyBudgetUsd: v.budget.monthlyBudgetUsd,
      owner,
    });
    if (!schedule) throw new NotFoundError('Planification introuvable');
    forgetScheduleRules(null);
    return schedule;
  },

  /** Met en pause (plus aucune échéance) ou reprend (échéance recalculée depuis maintenant). */
  async setEnabled(id: string, enabled: boolean): Promise<SessionSchedule> {
    const existing = await this.require(id);
    if (existing.enabled === enabled) return existing;
    const next = enabled ? nextRun(parseOrThrow(existing.cron), new Date(), existing.timezone) : null;
    return (await scheduleRepository.setEnabled(id, enabled, next)) ?? existing;
  },

  /** Supprime la planification et son historique ; les sessions de ses exécutions restent. */
  async remove(id: string): Promise<boolean> {
    return scheduleRepository.delete(id);
  },

  /** Exécution immédiate, hors échéance (la prochaine échéance est inchangée). Renvoie la session de l'exécution. */
  async runNow(id: string, userId: string | null = null): Promise<Session | null> {
    const schedule = await this.require(id);
    const rid = await this.run(schedule, { manual: true, userId });
    return rid ? sessionRepository.findById(rid) : null;
  },

  /**
   * Exécute la planification : crée une nouvelle session (projet, propriétaire, provider et réglages de la
   * planification, dans son propre dossier de travail) et lui envoie l'instruction ; puis, en tâche de fond, attend
   * la fin du tour, termine la session si demandé, notifie avec le coût et applique l'archivage choisi.
   * `manual` : lancée depuis l'interface, les erreurs sont renvoyées à l'appelant. Renvoie la session de l'exécution.
   */
  async run(schedule: SessionSchedule, opts: { manual?: boolean; userId?: string | null; scheduledFor?: Date | null } = {}): Promise<string | null> {
    const manual = Boolean(opts.manual);
    const id = schedule.id;
    const projectId = schedule.projectId;
    const label = scheduleLabel(schedule);
    const editLink = `/projects/${projectId}/schedules?edit=${id}`;
    const runBase = { scheduleId: id, trigger: manual ? ('manual' as const) : ('schedule' as const), triggeredBy: opts.userId ?? null, scheduledFor: opts.scheduledFor ?? null };
    const skip = async (reason: string, type = 'schedule.skipped'): Promise<null> => {
      if (manual) throw new AppError(`Exécution impossible : ${reason}`);
      await scheduleRepository.createRun({ ...runBase, status: 'skipped', message: reason });
      await scheduleRepository.setResult(id, `Ignorée : ${reason}`);
      void notificationService.notify({ type, title: `« ${label} » ignorée`, message: reason, link: editLink, projectId });
      return null;
    };

    if (scheduledRuns.has(id) || (await scheduleRepository.hasRunning(id))) return skip("l'exécution précédente n'est pas terminée");
    if (serverSettings.maintenance) return skip('le serveur est en maintenance');
    // La session de l'exécution démarre avec les identifiants et le plafond du propriétaire de la planification ; pour un
    // agent, ceux du compte Claude qu'une personne lui prête (comme le provider : agentService.accountsForOwner).
    try {
      // Import à la demande : agents/service importe ce module (actions planifiées).
      const { agentService } = await import('../agents/service.js');
      const accounts = await agentService.accountsForOwner(schedule.ownerId);
      const owner = await claudeSettings.forSession(accounts?.claudeUserId ?? null);
      owner.assertCredentials();
      await owner.assertBudgetAvailable();
      await projectBudget.assertAvailable(projectId);
    } catch (err) {
      return skip((err as Error).message);
    }
    // Budget propre à la planification : mensuel au lancement, plafond effectif pendant l'exécution.
    let cap: number | null = null;
    if (schedule.maxRunUsd || schedule.monthlyBudgetUsd) {
      const monthSpent = schedule.monthlyBudgetUsd ? await scheduleRepository.spentSince(id, currentMonthStart()) : 0;
      const amounts = new Map<number, string>();
      for (const usd of [monthSpent, schedule.monthlyBudgetUsd ?? 0]) amounts.set(usd, await describeCost(usd));
      const refusal = launchRefusal(schedule, monthSpent, (usd) => amounts.get(usd) ?? `${usd.toFixed(2)} $`);
      if (refusal) return skip(refusal, 'schedule.budget_exceeded');
      cap = runCap(schedule, monthSpent);
    }

    const startedAt = Date.now();
    scheduledRuns.add(id);
    let run = await scheduleRepository.createRun({ ...runBase, status: 'running' });
    let runSession: Session;
    try {
      const keys = await providerConfigKeys(schedule.provider);
      const runConfig = pickConfig(schedule.config, keys);
      // Le CLI Claude arrête lui-même l'agent au plafond, même au milieu d'un tour.
      const limit = cap !== null && keys.includes('maxBudgetUsd') ? providerCap(runConfig.maxBudgetUsd, cap) : undefined;
      if (limit !== undefined) runConfig.maxBudgetUsd = Number(limit.toFixed(4));
      runSession = await sessionService.create({
        projectId,
        name: runSessionName(label, new Date(startedAt), schedule.timezone),
        provider: schedule.provider,
        config: runConfig,
        newWorksession: {},
        ownerId: schedule.ownerId,
        requestedById: schedule.requestedById,
        autoStart: false,
      });
    } catch (err) {
      scheduledRuns.delete(id);
      const message = `Session de l'exécution non créée : ${(err as Error).message}`;
      await scheduleRepository.finishRun(run.id, { status: 'failed', costUsd: 0, durationMs: Date.now() - startedAt, message });
      await scheduleRepository.setResult(id, `Erreur : ${message}`);
      if (manual) throw new AppError(message);
      void notificationService.notify({ type: 'schedule.failed', title: `« ${label} » en erreur`, message, link: editLink, projectId });
      return null;
    }
    const rid = runSession.id;
    await scheduleRepository.setRunSession(run.id, rid);
    const eventId = await emit(rid, 'schedule', { action: 'run', runId: run.id, cron: schedule.cron, timezone: schedule.timezone, manual, name: label, scheduleId: id });
    await scheduleRepository.setRunStartEvent(run.id, eventId);
    run = { ...run, runSessionId: rid, startEventId: eventId };
    if (manual) await scheduleRepository.markRun(id, new Date());
    await scheduleRepository.setResult(id, 'En cours');
    scheduledRuns.add(rid);
    localRuns.set(rid, run.id);
    forgetScheduleRules(rid);
    // « Archiver l'ancien lors d'un nouveau run » : les sessions des exécutions précédentes sont rangées.
    if (schedule.archivePolicy === 'previous_on_run') {
      for (const previous of await scheduleRepository.activeRunSessions(id, rid)) await archiveRunSession(previous, 'nouvelle exécution de la planification');
    }
    try {
      await sessionService.sendMessage(rid, schedule.prompt, null, { author: systemAuthor(`Planification « ${label} »`) });
    } catch (err) {
      scheduledRuns.delete(id);
      scheduledRuns.delete(rid);
      localRuns.delete(rid);
      const message = (err as Error).message;
      await scheduleRepository.finishRun(run.id, { status: 'failed', costUsd: 0, durationMs: Date.now() - startedAt, message });
      await scheduleRepository.setResult(id, `Erreur : ${message}`);
      if (manual) throw err;
      void notificationService.notify({ type: 'schedule.failed', title: `« ${label} » en erreur`, message, link: `/sessions/${rid}`, projectId, sessionId: rid });
      return rid;
    }

    // Suivi en tâche de fond : fin du tour (ou demande restée sans réponse), fin de session si demandé, compte rendu et notification.
    const tracked = run;
    void (async () => {
      try {
        let current = (await sessionRepository.findById(rid)) ?? runSession;
        let pendingRequest: string | null = null;
        let budgetStop: string | null = null;
        const overCap = async (): Promise<string | null> => {
          if (cap === null) return null;
          const spent = await scheduleRepository.sessionSpent(rid);
          return capReached(spent, cap) ? `plafond de coût atteint (${await describeCost(spent)} pour un plafond de ${await describeCost(cap)})` : null;
        };
        while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
          current = await sessionService.waitForIdle(rid, WAIT_STEP_MS);
          if (current.status !== 'running' || current.activity === 'idle') break;
          // Coût relevé à chaque tour : au plafond, l'exécution est arrêtée (tout provider).
          budgetStop = await overCap();
          if (budgetStop) {
            await sessionService.stop(rid).catch((err) => log.warn(`[schedules] arrêt de l'exécution ${rid} au plafond : ${(err as Error).message}`));
            current = (await sessionRepository.findById(rid)) ?? current;
            break;
          }
          const waiting = (await requestRepository.list({ sessionId: rid, status: 'pending', limit: 1 }))[0];
          if (waiting && Date.now() - waiting.createdAt.getTime() >= BLOCKED_AFTER_MS) {
            // Personne ne répond : l'exécution est notée « bloquée » ; la demande reste ouverte et l'agent repartira si quelqu'un y répond.
            pendingRequest = waiting.title;
            break;
          }
        }
        if (!pendingRequest && current.status === 'running' && current.activity === 'idle' && schedule.endAfterRun) {
          await sessionService.end(rid).catch(() => undefined);
          current = await sessionService.waitForIdle(rid, 60_000);
        }
        // Arrêtée par le CLI au plafond (maxBudgetUsd), ou plafond franchi par le dernier tour.
        budgetStop ??= await overCap();
        const stillBusy = !budgetStop && !pendingRequest && current.status === 'running' && current.activity !== 'idle';
        // Réglages à jour (archivage modifié pendant l'exécution), sinon ceux du lancement.
        await finish(tracked, current, (await scheduleRepository.findById(id)) ?? schedule, { stillBusy, startedAt, pendingRequest, budgetStop });
      } catch (err) {
        log.error("[schedules] suivi de l'exécution", err);
      } finally {
        scheduledRuns.delete(id);
        scheduledRuns.delete(rid);
        if (localRuns.get(rid) === tracked.id) localRuns.delete(rid);
      }
    })();
    return rid;
  },

  /** Archivage « après X temps » : sessions d'exécutions terminées depuis plus que le délai de leur planification. */
  async archiveExpiredRuns(now = new Date()): Promise<number> {
    let archived = 0;
    for (const id of await scheduleRepository.runSessionsPastDelay(now)) {
      if (scheduledRuns.has(id)) continue;
      if (await archiveRunSession(id, 'délai d’archivage de la planification écoulé')) archived += 1;
    }
    // « Dès la fin de l'exécution » : une exécution close « bloquée » (ou « délai dépassé ») n'est pas archivée tout
    // de suite ; quand l'agent a fini après une réponse, sa session est rangée ici (et terminée si elle tourne encore).
    for (const id of await scheduleRepository.settledUnfinishedRunSessions(now, SETTLED_QUIET_MINUTES)) {
      if (scheduledRuns.has(id)) continue;
      if (await archiveRunSession(id, 'exécution terminée après sa clôture')) archived += 1;
    }
    return archived;
  },

  /**
   * Exécutions « en cours » dont le suivi a été perdu (instance arrêtée pendant l'exécution) : celles dont la
   * session est au repos sont closes avec ce que le transcript en dit. La clôture est atomique : si l'instance
   * qui la suit la clôt au même moment, une seule des deux notifie.
   */
  async reconcile(now = new Date()): Promise<number> {
    let closed = 0;
    for (const run of await scheduleRepository.listRunningBefore(new Date(now.getTime() - ORPHAN_AFTER_MS))) {
      const runSessionId = run.runSessionId;
      if (runSessionId && localRuns.get(runSessionId) === run.id) continue;
      const session = runSessionId ? await sessionRepository.findById(runSessionId) : null;
      const schedule = await scheduleRepository.findById(run.scheduleId);
      const settled = !session || (session.status !== 'running' && session.status !== 'queued') || session.activity === 'idle';
      const tooOld = now.getTime() - run.startedAt.getTime() > RUN_TIMEOUT_MS + ORPHAN_AFTER_MS;
      if (!settled && !tooOld) continue;
      if (!session || !schedule) {
        if (await scheduleRepository.finishRun(run.id, { status: 'failed', costUsd: null, durationMs: null, message: 'Planification ou session supprimée pendant l’exécution' })) closed += 1;
        continue;
      }
      if (await finish(run, session, schedule, { stillBusy: !settled, startedAt: run.startedAt.getTime() })) closed += 1;
    }
    return closed;
  },

  /** Un passage de l'ordonnanceur : réserve puis exécute chaque échéance passée. */
  async tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      if (now.getTime() - lastSweep >= SWEEP_MS) {
        lastSweep = now.getTime();
        const swept = await cleanupService.sweep();
        if (swept.deleted) log.info(`[cleanup] ${swept.deleted} événement(s) purgé(s) sur ${swept.sessions} session(s)`);
      }
      await this.reconcile(now).catch((err) => log.error('[schedules] reprise des exécutions orphelines', err));
      await this.archiveExpiredRuns(now).catch((err) => log.error('[schedules] archivage des sessions d’exécution', err));
      for (const due of await scheduleRepository.listDue(now)) {
        if (!due.nextRunAt) continue;
        let next: Date | null = null;
        try {
          next = nextRun(parseCron(due.cron), now, due.timezone);
        } catch (err) {
          log.error(`[schedules] expression invalide pour la planification ${due.id} : ${(err as Error).message}`);
        }
        // Réservation atomique : une seule instance du serveur exécute l'échéance.
        const claimed = await scheduleRepository.claim(due.id, due.nextRunAt, next, now);
        if (!claimed) continue;
        if (now.getTime() - due.nextRunAt.getTime() > MISSED_GRACE_MS) {
          await this.recordMissed(due.id, due.nextRunAt);
          continue;
        }
        await this.run(claimed, { scheduledFor: due.nextRunAt }).catch((err) => log.error('[schedules] exécution', err));
      }
    } finally {
      ticking = false;
    }
  },

  /** Échéance passée pendant un arrêt du serveur : notée « manquée » dans l'historique, non rattrapée. */
  async recordMissed(scheduleId: string, scheduledFor: Date): Promise<void> {
    await scheduleRepository.createRun({ scheduleId, trigger: 'schedule', status: 'missed', scheduledFor, message: 'Serveur arrêté à l’échéance, non rattrapée' });
    await scheduleRepository.setResult(scheduleId, `Échéance du ${scheduledFor.toISOString()} manquée (serveur arrêté), non rattrapée`);
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
        await scheduleRepository.setNextRunAt(s.id, nextRun(parseCron(s.cron), now, s.timezone));
        if (s.nextRunAt) {
          skipped += 1;
          await this.recordMissed(s.id, s.nextRunAt);
        }
      } catch (err) {
        log.error(`[schedules] expression invalide pour la planification ${s.id} : ${(err as Error).message}`);
      }
    }
    void this.archiveLegacyHolders().catch((err) => log.warn(`[schedules] rangement des sessions des anciennes planifications : ${(err as Error).message}`));
    timer = setInterval(() => void this.tick().catch((err) => log.error('[schedules] ordonnanceur', err)), TICK_MS);
    timer.unref?.();
    return skipped;
  },

  /**
   * Sessions qui ne faisaient que porter les réglages d'une planification d'avant (jamais lancées, jamais session
   * d'une exécution) : archivées, la planification porte désormais elle-même ses réglages.
   */
  async archiveLegacyHolders(): Promise<number> {
    const ids = await scheduleRepository.legacyHolderSessions();
    if (!ids.length) return 0;
    const { archiveSessionCascade } = await import('../projects/cleanup.js');
    let archived = 0;
    for (const id of ids) {
      try {
        await archiveSessionCascade(id);
        archived += 1;
      } catch (err) {
        log.warn(`[schedules] session ${id} d'une ancienne planification non archivée : ${(err as Error).message}`);
      }
    }
    if (archived) log.info(`[schedules] ${archived} session(s) qui portaient une planification archivée(s)`);
    return archived;
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
