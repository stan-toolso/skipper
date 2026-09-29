import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { accessibleProjectIds, canAccessProject, filterAsync, requireAdmin, requireProject, requireUser, roleFor, type AuthContext } from '../auth/access.js';
import { connectionService } from '../connections/service.js';
import { fingerprint } from '../connections/ssh.js';
import type { Connection, ConnectionInput, PostgresSettings, WebsiteSettings } from '../connections/types.js';
import { variableName } from '../connections/website.js';
import { contextService, HUMAN } from '../context/service.js';
import { NotFoundError } from '../errors.js';
import { fileService, type WorkspaceRef } from '../files/service.js';
import { gitService } from '../git/service.js';
import { googleAccountService } from '../google/service.js';
import type { GoogleAccount } from '../google/types.js';
import { deleteProjectCascade, deleteWorktreeCascade } from '../projects/cleanup.js';
import { runner } from '../runners/index.js';
import type { ContextChange, ContextInstruction, ContextInstructionVersion } from '../context/types.js';
import { projectService } from '../projects/service.js';
import type { CreateProjectInput, Project, UpdateProjectInput } from '../projects/types.js';
import { workspaceExists, workspaceGitInfo, workspacePath } from '../projects/workspace.js';
import { notificationService } from '../notifications/service.js';
import type { Notification } from '../notifications/types.js';
import { pubSub } from '../pubsub.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest, RequestStatus } from '../requests/types.js';
import { listProviders } from '../sessions/providers/registry.js';
import { sessionService } from '../sessions/service.js';
import { serverAuthStatus, serverLogout } from '../settings/cli.js';
import { loginService, type ClaudeLoginKind } from '../settings/login.js';
import { githubService } from '../settings/github.js';
import { settingsService, type ClaudeSettingsPatch } from '../settings/service.js';
import type { ClaudeAuthMode } from '../settings/types.js';
import { usageService } from '../settings/usage.js';
import { terminalService } from '../terminals/service.js';
import { worktreePath, worktreeService } from '../worktrees/service.js';
import type { Worktree } from '../worktrees/types.js';
import { startTaskSession } from '../tasks/launch.js';
import { taskService } from '../tasks/service.js';
import type { Task, TaskPriority, TaskStatus } from '../tasks/types.js';
import type { TerminalRecord } from '../terminals/types.js';
import type { Session, SessionStatus } from '../sessions/types.js';
import { permissionRuleService } from '../permissions/service.js';
import { formatRule, type PermissionRule } from '../permissions/types.js';
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
const guardSession = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, await projectOfSession(id), min);
const guardRequest = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, await projectOfRequest(id), min);
const guardTask = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await taskService.get(id)).projectId, min);
const guardTerminal = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await terminalService.get(id)).projectId, min);
const guardWorktree = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await worktreeService.get(id)).projectId, min);
const guardConnection = async (ctx: Ctx, id: string, min: ProjectRole) => requireProject(ctx, (await connectionService.get(id)).projectId, min);
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
}
const toTaskInput = (i: GqlTaskInput) => ({
  title: i.title ?? undefined,
  description: i.description ?? undefined,
  priority: fromGqlTaskPriority(i.priority),
  status: fromGqlTaskStatus(i.status),
  sessionId: i.sessionId,
  dueDate: i.dueDate,
});
const fromGqlRequestStatus = (s?: GqlRequestStatus | null): RequestStatus | undefined =>
  s ? (s.toLowerCase() as RequestStatus) : undefined;

const toGqlStatus = (s: SessionStatus): GqlStatus => s.toUpperCase() as GqlStatus;
const fromGqlStatus = (s?: GqlStatus | null): SessionStatus | undefined =>
  s ? (s.toLowerCase() as SessionStatus) : undefined;

/** Vue agrégée des paramètres ; les champs coûteux (consommation) sont résolus à la demande. */
const appSettings = () => ({
  claude: settingsService.claude,
  claudeAuth: settingsService.authStatus(),
  github: githubService.status(),
  models: settingsService.models(),
  usage: () => usageService.summary(),
});

export const resolvers = {
  JSON: JSONResolver,
  DateTime: DateTimeResolver,

  ProjectMember: {
    user: (m: ProjectMember) => userService.get(m.userId),
    role: (m: ProjectMember) => m.role.toUpperCase(),
    invitedBy: (m: ProjectMember) => (m.invitedById ? userService.get(m.invitedById).catch(() => null) : null),
    pending: async (m: ProjectMember) => (await userService.get(m.userId)).lastLoginAt === null,
  },

  ClaudeAuthStatus: {
    server: () => serverAuthStatus(),
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
  },

  Task: {
    status: (t: Task) => t.status.toUpperCase(),
    priority: (t: Task) => t.priority.toUpperCase(),
    project: (t: Task) => projectService.get(t.projectId),
    session: (t: Task) => (t.sessionId ? sessionService.get(t.sessionId) : null),
    createdBySession: (t: Task) => (t.createdBySessionId ? sessionService.get(t.createdBySessionId) : null),
  },

  Connection: {
    project: (c: Connection) => projectService.get(c.projectId),
    host: (c: Connection) => (c.kind === 'website' ? null : (c.settings as PostgresSettings).host),
    port: (c: Connection) => (c.kind === 'website' ? null : (c.settings as PostgresSettings).port),
    username: (c: Connection) => (c.kind === 'website' ? null : (c.settings as PostgresSettings).username),
    url: (c: Connection) => (c.kind === 'website' ? (c.settings as WebsiteSettings).url : null),
    fields: (c: Connection) => (c.kind === 'website' ? (c.settings as WebsiteSettings).fields.map((f) => ({ ...f, variable: variableName(c.name, f.key) })) : []),
    database: (c: Connection) => (c.kind === 'postgres' ? (c.settings as PostgresSettings).database : null),
    ssl: (c: Connection) => (c.kind === 'postgres' ? (c.settings as PostgresSettings).ssl : null),
    viaConnection: (c: Connection) => {
      const via = c.kind === 'postgres' ? (c.settings as PostgresSettings).viaConnectionId : null;
      return via ? connectionService.get(via).catch(() => null) : null;
    },
    hostFingerprint: (c: Connection) => (c.hostKey ? fingerprint(c.hostKey) : null),
    hasSecret: (c: Connection) => connectionService.hasSecret(c),
  },

  Terminal: {
    status: (t: TerminalRecord) => t.status.toUpperCase(),
    project: (t: TerminalRecord) => projectService.get(t.projectId),
    worktree: (t: TerminalRecord) => (t.worktreeId ? worktreeService.get(t.worktreeId).catch(() => null) : null),
  },

  Worktree: {
    project: (w: Worktree) => projectService.get(w.projectId),
    path: async (w: Worktree) => worktreePath(await projectService.get(w.projectId), w),
    exists: async (w: Worktree) => worktreeService.exists(await projectService.get(w.projectId), w),
    git: async (w: Worktree) => worktreeService.gitInfo(await projectService.get(w.projectId), w),
    sessions: (w: Worktree) => sessionService.list({ projectId: w.projectId, worktreeId: w.id }),
    terminals: async (w: Worktree) => (await terminalService.listByProject(w.projectId)).filter((t) => t.worktreeId === w.id),
  },

  GoogleAccount: {
    gmailAccess: (a: GoogleAccount) => a.gmailAccess.toUpperCase(),
    driveAccess: (a: GoogleAccount) => a.driveAccess.toUpperCase(),
    connectedBy: (a: GoogleAccount) => (a.connectedById ? userService.get(a.connectedById).catch(() => null) : null),
  },

  PermissionRule: {
    rule: (r: PermissionRule) => formatRule(r),
    createdBySession: (r: PermissionRule) => (r.createdBySessionId ? sessionService.get(r.createdBySessionId) : null),
  },

  Project: {
    workspacePath: (project: Project) => workspacePath(project),
    permissionRules: (project: Project) => permissionRuleService.list(project.id),
    runnerStatus: (project: Project) => runner.status(project),
    members: (project: Project) => userService.members(project.id),
    myRole: async (project: Project, _: unknown, ctx: Ctx) => ((await roleFor(ctx, project.id)) ?? 'viewer').toUpperCase(),
    terminals: (project: Project) => terminalService.listByProject(project.id),
    worktrees: (project: Project) => worktreeService.listByProject(project.id),
    connections: (project: Project) => connectionService.listByProject(project.id),
    googleAccount: (project: Project) => googleAccountService.find(project.id),
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
  },

  Session: {
    project: (session: Session) => projectService.get(session.projectId),
    worktree: (session: Session) => (session.worktreeId ? worktreeService.get(session.worktreeId).catch(() => null) : null),
    status: (session: Session) => toGqlStatus(session.status),
    activity: (session: Session) => (session.activity ? session.activity.toUpperCase() : null),
    requests: (session: Session, args: { status?: GqlRequestStatus | null }) =>
      requestService.list({ sessionId: session.id, status: fromGqlRequestStatus(args.status) }),
    pendingRequestCount: (session: Session) => requestService.countPending(session.id),
    events: (session: Session, args: { after?: string | null; limit?: number | null }) =>
      sessionService.events(session.id, { after: args.after ?? undefined, limit: args.limit ?? undefined }),
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
      return githubService.listRepositories(args.query);
    },
    me: (_: unknown, __: unknown, ctx: Ctx) => ctx.user,
    users: (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      return userService.list();
    },
    settings: (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      return appSettings();
    },
    claudeLogin: (_: unknown, args: { id: string }, ctx: Ctx) => {
      requireAdmin(ctx);
      return loginService.get(args.id);
    },
    providers: (_: unknown, __: unknown, ctx: Ctx) => {
      requireUser(ctx);
      return listProviders();
    },
    sessions: async (_: unknown, args: { projectId?: string | null; status?: GqlStatus | null; provider?: string | null; limit?: number | null; offset?: number | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      return sessionService.list({
        projectId: args.projectId ?? undefined,
        projectIds: args.projectId ? undefined : await accessibleProjectIds(ctx),
        status: fromGqlStatus(args.status),
        provider: args.provider ?? undefined,
        limit: args.limit ?? undefined,
        offset: args.offset ?? undefined,
      });
    },
    session: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const session = await sessionService.get(args.id);
      if (session) await requireProject(ctx, session.projectId);
      return session;
    },
    projects: (_: unknown, __: unknown, ctx: Ctx) => projectService.listForUser(requireUser(ctx).id),
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
    worktree: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardWorktree(ctx, args.id, 'viewer');
      return worktreeService.get(args.id);
    },
    connection: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardConnection(ctx, args.id, 'viewer');
      return connectionService.get(args.id);
    },
    notifications: async (_: unknown, args: { unreadOnly?: boolean | null; limit?: number | null }, ctx: Ctx) =>
      notificationService.list({ unreadOnly: args.unreadOnly ?? false, limit: args.limit ?? undefined, projectIds: await accessibleProjectIds(ctx) }),
    unreadNotificationCount: async (_: unknown, __: unknown, ctx: Ctx) => notificationService.countUnread(await accessibleProjectIds(ctx)),
    tasks: async (_: unknown, args: { projectId?: string | null; status?: GqlTaskStatus[] | null; priority?: GqlTaskPriority | null; limit?: number | null }, ctx: Ctx) => {
      if (args.projectId) await requireProject(ctx, args.projectId);
      return taskService.list({
        projectId: args.projectId ?? undefined,
        projectIds: args.projectId ? undefined : await accessibleProjectIds(ctx),
        status: fromGqlTaskStatuses(args.status) ?? ['todo', 'in_progress'],
        priority: fromGqlTaskPriority(args.priority),
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
    gitCommit: async (_: unknown, args: WorkspaceRef & { message: string; stageAll?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.commit(args, args.message, args.stageAll ?? false);
      return gitService.status(args);
    },
    gitFetch: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.fetch(args);
      return gitService.status(args);
    },
    gitPull: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.pull(args);
      return gitService.status(args);
    },
    gitPush: async (_: unknown, args: WorkspaceRef, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.push(args);
      return gitService.status(args);
    },
    gitCheckout: async (_: unknown, args: WorkspaceRef & { branch: string; create?: boolean | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      await gitService.checkout(args, args.branch, args.create ?? false);
      return gitService.status(args);
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
    setGithubClientId: async (_: unknown, args: { clientId?: string | null }, ctx: Ctx) => {
      requireAdmin(ctx);
      await githubService.setClientId(args.clientId ?? null);
      return appSettings();
    },
    setGithubPersonalToken: async (_: unknown, args: { token: string }, ctx: Ctx) => {
      requireAdmin(ctx);
      await githubService.setPersonalToken(args.token);
      return appSettings();
    },
    startGithubLogin: (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      return githubService.startLogin();
    },
    cancelGithubLogin: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      githubService.cancelLogin();
      return appSettings();
    },
    disconnectGithub: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      await githubService.disconnect();
      return appSettings();
    },
    updateClaudeSettings: async (_: unknown, { input }: { input: ClaudeSettingsPatch }, ctx: Ctx) => {
      requireAdmin(ctx);
      await settingsService.update(input);
      return appSettings();
    },
    setClaudeApiKey: async (_: unknown, args: { apiKey?: string | null }, ctx: Ctx) => {
      requireAdmin(ctx);
      await settingsService.setApiKey(args.apiKey ?? null);
      return appSettings();
    },
    clearClaudeOauthToken: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      await settingsService.clearOauthToken();
      return appSettings();
    },
    startClaudeLogin: (_: unknown, args: { kind?: ClaudeLoginKind | null }, ctx: Ctx) => {
      requireAdmin(ctx);
      return loginService.start(args.kind ?? 'oauth');
    },
    logoutServerClaude: async (_: unknown, __: unknown, ctx: Ctx) => {
      requireAdmin(ctx);
      await serverLogout();
      settingsService.invalidateVerification();
      return appSettings();
    },
    completeClaudeLogin: (_: unknown, args: { id: string; code: string }, ctx: Ctx) => {
      requireAdmin(ctx);
      return loginService.complete(args.id, args.code);
    },
    cancelClaudeLogin: (_: unknown, args: { id: string }, ctx: Ctx) => {
      requireAdmin(ctx);
      return loginService.cancel(args.id);
    },
    verifyClaudeAuth: async (_: unknown, args: { mode?: ClaudeAuthMode | null }, ctx: Ctx) => {
      requireAdmin(ctx);
      await settingsService.verify(args.mode ?? undefined);
      return appSettings();
    },

    inviteProjectMember: async (_: unknown, args: { projectId: string; email: string; role?: GqlRole | null }, ctx: Ctx) => {
      const user = requireUser(ctx);
      await requireProject(ctx, args.projectId, 'admin');
      return userService.invite(args.projectId, args.email, fromGqlRole(args.role), user);
    },
    updateProjectMemberRole: async (_: unknown, args: { projectId: string; userId: string; role: GqlRole }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return userService.setRole(args.projectId, args.userId, fromGqlRole(args.role));
    },
    addProjectPermissionRule: async (_: unknown, args: { projectId: string; toolName: string; ruleContent?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return permissionRuleService.add(args.projectId, args.toolName, args.ruleContent ?? null);
    },
    deleteProjectPermissionRule: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, (await permissionRuleService.get(args.id)).projectId, 'member');
      return permissionRuleService.remove(args.id);
    },
    removeProjectMember: async (_: unknown, args: { projectId: string; userId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return userService.remove(args.projectId, args.userId);
    },

    createProject: async (_: unknown, { input }: { input: CreateProjectInput }, ctx: Ctx) => {
      const user = requireUser(ctx);
      const project = await projectService.create(input);
      await userService.addCreator(project.id, user);
      return project;
    },
    updateProject: async (_: unknown, { id, input }: { id: string; input: UpdateProjectInput }, ctx: Ctx) => {
      await requireProject(ctx, id, 'admin');
      return projectService.update(id, input);
    },
    prepareProjectWorkspace: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      return projectService.prepareWorkspace(args.id);
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
      await runner.stop(project);
      return project;
    },
    resetProjectRunner: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      const project = await projectService.get(args.id);
      await runner.remove(project);
      return project;
    },
    deleteProject: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await requireProject(ctx, args.id, 'admin');
      return deleteProjectCascade(args.id);
    },
    createSession: async (
      _: unknown,
      { input }: { input: { projectId: string; worktreeId?: string | null; name: string; provider: string; prompt?: string | null; config?: Record<string, unknown> | null; autoStart?: boolean | null } },
      ctx: Ctx,
    ) => {
      await requireProject(ctx, input.projectId, 'member');
      return sessionService.create({ ...input, autoStart: input.autoStart ?? true });
    },
    startSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.start(args.id);
    },
    stopSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.stop(args.id);
    },
    deleteSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.delete(args.id);
    },
    sendSessionMessage: async (_: unknown, args: { id: string; text: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.sendMessage(args.id, args.text);
    },
    endSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.end(args.id);
    },
    interruptSession: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardSession(ctx, args.id, 'member');
      return sessionService.interrupt(args.id);
    },
    answerRequest: async (_: unknown, args: { id: string; response: Record<string, unknown> }, ctx: Ctx) => {
      await guardRequest(ctx, args.id, 'member');
      return requestService.answer(args.id, args.response ?? {});
    },
    cancelRequest: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardRequest(ctx, args.id, 'member');
      return requestService.cancel(args.id);
    },

    markNotificationRead: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      const n = await notificationService.get(args.id);
      if (n.projectId) await requireProject(ctx, n.projectId);
      else requireUser(ctx);
      return notificationService.markRead(args.id);
    },
    markAllNotificationsRead: async (_: unknown, __: unknown, ctx: Ctx) => notificationService.markAllRead(await accessibleProjectIds(ctx)),
    createTask: async (_: unknown, { input }: { input: GqlTaskInput & { projectId: string; title: string } }, ctx: Ctx) => {
      await requireProject(ctx, input.projectId, 'member');
      return taskService.create(input.projectId, { ...toTaskInput(input), title: input.title }, HUMAN);
    },
    updateTask: async (_: unknown, { id, input }: { id: string; input: GqlTaskInput }, ctx: Ctx) => {
      await guardTask(ctx, id, 'member');
      return taskService.update(id, toTaskInput(input));
    },
    deleteTask: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      return taskService.delete(args.id);
    },
    startTaskSession: async (_: unknown, args: { id: string; provider?: string | null; config?: Record<string, unknown> | null; worktreeId?: string | null; dedicatedWorktree?: boolean | null }, ctx: Ctx) => {
      await guardTask(ctx, args.id, 'member');
      return startTaskSession(args.id, args);
    },
    createTerminal: async (_: unknown, args: { projectId: string; name?: string | null; worktreeId?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return terminalService.create(args.projectId, args.name, args.worktreeId);
    },
    createWorktree: async (_: unknown, args: { projectId: string; branch: string; name?: string | null; baseRef?: string | null }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'member');
      return worktreeService.create(args.projectId, args);
    },
    deleteWorktree: async (_: unknown, args: { id: string; deleteBranch?: boolean | null }, ctx: Ctx) => {
      await guardWorktree(ctx, args.id, 'member');
      return deleteWorktreeCascade(args.id, args.deleteBranch ?? false);
    },
    // Connexions : identifiants et politique d'accès des agents, réservés aux administrateurs du projet.
    createConnection: async (_: unknown, args: { projectId: string; input: ConnectionInput }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      return connectionService.create(args.projectId, args.input);
    },
    updateConnection: async (_: unknown, args: { id: string; input: ConnectionInput }, ctx: Ctx) => {
      await guardConnection(ctx, args.id, 'admin');
      return connectionService.update(args.id, args.input);
    },
    deleteConnection: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardConnection(ctx, args.id, 'admin');
      return connectionService.delete(args.id);
    },
    testConnection: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardConnection(ctx, args.id, 'admin');
      const { connection, result } = await connectionService.test(args.id);
      return { connection, ...result };
    },
    regenerateConnectionKey: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardConnection(ctx, args.id, 'admin');
      return connectionService.regenerateKey(args.id);
    },
    forgetConnectionHostKey: async (_: unknown, args: { id: string }, ctx: Ctx) => {
      await guardConnection(ctx, args.id, 'admin');
      return connectionService.forgetHostKey(args.id);
    },
    checkGoogleAccount: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      const { account, result } = await googleAccountService.check(args.projectId);
      return { account, ...result };
    },
    disconnectGoogleAccount: async (_: unknown, args: { projectId: string }, ctx: Ctx) => {
      await requireProject(ctx, args.projectId, 'admin');
      await googleAccountService.disconnect(args.projectId);
      return projectService.get(args.projectId);
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
        return filterAsync(pubSub.subscribe('notificationCreated'), (n: Notification) => canAccessProject(ctx, n.projectId));
      },
      resolve: (payload: unknown) => payload,
    },
  },
};
