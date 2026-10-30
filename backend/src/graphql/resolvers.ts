import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { accessibleProjectIds, canAccessProject, filterAsync, memberRoleFor, requireAdmin, requireProject, requireSuperAdmin, requireUser, roleFor, type AuthContext } from '../auth/access.js';
import { liveBrowserService } from '../browser/live.js';
import { liveDraftService } from '../sessions/live.js';
import { createLoaders, type Loaders } from './loaders.js';
import { apiKeyService } from '../apiKeys/service.js';
import { contextService, HUMAN } from '../context/service.js';
import { accountOf, googleAccountService } from '../google/service.js';
import { pushPreferencesService } from '../notifications/preferences.js';
import { pushService, type PushSubscriptionInput } from '../notifications/push.js';
import { searchService, type SearchKind } from '../search/service.js';
import { sharedPageService } from '../sharedPages/service.js';
import type { SharedPage, SharedPageMember, SharedPageVersion } from '../sharedPages/types.js';
import { readRawFile } from '../files/service.js';
import { fingerprint } from '../vault/ssh.js';
import { isOauthToken, vaultService, type VaultItemWithPermission } from '../vault/service.js';
import { awsService } from '../vault/awsService.js';
import type { ApiSettings, AwsSettings, LangfuseSettings, LitellmSettings, PostgresSettings, ProjectVaultRow, ScalewaySettings, SecretSettings, SshSettings, TokenSettings, VaultAuditEvent, VaultItem, VaultItemInput, VaultItemKind, VaultLink, VaultLinkScope, VaultPermission, VaultShare, WebsiteSettings } from '../vault/types.js';
import { variableName } from '../vault/website.js';
import { dashboardService } from '../dashboard/service.js';
import { AppError, NotFoundError } from '../errors.js';
import { fileService, type WorkspaceRef } from '../files/service.js';
import { pullRequestService, type MergeCleanup, type MergeMethod, type PullRequest, type PullRequestFilter } from '../git/pullRequests.js';
import { trackedPullRequestService } from '../pullRequests/service.js';
import { stageOf, type PullRequestStage, type TrackedPullRequest, type TrackedPullRequestStatus } from '../pullRequests/types.js';
import { gitService } from '../git/service.js';
import { archiveSessionCascade, archiveWorksessionCascade, deleteProjectCascade, deleteSessionCascade, deleteWorksessionCascade, restoreWorksessionCascade } from '../projects/cleanup.js';
import { runner, type RunnerConfig } from '../runners/index.js';
import { containerMonitor } from '../runners/monitor.js';
import { runnerLifecycle } from '../runners/lifecycle.js';
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
import type { HumanRequest, RequestStatus } from '../requests/types.js';
import { listProviders } from '../sessions/providers/registry.js';
import { publicAttachment } from '../sessions/attachments.js';
import { sessionService } from '../sessions/service.js';
import { sessionChangesService, type SessionChanges } from '../sessions/changes.js';
import { loginService } from '../settings/login.js';
import { githubService } from '../settings/github.js';
import { githubDeviceAvailable, githubDeviceService } from '../settings/githubDevice.js';
import { claudeSettings, type ClaudeSettingsPatch } from '../settings/claude.js';
import { opencodeProviders, opencodeSettings, type OpencodeSettingsPatch } from '../settings/opencode.js';
import { workflowService } from '../workflows/service.js';
import { workflowVariables } from '../workflows/graph.js';
import type { AutomationScheduleInput, RunStatus, RunTrigger, Workflow, WorkflowInput, WorkflowRun, WorkflowRunNode } from '../workflows/types.js';
import { TOKEN_SERVICES, TOKEN_SERVICE_IDS, tokenServiceLabel } from '../vault/tokens.js';
import { serverSettings } from '../settings/server.js';
import { sessionRepository } from '../sessions/repository.js';
import { healthService } from '../health/service.js';
import type { ClaudeAuthMode } from '../settings/types.js';
import { usageService } from '../settings/usage.js';
import { scheduleService } from '../schedules/service.js';
import { cleanupService } from '../sessions/cleanup.js';
import { CONTEXT_WARN_TOKENS, contextEstimate, contextModel } from '../sessions/context.js';
import type { SessionCleanup } from '../sessions/types.js';
import { terminalService } from '../terminals/service.js';
import { worksessionPath, worksessionService } from '../worksessions/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { worksessionLabel, type Worksession } from '../worksessions/types.js';
import { startTaskSession } from '../tasks/launch.js';
import { taskService } from '../tasks/service.js';
import type { Task, TaskComment, TaskField, TaskPersonInput, TaskPriority, TaskReaction, TaskStatus, ProjectApiKey } from '../tasks/types.js';
import type { TerminalRecord } from '../terminals/types.js';
import type { AttachmentInput, CreateSessionInput, RelaunchInput, Session, SessionStatus } from '../sessions/types.js';
import type { OpenItems, User } from '../users/types.js';
import { permissionRuleService } from '../permissions/service.js';
import { formatRule, type PermissionRule } from '../permissions/types.js';
import type { SessionScheduleInput } from '../schedules/types.js';
import { userService } from '../users/service.js';
import type { ProjectMember, ProjectRole } from '../users/types.js';

type Ctx = AuthContext;
type GqlRole = Uppercase<ProjectRole>;
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
  model?: Promise<string | null>;
}
const modelOfContext = (p: ContextParent) => (p.model ??= contextModel(p.session).catch(() => null));
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
const guardRequest = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, await projectOfRequest(id), min);
const guardTask = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await taskService.get(id)).projectId, min);
const guardTerminal = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await terminalService.get(id)).projectId, min);
const guardWorksession = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await worksessionService.get(id)).projectId, min);
const guardComment = async (ctx: Ctx, id: string) => {
  const comment = await taskService.getComment(id);
  const task = await taskService.get(comment.taskId);
  const role = await requireProject(ctx, task.projectId, 'member');
  return { comment, task, role };
};
const guardFolder = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await contextService.getFolder(id)).projectId, min);
const guardInstruction = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await contextService.getInstruction(id)).projectId, min);

type GqlStatus = Uppercase<SessionStatus>;
type GqlRequestStatus = Uppercase<RequestStatus>;
type GqlTaskStatus = Uppercase<TaskStatus>;
type GqlTaskPriority = Uppercase<TaskPriority>;
const fromGqlTaskStatus = (s?: GqlTaskStatus | null) => (s ? (s.toLowerCase() as TaskStatus) : undefined);
const fromGqlTaskStatuses = (s?: GqlTaskStatus[] | null) => (s?.length ? s.map((x) => x.toLowerCase() as TaskStatus) : undefined);
const fromGqlTaskPriority = (p?: GqlTaskPriority | null) => (p ? (p.toLowerCase() as TaskPriority) : undefined);
interface GqlTaskInput {
  title?: string | null;
  description?: string | null;
  priority?: GqlTaskPriority | null;
  status?: GqlTaskStatus | null;
  sessionId?: string | null;
  dueDate?: string | null;
  customFields?: TaskField[] | null;
  statusTag?: string | null;
  tags?: string[] | null;
  assignee?: TaskPersonInput | null;
  reporter?: TaskPersonInput | null;
  attachments?: AttachmentInput[] | null;
  removeAttachmentIds?: string[] | null;
}
const toTaskInput = (i: GqlTaskInput) => ({
  title: i.title ?? undefined,
  description: i.description ?? undefined,
  priority: fromGqlTaskPriority(i.priority),
  status: fromGqlTaskStatus(i.status),
  sessionId: i.sessionId,
  dueDate: i.dueDate,
  customFields: i.customFields ?? undefined,
  statusTag: i.statusTag,
  tags: i.tags ?? undefined,
  assignee: i.assignee,
  reporter: i.reporter,
  attachments: i.attachments ?? null,
  removeAttachmentIds: i.removeAttachmentIds ?? null,
});
const actorOf = (user: User) => ({ type: 'human' as const, userId: user.id, name: user.name || user.email });
const fromGqlPermission = (p: string): VaultPermission => p.toLowerCase() as VaultPermission;
const fromGqlScope = (sc: string): VaultLinkScope => sc.toLowerCase() as VaultLinkScope;
const vaultActor = (ctx: Ctx) => ({ userId: requireUser(ctx).id });
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
const projectOf = async (ctx: Ctx, id: string): Promise<Project> => {
  const project = await loadersOf(ctx).project(id);
  if (!project) throw new NotFoundError('Projet introuvable');
  return project;
};
const worksessionOrNull = async (ctx: Ctx, id: string | null | undefined) => (id ? ((await loadersOf(ctx).worksession(id)) ?? null) : null);
/** Réactions regroupées par emoji (ordre de première apparition), avec les noms et si l'utilisateur connecté en est. */
function groupReactions(reactions: TaskReaction[], userId: string | undefined): { emoji: string; count: number; actors: string[]; mine: boolean }[] {
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

/** Paramètres de la personne connectée (Claude, OpenCode, GitHub, consommation) ; les champs du serveur sont réservés aux administrateurs. */
const appSettings = (ctx: Ctx) => {
  const user = requireUser(ctx);
  const claude = () => claudeSettings.forUser(user.id);
  return {
    claude: async () => (await claude()).settings,
    claudeAuth: async () => (await claude()).authStatus(),
    models: async () => (await claude()).models(),
    usage: () => usageService.summary(user.id),
    github: () => githubService.status(user.id, githubDeviceAvailable()),
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
    };
    },
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

  Task: {
    status: (t: Task) => t.status.toUpperCase(),
    priority: (t: Task) => t.priority.toUpperCase(),
    project: (t: Task) => projectService.get(t.projectId),
    session: (t: Task) => (t.sessionId ? sessionService.get(t.sessionId) : null),
    sessions: async (t: Task) => {
      const ids = await taskService.sessionIds(t.id);
      const sessions = ids.length ? await sessionService.list({ ids, archived: 'all', limit: 500 }) : [];
      return ids.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => Boolean(s));
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
  },

  TaskComment: {
    reactions: async (c: TaskComment & { reactionRows?: TaskReaction[] }, _: unknown, ctx: Ctx) => groupReactions(c.reactionRows ?? (await taskService.reactions(c.taskId)).filter((r) => r.commentId === c.id), ctx.user?.id),
    attachments: (c: TaskComment) => taskService.attachments(c.taskId, c.id),
    author: (c: TaskComment, _: unknown, ctx: Ctx) => userOrNull(ctx, c.authorUserId),
    authorSession: (c: TaskComment) => (c.authorSessionId ? sessionService.get(c.authorSessionId) : null),
    editable: (c: TaskComment, _: unknown, ctx: Ctx) => c.authorType === 'human' && c.authorUserId === ctx.user?.id,
    deletable: async (c: TaskComment, _: unknown, ctx: Ctx) => {
      if (c.authorUserId === ctx.user?.id) return true;
      const task = await taskService.get(c.taskId).catch(() => null);
      return task ? (await roleFor(ctx, task.projectId)) === 'admin' : false;
    },
  },

  ProjectApiKey: {
    createdBy: (k: ProjectApiKey, _: unknown, ctx: Ctx) => userOrNull(ctx, k.createdById),
  },

  PullRequest: {
    worksession: async (pr: PullRequest) => (pr.isCrossRepository ? null : (await worksessionService.listByProject(pr.projectId)).find((w) => w.branch === pr.headRefName) ?? null),
    tasks: async (pr: PullRequest) => (pr.isCrossRepository ? [] : (await taskService.list({ projectId: pr.projectId, limit: 1000 })).filter((t) => t.branch === pr.headRefName)),
  },

  TrackedPullRequest: {
    project: (pr: TrackedPullRequest) => projectService.get(pr.projectId),
    task: (pr: TrackedPullRequest) => (pr.taskId ? taskService.get(pr.taskId).catch(() => null) : null),
    status: (pr: TrackedPullRequest) => pr.status.toUpperCase(),
    stage: (pr: TrackedPullRequest) => stageOf(pr).toUpperCase(),
    deployedBy: (pr: TrackedPullRequest, _: unknown, ctx: Ctx) => userOrNull(ctx, pr.deployedByUserId),
    deployedBySession: (pr: TrackedPullRequest) => (pr.deployedBySessionId ? sessionService.get(pr.deployedBySessionId) : null),
    createdBy: (pr: TrackedPullRequest, _: unknown, ctx: Ctx) => userOrNull(ctx, pr.createdByUserId),
    createdBySession: (pr: TrackedPullRequest) => (pr.createdBySessionId ? sessionService.get(pr.createdBySessionId) : null),
    // En direct depuis GitHub (cache de 20 s côté service) : null si le projet n'y est pas ou si GitHub ne répond pas.
    github: (pr: TrackedPullRequest, _: unknown, ctx: Ctx) => pullRequestService.get(pr.projectId, ctx.user?.id, pr.number).catch(() => null),
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

  Workflow: {
    project: (w: Workflow) => projectService.get(w.projectId),
    issues: (w: Workflow) => workflowService.issues(w.definition),
    variables: (w: Workflow, args: { triggerKey?: string | null }) => workflowVariables(w.definition, args.triggerKey),
    eventOwner: (w: Workflow, _: unknown, ctx: Ctx) => userOrNull(ctx, w.eventOwnerId),
    runs: (w: Workflow, args: { limit?: number | null }) => workflowService.listRuns({ workflowId: w.id, limit: args.limit ?? 20 }),
    lastRun: (w: Workflow) => workflowService.lastRun(w.id),
    createdBy: (w: Workflow, _: unknown, ctx: Ctx) => userOrNull(ctx, w.createdById),
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

  SharedPage: {
    owner: (p: SharedPage) => userService.get(p.ownerId),
    members: async (p: SharedPage, _: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      const members = await sharedPageService.members(p.id);
      return p.ownerId === user.id || members.some((m) => m.userId === user.id) ? members : [];
    },
    versions: (p: SharedPage) => sharedPageService.versions(p.id),
    project: (p: SharedPage, _: unknown, ctx: Ctx) => (p.ownerId === ctx.user?.id ? projectIfAccessible(ctx, p.projectId) : null),
    session: (p: SharedPage, _: unknown, ctx: Ctx) => (p.ownerId === ctx.user?.id && p.sessionId ? sessionService.get(p.sessionId) : null),
    sourcePath: (p: SharedPage, _: unknown, ctx: Ctx) => (p.ownerId === ctx.user?.id ? p.sourcePath : null),
    viewerAccess: async (p: SharedPage, _: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      const members = await sharedPageService.members(p.id);
      return { owner: p.ownerId === user.id, member: members.some((m) => m.userId === user.id) };
    },
  },
  SharedPageMember: {
    user: (m: SharedPageMember) => userService.get(m.userId),
    addedBy: (m: SharedPageMember, _: unknown, ctx: Ctx) => userOrNull(ctx, m.addedById),
    addedAt: (m: SharedPageMember) => m.createdAt,
  },
  SharedPageVersion: {
    createdBy: (v: SharedPageVersion, _: unknown, ctx: Ctx) => userOrNull(ctx, v.createdById),
  },

  Terminal: {
    status: (t: TerminalRecord) => t.status.toUpperCase(),
    project: (t: TerminalRecord, _: unknown, ctx: Ctx) => projectOf(ctx, t.projectId),
    worksession: (t: TerminalRecord, _: unknown, ctx: Ctx) => worksessionOrNull(ctx, t.worksessionId),
    createdBy: (t: TerminalRecord, _: unknown, ctx: Ctx) => userOrNull(ctx, t.createdById),
  },

  Worksession: {
    project: (w: Worksession, _: unknown, ctx: Ctx) => projectOf(ctx, w.projectId),
    label: (w: Worksession) => worksessionLabel(w),
    customLabel: (w: Worksession) => w.label,
    path: async (w: Worksession, _: unknown, ctx: Ctx) => worksessionPath(await projectOf(ctx, w.projectId), w),
    exists: async (w: Worksession, _: unknown, ctx: Ctx) => worksessionService.exists(await projectOf(ctx, w.projectId), w),
    git: async (w: Worksession, _: unknown, ctx: Ctx) => worksessionService.gitInfo(await projectOf(ctx, w.projectId), w),
    pullRequest: async (w: Worksession, _: unknown, ctx: Ctx) => ((await projectOf(ctx, w.projectId)).gitUrl ? pullRequestService.forBranch(w.projectId, ctx.user?.id, w.branch).catch(() => null) : null),
    task: async (w: Worksession, _: unknown, ctx: Ctx) => (w.taskId ? await loadersOf(ctx).task(w.taskId) : null) ?? (await loadersOf(ctx).taskForBranch({ projectId: w.projectId, branch: w.branch })) ?? null,
    sessions: (w: Worksession) => sessionService.list({ projectId: w.projectId, worksessionId: w.id, limit: 200 }),
    terminals: async (w: Worksession, _: unknown, ctx: Ctx) => (await terminalService.listByProject(w.projectId, requireUser(ctx).id)).filter((t) => t.worksessionId === w.id),
  },

  PermissionRule: {
    rule: (r: PermissionRule) => formatRule(r),
    createdBySession: (r: PermissionRule) => (r.createdBySessionId ? sessionService.get(r.createdBySessionId) : null),
  },

  Project: {
    workspacePath: (project: Project) => workspacePath(project),
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
    vaultItems: (project: Project, _: unknown, ctx: Ctx) => vaultService.projectRows(project.id, requireUser(ctx).id),
    apiKeys: async (project: Project, _: unknown, ctx: Ctx) => ((await roleFor(ctx, project.id)) === 'admin' ? apiKeyService.list(project.id) : []),
    approvalConnections: async (project: Project, _: unknown, ctx: Ctx) => vaultService.approvalNames(await vaultService.agentItems(project.id, ctx.user?.id ?? null)),
    tasks: (project: Project, args: { status?: GqlTaskStatus[] | null }) => taskService.list({ projectId: project.id, status: fromGqlTaskStatuses(args.status) }),
    contextFolders: async (project: Project) => (await contextService.tree(project.id)).folders,
    contextInstructions: async (project: Project) => (await contextService.tree(project.id)).instructions,
    contextChanges: (project: Project, args: { limit?: number | null }) => contextService.changes(project.id, args.limit ?? undefined),
    workspaceExists: (project: Project) => workspaceExists(project),
    git: (project: Project) => workspaceGitInfo(project),
    sessions: (project: Project, args: { status?: GqlStatus | null; limit?: number | null; offset?: number | null }) =>
      sessionService.list({ projectId: project.id, status: fromGqlStatus(args.status), limit: args.limit ?? undefined, offset: args.offset ?? undefined }),
  },

  Request: {
    status: (request: HumanRequest) => request.status.toUpperCase(),
    session: (request: HumanRequest) => sessionService.get(request.sessionId),
    answeredBy: (request: HumanRequest, _: unknown, ctx: Ctx) => userOrNull(ctx, request.answeredById),
  },

  Session: {
    kind: (session: Session) => session.kind.toUpperCase(),
    project: (session: Session, _: unknown, ctx: Ctx) => projectOf(ctx, session.projectId),
    worksession: (session: Session, _: unknown, ctx: Ctx) => worksessionOrNull(ctx, session.worksessionId),
    owner: (session: Session, _: unknown, ctx: Ctx) => userOrNull(ctx, session.ownerId),
    task: (session: Session) => taskService.forSession(session.id),
    parentSession: async (session: Session, _: unknown, ctx: Ctx) => (session.parentSessionId ? ((await loadersOf(ctx).session(session.parentSessionId)) ?? null) : null),
    childSessions: (session: Session) => sessionService.list({ parentSessionId: session.id, archived: 'all', limit: 50 }),
    workflowRun: (session: Session) => (session.workflowRunId ? workflowService.findRun(session.workflowRunId) : null),
    status: (session: Session) => toGqlStatus(session.status),
    activity: (session: Session) => (session.activity ? session.activity.toUpperCase() : null),
    requests: (session: Session, args: { status?: GqlRequestStatus | null }) =>
      requestService.list({ sessionId: session.id, status: fromGqlRequestStatus(args.status) }),
    pendingRequestCount: async (session: Session, _: unknown, ctx: Ctx) => (await loadersOf(ctx).pendingRequestCount(session.id)) ?? 0,
    browserActive: (session: Session) => liveBrowserService.isActive(session.id),
    liveDraft: (session: Session) => liveDraftService.get(session.id),
    queuePosition: (session: Session) => (session.status === 'queued' ? sessionService.queuePosition(session.id) : null),
    promptAttachments: (session: Session) => session.promptAttachments.map(publicAttachment),
    schedule: (session: Session) => scheduleService.get(session.id),
    context: (session: Session): ContextParent => ({ session }),
    events: (session: Session, args: { after?: string | null; limit?: number | null }) =>
      sessionService.events(session.id, { after: args.after ?? undefined, limit: args.limit ?? undefined }),
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
    coldTurnUsd: async (p: ContextParent) => contextEstimate(p.session.contextTokens, await modelOfContext(p)).coldTurnUsd,
  },

  Query: {
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
    githubPullRequests: async (_: unknown, args: { projectId: string; state?: PullRequestFilter | null; limit?: number | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return pullRequestService.list(args.projectId, requireUser(ctx).id, args.state ?? 'OPEN', args.limit ?? 50);
    },
    githubPullRequest: async (_: unknown, args: { projectId: string; number: number }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return pullRequestService.get(args.projectId, requireUser(ctx).id, args.number);
    },
    githubPullRequestDraft: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return pullRequestService.draft(args, requireUser(ctx).id);
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
      requireUser(ctx);
      return githubService.listRepositories(requireUser(ctx).id, args.query);
    },
    me: (_: unknown, __: unknown, ctx: Ctx) => ctx.user,
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
    search: async (_: unknown, args: { query: string; kinds?: SearchKind[] | null; limit?: number | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const memberProjectIds = await accessibleProjectIds(ctx);
      const projectIds = user.isSuperAdmin ? (await projectService.list()).map((p) => p.id) : memberProjectIds;
      return { query: args.query, groups: await searchService.search({ userId: user.id, memberProjectIds, projectIds }, args.query, args.kinds, args.limit) };
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
    vaultItems: (_: unknown, args: { kind?: VaultItemKind | null }, ctx: Ctx) => vaultService.listAccessible(requireUser(ctx).id, args.kind),
    vaultItem: (_: unknown, args: { id: string }, ctx: Ctx) => vaultService.findFor(requireUser(ctx).id, args.id),
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
    sharedPages: (_: unknown, __: unknown, ctx: Ctx) => sharedPageService.listFor(requireUser(ctx).id),
    pushPublicKey: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return pushService.publicKey();
    },
    pushPreferences: (_: unknown, __: unknown, ctx: Ctx) => {
      const user = requireUser(ctx);
      return pushPreferencesService.list(user.id, user.isAdmin);
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
    providers: (_: unknown, __: unknown, ctx: Ctx) => listProviders(requireUser(ctx).id),
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
    scheduleNextRuns: (_: unknown, args: { cron: string; timezone?: string | null; count?: number | null }, ctx: Ctx) => {
      requireUser(ctx);
      return scheduleService.preview(args.cron, args.timezone, args.count ?? 5);
    },
    projects: (_: unknown, args: { all?: boolean | null; includePersonal?: boolean | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      return args.all && user.isSuperAdmin ? projectService.list() : projectService.listForUser(user.id, { includePersonal: args.includePersonal ?? false });
    },
    project: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id);
      return projectService.get(args.id);
    },
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
    notifications: async (_: unknown, args: { unreadOnly?: boolean | null; limit?: number | null }, ctx: Ctx) =>
      notificationService.list({ unreadOnly: args.unreadOnly ?? false, limit: args.limit ?? undefined, projectIds: await accessibleProjectIds(ctx), admin: requireUser(ctx).isAdmin, userId: requireUser(ctx).id }),
    unreadNotificationCount: async (_: unknown, __: unknown, ctx: Ctx) => notificationService.countUnread({ projectIds: await accessibleProjectIds(ctx), admin: requireUser(ctx).isAdmin, userId: requireUser(ctx).id }),
    dashboard: async (_: unknown, __: unknown, ctx: Ctx) => dashboardService.build(requireUser(ctx).id, await accessibleProjectIds(ctx), new Date(), requireUser(ctx).isAdmin),
    tasks: async (_: unknown, args: { projectId?: string | null; status?: GqlTaskStatus[] | null; priority?: GqlTaskPriority | null; assignee?: string | null; reporter?: string | null; tag?: string | null; mine?: boolean | null; limit?: number | null }, ctx: Ctx) => {
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
    searchContext: async (_: unknown, args: { projectId: string; query: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId);
      return contextService.search(args.projectId, args.query);
    },
  },

  Mutation: {
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
    gitCheckout: async (_: unknown, args: WorkspaceRef & { branch: string; create?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.checkout(args, args.branch, args.create ?? false);
      return gitService.status(args);
    },
    createPullRequest: async (_: unknown, args: WorkspaceRef & { title: string; body?: string | null; base?: string | null; draft?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const user = requireUser(ctx);
      const pr = await pullRequestService.create(args, user.id, args);
      // La PR ouverte depuis l'interface est suivie (reliée à la tâche de sa branche).
      await trackedPullRequestService.recordGithub(args.projectId, pr, { type: 'human', userId: user.id }).catch((err) => console.error('[pull-requests] suivi de la PR créée', err));
      return pr;
    },
    mergePullRequest: async (_: unknown, args: { projectId: string; number: number; method?: MergeMethod | null; cleanup?: MergeCleanup | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const user = requireUser(ctx);
      const result = await pullRequestService.merge(args.projectId, user.id, args.number, args.method ?? 'MERGE', args.cleanup ?? { deleteRemoteBranch: true, deleteWorksession: true, completeTasks: true });
      await trackedPullRequestService.markMerged(args.projectId, result.pullRequest, result.sha, { type: 'human', userId: user.id }).catch((err) => console.error('[pull-requests] suivi de la PR fusionnée', err));
      return result;
    },
    registerPullRequest: async (_: unknown, args: { projectId: string; url?: string | null; number?: number | null; taskId?: string | null; note?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      const user = requireUser(ctx);
      return trackedPullRequestService.register(args.projectId, { url: args.url, number: args.number }, { taskId: args.taskId, note: args.note, userId: user.id }, { type: 'human', userId: user.id });
    },
    updatePullRequest: async (_: unknown, args: { id: string; input: { status?: string | null; note?: string | null; taskId?: string | null; deployed?: boolean | null; deployNote?: string | null } }, ctx: Ctx) => {
      const pr = await trackedPullRequestService.get(args.id);
      await requireProject(ctx, pr.projectId, 'member');
      const user = requireUser(ctx);
      return trackedPullRequestService.update(args.id, { ...args.input, status: args.input.status ? (args.input.status.toLowerCase() as TrackedPullRequestStatus) : undefined }, { type: 'human', userId: user.id });
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
      console.log(`[server] mode maintenance ${args.enabled ? 'activé' : 'levé'} par ${user.email}`);
      // Fin de la maintenance : les sessions en file d'attente peuvent démarrer.
      if (!args.enabled) void sessionService.drainQueue();
      return appSettings(ctx);
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
    updateClaudeSettings: async (_: unknown, { input }: { input: ClaudeSettingsPatch }, ctx: Ctx) => {
      await (await claudeSettings.forUser(requireUser(ctx).id)).update(input);
      return appSettings(ctx);
    },
    setClaudeApiKeyItem: async (_: unknown, args: { itemId?: string | null }, ctx: Ctx) => {
      await (await claudeSettings.forUser(requireUser(ctx).id)).setApiKeyItem(args.itemId ?? null);
      return appSettings(ctx);
    },
    setClaudeOauthItem: async (_: unknown, args: { itemId?: string | null }, ctx: Ctx) => {
      await (await claudeSettings.forUser(requireUser(ctx).id)).setOauthItem(args.itemId ?? null);
      return appSettings(ctx);
    },
    clearClaudeOauthToken: async (_: unknown, __: unknown, ctx: Ctx) => {
      await (await claudeSettings.forUser(requireUser(ctx).id)).clearOauthToken();
      return appSettings(ctx);
    },
    startClaudeLogin: (_: unknown, __: unknown, ctx: Ctx) => loginService.start(requireUser(ctx).id),
    completeClaudeLogin: (_: unknown, args: { id: string; code: string }, ctx: Ctx) => loginService.complete(args.id, args.code, requireUser(ctx).id),
    cancelClaudeLogin: (_: unknown, args: { id: string }, ctx: Ctx) => loginService.cancel(args.id, requireUser(ctx).id),
    verifyClaudeAuth: async (_: unknown, args: { mode?: ClaudeAuthMode | null }, ctx: Ctx) => {
      await claudeSettings.verify(requireUser(ctx).id, args.mode ?? null);
      return appSettings(ctx);
    },
    updateOpencodeSettings: async (_: unknown, { input }: { input: OpencodeSettingsPatch }, ctx: Ctx) => {
      await (await opencodeSettings.forUser(requireUser(ctx).id)).update(input);
      return appSettings(ctx);
    },
    setOpencodeKeyItem: async (_: unknown, args: { provider: string; itemId?: string | null }, ctx: Ctx) => {
      await (await opencodeSettings.forUser(requireUser(ctx).id)).setKeyItem(args.provider, args.itemId ?? null);
      return appSettings(ctx);
    },
    refreshOpencodeModels: async (_: unknown, __: unknown, ctx: Ctx) => {
      await (await opencodeSettings.forUser(requireUser(ctx).id)).listModels();
      return appSettings(ctx);
    },
    startAwsLogin: (_: unknown, args: { id: string }, ctx: Ctx) => awsService.startLogin(vaultActor(ctx), args.id),
    pollAwsLogin: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const r = await awsService.pollLogin(vaultActor(ctx), args.id);
      return { ...r, status: r.status.toUpperCase(), item: r.item ? { ...r.item, permission: 'manage' } : null };
    },
    startGithubDeviceLogin: (_: unknown, __: unknown, ctx: Ctx) => githubDeviceService.start(requireUser(ctx).id),
    pollGithubDeviceLogin: (_: unknown, args: { id: string }, ctx: Ctx) => githubDeviceService.poll(requireUser(ctx).id, args.id),
    connectGithubFromVault: (_: unknown, args: { itemId: string }, ctx: Ctx) => githubService.connectFromVault(requireUser(ctx).id, args.itemId),
    setDefaultGithubAccount: async (_: unknown, args: { accountId: string }, ctx: Ctx) => {
      await githubService.setDefault(requireUser(ctx).id, args.accountId);
      return appSettings(ctx);
    },
    disconnectGithub: async (_: unknown, args: { accountId?: string | null }, ctx: Ctx) => {
      await githubService.disconnect(requireUser(ctx).id, args.accountId ?? null);
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
    deleteUser: (_: unknown, args: { userId: string }, ctx: Ctx) => userService.delete(args.userId, requireAdmin(ctx)),
    inviteProjectMember: async (_: unknown, args: { projectId: string; email: string; role?: GqlRole | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await requireProject(ctx, args.projectId, 'admin');
      await personalService.assertNotPersonal(args.projectId, 'Inviter quelqu\'un');
      return userService.invite(args.projectId, args.email, fromGqlRole(args.role), user);
    },
    updateProjectMemberRole: async (_: unknown, args: { projectId: string; userId: string; role: GqlRole }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      await personalService.assertNotPersonal(args.projectId, 'Changer un rôle');
      return userService.setRole(args.projectId, args.userId, fromGqlRole(args.role));
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
      return userService.remove(args.projectId, args.userId);
    },

    createProject: async (_: unknown, { input }: { input: CreateProjectInput }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const project = await projectService.create(input, user.id);
      await userService.addCreator(project.id, user);
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
    deleteProject: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      await personalService.assertNotPersonal(args.id, 'Supprimer');
      return deleteProjectCascade(args.id);
    },
    createSession: async (
      _: unknown,
      { input }: { input: CreateSessionInput & { autoStart?: boolean | null } },
      ctx: Ctx,
    ) => {
      await requireProject(ctx, input.projectId, 'member');
      return sessionService.create({ ...input, ownerId: requireUser(ctx).id, autoStart: input.autoStart ?? true });
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
      await scheduleService.remove(args.id).catch(() => undefined);
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
      return sessionService.sendMessage(args.id, args.text, args.attachments);
    },
    endSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.end(args.id);
    },
    resumeSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.resume(args.id);
    },
    interruptSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.interrupt(args.id);
    },
    updateSessionConfig: async (_: unknown, args: { id: string; config: Record<string, unknown> }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.updateConfig(args.id, args.config ?? {});
    },
    setSessionSchedule: async (_: unknown, args: { id: string; input: SessionScheduleInput }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      await scheduleService.set(args.id, args.input);
      return sessionService.get(args.id);
    },
    clearSessionSchedule: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return scheduleService.remove(args.id);
    },
    runSessionScheduleNow: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return scheduleService.runNow(args.id);
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
      await guardRequest(ctx, args.id, 'member');
      return requestService.answer(args.id, args.response ?? {}, requireUser(ctx).id);
    },
    cancelRequest: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardRequest(ctx, args.id, 'member');
      return requestService.cancel(args.id, requireUser(ctx).id);
    },

    markNotificationRead: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const n = await notificationService.get(args.id);
      if (n.adminsOnly) requireAdmin(ctx);
      if (n.projectId) await requireProject(ctx, n.projectId);
      else requireUser(ctx);
      return notificationService.markRead(args.id);
    },
    markAllNotificationsRead: async (_: unknown, __: unknown, ctx: Ctx) => notificationService.markAllRead({ projectIds: await accessibleProjectIds(ctx), admin: requireUser(ctx).isAdmin }),
    createTask: async (_: unknown, { input }: { input: GqlTaskInput & { projectId: string; title: string } }, ctx: Ctx) => {
      await requireProject(ctx, input.projectId, 'member');
      return taskService.create(input.projectId, { ...toTaskInput(input), title: input.title }, HUMAN);
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
    startTaskSession: async (_: unknown, args: { id: string; provider?: string | null; config?: Record<string, unknown> | null; prompt?: string | null }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      return startTaskSession(args.id, { ...args, ownerId: requireUser(ctx).id });
    },
    createProjectApiKey: async (_: unknown, args: { projectId: string; name: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return apiKeyService.create(args.projectId, args.name, requireUser(ctx).id);
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
    renameWorksession: async (_: unknown, args: { id: string; label?: string | null; name?: string | null }, ctx: Ctx) => {
      await guardWorksession(ctx, args.id, 'member');
      return worksessionService.rename(args.id, args);
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
    updateSharedPage: (_: unknown, args: { id: string; input: { title?: string | null; description?: string | null; linkAccess?: boolean | null } }, ctx: Ctx) => sharedPageService.update(requireUser(ctx).id, args.id, args.input),
    addSharedPageMember: (_: unknown, args: { id: string; email: string }, ctx: Ctx) => sharedPageService.addMember(requireUser(ctx), args.id, args.email),
    removeSharedPageMember: (_: unknown, args: { id: string; userId: string }, ctx: Ctx) => sharedPageService.removeMember(requireUser(ctx), args.id, args.userId),
    deleteSharedPage: (_: unknown, args: { id: string }, ctx: Ctx) => sharedPageService.delete(requireUser(ctx).id, args.id),
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
    closeTerminal: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTerminal(ctx, args.id, 'member');
      return terminalService.close(args.id);
    },
    deleteTerminal: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTerminal(ctx, args.id, 'member');
      return terminalService.delete(args.id);
    },
    createContextFolder: async (_: unknown, args: { projectId: string; parentId?: string | null; name: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return contextService.createFolder(args.projectId, { parentId: args.parentId ?? null, name: args.name }, HUMAN);
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
      { input }: { input: { projectId: string; folderId?: string | null; name: string; description?: string | null; content?: string | null; changeNote?: string | null } },
      ctx: Ctx,
    ) => {
      await requireProject(ctx, input.projectId, 'member');
      return contextService.createInstruction(input.projectId, input, HUMAN);
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
  },

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
