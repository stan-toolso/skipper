import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentService } from '../agents/service.js';
import { auditService } from '../audit/service.js';
import { createAuthContext, requireProject } from '../auth/access.js';
import { describeCost } from '../billing/display.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { userRepository } from '../users/repository.js';
import type { ProjectRole } from '../users/types.js';
import { RUN_STATUS_LABELS } from './outcome.js';
import { scheduleLabel, scheduleService } from './service.js';
import { SCHEDULE_ARCHIVE_POLICIES, type ScheduleArchivePolicy, type ScheduleRun, type SessionSchedule, type SessionScheduleInput } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Outils libres du serveur `schedules` : lecture seule. Créer, modifier, suspendre, supprimer ou exécuter passe par l'autorisation de la personne. */
export const SCHEDULES_FREE_TOOLS = ['mcp__schedules__list', 'mcp__schedules__get', 'mcp__schedules__runs', 'mcp__schedules__preview'];

/** Paragraphe du prompt système qui présente le serveur `schedules`. */
export function schedulesPromptSummary(): string {
  return "Planifications de sessions (serveur MCP `schedules`) : une planification du projet lance, à chaque échéance d'une expression cron (dans un fuseau), une nouvelle session indépendante qui reçoit son instruction (une session et un dossier de travail par exécution). `list` les liste, `get` en montre le détail et les prochaines échéances, `runs` l'historique de ses exécutions (issue, coût, session), `preview` vérifie une expression cron avant de l'enregistrer. `create` en crée une (nom, cron, instruction autonome et complète, fuseau, modèle, archivage des sessions d'exécution, outils pré-autorisés pour ses exécutions ; `run_now` lance la première tout de suite) : elle appartient au propriétaire de cette session (ses comptes, son budget), ou à l'agent du projet donné par `agent` (ses exécutions tournent alors au nom de l'agent, avec ses comptes). `update` la modifie (seuls les champs donnés changent), `pause` / `resume` la suspendent ou la reprennent, `run_now` l'exécute hors échéance, `delete` la supprime avec son historique (les sessions déjà lancées restent). Ces écritures passent par l'autorisation de la personne : ne crée ou ne modifie une planification que sur demande, et donne son identifiant et sa prochaine échéance dans ta réponse.";
}

export interface SchedulesMcpContext {
  project: Project;
  sessionId: string;
  /** Propriétaire de la session (personne ou agent) : propriétaire des planifications créées. */
  ownerId: string | null;
  /** Personne qui a demandé la session d'un agent (demandeur des planifications qu'il crée). */
  requestedById?: string | null;
  /** Personne dont les droits valent pour la session (celle qui a pris la main, sinon le propriétaire). */
  rightsHolderId: string | null;
}

const ARCHIVE_LABELS: Record<ScheduleArchivePolicy, string> = {
  on_finish: 'dès la fin de chaque exécution',
  previous_on_run: 'les précédentes au lancement d’une nouvelle',
  after_delay: 'après un délai',
  never: 'jamais',
};

const fmt = (d: Date | null | undefined, timezone: string) =>
  d ? d.toLocaleString('fr-FR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Une ligne par planification, identifiant en tête. */
export function scheduleLine(s: SessionSchedule): string {
  const state = s.enabled ? `prochaine ${fmt(s.nextRunAt, s.timezone)}` : 'en pause';
  return `${s.id} · ${scheduleLabel(s)} · ${s.cron} (${s.timezone}) · ${state}${s.lastRunAt ? ` · dernière ${fmt(s.lastRunAt, s.timezone)}` : ''}`;
}

/** Détail d'une planification. */
export function scheduleDetail(s: SessionSchedule, upcoming: Date[] = []): string {
  const model = typeof s.config.model === 'string' ? s.config.model : null;
  const mode = typeof s.config.permissionMode === 'string' ? s.config.permissionMode : null;
  return [
    `${s.id} · ${scheduleLabel(s)}${s.enabled ? '' : ' · en pause'}`,
    `Cron : ${s.cron} (${s.timezone})`,
    s.enabled ? `Prochaines échéances : ${upcoming.length ? upcoming.map((d) => fmt(d, s.timezone)).join(', ') : fmt(s.nextRunAt, s.timezone)}` : 'En pause : aucune échéance',
    `Provider : ${s.provider}${model ? ` · modèle ${model}` : ''}${mode ? ` · autorisations ${mode}` : ''}`,
    `Propriétaire : ${s.ownerId ?? '—'}${s.requestedById ? ` (demandée par ${s.requestedById})` : ''}`,
    `Fin de session après chaque exécution : ${s.endAfterRun ? 'oui' : 'non'}`,
    `Archivage des sessions d'exécution : ${ARCHIVE_LABELS[s.archivePolicy]}${s.archivePolicy === 'after_delay' && s.archiveAfterMinutes ? ` (${s.archiveAfterMinutes} min)` : ''}`,
    `Outils pré-autorisés : ${s.allowedTools.length ? s.allowedTools.join(', ') : 'aucun'}`,
    s.lastResult ? `Dernier résultat : ${s.lastResult}` : null,
    '',
    'Instruction :',
    s.prompt,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

async function runLine(r: ScheduleRun): Promise<string> {
  const parts = [
    r.id,
    r.startedAt.toISOString().slice(0, 16).replace('T', ' '),
    r.trigger === 'manual' ? 'manuelle' : 'échéance',
    RUN_STATUS_LABELS[r.status],
    r.costUsd != null ? await describeCost(r.costUsd) : '',
    r.durationMs != null ? `${Math.round(r.durationMs / 1000)} s` : '',
    r.runSessionId ? `session ${r.runSessionId}` : '',
    r.message ?? '',
  ];
  return parts.filter(Boolean).join(' · ');
}

const archiveParam = z.enum(SCHEDULE_ARCHIVE_POLICIES as [ScheduleArchivePolicy, ...ScheduleArchivePolicy[]]);

/** Champs modifiables communs à create et update. */
const editable = {
  name: z.string().optional().describe('Nom de la planification (« Revue quotidienne »)'),
  cron: z.string().optional().describe('Expression cron à cinq champs (minute heure jour mois jour-de-semaine) ou alias (@daily, @hourly…), ex. "0 8 * * 1-5"'),
  timezone: z.string().optional().describe('Fuseau IANA de l’expression, ex. Europe/Paris (défaut : UTC)'),
  prompt: z.string().optional().describe('Instruction envoyée à la session de chaque exécution : autonome et complète (la session ne voit pas cette conversation)'),
  model: z.string().optional().describe('Modèle des sessions d’exécution (ex. claude-sonnet-5-5) ; chaîne vide : modèle par défaut du propriétaire'),
  permission_mode: z.string().optional().describe('Mode d’autorisation des sessions d’exécution (default, acceptEdits, bypassPermissions, dontAsk…) ; chaîne vide : défaut'),
  end_after_run: z.boolean().optional().describe('Terminer la session à la fin de chaque exécution (défaut : oui)'),
  archive_policy: archiveParam.optional().describe('Archivage des sessions d’exécution : on_finish, previous_on_run (défaut), after_delay, never'),
  archive_after_minutes: z.number().int().min(1).optional().describe('Délai en minutes pour after_delay'),
  allowed_tools: z.array(z.string()).optional().describe('Outils pré-autorisés pour les seules exécutions, au format Claude Code (ex. "Bash(git status *)", "mcp__vault__sql_query(base)") ; remplace la liste'),
};

type Editable = { [K in keyof typeof editable]?: z.infer<(typeof editable)[K]> };

/** Réglages du provider fournis par l'outil (absent : inchangés ; vide : retiré). */
function configOf(args: Editable): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (args.model !== undefined) config.model = args.model.trim();
  if (args.permission_mode !== undefined) config.permissionMode = args.permission_mode.trim();
  return Object.keys(config).length ? config : undefined;
}

/** Entrée du service : les champs donnés, les autres repris de la planification existante (update) ou absents. */
export function scheduleInput(args: Editable, existing?: SessionSchedule): SessionScheduleInput {
  const cron = args.cron ?? existing?.cron;
  const prompt = args.prompt ?? existing?.prompt;
  if (!cron?.trim()) throw new AppError('Expression cron manquante (paramètre cron)');
  if (!prompt?.trim()) throw new AppError('Instruction manquante (paramètre prompt)');
  return {
    cron,
    prompt,
    timezone: args.timezone ?? existing?.timezone ?? null,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(existing ? { enabled: existing.enabled } : {}),
    ...(args.end_after_run !== undefined ? { endAfterRun: args.end_after_run } : {}),
    // Un délai seul garde la politique en place (il ne vaut que pour after_delay).
    ...(args.archive_policy !== undefined || args.archive_after_minutes !== undefined ? { archivePolicy: args.archive_policy ?? existing?.archivePolicy ?? 'after_delay' } : {}),
    ...(args.archive_after_minutes !== undefined ? { archiveAfterMinutes: args.archive_after_minutes } : {}),
    ...(args.allowed_tools !== undefined ? { allowedTools: args.allowed_tools } : {}),
    ...(configOf(args) ? { config: configOf(args) } : {}),
  };
}

/**
 * Serveur MCP in-process `schedules` : planifications de sessions du projet de la session, avec les droits de la
 * personne (ou de l'agent) qui la pilote — mêmes règles que l'interface (lecteur pour lire, membre pour écrire).
 */
export function createSchedulesMcpServer(ctx: SchedulesMcpContext): McpSdkServerConfigWithInstance {
  const { project, sessionId } = ctx;
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const requireRole = async (min: ProjectRole) => {
    if (!ctx.rightsHolderId) throw new AppError('Session sans propriétaire : planifications indisponibles');
    const user = await userRepository.findById(ctx.rightsHolderId);
    if (!user) throw new AppError('Propriétaire de la session introuvable');
    await requireProject(createAuthContext(user), project.id, min);
  };
  /** Planification du projet de la session ; refusée si elle appartient à un autre projet. */
  const scheduleOf = async (id: string) => {
    const schedule = await scheduleService.get(id);
    if (!schedule || schedule.projectId !== project.id) throw new AppError(`Planification ${id} introuvable dans ce projet`);
    return schedule;
  };
  /** Agent du projet propriétaire des exécutions ; la personne qui pilote cette session en devient la demandeuse. */
  const agentOwner = async (ref: string) => {
    const agent = await agentService.resolve(project.id, ref);
    return { ownerId: agent.id, requestedById: ctx.requestedById ?? (ctx.rightsHolderId !== agent.id ? ctx.rightsHolderId : null) };
  };
  const audit = (action: string, s: SessionSchedule, details?: Record<string, unknown>) =>
    auditService.record({ projectId: project.id, actor: { sessionId }, action, targetType: 'schedule', targetId: s.id, targetLabel: scheduleLabel(s), details });
  const upcoming = (s: SessionSchedule) => (s.enabled ? scheduleService.preview(s.cron, s.timezone, 3) : []);

  return createSdkMcpServer({
    name: 'schedules',
    version: '1.0.0',
    tools: [
      tool('list', `Liste les planifications de sessions du projet "${project.name}" (une ligne par planification : id, nom, cron, prochaine échéance ou pause).`, {}, async () =>
        run(async () => {
          await requireRole('viewer');
          const list = await scheduleService.listForProjects([project.id]);
          if (!list.length) return 'Aucune planification dans ce projet. `create` pour en créer une.';
          return [...list.map(scheduleLine), '', '`get` pour le détail, `runs` pour l’historique.'].join('\n');
        }),
      ),
      tool('get', "Détail d'une planification : réglages, prochaines échéances, outils pré-autorisés, instruction.", { id: z.string().describe('Identifiant de la planification') }, async ({ id }) =>
        run(async () => {
          await requireRole('viewer');
          const s = await scheduleOf(id);
          return scheduleDetail(s, upcoming(s));
        }),
      ),
      tool(
        'runs',
        "Historique des exécutions d'une planification, les plus récentes d'abord (date, déclencheur, issue, coût, durée, session d'exécution, message).",
        { id: z.string().describe('Identifiant de la planification'), limit: z.number().int().min(1).max(50).optional().describe('Nombre d’exécutions (défaut 10)') },
        async ({ id, limit }) =>
          run(async () => {
            await requireRole('viewer');
            const s = await scheduleOf(id);
            const runs = await scheduleService.listRuns(s.id, limit ?? 10);
            if (!runs.length) return `Aucune exécution pour « ${scheduleLabel(s)} ».`;
            return (await Promise.all(runs.map(runLine))).join('\n');
          }),
      ),
      tool(
        'preview',
        "Prochaines échéances d'une expression cron (vérifie l'expression et le fuseau avant create ou update).",
        { cron: z.string().describe('Expression cron'), timezone: z.string().optional().describe('Fuseau IANA, ex. Europe/Paris (défaut : UTC)'), count: z.number().int().min(1).max(20).optional() },
        async ({ cron, timezone, count }) =>
          run(async () => {
            const tz = timezone?.trim() || 'UTC';
            return scheduleService
              .preview(cron, tz, count ?? 5)
              .map((d) => fmt(d, tz))
              .join('\n');
          }),
      ),
      tool(
        'create',
        "Crée une planification du projet : à chaque échéance, une nouvelle session reçoit l'instruction. Propriétaire : le propriétaire de cette session (ses comptes, son budget), ou l'agent du projet donné par `agent`.",
        {
          ...editable,
          agent: z.string().optional().describe("Agent du projet (nom ou identifiant) au nom duquel lancer les exécutions : ses comptes, son budget, ses règles ; absent : le propriétaire de cette session"),
          name: z.string().describe('Nom de la planification (« Revue quotidienne »)'),
          cron: editable.cron.unwrap(),
          prompt: editable.prompt.unwrap(),
          paused: z.boolean().optional().describe('Créer en pause (défaut : active)'),
          run_now: z.boolean().optional().describe('Lancer une première exécution tout de suite'),
        },
        async (args) =>
          run(async () => {
            await requireRole('member');
            if (!ctx.ownerId) throw new AppError('Session sans propriétaire : impossible de créer une planification');
            const input = { ...scheduleInput(args), name: args.name, enabled: !args.paused, projectId: project.id, provider: 'claude', runNow: args.run_now ?? false };
            const owner = args.agent?.trim() ? await agentOwner(args.agent) : { ownerId: ctx.ownerId, requestedById: ctx.requestedById ?? null };
            const s = await scheduleService.create(input, owner);
            await audit('schedule.create', s, { cron: s.cron, timezone: s.timezone, enabled: s.enabled });
            return [`Planification créée.`, scheduleDetail(s, upcoming(s))].join('\n');
          }),
      ),
      tool(
        'update',
        "Modifie une planification : seuls les champs donnés changent (l'échéance suivante est recalculée depuis maintenant).",
        {
          id: z.string().describe('Identifiant de la planification'),
          ...editable,
          agent: z.string().optional().describe("Lance désormais les exécutions au nom de cet agent du projet (nom ou identifiant) ; chaîne vide : au nom de la personne qui pilote cette session ; absent : propriétaire inchangé"),
        },
        async ({ id, agent, ...args }) =>
          run(async () => {
            await requireRole('member');
            const existing = await scheduleOf(id);
            const input = scheduleInput(args, existing);
            const person = ctx.requestedById ?? ctx.rightsHolderId;
            const owner = agent === undefined ? undefined : agent.trim() ? await agentOwner(agent) : person ? { ownerId: person, requestedById: null } : undefined;
            const s = await scheduleService.update(id, input, owner);
            await audit('schedule.set', s, { fields: [...Object.keys(args).filter((k) => args[k as keyof typeof args] !== undefined), ...(owner ? ['owner'] : [])] });
            return [`Planification modifiée.`, scheduleDetail(s, upcoming(s))].join('\n');
          }),
      ),
      tool('pause', 'Met une planification en pause (plus aucune échéance, réglages et historique conservés).', { id: z.string() }, async ({ id }) =>
        run(async () => {
          await requireRole('member');
          await scheduleOf(id);
          const s = await scheduleService.setEnabled(id, false);
          await audit('schedule.enable', s, { enabled: false });
          return `${scheduleLine(s)}\nPlanification en pause.`;
        }),
      ),
      tool('resume', 'Reprend une planification en pause (prochaine échéance calculée depuis maintenant).', { id: z.string() }, async ({ id }) =>
        run(async () => {
          await requireRole('member');
          await scheduleOf(id);
          const s = await scheduleService.setEnabled(id, true);
          await audit('schedule.enable', s, { enabled: true });
          return `${scheduleLine(s)}\nPlanification reprise.`;
        }),
      ),
      tool('run_now', "Exécute une planification tout de suite, hors échéance (nouvelle session ; la prochaine échéance ne change pas). Renvoie la session lancée.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          await requireRole('member');
          const s = await scheduleOf(id);
          const session = await scheduleService.runNow(id, ctx.requestedById ?? ctx.rightsHolderId);
          await audit('schedule.run', s);
          return session ? `Exécution lancée : session ${session.id} (« ${session.name} »).` : "Exécution non lancée (exécution précédente en cours, budget ou identifiants) : voir `runs`.";
        }),
      ),
      tool('delete', "Supprime une planification et son historique d'exécutions (les sessions déjà lancées restent).", { id: z.string() }, async ({ id }) =>
        run(async () => {
          await requireRole('member');
          const s = await scheduleOf(id);
          await scheduleService.remove(id);
          await audit('schedule.clear', s);
          return `Planification « ${scheduleLabel(s)} » supprimée.`;
        }),
      ),
    ],
  });
}
