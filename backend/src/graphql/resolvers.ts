import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { contextService, HUMAN } from '../context/service.js';
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

  Project: {
    workspacePath: (project: Project) => workspacePath(project),
    terminals: (project: Project) => terminalService.listByProject(project.id),
    worktrees: (project: Project) => worktreeService.listByProject(project.id),
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
    settings: () => appSettings(),
    githubRepositories: (_: unknown, args: { query?: string | null }) => githubService.listRepositories(args.query),
    claudeLogin: (_: unknown, args: { id: string }) => loginService.get(args.id),
    providers: () => listProviders(),
    sessions: (_: unknown, args: { projectId?: string | null; status?: GqlStatus | null; provider?: string | null; limit?: number | null; offset?: number | null }) =>
      sessionService.list({
        projectId: args.projectId ?? undefined,
        status: fromGqlStatus(args.status),
        provider: args.provider ?? undefined,
        limit: args.limit ?? undefined,
        offset: args.offset ?? undefined,
      }),
    session: (_: unknown, args: { id: string }) => sessionService.get(args.id),
    projects: () => projectService.list(),
    project: (_: unknown, args: { id: string }) => projectService.get(args.id),
    requests: (_: unknown, args: { status?: GqlRequestStatus | null; sessionId?: string | null; limit?: number | null; newestFirst?: boolean | null }) =>
      requestService.list({
        status: fromGqlRequestStatus(args.status),
        sessionId: args.sessionId ?? undefined,
        limit: args.limit ?? undefined,
        newestFirst: args.newestFirst ?? false,
      }),
    request: (_: unknown, args: { id: string }) => requestService.get(args.id),
    terminal: (_: unknown, args: { id: string }) => terminalService.get(args.id),
    worktree: (_: unknown, args: { id: string }) => worktreeService.get(args.id),
    notifications: (_: unknown, args: { unreadOnly?: boolean | null; limit?: number | null }) => notificationService.list({ unreadOnly: args.unreadOnly ?? false, limit: args.limit ?? undefined }),
    unreadNotificationCount: () => notificationService.countUnread(),
    tasks: (_: unknown, args: { projectId?: string | null; status?: GqlTaskStatus[] | null; priority?: GqlTaskPriority | null; limit?: number | null }) =>
      taskService.list({
        projectId: args.projectId ?? undefined,
        status: fromGqlTaskStatuses(args.status) ?? ['todo', 'in_progress'],
        priority: fromGqlTaskPriority(args.priority),
        limit: args.limit ?? undefined,
      }),
    task: (_: unknown, args: { id: string }) => taskService.get(args.id),
    contextInstruction: (_: unknown, args: { id: string }) => contextService.getInstruction(args.id),
    searchContext: (_: unknown, args: { projectId: string; query: string }) => contextService.search(args.projectId, args.query),
  },

  Mutation: {
    setGithubClientId: async (_: unknown, args: { clientId?: string | null }) => {
      await githubService.setClientId(args.clientId ?? null);
      return appSettings();
    },
    setGithubPersonalToken: async (_: unknown, args: { token: string }) => {
      await githubService.setPersonalToken(args.token);
      return appSettings();
    },
    startGithubLogin: () => githubService.startLogin(),
    cancelGithubLogin: async () => {
      githubService.cancelLogin();
      return appSettings();
    },
    disconnectGithub: async () => {
      await githubService.disconnect();
      return appSettings();
    },
    updateClaudeSettings: async (_: unknown, { input }: { input: ClaudeSettingsPatch }) => {
      await settingsService.update(input);
      return appSettings();
    },
    setClaudeApiKey: async (_: unknown, args: { apiKey?: string | null }) => {
      await settingsService.setApiKey(args.apiKey ?? null);
      return appSettings();
    },
    clearClaudeOauthToken: async () => {
      await settingsService.clearOauthToken();
      return appSettings();
    },
    startClaudeLogin: (_: unknown, args: { kind?: ClaudeLoginKind | null }) => loginService.start(args.kind ?? 'oauth'),
    logoutServerClaude: async () => {
      await serverLogout();
      settingsService.invalidateVerification();
      return appSettings();
    },
    completeClaudeLogin: (_: unknown, args: { id: string; code: string }) => loginService.complete(args.id, args.code),
    cancelClaudeLogin: (_: unknown, args: { id: string }) => loginService.cancel(args.id),
    verifyClaudeAuth: async (_: unknown, args: { mode?: ClaudeAuthMode | null }) => {
      await settingsService.verify(args.mode ?? undefined);
      return appSettings();
    },
    createProject: (_: unknown, { input }: { input: CreateProjectInput }) => projectService.create(input),
    updateProject: (_: unknown, { id, input }: { id: string; input: UpdateProjectInput }) => projectService.update(id, input),
    prepareProjectWorkspace: (_: unknown, args: { id: string }) => projectService.prepareWorkspace(args.id),
    deleteProject: (_: unknown, args: { id: string }) => projectService.delete(args.id),
    createSession: (
      _: unknown,
      { input }: { input: { projectId: string; worktreeId?: string | null; name: string; provider: string; prompt?: string | null; config?: Record<string, unknown> | null; autoStart?: boolean | null } },
    ) => sessionService.create({ ...input, autoStart: input.autoStart ?? true }),
    startSession: (_: unknown, args: { id: string }) => sessionService.start(args.id),
    stopSession: (_: unknown, args: { id: string }) => sessionService.stop(args.id),
    deleteSession: (_: unknown, args: { id: string }) => sessionService.delete(args.id),
    sendSessionMessage: (_: unknown, args: { id: string; text: string }) => sessionService.sendMessage(args.id, args.text),
    endSession: (_: unknown, args: { id: string }) => sessionService.end(args.id),
    interruptSession: (_: unknown, args: { id: string }) => sessionService.interrupt(args.id),
    answerRequest: (_: unknown, args: { id: string; response: Record<string, unknown> }) => requestService.answer(args.id, args.response ?? {}),
    cancelRequest: (_: unknown, args: { id: string }) => requestService.cancel(args.id),

    markNotificationRead: (_: unknown, args: { id: string }) => notificationService.markRead(args.id),
    markAllNotificationsRead: () => notificationService.markAllRead(),
    createTask: (_: unknown, { input }: { input: GqlTaskInput & { projectId: string; title: string } }) => taskService.create(input.projectId, { ...toTaskInput(input), title: input.title }, HUMAN),
    updateTask: (_: unknown, { id, input }: { id: string; input: GqlTaskInput }) => taskService.update(id, toTaskInput(input)),
    deleteTask: (_: unknown, args: { id: string }) => taskService.delete(args.id),
    startTaskSession: (_: unknown, args: { id: string; provider?: string | null; config?: Record<string, unknown> | null; worktreeId?: string | null }) => startTaskSession(args.id, args),
    createTerminal: (_: unknown, args: { projectId: string; name?: string | null; worktreeId?: string | null }) => terminalService.create(args.projectId, args.name, args.worktreeId),
    createWorktree: (_: unknown, args: { projectId: string; branch: string; name?: string | null; baseRef?: string | null }) => worktreeService.create(args.projectId, args),
    deleteWorktree: (_: unknown, args: { id: string; deleteBranch?: boolean | null }) => worktreeService.delete(args.id, args.deleteBranch ?? false),
    closeTerminal: (_: unknown, args: { id: string }) => terminalService.close(args.id),
    deleteTerminal: (_: unknown, args: { id: string }) => terminalService.delete(args.id),
    createContextFolder: (_: unknown, args: { projectId: string; parentId?: string | null; name: string }) =>
      contextService.createFolder(args.projectId, { parentId: args.parentId ?? null, name: args.name }, HUMAN),
    renameContextFolder: (_: unknown, args: { id: string; name: string }) => contextService.renameFolder(args.id, args.name, HUMAN),
    moveContextFolder: (_: unknown, args: { id: string; parentId?: string | null }) => contextService.moveFolder(args.id, args.parentId ?? null, HUMAN),
    deleteContextFolder: (_: unknown, args: { id: string }) => contextService.deleteFolder(args.id, HUMAN),
    createContextInstruction: (
      _: unknown,
      { input }: { input: { projectId: string; folderId?: string | null; name: string; description?: string | null; content?: string | null; changeNote?: string | null } },
    ) => contextService.createInstruction(input.projectId, input, HUMAN),
    updateContextInstruction: (
      _: unknown,
      { id, input }: { id: string; input: { name?: string | null; description?: string | null; content?: string | null; folderId?: string | null; changeNote?: string | null } },
    ) => contextService.updateInstruction(id, input, HUMAN),
    deleteContextInstruction: (_: unknown, args: { id: string }) => contextService.deleteInstruction(args.id, HUMAN),
    restoreContextInstructionVersion: (_: unknown, args: { id: string; version: number }) => contextService.restoreVersion(args.id, args.version, HUMAN),
  },

  Subscription: {
    sessionEvents: {
      subscribe: (_: unknown, args: { sessionId: string }) => pubSub.subscribe('sessionEvent', args.sessionId),
      resolve: (payload: unknown) => payload,
    },
    sessionUpdated: {
      subscribe: () => pubSub.subscribe('sessionUpdated'),
      resolve: (payload: unknown) => payload,
    },
    requestCreated: {
      subscribe: () => pubSub.subscribe('requestCreated'),
      resolve: (payload: unknown) => payload,
    },
    requestUpdated: {
      subscribe: () => pubSub.subscribe('requestUpdated'),
      resolve: (payload: unknown) => payload,
    },
    notificationCreated: {
      subscribe: () => pubSub.subscribe('notificationCreated'),
      resolve: (payload: unknown) => payload,
    },
  },
};
