import { withAudit } from '../audit/mutations.js';
import { withCtoTime } from '../billing/ctoTime.js';
import { auditService } from '../audit/service.js';
import { actionLabel, targetTypeLabel } from '../audit/labels.js';
import { parseAuditFilter, type AuditEntry, type RawAuditFilter } from '../audit/types.js';
import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { accessibleProjectIds, canAccessProject, filterAsync, isGuestOn, memberRoleFor, requireAdmin, requireProject, requireSuperAdmin, requireUser, roleFor, settingsUser, type AuthContext } from '../auth/access.js';
import { guardTypeForGuests } from './guestFields.js';
import { agentService } from '../agents/service.js';
import type { Agent, AgentAccountKind, AgentAction, AgentActionInput, AgentInput, AgentKind, AgentManager, AgentManagerRole, AgentTemplate } from '../agents/types.js';
import { slugify } from '../projects/slug.js';
import { liveBrowserService } from '../browser/live.js';
import { liveDraftService } from '../sessions/live.js';
import { createLoaders, type Loaders } from './loaders.js';
import { apiKeyService } from '../apiKeys/service.js';
import { inboundRepository, type InboundEvent } from '../inbound/repository.js';
import { chromeBrowserService } from '../chrome/service.js';
import { contextService, HUMAN } from '../context/service.js';
import { accountOf, googleAccountService } from '../google/service.js';
import { pushPreferencesService } from '../notifications/preferences.js';
import { pushService, type PushSubscriptionInput } from '../notifications/push.js';
import { notificationChannelService, type ChannelInput, type ChannelPatch } from '../notifications/channels.js';
import { mailService, type MailInput } from '../notifications/mail.js';
import { searchService, type SearchKind } from '../search/service.js';
import { sharedPageCommentService } from '../sharedPages/commentService.js';
import { sharedPageService } from '../sharedPages/service.js';
import { artifactDataService } from '../sharedPages/dataService.js';
import { alertService } from '../sharedPages/alertService.js';
import { describeCondition, type DataAlert } from '../sharedPages/alerts.js';
import type { AgentSourceConfig, DataSource, GraphqlSourceConfig, ScriptSourceConfig, SqlSourceConfig } from '../sharedPages/dataSources.js';
import { sharedPageUpdateService } from '../sharedPages/updateRequest.js';
import { envFileService } from '../envFiles/service.js';
import type { EnvFile } from '../envFiles/types.js';
import type { SharedPage, SharedPageComment, SharedPageMember, SharedPageVersion } from '../sharedPages/types.js';
import { readRawFile } from '../files/service.js';
import { fingerprint } from '../vault/ssh.js';
import { isOauthToken, vaultService, type VaultItemWithPermission } from '../vault/service.js';
import { awsService } from '../vault/awsService.js';
import type { ApiSettings, AwsSettings, LangfuseSettings, LitellmSettings, PostgresSettings, ProjectVaultRow, ScalewaySettings, SecretSettings, SshSettings, TokenSettings, VaultAuditEvent, VaultItem, VaultItemInput, VaultItemKind, VaultLink, VaultLinkScope, VaultPermission, VaultShare, WebsiteSettings } from '../vault/types.js';
import { variableName } from '../vault/website.js';
import { billingService } from '../billing/service.js';
import type { BillingSettings, CtoTimeEntry, CtoTimeEntryInput } from '../billing/types.js';
import { applyCostConversion, costDisplay, costRate, toStoredUsd } from '../billing/display.js';
import { dashboardService } from '../dashboard/service.js';
import { projectBudget } from '../projects/budget.js';
import { usageReport } from '../usage/report.js';
import { inboxService } from '../inbox/service.js';
import { AppError, NotFoundError } from '../errors.js';
import { fileService, type WorkspaceRef } from '../files/service.js';
import { parseRepoFullName, pullRequestService, type MergeCleanup, type MergeMethod, type PullRequest, type PullRequestFilter } from '../git/pullRequests.js';
import { foreignRepoOf, projectRepoName, trackedPullRequestService } from '../pullRequests/service.js';
import { pullRequestSession, requestConflictResolution } from '../pullRequests/conflicts.js';
import { deliveryService } from '../deliveries/service.js';
import { deliveryQualityService, type QualityReport, type QualitySettings } from '../deliveries/qualityService.js';
import type { DeliveryTaskLink } from '../deliveries/qualityRepository.js';
import type { Delivery, DeployConfig, DeployConfigInput } from '../deliveries/types.js';
import { deliveryPolicyService } from '../deliveries/autoMerge.js';
import type { DeliveryPolicy, DeliveryPolicyRule } from '../deliveries/policy.js';
import { ciVerdict } from '../git/pullRequests.js';
import { requestGitConflictResolution } from '../git/conflicts.js';
import { reviewService } from '../reviews/service.js';
import { reviewOf, type SessionReview } from '../reviews/types.js';
import { stageOf, type PullRequestStage, type TrackedPullRequest, type TrackedPullRequestStatus } from '../pullRequests/types.js';
import { config } from '../config.js';
import { gitService } from '../git/service.js';
import { repoBrowser, type RepoEntry, type RepoRef } from '../gitServer/browse.js';
import { gitServer } from '../gitServer/service.js';
import type { GitBackup } from '../gitServer/backups.js';
import { archiveSessionCascade, archiveWorksessionCascade, deleteProjectCascade, deleteSessionCascade, deleteWorksessionCascade, restoreWorksessionCascade } from '../projects/cleanup.js';
import { importProjectArchive, MAX_IMPORT_BYTES } from '../exports/service.js';
import { sessionShareService, type SessionShare } from '../sessionShares/service.js';
import { runner, type RunnerConfig } from '../runners/index.js';
import { containerMonitor } from '../runners/monitor.js';
import { runnerLifecycle } from '../runners/lifecycle.js';
import { checkBrowser } from '../browser/check.js';
import type { ContextChange, ContextInstruction, ContextInstructionVersion } from '../context/types.js';
import { projectService } from '../projects/service.js';
import { isPersonalProject } from '../projects/types.js';
import { personalService } from '../personal/service.js';
import type { CreateProjectInput, Project, UpdateProjectInput } from '../projects/types.js';
import { workspaceExists, workspaceGitInfo, workspacePath } from '../projects/workspace.js';
import { notificationService } from '../notifications/service.js';
import { rateLimitView } from '../settings/rateLimits.js';
import type { Notification } from '../notifications/types.js';
import { pubSub } from '../pubsub.js';
import { requestService } from '../requests/service.js';
import { APPROVAL, approvalService } from '../approvals/service.js';
import { provideSecrets, SECRETS_REQUEST } from '../vault/secretRequests.js';
import type { HumanRequest, RequestStatus } from '../requests/types.js';
import { listProviders } from '../sessions/providers/registry.js';
import { publicAttachment } from '../sessions/attachments.js';
import { sessionService } from '../sessions/service.js';
import { sessionChangesService, type SessionChanges } from '../sessions/changes.js';
import { loginService } from '../settings/login.js';
import { githubService } from '../settings/github.js';
import { githubDeviceAvailable, githubDeviceService } from '../settings/githubDevice.js';
import { gitlabService } from '../settings/gitlab.js';
import { gitlabDevice, gitlabDeviceService } from '../settings/gitlabDevice.js';
import { claudeSettings, type ClaudeSettingsPatch } from '../settings/claude.js';
import { cellClaude } from '../settings/cellClaude.js';
import { onboardingService } from '../settings/onboarding.js';
import { opencodeProviders, opencodeSettings, type OpencodeSettingsPatch } from '../settings/opencode.js';
import { workflowService } from '../workflows/service.js';
import { workflowVariables } from '../workflows/graph.js';
import type { AutomationScheduleInput, RunStatus, RunTrigger, Workflow, WorkflowInput, WorkflowRun, WorkflowRunNode } from '../workflows/types.js';
import { TOKEN_SERVICES, TOKEN_SERVICE_IDS, tokenServiceLabel } from '../vault/tokens.js';
import { serverSettings } from '../settings/server.js';
import { sessionRepository } from '../sessions/repository.js';
import { healthService } from '../health/service.js';
import type { ClaudeAuthMode } from '../settings/types.js';
import { currentMonthStart, usageService } from '../settings/usage.js';
import { scheduleLabel, scheduleService } from '../schedules/service.js';
import { cleanupService } from '../sessions/cleanup.js';
import { CONTEXT_WARN_TOKENS, contextEstimate, contextLedger } from '../sessions/context.js';
import type { SessionCleanup } from '../sessions/types.js';
import { terminalService } from '../terminals/service.js';
import { worksessionPath, worksessionService } from '../worksessions/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { worksessionDisk, type WorksessionDiskEntry } from '../worksessions/disk.js';
import { worksessionLabel, type Worksession } from '../worksessions/types.js';
import { resumableTaskSession, resumeTaskSession, startTaskSession } from '../tasks/launch.js';
import { taskService } from '../tasks/service.js';
import { conversationService } from '../conversations/service.js';
import type { Conversation, Message, MessageAttachment, MessageReaction } from '../conversations/types.js';
import type { Task, TaskComment, TaskField, TaskPersonInput, TaskPriority, TaskReaction, TaskStatus, ProjectApiKey } from '../tasks/types.js';
import type { TerminalRecord } from '../terminals/types.js';
import type { AttachmentInput, CreateSessionInput, RelaunchInput, Session, SessionStatus } from '../sessions/types.js';
import type { OpenItems, User } from '../users/types.js';
import { permissionRuleService } from '../permissions/service.js';
import { formatRule, type PermissionRule } from '../permissions/types.js';
import type { CreateScheduleInput, ScheduleRun, SessionSchedule, SessionScheduleInput } from '../schedules/types.js';
import { scheduleRepository } from '../schedules/repository.js';
import { userService } from '../users/service.js';
import { cleanInviteMessage, sendProjectGuestInvitation } from '../users/invitations.js';
import { userRepository } from '../users/repository.js';
import { cockpitService } from '../cockpit/service.js';
import { projectPageService } from '../cockpit/projectPages.js';
import type { ResolvedLayout } from '../cockpit/types.js';
import { signInService } from '../auth/signInService.js';
import type { ProjectMember, ProjectRole } from '../users/types.js';
import { log } from '../log.js';
import { previewService } from '../previews/service.js';
import { personAuthor } from '../sessions/instructionAuthor.js';

type Ctx = AuthContext;
/** Message d'un canal enrichi par le résolveur de la liste : ses réactions et ses réponses, lues en une fois. */
type MessageWithRows = Message & { reactionRows?: MessageReaction[]; attachmentRows?: MessageAttachment[]; replyStat?: { count: number; lastAt: Date | null } | null; authorRole?: ProjectRole | null };
type GqlRole = Uppercase<ProjectRole>;
/** L'agent de triage d'une clé d'API doit être un agent actif du projet. */
async function assertProjectAgent(projectId: string, agentId: string): Promise<void> {
  const agent = await agentService.get(agentId).catch(() => null);
  if (!agent || agent.projectId !== projectId || agent.archivedAt) throw new AppError("L'agent de triage doit être un agent du projet");
}

const fromGqlRole = (r?: GqlRole | null): ProjectRole => ((r ?? 'MEMBER').toLowerCase() as ProjectRole);

// ---- Accès : rôle minimal requis sur le projet auquel appartient l'objet visé -------------------
const projectOfSession = async (id: string) => {
  const session = await sessionService.get(id);
  if (!session) throw new NotFoundError('Session introuvable');
  return session.projectId;
};
const projectOfRequest = async (id: string) => projectOfSession((await requestService.get(id)).sessionId);
const loadSession = async (id: string) => {
  const session = await sessionService.get(id);
  if (!session) throw new NotFoundError('Session introuvable');
  return session;
};
const guardSession = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, await projectOfSession(id), min);

/** Parent des champs de `SessionContext` : la session, et le modèle résolu paresseusement (une requête au plus). */
interface ContextParent {
  session: Session;
  ledger?: Promise<{ model: string | null; billable: boolean }>;
}
const ledgerOfContext = (p: ContextParent) => (p.ledger ??= contextLedger(p.session).catch(() => ({ model: null, billable: true })));
const modelOfContext = async (p: ContextParent) => (await ledgerOfContext(p)).model;
/**
 * Seuil de signalement du contexte de la personne connectée (réglages Claude), lu une fois par requête quel que soit
 * le nombre de sessions listées ; seuil par défaut sans personne connectée ou si la lecture échoue.
 */
const warnTokensByCtx = new WeakMap<Ctx, Promise<number | null>>();
const warnTokensOf = (ctx: Ctx): Promise<number | null> => {
  let pending = warnTokensByCtx.get(ctx);
  if (!pending) {
    pending = ctx.user
      ? claudeSettings
          .forUser(ctx.user.id)
          .then((s) => s.settings.contextWarnTokens)
          .catch(() => CONTEXT_WARN_TOKENS)
      : Promise.resolve(CONTEXT_WARN_TOKENS);
    warnTokensByCtx.set(ctx, pending);
  }
  return pending;
};
/**
 * Modèle par défaut du propriétaire d'une session (réglages Claude du compte qui la sert : celui de la personne, ou le
 * compte prêté à un agent), lu une fois par propriétaire et par requête : la sidebar en affiche une liste.
 */
const ownerModelByCtx = new WeakMap<Ctx, Map<string, Promise<string | null>>>();
const ownerDefaultModelOf = (ctx: Ctx, ownerId: string): Promise<string | null> => {
  let byOwner = ownerModelByCtx.get(ctx);
  if (!byOwner) ownerModelByCtx.set(ctx, (byOwner = new Map()));
  let pending = byOwner.get(ownerId);
  if (!pending) {
    pending = agentService
      .accountsForOwner(ownerId)
      .then((acc) => (acc?.claudeUserId ? claudeSettings.forUser(acc.claudeUserId).then((s) => s.settings.defaultModel ?? null) : null))
      .catch(() => null);
    byOwner.set(ownerId, pending);
  }
  return pending;
};
/** Canal de notification : son propriétaire pour un canal personnel, un administrateur du projet sinon. */
const guardNotificationChannel = async (ctx: Ctx, id: string) => {
  const user = requireUser(ctx);
  const channel = await notificationChannelService.get(id);
  if (channel.projectId) await requireProject(ctx, channel.projectId, 'admin');
  else if (channel.userId !== user.id) throw new NotFoundError('Canal de notification introuvable');
  return user;
};
const guardRequest = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, await projectOfRequest(id), min);
const guardTask = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await taskService.get(id)).projectId, min);
/** Dépôt « owner/name » passé par le client pour une PR d'un autre dépôt que celui du projet ; null = dépôt du projet. */
const repoArg = (repo: string | null | undefined) => {
  if (!repo?.trim()) return null;
  const parsed = parseRepoFullName(repo);
  if (!parsed) throw new AppError(`Dépôt GitHub invalide : ${repo}`);
  return parsed;
};
const guardTerminal = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await terminalService.get(id)).projectId, min);
const guardWorksession = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await worksessionService.get(id)).projectId, min);
const guardComment = async (ctx: Ctx, id: string) => {
  const comment = await taskService.getComment(id);
  const task = await taskService.get(comment.taskId);
  const role = await requireProject(ctx, task.projectId, 'member');
  return { comment, task, role };
};
const guardConversation = async (ctx: Ctx, id: string, min: ProjectRole) => {
  const conversation = await conversationService.get(id);
  const role = await requireProject(ctx, conversation.projectId, min);
  return { conversation, role };
};
// Les canaux sont ouverts aux invités du projet (rôle `guest`) : lire, écrire, réagir ; les gardes qui suivent ne
// demandent que ce rôle, et la propriété du message reste vérifiée par chaque mutation.
const guardMessage = async (ctx: Ctx, id: string) => {
  const message = await conversationService.getMessage(id);
  const { conversation, role } = await guardConversation(ctx, message.conversationId, 'guest');
  return { message, conversation, role };
};
const guardFolder = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await contextService.getFolder(id)).projectId, min);
const guardInstruction = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await contextService.getInstruction(id)).projectId, min);
/** Périmètre des notifications de la personne ; avec projectId (fenêtre dédiée à un projet), celles de ce projet seulement. */
const notificationScope = async (ctx: Ctx, projectId?: string | null) => {
  const user = requireUser(ctx);
  if (projectId) await requireProject(ctx, projectId);
  return { projectIds: projectId ? [projectId] : await accessibleProjectIds(ctx), admin: user.isAdmin, userId: user.id, onlyProjectId: projectId ?? undefined };
};
/** Projets de la file « À traiter » : tous ceux de la personne, ou un seul (fenêtre dédiée à un projet). */
const inboxProjectIds = async (ctx: Ctx, projectId?: string | null) => {
  if (!projectId) return accessibleProjectIds(ctx);
  await requireProject(ctx, projectId);
  return [projectId];
};

type GqlStatus = Uppercase<SessionStatus>;
type GqlRequestStatus = Uppercase<RequestStatus>;
type GqlTaskStatus = Uppercase<TaskStatus>;
type GqlTaskPriority = Uppercase<TaskPriority>;
const fromGqlTaskStatus = (s?: GqlTaskStatus | null) => (s ? (s.toLowerCase() as TaskStatus) : undefined);
const fromGqlTaskStatuses = (s?: GqlTaskStatus[] | null) => (s?.length ? s.map((x) => x.toLowerCase() as TaskStatus) : undefined);
const fromGqlTaskPriority = (p?: GqlTaskPriority | null) => (p ? (p.toLowerCase() as TaskPriority) : undefined);
interface GqlTaskInput {
  title?: string | null;
  summary?: string | null;
  description?: string | null;
  priority?: GqlTaskPriority | null;
  status?: GqlTaskStatus | null;
  sessionId?: string | null;
  releaseSessionIds?: string[] | null;
  dueDate?: string | null;
  customFields?: TaskField[] | null;
  statusTag?: string | null;
  tags?: string[] | null;
  assignee?: TaskPersonInput | null;
  reporter?: TaskPersonInput | null;
  attachments?: AttachmentInput[] | null;
  removeAttachmentIds?: string[] | null;
  dependsOnIds?: string[] | null;
  autoStartWhenUnblocked?: boolean | null;
  wakeAt?: string | null;
  wakeNote?: string | null;
}
const toTaskInput = (i: GqlTaskInput) => ({
  title: i.title ?? undefined,
  summary: i.summary,
  description: i.description ?? undefined,
  priority: fromGqlTaskPriority(i.priority),
  status: fromGqlTaskStatus(i.status),
  sessionId: i.sessionId,
  releaseSessionIds: i.releaseSessionIds ?? undefined,
  dueDate: i.dueDate,
  customFields: i.customFields ?? undefined,
  statusTag: i.statusTag,
  tags: i.tags ?? undefined,
  assignee: i.assignee,
  reporter: i.reporter,
  attachments: i.attachments ?? null,
  removeAttachmentIds: i.removeAttachmentIds ?? null,
  dependsOn: i.dependsOnIds ?? undefined,
  autoStartWhenUnblocked: i.autoStartWhenUnblocked ?? undefined,
  wakeAt: i.wakeAt,
  wakeNote: i.wakeNote,
});
/** Tâches d'identifiants donnés, dans leur ordre (chargeur groupé de la requête). */
const tasksByIds = async (ctx: Ctx, ids: string[]) => (await Promise.all(ids.map((id) => loadersOf(ctx).task(id)))).filter((t): t is Task => Boolean(t));
const actorOf = (user: User) => ({ type: 'human' as const, userId: user.id, name: user.name || user.email });
const fromGqlPermission = (p: string): VaultPermission => p.toLowerCase() as VaultPermission;
const fromGqlScope = (sc: string): VaultLinkScope => sc.toLowerCase() as VaultLinkScope;
const vaultActor = (ctx: Ctx) => ({ userId: settingsUser(ctx).id });
/**
 * Chargeurs groupés de la requête en cours (voir loaders.ts) : les résolveurs de champ appelés une fois par objet
 * (propriétaire, work session, projet, tâche, demandes en attente) sont servis en une requête SQL par lot.
 */
const loadersByCtx = new WeakMap<Ctx, Loaders>();
const loadersOf = (ctx: Ctx): Loaders => {
  let loaders = loadersByCtx.get(ctx);
  if (!loaders) {
    loaders = createLoaders();
    loadersByCtx.set(ctx, loaders);
  }
  return loaders;
};
const userOrNull = async (ctx: Ctx, id: string | null | undefined) => (id ? ((await loadersOf(ctx).user(id)) ?? null) : null);

// ---- Agents de projet ---------------------------------------------------------------------------
interface GqlAgentInput extends Omit<AgentInput, 'kind' | 'actions'> {
  kind?: string | null;
  actions?: AgentActionInput[] | null;
}
const fromGqlAgentInput = (input: GqlAgentInput): AgentInput => ({ ...input, kind: input.kind ? (input.kind.toLowerCase() as AgentKind) : null, actions: input.actions ?? null });
/** Membre du projet de l'agent et gestionnaire de l'agent (ou administrateur du projet). */
async function guardAgentManager(ctx: Ctx, agentId: string): Promise<Agent> {
  const user = requireUser(ctx); // avant toute lecture en base
  const agent = await agentService.get(agentId);
  await requireProject(ctx, agent.projectId, 'member');
  await agentService.assertCanManage(user.id, agent);
  return agent;
}
/** Bibliothèque visée par `agentId` : la bibliothèque propre d'un agent du projet (vérifié), sinon celle du projet. */
async function projectAgentLibrary(projectId: string, agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  const agent = await agentService.get(agentId);
  if (agent.projectId !== projectId) throw new AppError("Cet agent n'appartient pas au projet");
  return agent.id;
}
/** Propriétaire d'une session lancée par l'utilisateur connecté : lui-même, ou un agent du projet (il en est alors le demandeur). */
async function sessionOwnerFor(ctx: Ctx, agentId: string | null | undefined, projectId: string): Promise<{ ownerId: string; requestedById: string | null }> {
  const user = requireUser(ctx);
  if (!agentId) return { ownerId: user.id, requestedById: null };
  const agent = await agentService.get(agentId);
  if (agent.projectId !== projectId) throw new AppError(`L'agent ${agent.name} n'appartient pas à ce projet`);
  return { ownerId: agent.id, requestedById: user.id };
}
/** État du dépôt hébergé pour le client, avec l'adresse de téléchargement de chaque sauvegarde. */
/** Plafonds d'une planification saisis dans l'unité d'affichage (crédits ou USD) → USD enregistrés. */
async function scheduleBudgetInUsd<T extends { maxRunUsd?: number | null; monthlyBudgetUsd?: number | null }>(input: T, ctx: Ctx): Promise<T> {
  const rate = await costRate(ctx);
  return { ...input, maxRunUsd: toStoredUsd(input.maxRunUsd, rate), monthlyBudgetUsd: toStoredUsd(input.monthlyBudgetUsd, rate) };
}

async function hostedGitView(project: Project) {
  const status = await gitServer.status(project);
  const withUrl = (b: GitBackup) => ({ ...b, downloadUrl: `${config.apiUrl}/api/repo-backups/${b.id}` });
  return { ...status, tokensUrl: `${config.forgejo.url}/user/settings/applications`, lastBackup: status.lastBackup ? withUrl(status.lastBackup) : null, backups: status.backups.map(withUrl) };
}

/** Membres d'un projet hébergé → collaborateurs de son dépôt Forgejo, sans faire attendre la mutation (repris par le passage de fond en cas d'échec). */
function syncHostedMembers(projectId: string): void {
  void projectService
    .get(projectId)
    .then((p) => gitServer.syncMembers(p))
    .catch((err) => log.warn(`[forgejo] collaborateurs du projet ${projectId} : ${(err as Error).message}`));
}

const projectOf = async (ctx: Ctx, id: string): Promise<Project> => {
  const project = await loadersOf(ctx).project(id);
  if (!project) throw new NotFoundError('Projet introuvable');
  return project;
};
const worksessionOrNull = async (ctx: Ctx, id: string | null | undefined) => (id ? ((await loadersOf(ctx).worksession(id)) ?? null) : null);
/** Réactions regroupées par emoji (ordre de première apparition), avec les noms et si l'utilisateur connecté en est. */
function groupReactions(reactions: Pick<TaskReaction, 'emoji' | 'actorName' | 'userId'>[], userId: string | undefined): { emoji: string; count: number; actors: string[]; mine: boolean }[] {
  const groups = new Map<string, { emoji: string; count: number; actors: string[]; mine: boolean }>();
  for (const r of reactions) {
    const g = groups.get(r.emoji) ?? { emoji: r.emoji, count: 0, actors: [], mine: false };
    g.count += 1;
    g.actors.push(r.actorName);
    if (userId && r.userId === userId) g.mine = true;
    groups.set(r.emoji, g);
  }
  return [...groups.values()];
}
/** Projet renvoyé seulement si l'utilisateur y a accès (sinon null, le nom restant disponible à part). */
const projectIfAccessible = async (ctx: Ctx, id: string | null | undefined) => (id && (await roleFor(ctx, id)) ? projectService.get(id).catch(() => null) : null);
const fromGqlRequestStatus = (s?: GqlRequestStatus | null): RequestStatus | undefined =>
  s ? (s.toLowerCase() as RequestStatus) : undefined;

const toGqlStatus = (s: SessionStatus): GqlStatus => s.toUpperCase() as GqlStatus;
const fromGqlStatus = (s?: GqlStatus | null): SessionStatus | undefined =>
  s ? (s.toLowerCase() as SessionStatus) : undefined;

/** Paramètres de la personne connectée (Claude, OpenCode, GitHub, GitLab, consommation) ; les champs du serveur sont réservés aux administrateurs. */
const appSettings = (ctx: Ctx) => {
  const user = settingsUser(ctx);
  const claude = () => claudeSettings.forUser(user.id);
  return {
    claude: async () => (await claude()).settings,
    claudeAuth: async () => (await claude()).authStatus(),
    models: async () => (await claude()).models(),
    usage: () => usageService.summary(user.id),
    github: () => githubService.status(user.id, githubDeviceAvailable()),
    gitlab: () => gitlabService.status(user.id, gitlabDevice()),
    opencode: async () => {
      const o = await opencodeSettings.forUser(user.id);
      return { defaultModel: o.settings.defaultModel, sessionBudgetUsd: o.settings.sessionBudgetUsd, apiKeys: await o.keyStatus(), providers: opencodeProviders, modelList: o.modelList };
    },
    rateLimits: () => (user.isAdmin ? rateLimitView() : null),
    server: async () => {
      if (!user.isAdmin) return null;
      const maintenance = serverSettings.maintenance;
    const active = await sessionService.activeSummary();
    return {
      maintenance: Boolean(maintenance),
      maintenanceSince: maintenance?.since ?? null,
      maintenanceMessage: maintenance?.message ?? null,
      activeSessions: active.active,
      busySessions: active.busy,
      autoResumeInterrupted: serverSettings.current.autoResumeInterrupted,
      maxConcurrentSessions: serverSettings.current.maxConcurrentSessions,
      queuedSessions: (await sessionRepository.listQueued()).length,
      idleSessionTimeoutMinutes: serverSettings.current.idleSessionTimeoutMinutes,
      memoryAlertThresholdMb: serverSettings.current.memoryAlertThresholdMb,
      cellClaudeAccount: async () => {
        const view = await cellClaude.view();
        return view ? { ...view, configuredBy: () => userService.get(view.configuredById).catch(() => null) } : null;
      },
    };
    },
    onboarding: () => onboardingService.get(user.id),
  };
};

// ---- Workflows : accès par le projet de l'objet visé -----------------------------------------
const guardWorkflow = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await workflowService.get(id)).projectId, min);
const toGqlRunStatus = (s: RunStatus) => s.toUpperCase();
const toGqlTrigger = (t: RunTrigger) => t.toUpperCase();
/** Éléments du coffre d'un type, utilisables par la personne (choix dans un formulaire). */
const usableItems = async (ctx: Ctx, kinds: VaultItemKind[]) => vaultService.listAccessible(requireUser(ctx).id, kinds);

export const resolvers = {
  JSON: JSONResolver,
  DateTime: DateTimeResolver,
  // Champ obsolète gardé pour les frontends encore ouverts sur une ancienne version (bleu/vert).
  InboxCounts: { idleSessions: () => 0 },
  CtoTimeEntry: {
    source: (e: CtoTimeEntry) => e.source.toUpperCase(),
  },
  DashboardUsage: {
    rateLimits: () => rateLimitView(),
  },

  ProjectMember: {
    user: (m: ProjectMember) => userService.get(m.userId),
    role: (m: ProjectMember) => m.role.toUpperCase(),
    invitedBy: (m: ProjectMember) => (m.invitedById ? userService.get(m.invitedById).catch(() => null) : null),
    pending: async (m: ProjectMember) => (await userService.get(m.userId)).lastLoginAt === null,
  },

  ContextInstruction: {
    versions: (instruction: ContextInstruction) => contextService.versions(instruction.id),
  },
  ContextInstructionVersion: {
    authorSession: (v: ContextInstructionVersion) => (v.authorSessionId ? sessionService.get(v.authorSessionId) : null),
  },
  ContextChange: {
    authorSession: (c: ContextChange) => (c.authorSessionId ? sessionService.get(c.authorSessionId) : null),
  },

  Notification: {
    project: (n: Notification) => (n.projectId ? projectService.get(n.projectId).catch(() => null) : null),
    session: (n: Notification) => (n.sessionId ? sessionService.get(n.sessionId) : null),
    user: (n: Notification, _: unknown, ctx: Ctx) => userOrNull(ctx, n.userId),
  },

  TaskThreadSummary: {
    task: (t: { taskId: string }) => taskService.get(t.taskId),
  },
  Task: {
    status: (t: Task) => t.status.toUpperCase(),
    priority: (t: Task) => t.priority.toUpperCase(),
    project: (t: Task) => projectService.get(t.projectId),
    session: (t: Task) => (t.sessionId ? sessionService.get(t.sessionId) : null),
    sessionsInCharge: async (t: Task) => {
      const sessions = t.sessionIds.length ? await sessionService.list({ ids: t.sessionIds, archived: 'all', limit: 100 }) : [];
      return t.sessionIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => Boolean(s));
    },
    resumableSession: (t: Task) => resumableTaskSession(t),
    qualityDelivery: async (t: Task, _: unknown, ctx: Ctx) => (await loadersOf(ctx).taskDeliveryLink(t.id)) ?? null,
    sessions: async (t: Task) => {
      const ids = await taskService.sessionIds(t.id);
      const sessions = ids.length ? await sessionService.list({ ids, archived: 'all', limit: 500 }) : [];
      return ids.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => Boolean(s));
    },
    costUsd: async (t: Task, _: unknown, ctx: Ctx) => (await loadersOf(ctx).taskCost(t.id))?.totalUsd ?? 0,
    sessionCosts: async (t: Task, _: unknown, ctx: Ctx) => {
      const cost = await loadersOf(ctx).taskCost(t.id);
      if (!cost) return [];
      const sessions = await sessionService.list({ ids: [...cost.bySession.keys()], archived: 'all', limit: 500 });
      return sessions.map((session) => ({ session, usd: cost.bySession.get(session.id) ?? 0 })).sort((a, b) => b.usd - a.usd);
    },
    createdBySession: (t: Task) => (t.createdBySessionId ? sessionService.get(t.createdBySessionId) : null),
    // Les réactions de toute la tâche sont lues une fois et accrochées à chaque message (évite une requête par message).
    comments: async (t: Task) => {
      const [comments, reactions] = await Promise.all([taskService.comments(t.id), taskService.reactions(t.id)]);
      return comments.map((c) => ({ ...c, reactionRows: reactions.filter((r) => r.commentId === c.id) }));
    },
    reactions: async (t: Task, _: unknown, ctx: Ctx) => groupReactions((await taskService.reactions(t.id)).filter((r) => !r.commentId), ctx.user?.id),
    mentionables: (t: Task) => taskService.mentionables(t.projectId),
    pullRequest: (t: Task, _: unknown, ctx: Ctx) => (t.branch ? pullRequestService.forBranch(t.projectId, ctx.user?.id, t.branch) : null),
    pullRequests: (t: Task) => trackedPullRequestService.forTask(t.id),
    worksession: async (t: Task) => (await worksessionRepository.findByTask(t.id))[0] ?? null,
    attachments: (t: Task) => (t.attachmentCount ? taskService.attachments(t.id, null) : []),
    dependsOn: (t: Task, _: unknown, ctx: Ctx) => tasksByIds(ctx, t.dependsOnIds),
    blockedBy: (t: Task, _: unknown, ctx: Ctx) => tasksByIds(ctx, t.blockedByIds),
    blocked: (t: Task) => t.blockedByIds.length > 0,
    dependents: (t: Task, _: unknown, ctx: Ctx) => tasksByIds(ctx, t.dependentIds),
    autoStartBy: (t: Task, _: unknown, ctx: Ctx) => userOrNull(ctx, t.autoStartById),
  },

  TaskComment: {
    reactions: async (c: TaskComment & { reactionRows?: TaskReaction[] }, _: unknown, ctx: Ctx) => groupReactions(c.reactionRows ?? (await taskService.reactions(c.taskId)).filter((r) => r.commentId === c.id), ctx.user?.id),
    attachments: (c: TaskComment) => taskService.attachments(c.taskId, c.id),
    author: (c: TaskComment, _: unknown, ctx: Ctx) => userOrNull(ctx, c.authorUserId),
    agent: async (c: TaskComment, _: unknown, ctx: Ctx) => {
      if (!c.authorSessionId) return null;
      const session = await loadersOf(ctx).session(c.authorSessionId);
      return session?.ownerId ? ((await loadersOf(ctx).agent(session.ownerId)) ?? null) : null;
    },
    authorSession: (c: TaskComment) => (c.authorSessionId ? sessionService.get(c.authorSessionId) : null),
    editable: (c: TaskComment, _: unknown, ctx: Ctx) => c.authorType === 'human' && c.authorUserId === ctx.user?.id,
    deletable: async (c: TaskComment, _: unknown, ctx: Ctx) => {
      if (c.authorUserId === ctx.user?.id) return true;
      const task = await taskService.get(c.taskId).catch(() => null);
      return task ? (await roleFor(ctx, task.projectId)) === 'admin' : false;
    },
  },

  Conversation: {
    project: (c: Conversation) => projectService.get(c.projectId),
    unreadCount: async (c: Conversation, _: unknown, ctx: Ctx) => (ctx.user ? ((await conversationService.unreadCounts([c.id], ctx.user.id)).get(c.id) ?? 0) : 0),
    lastReadAt: async (c: Conversation, _: unknown, ctx: Ctx) => (ctx.user ? conversationService.lastReadAt(c.id, ctx.user.id) : null),
    messageCount: (c: Conversation) => conversationService.countMessages(c.id),
    // Les réactions, les comptes de réponses et les rôles des auteurs de la page sont lus une fois et accrochés à chaque message.
    messages: async (c: Conversation, args: { before?: Date | null; limit?: number | null }) => {
      const messages = await conversationService.messages(c.id, { before: args.before ?? null, limit: args.limit ?? undefined });
      const ids = messages.map((m) => m.id);
      const authorIds = [...new Set(messages.map((m) => m.authorUserId).filter((id): id is string => Boolean(id)))];
      const [reactions, replies, attachments, roles] = await Promise.all([conversationService.reactions(ids), conversationService.replyStats(messages.filter((m) => !m.parentId).map((m) => m.id)), conversationService.attachments(ids), userService.rolesFor(c.projectId, authorIds)]);
      return messages.map((m): MessageWithRows => ({ ...m, reactionRows: reactions.filter((r) => r.messageId === m.id), attachmentRows: attachments.filter((a) => a.messageId === m.id), replyStat: replies.get(m.id) ?? { count: 0, lastAt: null }, authorRole: m.authorUserId ? (roles.get(m.authorUserId) ?? null) : null }));
    },
    mentionables: (c: Conversation) => conversationService.mentionables(c.projectId),
  },

  Message: {
    reactions: async (m: MessageWithRows, _: unknown, ctx: Ctx) => groupReactions(m.reactionRows ?? (await conversationService.reactions([m.id])), ctx.user?.id),
    attachments: (m: MessageWithRows) => m.attachmentRows ?? conversationService.attachments([m.id]),
    author: (m: Message, _: unknown, ctx: Ctx) => userOrNull(ctx, m.authorUserId),
    agent: async (m: Message, _: unknown, ctx: Ctx) => {
      if (!m.authorSessionId) return null;
      const session = await loadersOf(ctx).session(m.authorSessionId);
      return session?.ownerId ? ((await loadersOf(ctx).agent(session.ownerId)) ?? null) : null;
    },
    authorSession: (m: Message) => (m.authorSessionId ? sessionService.get(m.authorSessionId) : null),
    editable: (m: Message, _: unknown, ctx: Ctx) => m.authorType === 'human' && m.authorUserId === ctx.user?.id,
    deletable: async (m: Message, _: unknown, ctx: Ctx) => {
      if (m.authorUserId === ctx.user?.id) return true;
      const conversation = await conversationService.get(m.conversationId).catch(() => null);
      return conversation ? (await roleFor(ctx, conversation.projectId)) === 'admin' : false;
    },
    replyCount: async (m: MessageWithRows) => (m.parentId ? 0 : (m.replyStat ?? (await conversationService.replyStats([m.id])).get(m.id))?.count ?? 0),
    lastReplyAt: async (m: MessageWithRows) => (m.parentId ? null : (m.replyStat ?? (await conversationService.replyStats([m.id])).get(m.id))?.lastAt ?? null),
    respondingSessions: async (m: Message) => {
      if (m.parentId) return [];
      const ids = await conversationService.busySessionIdsOnThread(m.id);
      return ids.length ? sessionService.list({ ids, archived: 'all', limit: 20 }) : [];
    },
    authorRole: async (m: MessageWithRows) => {
      if (!m.authorUserId) return null;
      const role = m.authorRole !== undefined ? m.authorRole : await userService.memberRoleFor(m.authorUserId, (await conversationService.get(m.conversationId)).projectId);
      return role ? role.toUpperCase() : null;
    },
  },

  ProjectApiKey: {
    createdBy: (k: ProjectApiKey, _: unknown, ctx: Ctx) => userOrNull(ctx, k.createdById),
    triageAgent: (k: ProjectApiKey, _: unknown, ctx: Ctx) => userOrNull(ctx, k.triageAgentId),
  },

  InboundEvent: {
    externalId: (e: InboundEvent) => e.idempotencyKey,
    task: (e: InboundEvent) => (e.taskId ? taskService.get(e.taskId).catch(() => null) : null),
    session: (e: InboundEvent) => (e.sessionId ? sessionRepository.findById(e.sessionId) : null),
    agent: (e: InboundEvent, _: unknown, ctx: Ctx) => userOrNull(ctx, e.agentId),
  },

  PullRequest: {
    forgeName: (pr: PullRequest) => (pr.forge === 'gitlab' ? 'GitLab' : config.forgejo.url && pr.url.startsWith(`${config.forgejo.url}/`) ? 'Forgejo' : 'GitHub'),
    worksession: async (pr: PullRequest) => (pr.isCrossRepository ? null : (await worksessionService.listByProject(pr.projectId)).find((w) => w.branch === pr.headRefName) ?? null),
    tasks: async (pr: PullRequest) => (pr.isCrossRepository ? [] : (await taskService.list({ projectId: pr.projectId, limit: 1000 })).filter((t) => t.branch === pr.headRefName)),
  },

  SessionReview: {
    pullRequest: (r: SessionReview) => (r.pullRequestId ? trackedPullRequestService.get(r.pullRequestId).catch(() => null) : null),
    task: async (r: SessionReview, _: unknown, ctx: Ctx) => (r.taskId ? (await loadersOf(ctx).task(r.taskId)) ?? null : null),
  },
  TrackedPullRequest: {
    project: (pr: TrackedPullRequest) => projectService.get(pr.projectId),
    task: (pr: TrackedPullRequest) => (pr.taskId ? taskService.get(pr.taskId).catch(() => null) : null),
    status: (pr: TrackedPullRequest) => pr.status.toUpperCase(),
    stage: (pr: TrackedPullRequest) => stageOf(pr).toUpperCase(),
    foreignRepo: async (pr: TrackedPullRequest) => Boolean(foreignRepoOf(pr, projectRepoName(await projectService.get(pr.projectId)))),
    worksession: (pr: TrackedPullRequest) => (pr.worksessionId ? worksessionRepository.findById(pr.worksessionId) : null),
    createdBy: (pr: TrackedPullRequest, _: unknown, ctx: Ctx) => userOrNull(ctx, pr.createdByUserId),
    createdBySession: (pr: TrackedPullRequest) => (pr.createdBySessionId ? sessionService.get(pr.createdBySessionId) : null),
    // En direct depuis GitHub (cache de 20 s côté service) : null si la PR n'est pas encore ouverte, si le projet n'y est pas ou si GitHub ne répond pas.
    github: async (pr: TrackedPullRequest, _: unknown, ctx: Ctx) => {
      if (pr.number == null) return null;
      const foreign = foreignRepoOf(pr, projectRepoName(await projectService.get(pr.projectId)));
      return pullRequestService.get(pr.projectId, ctx.user?.id, pr.number, foreign).catch(() => null);
    },
    session: (pr: TrackedPullRequest) => pullRequestSession(pr),
  },

  Delivery: {
    kind: (d: Delivery) => d.kind.toUpperCase(),
    status: (d: Delivery) => d.status.toUpperCase(),
    requestedBy: (d: Delivery, _: unknown, ctx: Ctx) => userOrNull(ctx, d.requestedById),
    joinedBy: async (d: Delivery, _: unknown, ctx: Ctx) => (await Promise.all(d.joinedByIds.map((id) => userOrNull(ctx, id)))).filter(Boolean),
    session: (d: Delivery) => (d.sessionId ? sessionService.get(d.sessionId).catch(() => null) : null),
    task: (d: Delivery) => (d.taskId ? taskService.get(d.taskId).catch(() => null) : null),
    cancellable: (d: Delivery) => (d.status === 'queued' || d.status === 'running') && !d.steps.some((st) => st.phase === 'command'),
    durationSeconds: (d: Delivery) => (d.startedAt ? Math.round(((d.finishedAt ?? new Date()).getTime() - d.startedAt.getTime()) / 1000) : null),
    qualityTasks: async (d: Delivery, _: unknown, ctx: Ctx) => (await loadersOf(ctx).deliveryQualityTasks(d.id)) ?? [],
  },
  DeliveryQualityTask: {
    task: (l: DeliveryTaskLink, _: unknown, ctx: Ctx) => loadersOf(ctx).task(l.taskId).then((t) => t ?? null),
    delivery: (l: DeliveryTaskLink) => (l.deliveryId ? deliveryService.get(l.deliveryId) : null),
    source: (l: DeliveryTaskLink) => l.source.toUpperCase(),
    linkedBy: (l: DeliveryTaskLink, _: unknown, ctx: Ctx) => userOrNull(ctx, l.linkedById),
    linkedAt: (l: DeliveryTaskLink) => l.createdAt,
  },
  DeliveryQualitySettings: {
    updatedBy: (s: QualitySettings, _: unknown, ctx: Ctx) => userOrNull(ctx, s.updatedById),
  },
  DeliveryQualityAuthor: {
    user: (a: QualityReport['byAuthor'][number], _: unknown, ctx: Ctx) => userOrNull(ctx, a.authorId),
    isAgent: async (a: QualityReport['byAuthor'][number], _: unknown, ctx: Ctx) => (await userOrNull(ctx, a.authorId))?.kind === 'agent',
  },
  DeployConfig: {
    updatedBy: (c: DeployConfig, _: unknown, ctx: Ctx) => userOrNull(ctx, c.updatedById),
  },
  DeliveryPolicy: {
    mergeUser: (p: DeliveryPolicy, _: unknown, ctx: Ctx) => userOrNull(ctx, p.mergeUserId),
  },
  DeliveryPolicyRule: {
    mode: (r: DeliveryPolicyRule) => r.mode.toUpperCase(),
  },

  VaultItem: {
    kind: (i: VaultItem) => i.kind,
    ownerUser: (i: VaultItem, _: unknown, ctx: Ctx) => userOrNull(ctx, i.ownerUserId),
    ownerProject: (i: VaultItem, _: unknown, ctx: Ctx) => projectIfAccessible(ctx, i.ownerProjectId),
    ownerProjectName: async (i: VaultItem) => (i.ownerProjectId ? (await projectService.get(i.ownerProjectId).catch(() => null))?.name ?? null : null),
    myPermission: async (i: VaultItemWithPermission, _: unknown, ctx: Ctx) => ((i.permission ?? (await vaultService.permissionFor(requireUser(ctx).id, i)) ?? 'use') as string).toUpperCase(),
    myShare: async (i: VaultItem, _: unknown, ctx: Ctx) => (await vaultService.shares(i.id)).find((sh) => sh.userId === ctx.user?.id)?.permission.toUpperCase() ?? null,
    host: (i: VaultItem) => (i.kind === 'ssh' || i.kind === 'postgres' ? (i.settings as SshSettings).host : null),
    port: (i: VaultItem) => (i.kind === 'ssh' || i.kind === 'postgres' ? (i.settings as SshSettings).port : null),
    username: (i: VaultItem) => (i.kind === 'ssh' || i.kind === 'postgres' ? (i.settings as SshSettings).username : i.kind === 'api' ? (i.settings as ApiSettings).username : null),
    url: (i: VaultItem) => (i.kind === 'website' ? (i.settings as WebsiteSettings).url : i.kind === 'api' ? (i.settings as ApiSettings).baseUrl : i.kind === 'litellm' ? (i.settings as LitellmSettings).baseUrl : i.kind === 'langfuse' ? (i.settings as LangfuseSettings).host : null),
    langfusePublicKey: (i: VaultItem) => (i.kind === 'langfuse' ? (i.settings as LangfuseSettings).publicKey : null),
    token: (i: VaultItem) => {
      if (i.kind !== 'token') return null;
      const t = i.settings as TokenSettings;
      return { service: t.service, serviceLabel: tokenServiceLabel(t.service), obtained: t.obtained, account: t.account, tokenExpiresAt: t.tokenExpiresAt };
    },
    fields: (i: VaultItem) => (i.kind === 'website' || i.kind === 'secret' ? (i.settings as SecretSettings).fields.map((f) => ({ ...f, variable: variableName(i.name, f.key) })) : []),
    database: (i: VaultItem) => (i.kind === 'postgres' ? (i.settings as PostgresSettings).database : null),
    ssl: (i: VaultItem) => (i.kind === 'postgres' ? (i.settings as PostgresSettings).ssl : null),
    sslCa: (i: VaultItem) => (i.kind === 'postgres' ? (i.settings as PostgresSettings).sslCa ?? null : null),
    via: async (i: VaultItem) => {
      const id = i.kind === 'postgres' ? (i.settings as PostgresSettings).viaItemId : null;
      return id ? vaultService.getInternal(id).catch(() => null) : null;
    },
    authScheme: (i: VaultItem) => (i.kind === 'api' ? (i.settings as ApiSettings).authScheme : null),
    authName: (i: VaultItem) => (i.kind === 'api' ? (i.settings as ApiSettings).authName : null),
    aws: (i: VaultItem) => {
      if (i.kind !== 'aws') return null;
      const s = i.settings as AwsSettings;
      return { ...s, connected: awsService.connected(i) };
    },
    scaleway: (i: VaultItem) => (i.kind === 'scaleway' ? (i.settings as ScalewaySettings) : null),
    google: (i: VaultItem) => {
      if (i.kind !== 'google') return null;
      const a = accountOf(i);
      return { email: a.email, name: a.displayName, avatarUrl: a.avatarUrl, gmailAccess: a.gmailAccess.toUpperCase(), driveAccess: a.driveAccess.toUpperCase(), scopes: a.scopes };
    },
    hostFingerprint: (i: VaultItem) => (i.hostKey ? fingerprint(i.hostKey) : null),
    hasSecret: (i: VaultItem) => vaultService.hasSecret(i),
    revealableFields: async (i: VaultItemWithPermission, _: unknown, ctx: Ctx) => vaultService.revealableFields(i, i.permission ?? (await vaultService.permissionFor(requireUser(ctx).id, i))),
    shares: async (i: VaultItemWithPermission, _: unknown, ctx: Ctx) => ((i.permission ?? (await vaultService.permissionFor(requireUser(ctx).id, i))) === 'manage' ? vaultService.shares(i.id) : []),
    links: async (i: VaultItemWithPermission, _: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      const links = await vaultService.links(i.id);
      if ((i.permission ?? (await vaultService.permissionFor(user.id, i))) === 'manage') return links;
      const mine = await accessibleProjectIds(ctx);
      return links.filter((l) => (l.scope === 'personal' ? l.userId === user.id : mine.includes(l.projectId)));
    },
    audit: async (i: VaultItemWithPermission, args: { limit?: number | null; before?: string | null }, ctx: Ctx) => ((i.permission ?? (await vaultService.permissionFor(requireUser(ctx).id, i))) === 'manage' ? vaultService.auditLog(i.id, args.limit ?? 50, args.before) : []),
    createdBy: (i: VaultItem, _: unknown, ctx: Ctx) => userOrNull(ctx, i.createdById),
  },

  VaultShare: {
    user: (sh: VaultShare) => userService.get(sh.userId),
    permission: (sh: VaultShare) => sh.permission.toUpperCase(),
    grantedBy: (sh: VaultShare, _: unknown, ctx: Ctx) => userOrNull(ctx, sh.grantedById),
  },

  VaultLink: {
    project: (l: VaultLink, _: unknown, ctx: Ctx) => projectIfAccessible(ctx, l.projectId),
    projectName: async (l: VaultLink) => (await projectService.get(l.projectId).catch(() => null))?.name ?? 'projet supprimé',
    scope: (l: VaultLink) => l.scope.toUpperCase(),
    user: (l: VaultLink, _: unknown, ctx: Ctx) => userOrNull(ctx, l.userId),
    linkedBy: (l: VaultLink, _: unknown, ctx: Ctx) => userOrNull(ctx, l.linkedById),
  },

  AuditEntry: {
    actionLabel: (e: AuditEntry) => actionLabel(e.action),
    targetTypeLabel: (e: AuditEntry) => targetTypeLabel(e.targetType),
    actorKind: (e: AuditEntry) => e.actorKind.toUpperCase(),
    actor: (e: AuditEntry, _: unknown, ctx: Ctx) => userOrNull(ctx, e.actorUserId),
  },

  VaultAuditEvent: {
    actor: (e: VaultAuditEvent, _: unknown, ctx: Ctx) => userOrNull(ctx, e.actorUserId),
    project: (e: VaultAuditEvent, _: unknown, ctx: Ctx) => projectIfAccessible(ctx, e.projectId),
    projectName: async (e: VaultAuditEvent) => (e.projectId ? (await projectService.get(e.projectId).catch(() => null))?.name ?? null : null),
  },

  ProjectVaultItem: {
    via: (r: ProjectVaultRow) => r.via.toUpperCase(),
    forAgents: (r: ProjectVaultRow) => r.forAgents !== false,
  },

  GithubAccount: {
    method: (a: { method: string }) => a.method.toUpperCase(),
  },
  GithubDevicePoll: {
    status: (p: { status: string }) => p.status.toUpperCase(),
  },
  GitlabAccount: {
    method: (a: { method: string }) => a.method.toUpperCase(),
  },
  GitlabDevicePoll: {
    status: (p: { status: string }) => p.status.toUpperCase(),
  },

  Workflow: {
    project: (w: Workflow) => projectService.get(w.projectId),
    issues: (w: Workflow) => workflowService.issues(w.definition),
    variables: (w: Workflow, args: { triggerKey?: string | null }) => workflowVariables(w.definition, args.triggerKey),
    eventOwner: (w: Workflow, _: unknown, ctx: Ctx) => userOrNull(ctx, w.eventOwnerId),
    runs: (w: Workflow, args: { limit?: number | null }) => workflowService.listRuns({ workflowId: w.id, limit: args.limit ?? 20 }),
    lastRun: (w: Workflow) => workflowService.lastRun(w.id),
    createdBy: (w: Workflow, _: unknown, ctx: Ctx) => userOrNull(ctx, w.createdById),
  },

  SessionSchedule: {
    name: (schedule: SessionSchedule) => scheduleLabel(schedule),
    customName: (schedule: SessionSchedule) => schedule.name,
    archivePolicy: (schedule: SessionSchedule) => schedule.archivePolicy.toUpperCase(),
    project: (schedule: SessionSchedule, _: unknown, ctx: Ctx) => loadersOf(ctx).project(schedule.projectId),
    owner: (schedule: SessionSchedule, _: unknown, ctx: Ctx) => userOrNull(ctx, schedule.ownerId),
    agent: async (schedule: SessionSchedule, _: unknown, ctx: Ctx) => (schedule.ownerId ? ((await loadersOf(ctx).agent(schedule.ownerId)) ?? null) : null),
    requestedBy: (schedule: SessionSchedule, _: unknown, ctx: Ctx) => userOrNull(ctx, schedule.requestedById),
    monthUsd: (schedule: SessionSchedule) => scheduleRepository.spentSince(schedule.id, currentMonthStart()),
    runs: (schedule: SessionSchedule, args: { limit?: number | null }) => scheduleService.listRuns(schedule.id, args.limit ?? 20),
    activeSessions: async (schedule: SessionSchedule, _: unknown, ctx: Ctx) => {
      const ids = await scheduleRepository.liveRunSessions(schedule.id);
      return (await Promise.all(ids.map((id) => loadersOf(ctx).session(id)))).filter(Boolean);
    },
  },
  ScheduleRun: {
    trigger: (run: ScheduleRun) => run.trigger.toUpperCase(),
    status: (run: ScheduleRun) => run.status.toUpperCase(),
    triggeredBy: (run: ScheduleRun, _: unknown, ctx: Ctx) => (run.triggeredBy ? loadersOf(ctx).user(run.triggeredBy) : null),
    session: (run: ScheduleRun, _: unknown, ctx: Ctx) => (run.runSessionId ? loadersOf(ctx).session(run.runSessionId) : null),
  },
  WorkflowRun: {
    workflow: (r: WorkflowRun) => workflowService.get(r.workflowId),
    project: (r: WorkflowRun) => projectService.get(r.projectId),
    trigger: (r: WorkflowRun) => toGqlTrigger(r.trigger),
    status: (r: WorkflowRun) => toGqlRunStatus(r.status),
    nodes: (r: WorkflowRun) => workflowService.runNodes(r.id),
    logs: (r: WorkflowRun, args: { after?: string | null; limit?: number | null }) => workflowService.runLogs(r.id, { after: args.after, limit: args.limit ?? 500 }),
    owner: (r: WorkflowRun, _: unknown, ctx: Ctx) => userOrNull(ctx, r.ownerId),
  },

  WorkflowRunNode: {
    session: (n: WorkflowRunNode) => {
      const sessionId = (n.output as { sessionId?: unknown } | null)?.sessionId;
      return typeof sessionId === 'string' ? sessionService.get(sessionId).catch(() => null) : null;
    },
  },

  SessionShare: {
    url: (share: SessionShare) => `${config.appUrl}/share/${share.token}`,
    createdBy: (share: SessionShare, _: unknown, ctx: Ctx) => userOrNull(ctx, share.createdById),
  },
  SharedPage: {
    owner: (p: SharedPage) => userService.get(p.ownerId),
    members: async (p: SharedPage, _: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      const members = await sharedPageService.members(p.id);
      return p.ownerId === user.id || members.some((m) => m.userId === user.id) ? members : [];
    },
    // pageKind : type de repli d'une version qui ne l'a pas gardé.
    versions: async (p: SharedPage) => (await sharedPageService.visibleVersions(p)).map((v) => ({ ...v, pageKind: p.kind })),
    historyEnabled: (p: SharedPage) => p.historyEnabled,
    project: (p: SharedPage, _: unknown, ctx: Ctx) => (p.ownerId === ctx.user?.id ? projectIfAccessible(ctx, p.projectId) : null),
    session: (p: SharedPage, _: unknown, ctx: Ctx) => (p.ownerId === ctx.user?.id && p.sessionId ? sessionService.get(p.sessionId) : null),
    sourcePath: (p: SharedPage, _: unknown, ctx: Ctx) => (p.ownerId === ctx.user?.id ? p.sourcePath : null),
    viewerAccess: async (p: SharedPage, _: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      const members = await sharedPageService.members(p.id);
      return { owner: p.ownerId === user.id, member: members.some((m) => m.userId === user.id), admin: sharedPageService.canManage(p, user) };
    },
    comments: (p: SharedPage) => sharedPageCommentService.roots(p.id),
    openComments: async (p: SharedPage, _: unknown, ctx: Ctx) => (await loadersOf(ctx).sharedPageOpenComments(p.id)) ?? 0,
    favorite: async (p: SharedPage, _: unknown, ctx: Ctx) => (ctx.user ? ((await loadersOf(ctx).sharedPageFavorite({ userId: ctx.user.id, pageId: p.id })) ?? false) : false),
    // Réglage effectif : sans session d'origine, rien ne peut être transmis.
    agentHandoff: (p: SharedPage) => (p.sessionId ? p.agentHandoff.toUpperCase() : 'OFF'),
    kind: (p: SharedPage) => p.kind.toUpperCase(),
    sources: async (p: SharedPage, args: { version?: number | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      // Une ancienne version : seulement si l'historique la laisse consulter (comme son contenu).
      const version = args.version && args.version !== p.version && p.historyEnabled ? args.version : null;
      const kind = version ? ((await sharedPageService.versions(p.id)).find((v) => v.version === version)?.kind ?? p.kind) : p.kind;
      if (kind !== 'data') return [];
      const full = sharedPageService.canManage(p, user);
      return (await artifactDataService.sourcesAt(p, version)).map((s) => sourceView(s, full));
    },
    alerts: async (p: SharedPage, _: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      if (p.kind !== 'data') return [];
      const full = sharedPageService.canManage(p, user);
      return (await alertService.list(p.id)).map((a) => alertView(a, full));
    },
  },
  SharedPageComment: {
    author: (c: SharedPageComment, _: unknown, ctx: Ctx) => userOrNull(ctx, c.authorId),
    viaAgent: (c: SharedPageComment) => c.sessionId != null,
    resolved: (c: SharedPageComment) => c.resolvedAt != null,
    resolvedBy: (c: SharedPageComment, _: unknown, ctx: Ctx) => userOrNull(ctx, c.resolvedById),
    replies: (c: SharedPageComment) => (c.parentId ? [] : sharedPageCommentService.replies(c.id)),
  },
  SharedPageMember: {
    user: (m: SharedPageMember) => userService.get(m.userId),
    addedBy: (m: SharedPageMember, _: unknown, ctx: Ctx) => userOrNull(ctx, m.addedById),
    addedAt: (m: SharedPageMember) => m.createdAt,
    message: async (m: SharedPageMember, _: unknown, ctx: Ctx) => {
      if (!m.message || !ctx.user) return null;
      if (ctx.user.id === m.userId || ctx.user.id === m.addedById) return m.message;
      return (await sharedPageService.get(m.pageId)).ownerId === ctx.user.id ? m.message : null;
    },
  },
  CockpitLayout: {
    kind: (r: ResolvedLayout) => r.scope.kind,
    scope: (r: ResolvedLayout) => r.scope.key,
    projectId: (r: ResolvedLayout) => r.scope.projectId,
    updatedBy: (r: ResolvedLayout) => (r.updatedById ? userRepository.findById(r.updatedById) : null),
    catalog: (r: ResolvedLayout) => cockpitService.catalog(r.scope.kind),
    artifacts: (r: ResolvedLayout, _: unknown, ctx: Ctx) => cockpitService.artifactsFor(requireUser(ctx), r.layout),
    warnings: (r: ResolvedLayout) => r.warnings ?? [],
  },
  CockpitArtifact: {
    owner: (a: { ownerId: string | null }) => (a.ownerId ? userRepository.findById(a.ownerId) : null),
    kind: (a: { kind: string | null }) => (a.kind ? a.kind.toUpperCase() : null),
  },
  CockpitLayoutVersion: {
    author: (v: { authorId: string | null }) => (v.authorId ? userRepository.findById(v.authorId) : null),
  },
  SharedPageVersion: {
    createdBy: (v: SharedPageVersion, _: unknown, ctx: Ctx) => userOrNull(ctx, v.createdById),
    kind: (v: SharedPageVersion & { pageKind?: string }) => (v.kind ?? v.pageKind ?? 'page').toUpperCase(),
    sourceCount: (v: SharedPageVersion) => (v.sources ? v.sources.length : null),
  },

  Terminal: {
    status: (t: TerminalRecord) => t.status.toUpperCase(),
    project: (t: TerminalRecord, _: unknown, ctx: Ctx) => projectOf(ctx, t.projectId),
    worksession: (t: TerminalRecord, _: unknown, ctx: Ctx) => worksessionOrNull(ctx, t.worksessionId),
    createdBy: (t: TerminalRecord, _: unknown, ctx: Ctx) => userOrNull(ctx, t.createdById),
  },

  EnvFile: {
    dotenv: (f: EnvFile) => envFileService.isDotenv(f),
    keys: (f: EnvFile) => envFileService.keys(f).map((k) => ({ key: k.key, value: k.value, fromVault: k.refs.length > 0 })),
    problems: (f: EnvFile, _: unknown, ctx: Ctx) => envFileService.problems(f, f.projectId, requireUser(ctx).id),
    updatedBy: (f: EnvFile, _: unknown, ctx: Ctx) => userOrNull(ctx, f.updatedById),
    updatedBySession: (f: EnvFile) => (f.updatedBySessionId ? sessionService.get(f.updatedBySessionId).catch(() => null) : null),
  },

  Worksession: {
    project: (w: Worksession, _: unknown, ctx: Ctx) => projectOf(ctx, w.projectId),
    label: (w: Worksession) => worksessionLabel(w),
    customLabel: (w: Worksession) => w.label,
    path: async (w: Worksession, _: unknown, ctx: Ctx) => worksessionPath(await projectOf(ctx, w.projectId), w),
    exists: async (w: Worksession, _: unknown, ctx: Ctx) => worksessionService.exists(await projectOf(ctx, w.projectId), w),
    git: async (w: Worksession, _: unknown, ctx: Ctx) => worksessionService.gitInfo(await projectOf(ctx, w.projectId), w),
    pullRequest: async (w: Worksession, _: unknown, ctx: Ctx) => ((await projectOf(ctx, w.projectId)).gitUrl ? pullRequestService.forBranch(w.projectId, ctx.user?.id, w.branch).catch(() => null) : null),
    trackedPullRequest: async (w: Worksession, _: unknown, ctx: Ctx) => (await loadersOf(ctx).trackedPullRequest({ id: w.id, projectId: w.projectId, branch: w.branch })) ?? null,
    task: async (w: Worksession, _: unknown, ctx: Ctx) => (w.taskId ? await loadersOf(ctx).task(w.taskId) : null) ?? (await loadersOf(ctx).taskForBranch({ projectId: w.projectId, branch: w.branch })) ?? null,
    sessions: (w: Worksession) => sessionService.list({ projectId: w.projectId, worksessionId: w.id, limit: 200 }),
    terminals: async (w: Worksession, _: unknown, ctx: Ctx) => (await terminalService.listByProject(w.projectId, requireUser(ctx).id)).filter((t) => t.worksessionId === w.id),
  },

  WorksessionDiskEntry: {
    activeSessions: (e: WorksessionDiskEntry) => e.activity?.activeSessions ?? 0,
    busySessions: (e: WorksessionDiskEntry) => e.activity?.busySessions ?? 0,
    deps: (e: WorksessionDiskEntry) => (e.deps ? e.deps.replace('-', '_').toUpperCase() : null),
  },

  PermissionRule: {
    rule: (r: PermissionRule) => formatRule(r),
    createdBySession: (r: PermissionRule) => (r.createdBySessionId ? sessionService.get(r.createdBySessionId) : null),
  },

  Project: {
    workspacePath: (project: Project) => workspacePath(project),
    pages: (project: Project) => projectPageService.list(project.id),
    tabs: (project: Project) => projectPageService.tabs(project.id),
    monthUsd: (project: Project) => projectBudget.monthSpent(project.id),
    permissionRules: (project: Project) => permissionRuleService.list(project.id),
    runnerStatus: (project: Project) => runner.status(project),
    containerStats: async (project: Project) => {
      const stats = await runner.stats(project);
      if (!stats) return null;
      return {
        ...stats,
        memoryHighSince: containerMonitor.memoryHighSince(project.id),
        claudeProcesses: stats.claudeProcesses.map((p) => ({
          ...p,
          // Une session d'un autre projet ne peut pas tourner dans ce conteneur ; on vérifie quand même.
          session: async () => {
            const session = p.sessionId ? await sessionRepository.findById(p.sessionId) : null;
            return session?.projectId === project.id ? session : null;
          },
        })),
      };
    },
    members: (project: Project) => userService.members(project.id),
    myRole: async (project: Project, _: unknown, ctx: Ctx) => ((await roleFor(ctx, project.id)) ?? 'viewer').toUpperCase(),
    isMember: async (project: Project, _: unknown, ctx: Ctx) => (await memberRoleFor(ctx, project.id)) !== null,
    isPersonal: (project: Project) => isPersonalProject(project),
    terminals: (project: Project, _: unknown, ctx: Ctx) => terminalService.listByProject(project.id, requireUser(ctx).id),
    worksessions: (project: Project) => worksessionService.listByProject(project.id),
    archivedWorksessions: (project: Project) => worksessionService.listByProject(project.id, { archived: 'only' }),
    worksessionDisk: (project: Project, args: { refresh?: boolean | null }, ctx: Ctx) => worksessionDisk.report(project.id, { refresh: Boolean(args.refresh), actorId: ctx.user?.id ?? null }),
    vaultItems: (project: Project, _: unknown, ctx: Ctx) => vaultService.projectRows(project.id, requireUser(ctx).id),
    agents: (project: Project) => (isPersonalProject(project) ? [] : agentService.listByProject(project.id)),
    apiKeys: async (project: Project, _: unknown, ctx: Ctx) => ((await roleFor(ctx, project.id)) === 'admin' ? apiKeyService.list(project.id) : []),
    inboundEvents: async (project: Project, args: { limit?: number | null }, ctx: Ctx) => ((await roleFor(ctx, project.id)) === 'admin' ? inboundRepository.listByProject(project.id, args.limit ?? 30) : []),
    // Un espace personnel n'a pas de canaux (ses chats suffisent).
    conversations: (project: Project, args: { includeArchived?: boolean | null }) => (isPersonalProject(project) ? [] : conversationService.list(project.id, { includeArchived: Boolean(args.includeArchived) })),
    followedTaskThreads: async (project: Project, args: { limit?: number | null }, ctx: Ctx) => {
      // Un invité n'a pas accès aux tâches : aucun fil de tâche pour lui.
      if (!ctx.user || isPersonalProject(project) || (await isGuestOn(ctx, project.id))) return [];
      const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
      const threads = await conversationService.followedTaskThreads(project.id, ctx.user.id, ctx.user.email ?? null, limit);
      return threads.map((t) => ({ id: t.conversation.id, slug: t.conversation.slug, taskId: t.conversation.taskId, messageCount: t.messageCount, lastMessageAt: t.conversation.lastMessageAt }));
    },
    unreadMessages: async (project: Project, _: unknown, ctx: Ctx) => (ctx.user && !isPersonalProject(project) ? ((await conversationService.unreadByProject([project.id], ctx.user.id)).get(project.id) ?? 0) : 0),
    approvalConnections: async (project: Project, _: unknown, ctx: Ctx) => vaultService.approvalNames(await vaultService.agentItems(project.id, ctx.user?.id ?? null)),
    tasks: (project: Project, args: { status?: GqlTaskStatus[] | null }) => taskService.list({ projectId: project.id, status: fromGqlTaskStatuses(args.status) }),
    contextFolders: async (project: Project, args: { agentId?: string | null }) => (await contextService.tree(project.id, await projectAgentLibrary(project.id, args.agentId))).folders,
    contextInstructions: async (project: Project, args: { agentId?: string | null }) => (await contextService.tree(project.id, await projectAgentLibrary(project.id, args.agentId))).instructions,
    contextChanges: async (project: Project, args: { limit?: number | null; agentId?: string | null }) => contextService.changes(project.id, args.limit ?? undefined, await projectAgentLibrary(project.id, args.agentId)),
    workspaceExists: (project: Project) => workspaceExists(project),
    git: (project: Project) => workspaceGitInfo(project),
    gitHosted: (project: Project) => project.gitHosted,
    hostedGit: (project: Project) => (project.gitHosted ? hostedGitView(project) : null),
    sessions: (project: Project, args: { status?: GqlStatus | null; limit?: number | null; offset?: number | null }) =>
      sessionService.list({ projectId: project.id, status: fromGqlStatus(args.status), limit: args.limit ?? undefined, offset: args.offset ?? undefined }),
  },

  RepoRef: {
    kind: (ref: RepoRef) => ref.kind.toUpperCase(),
  },
  RepoEntry: {
    kind: (entry: RepoEntry) => entry.kind.toUpperCase(),
  },

  Request: {
    status: (request: HumanRequest) => request.status.toUpperCase(),
    session: (request: HumanRequest) => sessionService.get(request.sessionId),
    answeredBy: (request: HumanRequest, _: unknown, ctx: Ctx) => userOrNull(ctx, request.answeredById),
  },

  Session: {
    kind: (session: Session) => session.kind.toUpperCase(),
    review: (session: Session) => reviewOf(session),
    project: (session: Session, _: unknown, ctx: Ctx) => projectOf(ctx, session.projectId),
    worksession: (session: Session, _: unknown, ctx: Ctx) => worksessionOrNull(ctx, session.worksessionId),
    owner: (session: Session, _: unknown, ctx: Ctx) => userOrNull(ctx, session.ownerId),
    requestedBy: (session: Session, _: unknown, ctx: Ctx) => userOrNull(ctx, session.requestedById),
    takenOverBy: (session: Session, _: unknown, ctx: Ctx) => userOrNull(ctx, session.takenOverById),
    // Les liens publics ne sont montrés qu'à ceux qui peuvent en créer ou en révoquer (pas aux lecteurs).
    shares: async (session: Session, _: unknown, ctx: Ctx) => {
      const role = ctx.user ? await roleFor(ctx, session.projectId) : null;
      return role && role !== 'viewer' ? sessionShareService.listActive(session.id) : [];
    },
    viewerCanTakeOver: (session: Session, _: unknown, ctx: Ctx) => (ctx.user && session.ownerId ? agentService.canTakeOver(ctx.user.id, session) : false),
    agent: async (session: Session, _: unknown, ctx: Ctx) => (session.ownerId ? ((await loadersOf(ctx).agent(session.ownerId)) ?? null) : null),
    task: (session: Session) => taskService.forSession(session.id),
    tasks: (session: Session) => taskService.tasksInCharge(session.id),
    parentSession: async (session: Session, _: unknown, ctx: Ctx) => (session.parentSessionId ? ((await loadersOf(ctx).session(session.parentSessionId)) ?? null) : null),
    childSessions: (session: Session) => sessionService.list({ parentSessionId: session.id, archived: 'all', limit: 50 }),
    workflowRun: (session: Session) => (session.workflowRunId ? workflowService.findRun(session.workflowRunId) : null),
    status: (session: Session) => toGqlStatus(session.status),
    activity: (session: Session) => (session.activity ? session.activity.toUpperCase() : null),
    requests: (session: Session, args: { status?: GqlRequestStatus | null }) =>
      requestService.list({ sessionId: session.id, status: fromGqlRequestStatus(args.status) }),
    pendingRequestCount: async (session: Session, _: unknown, ctx: Ctx) => (await loadersOf(ctx).pendingRequestCount(session.id)) ?? 0,
    browserActive: (session: Session) => liveBrowserService.isActive(session.id),
    // La liste n'est vidée qu'en fin d'exécution du CLI : un processus tué net (redémarrage) peut en laisser une.
    subagents: (session: Session) => (session.status === 'running' && !session.parkedAt ? (session.subagents ?? []).map((s) => ({ ...s, kind: s.kind ?? 'agent' })) : []),
    // Pages publiées depuis la session, réduites à celles que la personne voit : les autres gardent /shared/<id>.
    pages: async (session: Session, _: unknown, ctx: Ctx) => (ctx.user ? ((await loadersOf(ctx).sessionPages({ sessionId: session.id, viewerId: ctx.user.id })) ?? []) : []),
    liveDraft: (session: Session) => liveDraftService.get(session.id),
    queuePosition: (session: Session) => (session.status === 'queued' ? sessionService.queuePosition(session.id) : null),
    promptAttachments: (session: Session) => session.promptAttachments.map(publicAttachment),
    model: async (session: Session, _: unknown, ctx: Ctx) => {
      if (session.provider !== 'claude') return null;
      const own = typeof session.config.model === 'string' ? session.config.model.trim() : '';
      if (own) return own;
      return session.ownerId ? ownerDefaultModelOf(ctx, session.ownerId) : null;
    },
    schedule: async (session: Session, _: unknown, ctx: Ctx) => (await loadersOf(ctx).sessionSchedule(session.id)) ?? null,
    context: (session: Session): ContextParent => ({ session }),
    events: (session: Session, args: { after?: string | null; limit?: number | null; toolUseId?: string | null }) =>
      sessionService.events(session.id, { after: args.after ?? undefined, limit: args.limit ?? undefined, toolUseId: args.toolUseId ?? undefined }),
  },

  SessionChanges: {
    mode: (c: SessionChanges) => c.mode.toUpperCase(),
  },

  // Les champs qui ne dépendent pas du modèle sont gratuits (sidebar) ; le modèle n'est cherché (relevé de
  // consommation) que si un champ qui en dépend est demandé, une seule fois par session.
  SessionContext: {
    tokens: (p: ContextParent) => p.session.contextTokens,
    warnTokens: (_: ContextParent, __: unknown, ctx: Ctx) => warnTokensOf(ctx),
    overThreshold: async (p: ContextParent, _: unknown, ctx: Ctx) => contextEstimate(p.session.contextTokens, null, await warnTokensOf(ctx)).overThreshold,
    model: (p: ContextParent) => modelOfContext(p),
    windowTokens: async (p: ContextParent) => contextEstimate(p.session.contextTokens, await modelOfContext(p)).windowTokens,
    share: async (p: ContextParent) => contextEstimate(p.session.contextTokens, await modelOfContext(p)).share,
    // Dernier tour non compté (propre compte Claude, cellule en crédits) : pas de coût estimé à montrer.
    coldTurnUsd: async (p: ContextParent) => ((await ledgerOfContext(p)).billable ? contextEstimate(p.session.contextTokens, await modelOfContext(p)).coldTurnUsd : null),
  },

  Agent: {
    user: (a: Agent, _: unknown, ctx: Ctx) => userOrNull(ctx, a.id),
    project: async (a: Agent, _: unknown, ctx: Ctx) => (await loadersOf(ctx).project(a.projectId)) ?? null,
    kind: (a: Agent) => a.kind.toUpperCase(),
    delegations: async (a: Agent, _: unknown, ctx: Ctx) => {
      const acc = agentService.accounts(a);
      const github = await userOrNull(ctx, a.githubDelegateId);
      const gitlab = await userOrNull(ctx, a.gitlabDelegateId);
      return { claude: await userOrNull(ctx, a.claudeDelegateId), github, githubReadOnly: acc.githubReadOnly, githubPullRequests: acc.githubPullRequests, githubMerge: acc.githubMerge, gitlab, gitlabReadOnly: acc.gitlabReadOnly, gitlabPullRequests: acc.gitlabPullRequests, gitlabMerge: acc.gitlabMerge, git: github ?? gitlab, gitReadOnly: acc.githubReadOnly || acc.gitlabReadOnly };
    },
    managers: (a: Agent) => agentService.managers(a.id),
    canManage: (a: Agent, _: unknown, ctx: Ctx) => agentService.canManage(requireUser(ctx).id, a),
    stats: (a: Agent) => agentService.stats(a.id),
    sessions: (a: Agent, args: { limit?: number | null }) => agentService.sessions(a.id, args.limit ?? 50),
    tasks: (a: Agent, args: { limit?: number | null }) => agentService.tasks(a.id, args.limit ?? 50),
  },
  AgentAction: {
    schedule: async (a: AgentAction, _: unknown, ctx: Ctx) => (a.scheduleId ? ((await loadersOf(ctx).schedule(a.scheduleId)) ?? null) : null),
  },
  AgentManager: {
    user: (m: AgentManager, _: unknown, ctx: Ctx) => userOrNull(ctx, m.userId),
    role: (m: AgentManager) => m.role.toUpperCase(),
  },
  AgentTemplate: {
    kind: (t: AgentTemplate) => t.kind.toUpperCase(),
    actions: (t: AgentTemplate) => t.actions.map((a, i) => ({ key: a.key ?? slugify(a.label) ?? `action-${i + 1}`, label: a.label, instruction: a.instruction, cron: a.cron ?? null, timezone: a.timezone ?? null, scheduleId: null })),
  },
  User: {
    kind: (u: User) => (u.kind ?? 'person').toUpperCase(),
    agent: async (u: User, _: unknown, ctx: Ctx) => (u.kind === 'agent' ? ((await loadersOf(ctx).agent(u.id)) ?? null) : null),
    hasPassword: (u: User, _: unknown, ctx: Ctx) => (ctx.user && (ctx.user.id === u.id || ctx.user.isAdmin) ? Boolean(u.passwordSetAt) : null),
    conversationsOnly: (u: User, _: unknown, ctx: Ctx) => (ctx.user?.id === u.id ? userService.conversationsOnly(u) : null),
  },

  Query: {
    auditLog: async (_: unknown, args: { projectId: string; filter?: RawAuditFilter | null; limit?: number | null; before?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'viewer');
      return auditService.list({ ...parseAuditFilter(args.projectId, args.filter), limit: args.limit ?? 100, before: args.before ?? null });
    },
    auditFacets: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'viewer');
      const facets = await auditService.facets(args.projectId);
      const actors = (await Promise.all(facets.actorUserIds.map((id) => userOrNull(ctx, id)))).filter((u) => u !== null);
      return {
        actors,
        targetTypes: facets.targetTypes.map((value) => ({ value, label: targetTypeLabel(value) })),
        actions: facets.actions.map((value) => ({ value, label: actionLabel(value) })),
      };
    },
    agent: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      requireUser(ctx);
      const agent = await agentService.get(args.id);
      await requireProject(ctx, agent.projectId, 'viewer');
      return agent;
    },
    agentTemplates: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return agentService.templates();
    },
    myAgents: async (_: unknown, __: unknown, ctx: Ctx) => agentService.listActive(await accessibleProjectIds(ctx)),
    preview: async (_: unknown, args: { worksessionId: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.worksessionId, 'viewer');
      return previewService.get(args.worksessionId);
    },
    previewLog: async (_: unknown, args: { worksessionId: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.worksessionId, 'viewer');
      return previewService.log(args.worksessionId);
    },
    gitStatus: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.status(args);
    },
    gitDiff: async (_: unknown, args: WorkspaceRef & { path: string; staged?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.diff(args, args.path, args.staged ?? false);
    },
    gitCommitDiff: async (_: unknown, args: WorkspaceRef & { hash: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.show(args, args.hash);
    },
    gitBranches: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.branches(args);
    },
    gitLog: async (_: unknown, args: WorkspaceRef & { limit?: number | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.log(args, args.limit ?? undefined);
    },
    repoRefs: async (_: unknown, args: { projectId: string; refresh?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      const project = await projectService.get(args.projectId);
      await repoBrowser.refresh(project, ctx.user?.id, args.refresh ?? false);
      return repoBrowser.refs(project);
    },
    repoLog: async (_: unknown, args: { projectId: string; ref: string; limit?: number | null; skip?: number | null; path?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return repoBrowser.log(await projectService.get(args.projectId), args.ref, args.limit ?? undefined, args.skip ?? undefined, args.path);
    },
    repoCommit: async (_: unknown, args: { projectId: string; hash: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return repoBrowser.commit(await projectService.get(args.projectId), args.hash);
    },
    repoTree: async (_: unknown, args: { projectId: string; ref: string; path?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return repoBrowser.tree(await projectService.get(args.projectId), args.ref, args.path ?? '');
    },
    repoFile: async (_: unknown, args: { projectId: string; ref: string; path: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return repoBrowser.file(await projectService.get(args.projectId), args.ref, args.path);
    },
    hostedGitAvailable: (_: unknown, __: unknown, ctx: Ctx) => (requireUser(ctx), gitServer.available()),
    githubPullRequests: async (_: unknown, args: { projectId: string; state?: PullRequestFilter | null; limit?: number | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return pullRequestService.list(args.projectId, requireUser(ctx).id, args.state ?? 'OPEN', args.limit ?? 50);
    },
    githubPullRequest: async (_: unknown, args: { projectId: string; number: number; repo?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return pullRequestService.get(args.projectId, requireUser(ctx).id, args.number, repoArg(args.repo));
    },
    githubPullRequestDraft: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return pullRequestService.draft(args, requireUser(ctx).id);
    },
    deliveries: async (_: unknown, args: { projectId: string; worksessionId?: string | null; taskId?: string | null; kind?: string | null; limit?: number | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      const kind = args.kind?.toLowerCase();
      return deliveryService.list({ projectId: args.projectId, worksessionId: args.worksessionId ?? undefined, taskId: args.taskId ?? undefined, kind: kind === 'merge' || kind === 'deploy' ? kind : undefined, limit: args.limit ?? 50 });
    },
    delivery: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const d = await deliveryService.get(args.id);
      if (!d) return null;
      await requireProject(ctx, d.projectId);
      return d;
    },
    deployConfig: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return deliveryService.getConfig(args.projectId);
    },
    deliveryPolicy: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return deliveryPolicyService.get(args.projectId);
    },
    deliveryQualitySettings: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return deliveryQualityService.settings(args.projectId);
    },
    deliveryQualityReport: async (_: unknown, args: { projectId: string; days?: number | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return deliveryQualityService.report(args.projectId, args.days ?? 90);
    },
    ciStatus: async (_: unknown, args: { projectId: string; ref?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      const project = await projectService.get(args.projectId);
      const ci = await pullRequestService.ciStatus(args.projectId, requireUser(ctx).id, args.ref?.trim() || project.gitBranch || 'main');
      return { ...ci, verdict: ciVerdict(ci.state, ci.checks) };
    },
    pullRequests: async (_: unknown, args: { projectId?: string | null; taskId?: string | null; status?: string[] | null; stage?: string[] | null; limit?: number | null }, ctx: Ctx) => {
      if (args.projectId) {
        await requireProject(ctx, args.projectId);
        // La liste d'un projet rafraîchit ses PR depuis GitHub au passage (au plus toutes les 30 s).
        await trackedPullRequestService.sync(args.projectId, requireUser(ctx).id);
      }
      if (args.taskId) await guardTask(ctx, args.taskId, 'viewer');
      return trackedPullRequestService.list({
        projectId: args.projectId ?? undefined,
        projectIds: args.projectId ? undefined : await accessibleProjectIds(ctx),
        taskId: args.taskId ?? undefined,
        status: args.status?.map((s) => s.toLowerCase() as TrackedPullRequestStatus),
        stage: args.stage?.map((s) => s.toLowerCase() as PullRequestStage),
        limit: args.limit ?? undefined,
      });
    },
    pullRequest: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const pr = await trackedPullRequestService.get(args.id);
      await requireProject(ctx, pr.projectId);
      return pr;
    },
    workspaceEntries: async (_: unknown, args: WorkspaceRef & { path?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return fileService.list(args, args.path ?? '');
    },
    workspaceFile: async (_: unknown, args: WorkspaceRef & { path: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return fileService.read(args, args.path);
    },
    githubRepositories: (_: unknown, args: { query?: string | null }, ctx: Ctx) => {
      settingsUser(ctx);
      return githubService.listRepositories(settingsUser(ctx).id, args.query);
    },
    gitlabRepositories: (_: unknown, args: { query?: string | null }, ctx: Ctx) => gitlabService.listRepositories(settingsUser(ctx).id, args.query),
    me: (_: unknown, __: unknown, ctx: Ctx) => ctx.user,
    myLoginMethods: (_: unknown, __: unknown, ctx: Ctx) => signInService.methodsOf(requireUser(ctx).id),
    myChromeBrowsers: (_: unknown, __: unknown, ctx: Ctx) => chromeBrowserService.list(requireUser(ctx).id),
    users: (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      return userService.list();
    },
    sidebarProjects: async (_: unknown, args: { open?: OpenItems | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      // L'espace personnel figure dans la sidebar (en tête, voir le front), pas dans la liste des projets.
      const mine = await projectService.listForUser(user.id, { includePersonal: true });
      if (!user.isSuperAdmin || !args.open) return mine;
      const extra = (await userService.projectIdsHolding(args.open)).filter((id) => !mine.some((p) => p.id === id));
      // L'espace personnel d'une autre personne n'est jamais ouvert à un super administrateur.
      const others = (await Promise.all(extra.map((id) => projectService.get(id).catch(() => null)))).filter((p): p is Project => Boolean(p) && !isPersonalProject(p!));
      return [...mine, ...others].sort((a, b) => a.name.localeCompare(b.name));
    },
    search: async (_: unknown, args: { query: string; kinds?: SearchKind[] | null; limit?: number | null; projectId?: string | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const memberProjectIds = await accessibleProjectIds(ctx);
      if (args.projectId) await requireProject(ctx, args.projectId);
      const projectIds = args.projectId ? [args.projectId] : user.isSuperAdmin ? (await projectService.list()).map((p) => p.id) : memberProjectIds;
      return { query: args.query, groups: await searchService.search({ userId: user.id, memberProjectIds, projectIds, onlyProjectId: args.projectId ?? undefined }, args.query, args.kinds, args.limit) };
    },
    sessionOwners: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      const ids = await sessionRepository.listOwnerIds(args.projectId ? [args.projectId] : await accessibleProjectIds(ctx));
      const users = (await Promise.all(ids.map((id) => userService.get(id).catch(() => null)))).filter((u): u is User => Boolean(u));
      return users.sort((a, b) => a.name.localeCompare(b.name));
    },
    archivedSessions: async (_: unknown, args: { projectId: string; worksessionId?: string | null; search?: string | null; limit?: number | null; offset?: number | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return sessionService.list({ projectId: args.projectId, worksessionId: args.worksessionId ?? undefined, search: args.search ?? undefined, archived: 'only', limit: args.limit ?? 50, offset: args.offset ?? 0 });
    },
    gitBranchChanges: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.branchChanges(args);
    },
    gitBranchFileDiff: async (_: unknown, args: WorkspaceRef & { path: string; origPath?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return gitService.branchDiff(args, args.path, args.origPath);
    },
    vaultItems: (_: unknown, args: { kind?: VaultItemKind | null }, ctx: Ctx) => vaultService.listAccessible(settingsUser(ctx).id, args.kind),
    vaultItem: (_: unknown, args: { id: string }, ctx: Ctx) => vaultService.findFor(settingsUser(ctx).id, args.id),
    vaultShareCandidates: (_: unknown, __: unknown, ctx: Ctx) => userService.listColleagues(requireUser(ctx).id),
    vaultGoogleAvailable: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return googleAccountService.configured;
    },
    taskPrompt: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'viewer');
      return taskService.promptFor(args.id);
    },
    taskPeople: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      return taskService.people(args.projectId ? [args.projectId] : await accessibleProjectIds(ctx));
    },
    taskTags: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      return taskService.tags(args.projectId ? [args.projectId] : await accessibleProjectIds(ctx));
    },
    sharedPage: (_: unknown, args: { id: string }, ctx: Ctx) => sharedPageService.getFor(requireUser(ctx).id, args.id).catch(() => null),
    sharedPages: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      if (!args.projectId) return sharedPageService.listFor(user.id);
      await requireProject(ctx, args.projectId, 'viewer');
      return sharedPageService.listForProject(user, args.projectId);
    },
    favoriteSharedPages: (_: unknown, __: unknown, ctx: Ctx) => sharedPageService.listFavorites(requireUser(ctx)),
    pushPublicKey: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return pushService.publicKey();
    },
    envFiles: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return envFileService.list(args.projectId);
    },
    envVaultChoices: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const userId = requireUser(ctx).id;
      return Promise.all(
        (await envFileService.vaultChoices(args.projectId, userId)).map(async ({ item, fields }) => ({
          itemId: item.id,
          name: item.name,
          kind: item.kind,
          envExport: item.envExport,
          canManage: (await vaultService.permissionFor(userId, item)) === 'manage',
          fields,
        })),
      );
    },
    pushPreferences: (_: unknown, __: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      return pushPreferencesService.list(user.id, user.isAdmin);
    },
    myNotificationChannels: (_: unknown, __: unknown, ctx: Ctx) => notificationChannelService.list({ userId: requireUser(ctx).id }),
    projectNotificationChannels: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return notificationChannelService.list({ projectId: args.projectId });
    },
    mailSettings: (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      return mailService.view();
    },
    emailNotificationsAvailable: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return mailService.configured();
    },
    settings: (_: unknown, __: unknown, ctx: Ctx) => appSettings(ctx),
    vaultAwsAccounts: (_: unknown, args: { id: string }, ctx: Ctx) => awsService.accounts(vaultActor(ctx), args.id),
    vaultTokenServices: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return TOKEN_SERVICE_IDS.map((id) => ({ id, label: TOKEN_SERVICES[id].label, prefix: TOKEN_SERVICES[id].prefix, opencode: Boolean((TOKEN_SERVICES[id] as { opencode?: boolean }).opencode) }));
    },
    // ---- Workflows ----------------------------------------------------------------------------
    llmKeys: async (_: unknown, __: unknown, ctx: Ctx) => ({
      litellm: await usableItems(ctx, ['litellm']),
      langfuse: await usableItems(ctx, ['langfuse']),
      tokens: (await usableItems(ctx, ['token'])).filter((i) => ['openai', 'anthropic'].includes((i.settings as TokenSettings).service) && !isOauthToken(i)),
    }),
    workflows: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => {
      if (args.projectId) {
        await requireProject(ctx, args.projectId);
        return workflowService.list({ projectId: args.projectId });
      }
      return workflowService.list({ projectIds: await accessibleProjectIds(ctx) });
    },
    workflow: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const workflow = await workflowService.find(args.id);
      if (!workflow || !(await roleFor(ctx, workflow.projectId))) return null;
      return workflow;
    },
    workflowRuns: async (_: unknown, args: { workflowId?: string | null; projectId?: string | null; limit?: number | null }, ctx: Ctx) => {
      if (args.workflowId) await guardWorkflow(ctx, args.workflowId, 'viewer');
      if (args.projectId) await requireProject(ctx, args.projectId);
      return workflowService.listRuns({ workflowId: args.workflowId ?? undefined, projectId: args.projectId ?? undefined, projectIds: args.workflowId || args.projectId ? undefined : await accessibleProjectIds(ctx), limit: args.limit ?? 50 });
    },
    workflowRun: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const run = await workflowService.findRun(args.id);
      if (!run || !(await roleFor(ctx, run.projectId))) return null;
      return run;
    },
    validateWorkflow: async (_: unknown, args: { projectId: string; definition: unknown }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return workflowService.issues(args.definition);
    },
    serverHealth: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      const health = await healthService.snapshot();
      const project = (id: string | null) => (id ? projectService.get(id).catch(() => null) : null);
      return {
        ...health,
        docker: { ...health.docker, containers: health.docker.containers.map((c) => ({ ...c, project: () => project(c.projectId) })) },
        disk: { ...health.disk, workspaces: health.disk.workspaces.map((w) => ({ ...w, project: () => project(w.projectId) })) },
      };
    },
    claudeLogin: (_: unknown, args: { id: string }, ctx: Ctx) => loginService.get(args.id, requireUser(ctx).id),
    providers: async (_: unknown, __: unknown, ctx: Ctx) => {
      const list = await listProviders(requireUser(ctx).id);
      // Coûts en crédits : le budget par session en USD n'est pas proposé (le budget par défaut des Paramètres l'est, converti).
      if ((await costRate(ctx)) === null) return list;
      return list.map((p) => ({ ...p, configFields: p.configFields.filter((f) => !/BudgetUsd$/.test(f.key)) }));
    },
    costDisplay: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return costDisplay(ctx);
    },
    sessions: async (_: unknown, args: { projectId?: string | null; status?: GqlStatus | null; provider?: string | null; ownerId?: string | null; kind?: 'SESSION' | 'CHAT' | null; limit?: number | null; offset?: number | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      return sessionService.list({
        projectId: args.projectId ?? undefined,
        projectIds: args.projectId ? undefined : await accessibleProjectIds(ctx),
        kind: args.kind === 'CHAT' ? 'chat' : 'session',
        status: fromGqlStatus(args.status),
        provider: args.provider ?? undefined,
        ownerId: args.ownerId ?? undefined,
        limit: args.limit ?? undefined,
        offset: args.offset ?? undefined,
      });
    },
    session: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const session = await sessionService.get(args.id);
      if (session) await requireProject(ctx, session.projectId);
      return session;
    },
    personalSpace: (_: unknown, __: unknown, ctx: Ctx) => personalService.ensure(requireUser(ctx)),
    chats: (_: unknown, args: { limit?: number | null }, ctx: Ctx) => personalService.listChats(requireUser(ctx), args.limit ?? undefined),
    sessionChanges: async (_: unknown, args: { sessionId: string }, ctx: Ctx) => {
      await guardSession(ctx, args.sessionId, 'viewer');
      return sessionChangesService.list(await loadSession(args.sessionId));
    },
    sessionFileDiff: async (_: unknown, args: { sessionId: string; path: string; origPath?: string | null }, ctx: Ctx) => {
      await guardSession(ctx, args.sessionId, 'viewer');
      return sessionChangesService.diff(await loadSession(args.sessionId), args.path, args.origPath);
    },
    sessionSchedules: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => {
      if (args.projectId) {
        await requireProject(ctx, args.projectId);
        return scheduleService.listForProjects([args.projectId]);
      }
      return scheduleService.listForProjects(await accessibleProjectIds(ctx));
    },
    sessionSchedule: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const schedule = await scheduleService.get(args.id);
      if (!schedule) return null;
      await requireProject(ctx, schedule.projectId);
      return schedule;
    },
    schedulePermissionSuggestions: async (_: unknown, args: { projectId: string; scheduleId?: string | null; prompt?: string | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await requireProject(ctx, args.projectId, 'member');
      let ownerId: string | null = user.id;
      if (args.scheduleId) {
        const schedule = await scheduleService.require(args.scheduleId);
        if (schedule.projectId !== args.projectId) throw new AppError("La planification n'appartient pas à ce projet");
        ownerId = schedule.ownerId;
      }
      const list = await scheduleService.permissionSuggestions({ scheduleId: args.scheduleId ?? null, projectId: args.projectId, ownerId, prompt: args.prompt });
      return list.map((s) => ({ ...s, source: s.source.toUpperCase() }));
    },
    scheduleNextRuns: (_: unknown, args: { cron: string; timezone?: string | null; count?: number | null }, ctx: Ctx) => {
      requireUser(ctx);
      return scheduleService.preview(args.cron, args.timezone, args.count ?? 5);
    },
    projects: (_: unknown, args: { all?: boolean | null; includePersonal?: boolean | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      return args.all && user.isSuperAdmin ? projectService.list() : projectService.listForUser(user.id, { includePersonal: args.includePersonal ?? false });
    },
    // Ouvert aux invités du projet : seuls les champs de GUEST_TYPE_FIELDS.Project leur répondent (guestFields.ts).
    project: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'guest');
      return projectService.get(args.id);
    },
    guestProjects: (_: unknown, __: unknown, ctx: Ctx) => projectService.listForUser(requireUser(ctx).id, { guests: 'only' }),
    requests: async (_: unknown, args: { status?: GqlRequestStatus | null; sessionId?: string | null; limit?: number | null; newestFirst?: boolean | null }, ctx: Ctx) => {
      if (args.sessionId) await guardSession(ctx, args.sessionId, 'viewer');
      return requestService.list({
        status: fromGqlRequestStatus(args.status),
        sessionId: args.sessionId ?? undefined,
        projectIds: args.sessionId ? undefined : await accessibleProjectIds(ctx),
        limit: args.limit ?? undefined,
        newestFirst: args.newestFirst ?? false,
      });
    },
    request: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardRequest(ctx, args.id, 'viewer');
      return requestService.get(args.id);
    },
    terminal: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTerminal(ctx, args.id, 'viewer');
      return terminalService.get(args.id);
    },
    worksession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.id, 'viewer');
      return worksessionService.get(args.id);
    },
    notifications: async (_: unknown, args: { unreadOnly?: boolean | null; limit?: number | null; projectId?: string | null }, ctx: Ctx) =>
      notificationService.list({ unreadOnly: args.unreadOnly ?? false, limit: args.limit ?? undefined, ...(await notificationScope(ctx, args.projectId)) }),
    unreadNotificationCount: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => notificationService.countUnread(await notificationScope(ctx, args.projectId)),
    billingStatement: (_: unknown, args: { month?: string | null }, ctx: Ctx) => billingService.statement(args.month, requireAdmin(ctx).isSuperAdmin),
    billingSettings: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireSuperAdmin(ctx);
      const stored = await billingService.stored();
      return { ...(stored ?? (await billingService.settings())), configured: stored !== null };
    },
    dashboard: async (_: unknown, __: unknown, ctx: Ctx) => dashboardService.build(requireUser(ctx).id, await accessibleProjectIds(ctx), new Date(), requireUser(ctx).isAdmin),
    usageReport: async (_: unknown, args: { projectId?: string | null; days?: number | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      else requireAdmin(ctx);
      return usageReport(args.projectId ? [args.projectId] : null, args.days ?? 30);
    },
    projectDashboard: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id);
      return dashboardService.buildForProject(requireUser(ctx).id, await projectService.get(args.id), new Date(), requireUser(ctx).isAdmin);
    },
    cockpitLayout: (_: unknown, args: { scope: string }, ctx: Ctx) => cockpitService.resolve(requireUser(ctx), args.scope),
    cockpitLayoutHistory: (_: unknown, args: { scope: string }, ctx: Ctx) => cockpitService.history(requireUser(ctx), args.scope),
    conversation: async (_: unknown, args: { id: string }, ctx: Ctx) => (await guardConversation(ctx, args.id, 'guest')).conversation,
    conversationBySlug: async (_: unknown, args: { projectId: string; slug: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'guest');
      return conversationService.resolve(args.projectId, args.slug).catch(() => null);
    },
    inbox: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => inboxService.build(await inboxProjectIds(ctx, args.projectId)),
    inboxCounts: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => inboxService.counts(await inboxProjectIds(ctx, args.projectId)),
    unreadMessagesByProject: async (_: unknown, __: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      // Les projets où l'on n'est qu'invité comptent : ce sont leurs conversations que l'on suit.
      const projects = await projectService.listForUser(user.id, { includePersonal: false, guests: 'include' });
      const counts = await conversationService.unreadByProject(projects.map((p) => p.id), user.id);
      return projects.map((project) => ({ project, count: counts.get(project.id) ?? 0 }));
    },
    tasks: async (_: unknown, args: { projectId?: string | null; status?: GqlTaskStatus[] | null; priority?: GqlTaskPriority | null; assignee?: string | null; reporter?: string | null; tag?: string | null; mine?: boolean | null; closedSince?: Date | null; limit?: number | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      return taskService.list({
        projectId: args.projectId ?? undefined,
        projectIds: args.projectId ? undefined : await accessibleProjectIds(ctx),
        status: fromGqlTaskStatuses(args.status) ?? ['todo', 'in_progress'],
        priority: fromGqlTaskPriority(args.priority),
        assignee: args.assignee ?? undefined,
        reporter: args.reporter ?? undefined,
        tag: args.tag?.trim() || undefined,
        assigneeEmail: args.mine ? requireUser(ctx).email : undefined,
        closedSince: args.closedSince ?? undefined,
        limit: args.limit ?? undefined,
      });
    },
    task: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'viewer');
      return taskService.get(args.id);
    },
    contextInstruction: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardInstruction(ctx, args.id, 'viewer');
      return contextService.getInstruction(args.id);
    },
    searchContext: async (_: unknown, args: { projectId: string; query: string; agentId?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return contextService.search(args.projectId, args.query, await projectAgentLibrary(args.projectId, args.agentId));
    },
  },

  Mutation: withCtoTime(withAudit({
    createAgent: async (_: unknown, args: { projectId: string; input: GqlAgentInput }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return agentService.create(args.projectId, fromGqlAgentInput(args.input), requireUser(ctx));
    },
    updateAgent: async (_: unknown, args: { id: string; input: GqlAgentInput }, ctx: Ctx) => {
      await guardAgentManager(ctx, args.id);
      return agentService.update(args.id, fromGqlAgentInput(args.input));
    },
    setAgentEnabled: async (_: unknown, args: { id: string; enabled: boolean }, ctx: Ctx) => {
      await guardAgentManager(ctx, args.id);
      return agentService.setEnabled(args.id, args.enabled);
    },
    deleteAgent: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardAgentManager(ctx, args.id);
      return agentService.remove(args.id);
    },
    setAgentManagers: async (_: unknown, args: { id: string; managers: { userId: string; role: string }[] }, ctx: Ctx) => {
      await guardAgentManager(ctx, args.id);
      return agentService.setManagers(args.id, args.managers.map((m) => ({ userId: m.userId, role: m.role.toLowerCase() as AgentManagerRole })));
    },
    summonAgent: async (_: unknown, args: { id: string; text: string; taskId?: string | null; attachments?: AttachmentInput[] | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const agent = await agentService.get(args.id);
      await requireProject(ctx, agent.projectId, 'member');
      return agentService.summon(agent.id, { taskId: args.taskId ?? null, text: args.text, attachments: args.attachments ?? null, requestedById: user.id });
    },
    takeOverSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return agentService.takeOver(args.id, requireUser(ctx));
    },
    handBackSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return agentService.handBack(args.id, requireUser(ctx));
    },
    setAgentDelegation: async (_: unknown, args: { id: string; account: string; delegate: boolean; readOnly?: boolean | null; pullRequests?: boolean | null; merge?: boolean | null }, ctx: Ctx) => {
      const agent = await guardAgentManager(ctx, args.id);
      // On ne prête que son propre compte : la personne connectée est la délégante ; retirer une délégation est ouvert aux gestionnaires.
      const delegateId = args.delegate ? requireUser(ctx).id : null;
      const kinds: AgentAccountKind[] = args.account === 'GIT' ? ['github', 'gitlab'] : [args.account.toLowerCase() as AgentAccountKind];
      let updated = agent;
      for (const kind of kinds) updated = await agentService.setDelegation(agent.id, kind, delegateId, { readOnly: args.readOnly ?? null, pullRequests: args.pullRequests ?? null, merge: args.merge ?? null });
      return updated;
    },
    runAgentAction: async (_: unknown, args: { id: string; key: string; taskId?: string | null }, ctx: Ctx) => {
      const agent = await agentService.get(args.id);
      await requireProject(ctx, agent.projectId, 'member');
      return agentService.runAction(agent.id, args.key, { taskId: args.taskId ?? null, requestedById: requireUser(ctx).id });
    },
    gitStage: async (_: unknown, args: WorkspaceRef & { paths: string[] }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.stage(args, args.paths);
      return gitService.status(args);
    },
    gitUnstage: async (_: unknown, args: WorkspaceRef & { paths: string[] }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.unstage(args, args.paths);
      return gitService.status(args);
    },
    gitDiscard: async (_: unknown, args: WorkspaceRef & { paths: string[] }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.discard(args, args.paths);
      return gitService.status(args);
    },
    discardSessionFile: async (_: unknown, args: { sessionId: string; path: string; origPath?: string | null }, ctx: Ctx) => {
      await guardSession(ctx, args.sessionId, 'member');
      return sessionChangesService.discard(await loadSession(args.sessionId), args.path, args.origPath);
    },
    gitCommit: async (_: unknown, args: WorkspaceRef & { message: string; stageAll?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.commit(args, args.message, args.stageAll ?? false);
      return gitService.status(args);
    },
    gitFetch: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.fetch(args, requireUser(ctx).id);
      return gitService.status(args);
    },
    gitPull: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.pull(args, requireUser(ctx).id);
      return gitService.status(args);
    },
    gitPush: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.push(args, requireUser(ctx).id);
      return gitService.status(args);
    },
    gitMergeBase: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.mergeBase(args, requireUser(ctx).id);
      gitService.invalidate(args);
      return gitService.status(args);
    },
    gitAbortOperation: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.abortOperation(args);
      gitService.invalidate(args);
      return gitService.status(args);
    },
    resolveGitConflicts: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return requestGitConflictResolution(args, requireUser(ctx).id);
    },
    gitCheckout: async (_: unknown, args: WorkspaceRef & { branch: string; create?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.checkout(args, args.branch, args.create ?? false);
      return gitService.status(args);
    },
    backupHostedGit: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const project = await projectService.get(args.projectId);
      if (!project.gitHosted) throw new AppError("Le dépôt de ce projet n'est pas hébergé par Skipper");
      await gitServer.backup(project, { force: true });
      return hostedGitView(project);
    },
    createPullRequest: async (_: unknown, args: WorkspaceRef & { title: string; body?: string | null; base?: string | null; draft?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const user = requireUser(ctx);
      const pr = await pullRequestService.create(args, user.id, args);
      // La PR ouverte depuis l'interface est suivie (reliée à la tâche de sa branche).
      await trackedPullRequestService.recordGithub(args.projectId, pr, { type: 'human', userId: user.id }).catch((err) => log.error('[pull-requests] suivi de la PR créée', err));
      return pr;
    },
    mergePullRequest: async (_: unknown, args: { projectId: string; number: number; method?: MergeMethod | null; cleanup?: MergeCleanup | null; repo?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const user = requireUser(ctx);
      const result = await pullRequestService.merge(args.projectId, user.id, args.number, args.method ?? 'MERGE', args.cleanup ?? { deleteRemoteBranch: true, deleteWorksession: true, completeTasks: true }, repoArg(args.repo));
      await trackedPullRequestService.markMerged(args.projectId, result.pullRequest, result.sha, { type: 'human', userId: user.id }).catch((err) => log.error('[pull-requests] suivi de la PR fusionnée', err));
      return result;
    },
    registerPullRequest: async (_: unknown, args: { projectId: string; url?: string | null; number?: number | null; taskId?: string | null; note?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const user = requireUser(ctx);
      return trackedPullRequestService.register(args.projectId, { url: args.url, number: args.number }, { taskId: args.taskId, note: args.note, userId: user.id }, { type: 'human', userId: user.id });
    },
    updatePullRequest: async (_: unknown, args: { id: string; input: { status?: string | null; note?: string | null; taskId?: string | null } }, ctx: Ctx) => {
      const pr = await trackedPullRequestService.get(args.id);
      await requireProject(ctx, pr.projectId, 'member');
      return trackedPullRequestService.update(args.id, { ...args.input, status: args.input.status ? (args.input.status.toLowerCase() as TrackedPullRequestStatus) : undefined });
    },
    deletePullRequest: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const pr = await trackedPullRequestService.get(args.id);
      await requireProject(ctx, pr.projectId, 'member');
      return trackedPullRequestService.delete(args.id);
    },
    syncPullRequests: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return trackedPullRequestService.sync(args.projectId, requireUser(ctx).id, { force: true });
    },
    deliver: async (_: unknown, args: { sessionId?: string | null; taskId?: string | null; deploy?: boolean | null }, ctx: Ctx) => {
      if (args.sessionId) await guardSession(ctx, args.sessionId, 'member');
      else if (args.taskId) await requireProject(ctx, (await taskService.get(args.taskId)).projectId, 'member');
      else throw new AppError('Livrer quoi ? Une session ou une tâche est attendue');
      const userId = requireUser(ctx).id;
      if (args.deploy) {
        const projectId = args.sessionId ? await projectOfSession(args.sessionId) : (await taskService.get(args.taskId!)).projectId;
        await requireProject(ctx, projectId, 'admin');
      }
      return deliveryService.deliver({ sessionId: args.sessionId, taskId: args.taskId, userId, deploy: Boolean(args.deploy) });
    },
    requestDeploy: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return deliveryService.requestDeploy(args.projectId, requireUser(ctx).id);
    },
    cancelDelivery: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const d = await deliveryService.get(args.id);
      if (!d) throw new NotFoundError('Livraison introuvable');
      await requireProject(ctx, d.projectId, d.kind === 'deploy' ? 'admin' : 'member');
      return deliveryService.cancel(args.id, requireUser(ctx).id);
    },
    setDeployConfig: async (_: unknown, args: { projectId: string; input?: DeployConfigInput | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return deliveryService.setConfig(args.projectId, args.input ?? null, requireUser(ctx).id);
    },
    setDeliveryPolicy: async (_: unknown, args: { projectId: string; rules: { tag: string; mode: string }[] }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return deliveryPolicyService.set(args.projectId, args.rules, requireUser(ctx).id);
    },
    setDeliveryQualitySettings: async (_: unknown, args: { projectId: string; tags?: string[] | null; windowHours?: number | null; reset?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return deliveryQualityService.setSettings(args.projectId, args.reset ? null : { tags: args.tags, windowHours: args.windowHours }, requireUser(ctx).id);
    },
    setTaskDelivery: async (_: unknown, args: { taskId: string; deliveryId?: string | null; reset?: boolean | null }, ctx: Ctx) => {
      const task = await taskService.get(args.taskId);
      await requireProject(ctx, task.projectId, 'member');
      await deliveryQualityService.setLink(task.id, args.deliveryId ?? null, requireUser(ctx).id, { reset: Boolean(args.reset) });
      return task;
    },
    backfillDeliveryQualityTasks: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return deliveryQualityService.backfill(args.projectId);
    },
    watchPullRequests: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return trackedPullRequestService.watch(args.projectId, requireUser(ctx).id);
    },
    resolvePullRequestConflicts: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const pr = await trackedPullRequestService.get(args.id);
      await requireProject(ctx, pr.projectId, 'member');
      return requestConflictResolution(args.id, { type: 'human', userId: requireUser(ctx).id });
    },
    requestCodeReview: async (_: unknown, args: { projectId: string; worksessionId?: string | null; pullRequestId?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return reviewService.request(args, requireUser(ctx).id);
    },
    writeWorkspaceFile: async (_: unknown, args: WorkspaceRef & { path: string; content: string; expectedModifiedAt?: Date | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return fileService.write(args, args.path, args.content, args.expectedModifiedAt ?? null);
    },
    createWorkspaceEntry: async (_: unknown, args: WorkspaceRef & { path: string; kind: 'dir' | 'file' }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return fileService.create(args, args.path, args.kind);
    },
    renameWorkspaceEntry: async (_: unknown, args: WorkspaceRef & { path: string; newPath: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return fileService.rename(args, args.path, args.newPath);
    },
    deleteWorkspaceEntry: async (_: unknown, args: WorkspaceRef & { path: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return fileService.delete(args, args.path);
    },
    setMaintenanceMode: (_: unknown, args: { enabled: boolean; message?: string | null }, ctx: Ctx) => {
      const user = requireAdmin(ctx);
      serverSettings.setMaintenance(args.enabled, args.message ?? null, user.id);
      log.info(`[server] mode maintenance ${args.enabled ? 'activé' : 'levé'} par ${user.email}`);
      // Fin de la maintenance : les sessions en file d'attente peuvent démarrer.
      if (!args.enabled) void sessionService.drainQueue();
      return appSettings(ctx);
    },
    updateBillingSettings: async (_: unknown, { input }: { input: Partial<BillingSettings> }, ctx: Ctx) => {
      requireSuperAdmin(ctx);
      return { ...(await billingService.update(input)), configured: true };
    },
    addCtoTimeEntry: (_: unknown, { input }: { input: CtoTimeEntryInput }, ctx: Ctx) => billingService.addCtoTime(input, requireSuperAdmin(ctx).id),
    deleteCtoTimeEntry: (_: unknown, args: { id: string }, ctx: Ctx) => {
      requireSuperAdmin(ctx);
      return billingService.deleteCtoTime(args.id);
    },
    updateServerSettings: async (
      _: unknown,
      args: { autoResumeInterrupted?: boolean | null; maxConcurrentSessions?: number | null; idleSessionTimeoutMinutes?: number | null; memoryAlertThresholdMb?: number | null },
      ctx: Ctx,
    ) => {
      requireAdmin(ctx);
      await serverSettings.update({
        autoResumeInterrupted: args.autoResumeInterrupted ?? undefined,
        maxConcurrentSessions: args.maxConcurrentSessions ?? undefined,
        idleSessionTimeoutMinutes: args.idleSessionTimeoutMinutes ?? undefined,
        memoryAlertThresholdMb: args.memoryAlertThresholdMb ?? undefined,
      });
      // Limite relevée : des places se libèrent peut-être pour la file d'attente.
      void sessionService.drainQueue();
      return appSettings(ctx);
    },
    setCellClaudeAccount: async (_: unknown, args: { itemId?: string | null }, ctx: Ctx) => {
      await cellClaude.set(requireAdmin(ctx).id, args.itemId ?? null);
      return appSettings(ctx);
    },
    updateOnboarding: async (_: unknown, args: { dismissed?: boolean | null; completed?: boolean | null }, ctx: Ctx) => {
      await onboardingService.update(settingsUser(ctx).id, { dismissed: args.dismissed ?? undefined, completed: args.completed ?? undefined });
      return appSettings(ctx);
    },
    updateClaudeSettings: async (_: unknown, { input }: { input: ClaudeSettingsPatch }, ctx: Ctx) => {
      const rate = await costRate(ctx);
      await (await claudeSettings.forUser(settingsUser(ctx).id)).update({ ...input, monthlyBudgetUsd: toStoredUsd(input.monthlyBudgetUsd, rate), sessionBudgetUsd: toStoredUsd(input.sessionBudgetUsd, rate) });
      return appSettings(ctx);
    },
    setClaudeApiKeyItem: async (_: unknown, args: { itemId?: string | null }, ctx: Ctx) => {
      await (await claudeSettings.forUser(settingsUser(ctx).id)).setApiKeyItem(args.itemId ?? null);
      return appSettings(ctx);
    },
    setClaudeOauthItem: async (_: unknown, args: { itemId?: string | null }, ctx: Ctx) => {
      await (await claudeSettings.forUser(settingsUser(ctx).id)).setOauthItem(args.itemId ?? null);
      return appSettings(ctx);
    },
    clearClaudeOauthToken: async (_: unknown, __: unknown, ctx: Ctx) => {
      await (await claudeSettings.forUser(settingsUser(ctx).id)).clearOauthToken();
      return appSettings(ctx);
    },
    startClaudeLogin: (_: unknown, __: unknown, ctx: Ctx) => loginService.start(settingsUser(ctx).id),
    completeClaudeLogin: (_: unknown, args: { id: string; code: string }, ctx: Ctx) => loginService.complete(args.id, args.code, settingsUser(ctx).id),
    cancelClaudeLogin: (_: unknown, args: { id: string }, ctx: Ctx) => loginService.cancel(args.id, settingsUser(ctx).id),
    verifyClaudeAuth: async (_: unknown, args: { mode?: ClaudeAuthMode | null }, ctx: Ctx) => {
      await claudeSettings.verify(settingsUser(ctx).id, args.mode ?? null);
      return appSettings(ctx);
    },
    updateOpencodeSettings: async (_: unknown, { input }: { input: OpencodeSettingsPatch }, ctx: Ctx) => {
      await (await opencodeSettings.forUser(settingsUser(ctx).id)).update({ ...input, sessionBudgetUsd: toStoredUsd(input.sessionBudgetUsd, await costRate(ctx)) });
      return appSettings(ctx);
    },
    setOpencodeKeyItem: async (_: unknown, args: { provider: string; itemId?: string | null }, ctx: Ctx) => {
      await (await opencodeSettings.forUser(settingsUser(ctx).id)).setKeyItem(args.provider, args.itemId ?? null);
      return appSettings(ctx);
    },
    refreshOpencodeModels: async (_: unknown, __: unknown, ctx: Ctx) => {
      await (await opencodeSettings.forUser(settingsUser(ctx).id)).listModels();
      return appSettings(ctx);
    },
    startAwsLogin: (_: unknown, args: { id: string }, ctx: Ctx) => awsService.startLogin(vaultActor(ctx), args.id),
    pollAwsLogin: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const r = await awsService.pollLogin(vaultActor(ctx), args.id);
      return { ...r, status: r.status.toUpperCase(), item: r.item ? { ...r.item, permission: 'manage' } : null };
    },
    startGithubDeviceLogin: (_: unknown, __: unknown, ctx: Ctx) => githubDeviceService.start(settingsUser(ctx).id),
    pollGithubDeviceLogin: (_: unknown, args: { id: string }, ctx: Ctx) => githubDeviceService.poll(settingsUser(ctx).id, args.id),
    connectGithubFromVault: (_: unknown, args: { itemId: string }, ctx: Ctx) => githubService.connectFromVault(settingsUser(ctx).id, args.itemId),
    setDefaultGithubAccount: async (_: unknown, args: { accountId: string }, ctx: Ctx) => {
      await githubService.setDefault(settingsUser(ctx).id, args.accountId);
      return appSettings(ctx);
    },
    disconnectGithub: async (_: unknown, args: { accountId?: string | null }, ctx: Ctx) => {
      await githubService.disconnect(settingsUser(ctx).id, args.accountId ?? null);
      return appSettings(ctx);
    },
    startGitlabDeviceLogin: (_: unknown, __: unknown, ctx: Ctx) => gitlabDeviceService.start(settingsUser(ctx).id),
    pollGitlabDeviceLogin: (_: unknown, args: { id: string }, ctx: Ctx) => gitlabDeviceService.poll(settingsUser(ctx).id, args.id),
    connectGitlabFromVault: (_: unknown, args: { itemId: string; host?: string | null }, ctx: Ctx) => gitlabService.connectFromVault(settingsUser(ctx).id, args.itemId, args.host),
    setDefaultGitlabAccount: async (_: unknown, args: { accountId: string }, ctx: Ctx) => {
      await gitlabService.setDefault(settingsUser(ctx).id, args.accountId);
      return appSettings(ctx);
    },
    disconnectGitlab: async (_: unknown, args: { accountId?: string | null }, ctx: Ctx) => {
      await gitlabService.disconnect(settingsUser(ctx).id, args.accountId ?? null);
      return appSettings(ctx);
    },
    // ---- Workflows ----------------------------------------------------------------------------
    createWorkflow: async (_: unknown, { input }: { input: WorkflowInput & { projectId: string } }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await requireProject(ctx, input.projectId, 'member');
      return workflowService.create(input.projectId, input, user.id);
    },
    updateWorkflow: async (_: unknown, { id, input }: { id: string; input: WorkflowInput }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await guardWorkflow(ctx, id, 'member');
      return workflowService.update(id, input, user.id);
    },
    deleteWorkflow: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardWorkflow(ctx, args.id, 'member');
      return workflowService.delete(args.id);
    },
    runWorkflow: async (_: unknown, args: { id: string; inputs?: Record<string, unknown> | null; test?: boolean | null; triggerKey?: string | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await guardWorkflow(ctx, args.id, 'member');
      return workflowService.run(args.id, { inputs: args.inputs, trigger: args.test ? 'test' : 'manual', ownerId: user.id, triggerKey: args.triggerKey });
    },
    cancelWorkflowRun: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const run = await workflowService.getRun(args.id);
      await requireProject(ctx, run.projectId, 'member');
      return workflowService.cancelRun(args.id);
    },
    setWorkflowSchedule: async (_: unknown, args: { id: string; input: AutomationScheduleInput; inputs?: Record<string, unknown> | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await guardWorkflow(ctx, args.id, 'member');
      return workflowService.setSchedule(args.id, args.input, args.inputs, user.id);
    },
    clearWorkflowSchedule: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardWorkflow(ctx, args.id, 'member');
      return workflowService.clearSchedule(args.id);
    },

    inviteUser: (_: unknown, args: { email: string; isAdmin?: boolean | null }, ctx: Ctx) => {
      requireAdmin(ctx);
      return userService.inviteToApp(args.email, Boolean(args.isAdmin));
    },
    setUserAdmin: (_: unknown, args: { userId: string; isAdmin: boolean }, ctx: Ctx) => {
      requireAdmin(ctx);
      return userService.setAdmin(args.userId, args.isAdmin);
    },
    setUserSuperAdmin: (_: unknown, args: { userId: string; isSuperAdmin: boolean }, ctx: Ctx) => {
      requireSuperAdmin(ctx);
      return userService.setSuperAdmin(args.userId, args.isSuperAdmin);
    },
    setUserCto: (_: unknown, args: { userId: string; isCto: boolean }, ctx: Ctx) => {
      requireSuperAdmin(ctx);
      return userService.setCto(args.userId, args.isCto);
    },
    deleteUser: (_: unknown, args: { userId: string }, ctx: Ctx) => userService.delete(args.userId, requireAdmin(ctx)),
    connectChromeBrowser: (_: unknown, args: { name: string }, ctx: Ctx) => chromeBrowserService.create(requireUser(ctx).id, args.name),
    removeChromeBrowser: (_: unknown, args: { id: string }, ctx: Ctx) => chromeBrowserService.delete(requireUser(ctx).id, args.id),
    setMyPassword: (_: unknown, args: { currentPassword?: string | null; newPassword: string }, ctx: Ctx) => signInService.setPassword(requireUser(ctx), args.currentPassword, args.newPassword, ctx.sessionTokenHash ?? null),
    removeMyPassword: (_: unknown, __: unknown, ctx: Ctx) => signInService.removePassword(requireUser(ctx)),
    unlinkMyLoginIdentity: (_: unknown, args: { provider: string }, ctx: Ctx) => signInService.unlinkIdentity(requireUser(ctx), args.provider),
    createPasswordLink: async (_: unknown, args: { userId: string; sendEmail?: boolean | null }, ctx: Ctx) => {
      const admin = requireAdmin(ctx);
      return signInService.createPasswordLink(await userService.get(args.userId), admin, Boolean(args.sendEmail));
    },
    inviteProjectMember: async (_: unknown, args: { projectId: string; email: string; role?: GqlRole | null; message?: string | null; notify?: boolean | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await requireProject(ctx, args.projectId, 'admin');
      await personalService.assertNotPersonal(args.projectId, 'Inviter quelqu\'un');
      const role = fromGqlRole(args.role);
      const member = await userService.invite(args.projectId, args.email, role, user);
      syncHostedMembers(args.projectId);
      // Un invité (conversations seulement) reçoit un e-mail qui le mène droit aux canaux du projet.
      if (role === 'guest' && args.notify !== false) void sendProjectGuestInvitation(user, await projectService.get(args.projectId), await userService.get(member.userId), cleanInviteMessage(args.message));
      return member;
    },
    updateProjectMemberRole: async (_: unknown, args: { projectId: string; userId: string; role: GqlRole }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      await personalService.assertNotPersonal(args.projectId, 'Changer un rôle');
      const member = await userService.setRole(args.projectId, args.userId, fromGqlRole(args.role));
      syncHostedMembers(args.projectId);
      return member;
    },
    addProjectPermissionRule: async (_: unknown, args: { projectId: string; toolName: string; ruleContent?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return permissionRuleService.add(args.projectId, args.toolName, args.ruleContent ?? null);
    },
    updateProjectPermissionRule: async (_: unknown, args: { id: string; rule: string }, ctx: Ctx) => {
      await requireProject(ctx, (await permissionRuleService.get(args.id)).projectId, 'member');
      return permissionRuleService.update(args.id, args.rule);
    },
    deleteProjectPermissionRule: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, (await permissionRuleService.get(args.id)).projectId, 'member');
      return permissionRuleService.remove(args.id);
    },
    deleteProjectPermissionRules: async (_: unknown, args: { projectId: string; ids: string[] }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return permissionRuleService.removeMany(args.projectId, args.ids);
    },
    removeProjectMember: async (_: unknown, args: { projectId: string; userId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      await personalService.assertNotPersonal(args.projectId, 'Retirer un membre');
      const removed = await userService.remove(args.projectId, args.userId);
      syncHostedMembers(args.projectId);
      return removed;
    },

    createProject: async (_: unknown, { input }: { input: CreateProjectInput }, ctx: Ctx) => {
      const user = requireUser(ctx);
      // Un compte qui n'a que des accès d'invité ne crée pas de projet : il y lancerait des sessions avec les crédits de la cellule.
      if (await userService.conversationsOnly(user)) throw new AppError("Créer un projet est réservé aux membres d'un projet : votre compte ne donne accès qu'aux conversations et aux artefacts partagés avec vous", 'FORBIDDEN');
      const project = await projectService.create(input, user.id);
      await userService.addCreator(project.id, user);
      syncHostedMembers(project.id);
      return project;
    },
    setProjectBudget: async (_: unknown, args: { projectId: string; monthlyBudgetUsd?: number | null }, ctx: Ctx) => {
      // Administrateur de l'application (page Consommation des Paramètres) ou du projet.
      if (!requireUser(ctx).isAdmin) await requireProject(ctx, args.projectId, 'admin');
      const budget = toStoredUsd(args.monthlyBudgetUsd ?? null, await costRate(ctx)) ?? null;
      if (budget !== null && (!Number.isFinite(budget) || budget < 0)) throw new AppError('Budget invalide');
      const project = await projectService.update(args.projectId, { monthlyBudgetUsd: budget });
      // Un budget abaissé sous la consommation du mois prévient tout de suite ; relevé, il libère le projet.
      void projectBudget.checkAlert(project.id);
      return project;
    },
    updateProject: async (_: unknown, { id, input }: { id: string; input: UpdateProjectInput }, ctx: Ctx) => {
      await requireProject(ctx, id, 'admin');
      const before = await projectService.get(id);
      const project = await projectService.update(id, input);
      // Limite du projet changée : des places se libèrent peut-être pour la file d'attente.
      void sessionService.drainQueue();
      // Limites mémoire / CPU modifiées : appliquées à chaud au conteneur existant, sans couper les sessions.
      if (input.runnerConfig !== undefined) {
        const limits = (p: Project) => `${(p.runnerConfig as RunnerConfig)?.memory ?? ''}|${(p.runnerConfig as RunnerConfig)?.cpus ?? ''}`;
        if (limits(before) !== limits(project)) {
          try {
            await runner.applyLimits(project);
          } catch (err) {
            throw new AppError(`Limites enregistrées mais pas appliquées au conteneur en marche (${(err as Error).message}) : « Recréer » le conteneur pour les appliquer.`);
          }
        }
      }
      return project;
    },
    prepareProjectWorkspace: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      return projectService.prepareWorkspace(args.id, requireUser(ctx).id);
    },
    startProjectRunner: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      const project = await projectService.get(args.id);
      await runner.ensureReady(project);
      return project;
    },
    stopProjectRunner: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      const project = await projectService.get(args.id);
      await runnerLifecycle.stop(project);
      return project;
    },
    resetProjectRunner: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      const project = await projectService.get(args.id);
      await runnerLifecycle.reset(project);
      return project;
    },
    testProjectBrowser: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'member');
      return checkBrowser(await projectService.get(args.id));
    },
    deleteProject: async (_: unknown, args: { id: string; deleteHostedRepo?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      await personalService.assertNotPersonal(args.id, 'Supprimer');
      return deleteProjectCascade(args.id, { deleteHostedRepo: Boolean(args.deleteHostedRepo) });
    },
    importProjectArchive: async (_: unknown, args: { projectId: string; archive: string; context?: boolean | null; tasks?: boolean | null; settings?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      const archive = Buffer.from(args.archive, 'base64');
      if (!archive.length) throw new AppError('Archive vide');
      if (archive.length > MAX_IMPORT_BYTES) throw new AppError(`Archive trop volumineuse (${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} Mo au plus)`);
      return importProjectArchive(args.projectId, archive, { context: args.context !== false, tasks: args.tasks !== false, settings: Boolean(args.settings) });
    },
    createSession: async (
      _: unknown,
      { input }: { input: CreateSessionInput & { autoStart?: boolean | null } },
      ctx: Ctx,
    ) => {
      await requireProject(ctx, input.projectId, 'member');
      const { agentId, ...rest } = input as typeof input & { agentId?: string | null };
      const owner = await sessionOwnerFor(ctx, agentId, input.projectId);
      return sessionService.create({ ...rest, ...owner, autoStart: input.autoStart ?? true });
    },
    createChat: (_: unknown, args: { text: string; attachments?: AttachmentInput[] | null; config?: Record<string, unknown> | null }, ctx: Ctx) =>
      personalService.createChat(requireUser(ctx), args.text, args.attachments, args.config),
    startSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.start(args.id);
    },
    stopSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.stop(args.id);
    },
    archiveSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return archiveSessionCascade(args.id);
    },
    unarchiveSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.unarchive(args.id);
    },
    relaunchSession: async (_: unknown, args: { id: string; input: RelaunchInput }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.relaunch(args.id, { ...args.input, ownerId: requireUser(ctx).id });
    },
    deleteSession: async (_: unknown, args: { id: string; deleteBranch?: boolean | null }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return deleteSessionCascade(args.id, args.deleteBranch ?? false);
    },
    sendSessionMessage: async (_: unknown, args: { id: string; text: string; attachments?: AttachmentInput[] | null }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.sendMessage(args.id, args.text, args.attachments, { byPerson: true, unarchive: true, author: personAuthor(requireUser(ctx)) });
    },
    endSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.end(args.id);
    },
    resumeSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.resume(args.id);
    },
    restartSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.restart(args.id, personAuthor(requireUser(ctx)));
    },
    createSessionShare: async (_: unknown, args: { sessionId: string; expiresInDays: number }, ctx: Ctx) => {
      await guardSession(ctx, args.sessionId, 'member');
      return sessionShareService.create(args.sessionId, requireUser(ctx).id, args.expiresInDays);
    },
    revokeSessionShare: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const share = await sessionShareService.get(args.id);
      await guardSession(ctx, share.sessionId, 'member');
      await sessionShareService.revoke(share.id);
      return true;
    },
    interruptSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.interrupt(args.id);
    },
    updateSessionConfig: async (_: unknown, args: { id: string; config: Record<string, unknown> }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.updateConfig(args.id, args.config ?? {});
    },
    createSchedule: async (_: unknown, args: { input: CreateScheduleInput & { agentId?: string | null } }, ctx: Ctx) => {
      await requireProject(ctx, args.input.projectId, 'member');
      const { agentId, ...input } = args.input;
      const owner = await sessionOwnerFor(ctx, agentId, input.projectId);
      return scheduleService.create(await scheduleBudgetInUsd(input, ctx), owner);
    },
    updateSchedule: async (_: unknown, args: { id: string; input: SessionScheduleInput & { agentId?: string | null } }, ctx: Ctx) => {
      const existing = await scheduleService.require(args.id);
      await requireProject(ctx, existing.projectId, 'member');
      const { agentId, ...input } = args.input;
      // agentId absent : propriétaire inchangé ; vide : la personne connectée ; sinon un agent du projet.
      const owner = agentId === undefined || agentId === null ? undefined : await sessionOwnerFor(ctx, agentId || null, existing.projectId);
      return scheduleService.update(args.id, await scheduleBudgetInUsd(input, ctx), owner);
    },
    deleteSchedule: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, (await scheduleService.require(args.id)).projectId, 'member');
      return scheduleService.remove(args.id);
    },
    setScheduleEnabled: async (_: unknown, args: { id: string; enabled: boolean }, ctx: Ctx) => {
      await requireProject(ctx, (await scheduleService.require(args.id)).projectId, 'member');
      return scheduleService.setEnabled(args.id, args.enabled);
    },
    runScheduleNow: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, (await scheduleService.require(args.id)).projectId, 'member');
      return scheduleService.runNow(args.id, requireUser(ctx).id);
    },
    updateSession: async (_: unknown, args: { id: string; input: { name?: string | null; cleanup?: SessionCleanup | null } }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      if (args.input.name !== undefined && args.input.name !== null) await sessionService.rename(args.id, args.input.name);
      if (args.input.cleanup) await cleanupService.set(args.id, args.input.cleanup);
      return sessionService.get(args.id);
    },
    applySessionCleanup: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return cleanupService.applyNow(args.id);
    },
    compactSessionContext: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return cleanupService.compactNow(args.id);
    },
    resetSessionContext: async (_: unknown, args: { id: string; keepSummary?: boolean | null }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return cleanupService.resetNow(args.id, args.keepSummary ?? true);
    },
    answerRequest: async (_: unknown, args: { id: string; response: Record<string, unknown> }, ctx: Ctx) => {
      const type = (await requestService.get(args.id)).type;
      // Une demande de secrets se règle par provideSecrets : les valeurs ne doivent jamais aboutir dans la réponse.
      if (type === SECRETS_REQUEST) throw new AppError('Cette demande attend des secrets : saisissez-les dans sa fenêtre');
      // Une demande d'accord (approvals/service.ts) est réservée aux administrateurs du projet.
      if (type === APPROVAL) {
        await guardRequest(ctx, args.id, 'admin');
        return approvalService.answer(args.id, args.response ?? {}, requireUser(ctx));
      }
      await guardRequest(ctx, args.id, 'member');
      return requestService.answer(args.id, args.response ?? {}, requireUser(ctx).id);
    },
    provideSecrets: async (_: unknown, args: { requestId: string; input: { values: { key: string; value: string }[]; destination?: string | null; requireApproval?: boolean | null } }, ctx: Ctx) => {
      await guardRequest(ctx, args.requestId, 'member');
      const destination = args.input.destination ?? null;
      if (destination !== null && destination !== 'project' && destination !== 'personal') throw new AppError(`Destination inconnue : ${destination}`);
      return provideSecrets(args.requestId, requireUser(ctx).id, { values: args.input.values, destination, requireApproval: args.input.requireApproval ?? null });
    },
    cancelRequest: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      if ((await requestService.get(args.id)).type === APPROVAL) {
        await guardRequest(ctx, args.id, 'admin');
        return approvalService.cancel(args.id, requireUser(ctx));
      }
      await guardRequest(ctx, args.id, 'member');
      return requestService.cancel(args.id, requireUser(ctx).id);
    },

    markNotificationRead: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const n = await notificationService.get(args.id);
      if (n.adminsOnly) requireAdmin(ctx);
      if (n.userId && n.userId !== requireUser(ctx).id) throw new AppError('Cette notification est adressée à une autre personne', 'FORBIDDEN');
      if (n.projectId) await requireProject(ctx, n.projectId);
      else requireUser(ctx);
      return notificationService.markRead(args.id);
    },
    markAllNotificationsRead: async (_: unknown, args: { projectId?: string | null }, ctx: Ctx) => notificationService.markAllRead(await notificationScope(ctx, args.projectId)),
    createTask: async (_: unknown, { input }: { input: GqlTaskInput & { projectId: string; title: string } }, ctx: Ctx) => {
      await requireProject(ctx, input.projectId, 'member');
      return taskService.create(input.projectId, { ...toTaskInput(input), title: input.title }, actorOf(requireUser(ctx)));
    },
    updateTask: async (_: unknown, { id, input }: { id: string; input: GqlTaskInput }, ctx: Ctx) => {
      await guardTask(ctx, id, 'member');
      return taskService.update(id, toTaskInput(input), actorOf(requireUser(ctx)));
    },
    moveTask: async (_: unknown, args: { id: string; projectId: string }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      await requireProject(ctx, args.projectId, 'member');
      return taskService.move(args.id, args.projectId);
    },
    deleteTask: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      return taskService.delete(args.id);
    },
    addTaskComment: async (_: unknown, args: { taskId: string; body: string; attachments?: AttachmentInput[] | null; parentId?: string | null }, ctx: Ctx) => {
      await guardTask(ctx, args.taskId, 'member');
      return taskService.addComment(args.taskId, args.body, actorOf(requireUser(ctx)), args.attachments ?? null, { parentId: args.parentId ?? null });
    },
    toggleTaskReaction: async (_: unknown, args: { taskId: string; commentId?: string | null; emoji: string }, ctx: Ctx) => {
      await guardTask(ctx, args.taskId, 'member');
      return (await taskService.toggleReaction(args.taskId, args.commentId ?? null, args.emoji, actorOf(requireUser(ctx)))).added;
    },
    updateTaskComment: async (_: unknown, args: { id: string; body: string; attachments?: AttachmentInput[] | null; removeAttachmentIds?: string[] | null }, ctx: Ctx) => {
      const { comment } = await guardComment(ctx, args.id);
      if (comment.authorUserId !== requireUser(ctx).id) throw new AppError('Seul l\'auteur modifie son commentaire', 'FORBIDDEN');
      return taskService.updateComment(args.id, args.body, { attachments: args.attachments, removeAttachmentIds: args.removeAttachmentIds });
    },
    deleteTaskComment: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const { comment, role } = await guardComment(ctx, args.id);
      if (comment.authorUserId !== requireUser(ctx).id && role !== 'admin') throw new AppError("Seuls l'auteur et les administrateurs du projet suppriment un commentaire", 'FORBIDDEN');
      return taskService.deleteComment(args.id);
    },
    // ---- Conversations d'équipe ----
    createConversation: async (_: unknown, args: { projectId: string; name: string; topic?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return conversationService.create(args.projectId, { name: args.name, topic: args.topic }, requireUser(ctx).id);
    },
    updateConversation: async (_: unknown, args: { id: string; name?: string | null; topic?: string | null }, ctx: Ctx) => {
      await guardConversation(ctx, args.id, 'member');
      return conversationService.update(args.id, { name: args.name, topic: args.topic });
    },
    setConversationArchived: async (_: unknown, args: { id: string; archived: boolean }, ctx: Ctx) => {
      await guardConversation(ctx, args.id, 'admin');
      return conversationService.setArchived(args.id, args.archived);
    },
    postMessage: async (_: unknown, args: { conversationId: string; body: string; parentId?: string | null; attachments?: AttachmentInput[] | null }, ctx: Ctx) => {
      // Les invités écrivent dans les canaux (c'est leur raison d'être) ; les lecteurs non, comme avant.
      const { role } = await guardConversation(ctx, args.conversationId, 'guest');
      if (role === 'viewer') throw new AppError('Cette action demande le rôle membre sur le projet', 'FORBIDDEN');
      return conversationService.post(args.conversationId, args.body, actorOf(requireUser(ctx)), { parentId: args.parentId ?? null, attachments: args.attachments ?? null });
    },
    updateMessage: async (_: unknown, args: { id: string; body: string; attachments?: AttachmentInput[] | null; removeAttachmentIds?: string[] | null }, ctx: Ctx) => {
      const { message } = await guardMessage(ctx, args.id);
      if (message.authorUserId !== requireUser(ctx).id) throw new AppError("Seul l'auteur modifie son message", 'FORBIDDEN');
      return conversationService.updateMessage(args.id, args.body, { attachments: args.attachments, removeAttachmentIds: args.removeAttachmentIds });
    },
    deleteMessage: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const { message, role } = await guardMessage(ctx, args.id);
      if (message.authorUserId !== requireUser(ctx).id && role !== 'admin') throw new AppError("Seuls l'auteur et les administrateurs du projet suppriment un message", 'FORBIDDEN');
      return conversationService.deleteMessage(args.id);
    },
    toggleMessageReaction: async (_: unknown, args: { messageId: string; emoji: string }, ctx: Ctx) => {
      const { role } = await guardMessage(ctx, args.messageId);
      if (role === 'viewer') throw new AppError('Cette action demande le rôle membre sur le projet', 'FORBIDDEN');
      return (await conversationService.toggleReaction(args.messageId, args.emoji, actorOf(requireUser(ctx)))).added;
    },
    markConversationRead: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardConversation(ctx, args.id, 'guest');
      await conversationService.markRead(args.id, requireUser(ctx).id);
      return true;
    },
    startTaskSession: async (_: unknown, args: { id: string; provider?: string | null; config?: Record<string, unknown> | null; prompt?: string | null; agentId?: string | null }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      const task = await taskService.get(args.id);
      const { agentId, ...rest } = args;
      const owner = await sessionOwnerFor(ctx, agentId, task.projectId);
      if (agentId) {
        const agent = await agentService.get(agentId);
        return startTaskSession(args.id, { ...rest, ...owner, provider: rest.provider ?? agentService.providerOf(agent), config: agentService.sessionConfig(agent, rest.config) });
      }
      return startTaskSession(args.id, { ...rest, ...owner });
    },
    resumeTaskSession: async (_: unknown, args: { id: string; text: string }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      return resumeTaskSession(args.id, args.text, personAuthor(requireUser(ctx)));
    },
    createProjectApiKey: async (_: unknown, args: { projectId: string; name: string; scopes?: string[] | null; triageAgentId?: string | null; signed?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      if (args.triageAgentId) await assertProjectAgent(args.projectId, args.triageAgentId);
      return apiKeyService.create(args.projectId, { name: args.name, scopes: args.scopes, triageAgentId: args.triageAgentId || null, signed: !!args.signed }, requireUser(ctx).id);
    },
    updateProjectApiKey: async (_: unknown, args: { id: string; name?: string | null; scopes?: string[] | null; triageAgentId?: string | null }, ctx: Ctx) => {
      const key = await apiKeyService.get(args.id);
      await requireProject(ctx, key.projectId, 'admin');
      if (args.triageAgentId) await assertProjectAgent(key.projectId, args.triageAgentId);
      return apiKeyService.update(args.id, { name: args.name, scopes: args.scopes, triageAgentId: args.triageAgentId === undefined ? undefined : args.triageAgentId || null });
    },
    setProjectApiKeySigning: async (_: unknown, args: { id: string; enabled: boolean }, ctx: Ctx) => {
      await requireProject(ctx, (await apiKeyService.get(args.id)).projectId, 'admin');
      return apiKeyService.setSigning(args.id, args.enabled);
    },
    deleteProjectApiKey: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, (await apiKeyService.get(args.id)).projectId, 'admin');
      return apiKeyService.delete(args.id);
    },
    createTerminal: async (_: unknown, args: { projectId: string; name?: string | null; worksessionId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return terminalService.create(args.projectId, args.name, args.worksessionId, requireUser(ctx).id);
    },
    createWorksession: async (_: unknown, args: { projectId: string; branch?: string | null; name?: string | null; baseRef?: string | null; label?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return worksessionService.create(args.projectId, args, requireUser(ctx).id);
    },
    saveEnvFile: async (_: unknown, args: { projectId: string; id?: string | null; path: string; content: string; applyOnCreate?: boolean | null; expectedUpdatedAt?: Date | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return envFileService.save(args.projectId, args, { userId: requireUser(ctx).id });
    },
    deleteEnvFile: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, (await envFileService.get(args.id)).projectId, 'member');
      return envFileService.delete(args.id);
    },
    applyEnvFiles: async (_: unknown, args: { worksessionId: string; paths?: string[] | null }, ctx: Ctx) => {
      await guardWorksession(ctx, args.worksessionId, 'member');
      const ws = await worksessionService.get(args.worksessionId);
      const project = await projectService.get(ws.projectId);
      const usable = await worksessionService.assertUsable(project, ws.id);
      await worksessionService.ensureDir(project, usable);
      return envFileService.apply(project, usable, requireUser(ctx).id, { onlyPaths: args.paths ?? null, overwrite: true });
    },
    renameWorksession: async (_: unknown, args: { id: string; label?: string | null; name?: string | null }, ctx: Ctx) => {
      await guardWorksession(ctx, args.id, 'member');
      return worksessionService.rename(args.id, args);
    },
    startPreview: async (_: unknown, args: { worksessionId: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.worksessionId, 'member');
      return previewService.start(args.worksessionId, requireUser(ctx).id);
    },
    stopPreview: async (_: unknown, args: { worksessionId: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.worksessionId, 'member');
      return previewService.stop(args.worksessionId);
    },
    previewAccessUrl: async (_: unknown, args: { worksessionId: string; path?: string | null }, ctx: Ctx) => {
      await guardWorksession(ctx, args.worksessionId, 'viewer');
      return previewService.accessUrl(args.worksessionId, requireUser(ctx).id, args.path ?? '/');
    },
    archiveWorksession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.id, 'member');
      return archiveWorksessionCascade(args.id);
    },
    restoreWorksession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardWorksession(ctx, args.id, 'member');
      return restoreWorksessionCascade(args.id);
    },
    deleteWorksession: async (_: unknown, args: { id: string; deleteBranch?: boolean | null; deleteSessions?: boolean | null }, ctx: Ctx) => {
      await guardWorksession(ctx, args.id, 'member');
      return deleteWorksessionCascade(args.id, args.deleteBranch ?? false, { deleteSessions: args.deleteSessions ?? false });
    },
    cleanMergedWorksessions: async (_: unknown, args: { projectId: string; names?: string[] | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return worksessionDisk.cleanMerged(args.projectId, requireUser(ctx).id, args.names);
    },
    shareWorksessionDeps: async (_: unknown, args: { projectId: string; names?: string[] | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return worksessionDisk.shareDeps(args.projectId, args.names);
    },
    importOrphanWorksession: async (_: unknown, args: { projectId: string; name: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return worksessionDisk.importOrphan(args.projectId, args.name);
    },
    deleteOrphanWorksession: async (_: unknown, args: { projectId: string; name: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return worksessionDisk.deleteOrphan(args.projectId, args.name);
    },
    // Coffre : les droits sont vérifiés par le service (use / read / manage) ; un projet propriétaire exige un administrateur.
    createVaultItem: async (_: unknown, args: { projectId?: string | null; input: VaultItemInput }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId, 'admin');
      return vaultService.create(vaultActor(ctx), args.projectId ?? null, args.input);
    },
    updateVaultItem: (_: unknown, args: { id: string; input: VaultItemInput }, ctx: Ctx) => vaultService.update(vaultActor(ctx), args.id, args.input),
    deleteVaultItem: (_: unknown, args: { id: string }, ctx: Ctx) => vaultService.delete(vaultActor(ctx), args.id),
    testVaultItem: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const { item, result } = await vaultService.test(vaultActor(ctx), args.id);
      return { item, ...result };
    },
    duplicateVaultItem: (_: unknown, args: { id: string; name?: string | null }, ctx: Ctx) => vaultService.duplicate(vaultActor(ctx), args.id, args.name),
    regenerateVaultKey: (_: unknown, args: { id: string }, ctx: Ctx) => vaultService.regenerateKey(vaultActor(ctx), args.id),
    forgetVaultHostKey: (_: unknown, args: { id: string }, ctx: Ctx) => vaultService.forgetHostKey(vaultActor(ctx), args.id),
    revealVaultSecret: async (_: unknown, args: { id: string; field: string }, ctx: Ctx) => ({ field: args.field, value: await vaultService.reveal(vaultActor(ctx), args.id, args.field) }),
    shareVaultItem: (_: unknown, args: { id: string; email: string; permission: string }, ctx: Ctx) => vaultService.share(vaultActor(ctx), args.id, args.email, fromGqlPermission(args.permission)),
    unshareVaultItem: (_: unknown, args: { id: string; userId: string }, ctx: Ctx) => vaultService.unshare(vaultActor(ctx), args.id, args.userId),
    linkVaultItem: (_: unknown, args: { id: string; projectId: string; scope: string }, ctx: Ctx) => vaultService.link(vaultActor(ctx), args.id, args.projectId, fromGqlScope(args.scope)),
    unlinkVaultItem: (_: unknown, args: { linkId: string }, ctx: Ctx) => vaultService.unlink(vaultActor(ctx), args.linkId),
    copyVaultItem: async (_: unknown, args: { id: string; projectId: string; name?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return vaultService.copyToProject(vaultActor(ctx), args.id, args.projectId, args.name);
    },
    publishSharedPage: async (_: unknown, args: WorkspaceRef & { path: string; title: string; pageId?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      if (!/\.html?$/i.test(args.path)) throw new AppError('Seul un fichier HTML (.html) peut être publié');
      const file = await readRawFile(args, args.path);
      return sharedPageService.publish({ ownerId: requireUser(ctx).id, title: args.title, html: file.data, pageId: args.pageId ?? null, projectId: args.projectId, sourcePath: args.path });
    },
    updateSharedPage: async (_: unknown, args: { id: string; input: { title?: string | null; description?: string | null; linkAccess?: boolean | null; projectAccess?: boolean | null; agentHandoff?: string | null; refreshMinutes?: number | null } }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const { agentHandoff, ...input } = args.input;
      if (agentHandoff === 'AUTO') {
        // Les commentaires partiront à la session au nom de leurs auteurs : le propriétaire doit pouvoir y écrire.
        const page = await sharedPageService.getOwned(user.id, args.id);
        if (page.sessionId) await guardSession(ctx, page.sessionId, 'member');
      }
      return sharedPageService.update(user.id, args.id, { ...input, agentHandoff: agentHandoff ? agentHandoff.toLowerCase() : null });
    },
    addSharedPageMember: (_: unknown, args: { id: string; email: string; invite?: boolean | null; message?: string | null; notify?: boolean | null }, ctx: Ctx) =>
      sharedPageService.addMember(requireUser(ctx), args.id, args.email, { invite: Boolean(args.invite), message: args.message, notify: args.notify !== false }),
    removeSharedPageMember: (_: unknown, args: { id: string; userId: string }, ctx: Ctx) => sharedPageService.removeMember(requireUser(ctx), args.id, args.userId),
    deleteSharedPage: (_: unknown, args: { id: string }, ctx: Ctx) => sharedPageService.delete(requireUser(ctx).id, args.id),
    setSharedPageHistory: (_: unknown, args: { id: string; enabled: boolean }, ctx: Ctx) => sharedPageService.setHistory(requireUser(ctx), args.id, args.enabled),
    refreshSharedPageData: (_: unknown, args: { id: string }, ctx: Ctx) => artifactDataService.refreshFor(requireUser(ctx), args.id),
    setSharedPageFavorite: (_: unknown, args: { id: string; favorite: boolean }, ctx: Ctx) => sharedPageService.setFavorite(requireUser(ctx), args.id, args.favorite),
    updateCockpitLayout: async (_: unknown, args: { scope: string; layout: unknown; note?: string | null }, ctx: Ctx) => (await cockpitService.update(requireUser(ctx), args.scope, { layout: args.layout, note: args.note })).result,
    resetCockpitLayout: (_: unknown, args: { scope: string }, ctx: Ctx) => cockpitService.reset(requireUser(ctx), args.scope),
    restoreCockpitLayout: (_: unknown, args: { scope: string; version: number }, ctx: Ctx) => cockpitService.restore(requireUser(ctx), args.scope, args.version),
    pinArtifactToCockpit: async (_: unknown, args: { scope: string; artifactId: string; region?: string | null; title?: string | null }, ctx: Ctx) => (await cockpitService.pin(requireUser(ctx), args.scope, { artifactId: args.artifactId, region: args.region, title: args.title })).result,
    createProjectPage: async (_: unknown, args: { projectId: string; title: string; icon?: string | null; slug?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return projectPageService.create(args.projectId, { title: args.title, icon: args.icon, slug: args.slug }, requireUser(ctx).id);
    },
    updateProjectPage: async (_: unknown, args: { id: string; title?: string | null; icon?: string | null; position?: number | null }, ctx: Ctx) => {
      const page = await projectPageService.get(args.id);
      await requireProject(ctx, page.projectId, 'member');
      return projectPageService.update(page, { title: args.title, icon: args.icon, position: args.position });
    },
    deleteProjectPage: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const page = await projectPageService.get(args.id);
      await requireProject(ctx, page.projectId, 'member');
      await projectPageService.delete(page);
      return true;
    },
    updateProjectTabs: async (_: unknown, args: { projectId: string; tabs: unknown }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      await projectPageService.setTabs(args.projectId, args.tabs);
      return projectService.get(args.projectId);
    },
    duplicateSharedPage: (_: unknown, args: { id: string; title?: string | null; version?: number | null }, ctx: Ctx) => sharedPageService.duplicate(requireUser(ctx), args.id, { title: args.title, version: args.version }),
    deleteAllSharedPageComments: (_: unknown, args: { id: string }, ctx: Ctx) => sharedPageService.deleteAllComments(requireUser(ctx), args.id),
    addSharedPageComment: (_: unknown, args: { pageId: string; body: string; anchor?: unknown; version?: number | null }, ctx: Ctx) =>
      sharedPageCommentService.add({ user: requireUser(ctx) }, args.pageId, { body: args.body, anchor: args.anchor, version: args.version }),
    replySharedPageComment: (_: unknown, args: { commentId: string; body: string }, ctx: Ctx) => sharedPageCommentService.reply({ user: requireUser(ctx) }, args.commentId, args.body),
    updateSharedPageComment: (_: unknown, args: { id: string; body: string }, ctx: Ctx) => sharedPageCommentService.update({ user: requireUser(ctx) }, args.id, args.body),
    resolveSharedPageComment: (_: unknown, args: { id: string; resolved: boolean }, ctx: Ctx) => sharedPageCommentService.resolve({ user: requireUser(ctx) }, args.id, args.resolved),
    deleteSharedPageComment: (_: unknown, args: { id: string }, ctx: Ctx) => sharedPageCommentService.delete({ user: requireUser(ctx) }, args.id),
    requestSharedPageUpdate: async (_: unknown, args: { id: string; instruction?: string | null; withComments?: boolean | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const page = await sharedPageService.getOwned(user.id, args.id);
      if (page.sessionId) await guardSession(ctx, page.sessionId, 'member');
      return (await sharedPageUpdateService.request(user, args.id, { instruction: args.instruction, withComments: args.withComments })).session;
    },
    subscribePush: async (_: unknown, args: { input: PushSubscriptionInput }, ctx: Ctx) => {
      await pushService.subscribe(requireUser(ctx).id, args.input);
      return true;
    },
    unsubscribePush: (_: unknown, args: { endpoint: string }, ctx: Ctx) => pushService.unsubscribe(requireUser(ctx).id, args.endpoint),
    sendTestPush: (_: unknown, __: unknown, ctx: Ctx) => pushService.test(requireUser(ctx).id),
    setPushPreference: (_: unknown, args: { category: string; enabled: boolean }, ctx: Ctx) => {
      const user = requireUser(ctx);
      return pushPreferencesService.set(user.id, user.isAdmin, args.category, args.enabled);
    },
    createNotificationChannel: async (_: unknown, args: { input: ChannelInput & { projectId?: string | null } }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const projectId = args.input.projectId ?? null;
      if (projectId) await requireProject(ctx, projectId, 'admin');
      return notificationChannelService.create({ projectId, userId: projectId ? null : user.id, admin: user.isAdmin }, args.input, user.id);
    },
    updateNotificationChannel: async (_: unknown, args: { id: string; patch: ChannelPatch }, ctx: Ctx) => {
      const user = await guardNotificationChannel(ctx, args.id);
      return notificationChannelService.update(args.id, user.isAdmin, args.patch);
    },
    deleteNotificationChannel: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardNotificationChannel(ctx, args.id);
      return notificationChannelService.delete(args.id);
    },
    testNotificationChannel: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardNotificationChannel(ctx, args.id);
      return notificationChannelService.test(args.id);
    },
    updateMailSettings: (_: unknown, args: { input: MailInput }, ctx: Ctx) => {
      requireAdmin(ctx);
      return mailService.update(args.input);
    },
    clearMailSettings: (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      return mailService.clear();
    },
    sendTestEmail: async (_: unknown, __: unknown, ctx: Ctx) => {
      const user = requireAdmin(ctx);
      try {
        await mailService.send({ to: user.email, subject: 'Skipper : test des notifications par e-mail', text: 'L’envoi des e-mails de Skipper (Brevo) fonctionne.' });
      } catch (err) {
        throw new AppError(`Envoi impossible : ${(err as Error).message}`);
      }
      return true;
    },
    closeTerminal: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTerminal(ctx, args.id, 'member');
      return terminalService.close(args.id);
    },
    deleteTerminal: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTerminal(ctx, args.id, 'member');
      return terminalService.delete(args.id);
    },
    createContextFolder: async (_: unknown, args: { projectId: string; parentId?: string | null; name: string; agentId?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return contextService.createFolder(args.projectId, { parentId: args.parentId ?? null, name: args.name, agentId: await projectAgentLibrary(args.projectId, args.agentId) }, HUMAN);
    },
    renameContextFolder: async (_: unknown, args: { id: string; name: string }, ctx: Ctx) => {
      await guardFolder(ctx, args.id, 'member');
      return contextService.renameFolder(args.id, args.name, HUMAN);
    },
    moveContextFolder: async (_: unknown, args: { id: string; parentId?: string | null }, ctx: Ctx) => {
      await guardFolder(ctx, args.id, 'member');
      return contextService.moveFolder(args.id, args.parentId ?? null, HUMAN);
    },
    deleteContextFolder: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardFolder(ctx, args.id, 'member');
      return contextService.deleteFolder(args.id, HUMAN);
    },
    createContextInstruction: async (
      _: unknown,
      { input }: { input: { projectId: string; agentId?: string | null; folderId?: string | null; name: string; description?: string | null; content?: string | null; changeNote?: string | null } },
      ctx: Ctx,
    ) => {
      await requireProject(ctx, input.projectId, 'member');
      return contextService.createInstruction(input.projectId, { ...input, agentId: await projectAgentLibrary(input.projectId, input.agentId) }, HUMAN);
    },
    updateContextInstruction: async (
      _: unknown,
      { id, input }: { id: string; input: { name?: string | null; description?: string | null; content?: string | null; folderId?: string | null; changeNote?: string | null } },
      ctx: Ctx,
    ) => {
      await guardInstruction(ctx, id, 'member');
      return contextService.updateInstruction(id, input, HUMAN);
    },
    deleteContextInstruction: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardInstruction(ctx, args.id, 'member');
      return contextService.deleteInstruction(args.id, HUMAN);
    },
    restoreContextInstructionVersion: async (_: unknown, args: { id: string; version: number }, ctx: Ctx) => {
      await guardInstruction(ctx, args.id, 'member');
      return contextService.restoreVersion(args.id, args.version, HUMAN);
    },
  })),

  Subscription: {
    sessionEvents: {
      subscribe: async (_: unknown, args: { sessionId: string }, ctx: Ctx) => {
        await guardSession(ctx, args.sessionId, 'viewer');
        return pubSub.subscribe('sessionEvent', args.sessionId);
      },
      resolve: (payload: unknown) => payload,
    },
    sessionUpdated: {
      subscribe: (_: unknown, __: unknown, ctx: Ctx) => {
        requireUser(ctx);
        return filterAsync(pubSub.subscribe('sessionUpdated'), (s: Session) => canAccessProject(ctx, s.projectId));
      },
      resolve: (payload: unknown) => payload,
    },
    requestCreated: {
      subscribe: (_: unknown, __: unknown, ctx: Ctx) => {
        requireUser(ctx);
        return filterAsync(pubSub.subscribe('requestCreated'), async (r: HumanRequest) => canAccessProject(ctx, await projectOfSession(r.sessionId)));
      },
      resolve: (payload: unknown) => payload,
    },
    requestUpdated: {
      subscribe: (_: unknown, __: unknown, ctx: Ctx) => {
        requireUser(ctx);
        return filterAsync(pubSub.subscribe('requestUpdated'), async (r: HumanRequest) => canAccessProject(ctx, await projectOfSession(r.sessionId)));
      },
      resolve: (payload: unknown) => payload,
    },
    notificationCreated: {
      subscribe: (_: unknown, __: unknown, ctx: Ctx) => {
        requireUser(ctx);
        return filterAsync(pubSub.subscribe('notificationCreated'), async (n: Notification) => (n.userId ? n.userId === ctx.user?.id : (!n.adminsOnly || Boolean(ctx.user?.isAdmin)) && (await canAccessProject(ctx, n.projectId))));
      },
      resolve: (payload: unknown) => payload,
    },
  },
};

// Coûts rendus dans l'unité d'affichage (crédits quand la facturation de la cellule est configurée).
applyCostConversion(resolvers);

/** Alerte d'un artefact telle que l'API la montre : consigne réservée à qui administre l'artefact. */
function alertView(a: DataAlert, full: boolean) {
  return {
    id: a.id,
    name: a.name,
    source: a.source,
    path: a.config.path,
    op: a.config.op,
    value: a.config.value,
    match: a.config.match,
    for: a.config.for,
    condition: describeCondition(a),
    notify: a.config.notify,
    notifyResolved: a.config.notifyResolved,
    agent: a.config.agent,
    launchesSession: Boolean(a.config.prompt || a.config.agent),
    prompt: full ? a.config.prompt : null,
    message: a.config.message,
    state: a.state,
    streak: a.streak,
    lastValue: a.lastValue,
    evaluatedAt: a.evaluatedAt,
    triggeredAt: a.triggeredAt,
    resolvedAt: a.resolvedAt,
    fireCount: a.fireCount,
    sessionId: a.sessionId,
    error: a.error,
  };
}

/** Source de données telle que l'API la montre : requête et script réservés à qui administre l'artefact. */
function sourceView(s: DataSource, full: boolean) {
  const sql = s.kind === 'sql' ? (s.config as SqlSourceConfig) : null;
  const script = s.kind === 'script' ? (s.config as ScriptSourceConfig) : null;
  const gql = s.kind === 'graphql' ? (s.config as GraphqlSourceConfig) : null;
  const agent = s.kind === 'agent' ? (s.config as AgentSourceConfig) : null;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    item: sql?.item ?? null,
    database: sql?.database ?? null,
    query: full ? sql?.query ?? gql?.query ?? null : null,
    variables: full ? gql?.variables ?? null : null,
    interpreter: script?.interpreter ?? null,
    code: full ? script?.code ?? null : null,
    timeoutSeconds: script?.timeoutSeconds ?? null,
    prompt: full ? agent?.prompt ?? null : null,
    agent: agent?.agent ?? null,
    sessionId: agent ? s.sessionId ?? null : null,
    // Source graphql : vivante (exécutée à la lecture), jamais rafraîchie en base.
    status: gql && s.status !== 'inactive' ? 'live' : s.status,
    error: s.error,
    rowCount: s.rowCount,
    durationMs: s.durationMs,
    refreshedAt: s.refreshedAt,
    attemptedAt: s.attemptedAt,
  };
}

// Types atteints par les invités d'un projet (rôle `guest`) : seuls les champs de GUEST_TYPE_FIELDS leur répondent.
resolvers.Project = guardTypeForGuests('Project', (p: Project) => p.id, resolvers.Project);
resolvers.Session = guardTypeForGuests('Session', (s: Session) => s.projectId, resolvers.Session);
resolvers.Agent = guardTypeForGuests('Agent', (a: Agent) => a.projectId, resolvers.Agent);
