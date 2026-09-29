import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { contextService, HUMAN } from '../context/service.js';
import type { ContextChange, ContextInstruction, ContextInstructionVersion } from '../context/types.js';
import { projectService } from '../projects/service.js';
import type { CreateProjectInput, Project, UpdateProjectInput } from '../projects/types.js';
import { workspaceExists, workspaceGitInfo, workspacePath } from '../projects/workspace.js';
import { pubSub } from '../pubsub.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest, RequestStatus } from '../requests/types.js';
import { listProviders } from '../sessions/providers/registry.js';
import { sessionService } from '../sessions/service.js';
import { terminalService } from '../terminals/service.js';
import type { TerminalRecord } from '../terminals/types.js';
import type { Session, SessionStatus } from '../sessions/types.js';

type GqlStatus = Uppercase<SessionStatus>;
type GqlRequestStatus = Uppercase<RequestStatus>;
const fromGqlRequestStatus = (s?: GqlRequestStatus | null): RequestStatus | undefined =>
  s ? (s.toLowerCase() as RequestStatus) : undefined;

const toGqlStatus = (s: SessionStatus): GqlStatus => s.toUpperCase() as GqlStatus;
const fromGqlStatus = (s?: GqlStatus | null): SessionStatus | undefined =>
  s ? (s.toLowerCase() as SessionStatus) : undefined;

export const resolvers = {
  JSON: JSONResolver,
  DateTime: DateTimeResolver,

  ContextInstruction: {
    versions: (instruction: ContextInstruction) => contextService.versions(instruction.id),
  },
  ContextInstructionVersion: {
    authorSession: (v: ContextInstructionVersion) => (v.authorSessionId ? sessionService.get(v.authorSessionId) : null),
  },
  ContextChange: {
    authorSession: (c: ContextChange) => (c.authorSessionId ? sessionService.get(c.authorSessionId) : null),
  },

  Terminal: {
    status: (t: TerminalRecord) => t.status.toUpperCase(),
    project: (t: TerminalRecord) => projectService.get(t.projectId),
  },

  Project: {
    workspacePath: (project: Project) => workspacePath(project),
    terminals: (project: Project) => terminalService.listByProject(project.id),
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
    status: (session: Session) => toGqlStatus(session.status),
    activity: (session: Session) => (session.activity ? session.activity.toUpperCase() : null),
    requests: (session: Session, args: { status?: GqlRequestStatus | null }) =>
      requestService.list({ sessionId: session.id, status: fromGqlRequestStatus(args.status) }),
    pendingRequestCount: (session: Session) => requestService.countPending(session.id),
    events: (session: Session, args: { after?: string | null; limit?: number | null }) =>
      sessionService.events(session.id, { after: args.after ?? undefined, limit: args.limit ?? undefined }),
  },

  Query: {
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
    contextInstruction: (_: unknown, args: { id: string }) => contextService.getInstruction(args.id),
    searchContext: (_: unknown, args: { projectId: string; query: string }) => contextService.search(args.projectId, args.query),
  },

  Mutation: {
    createProject: (_: unknown, { input }: { input: CreateProjectInput }) => projectService.create(input),
    updateProject: (_: unknown, { id, input }: { id: string; input: UpdateProjectInput }) => projectService.update(id, input),
    prepareProjectWorkspace: (_: unknown, args: { id: string }) => projectService.prepareWorkspace(args.id),
    deleteProject: (_: unknown, args: { id: string }) => projectService.delete(args.id),
    createSession: (
      _: unknown,
      { input }: { input: { projectId: string; name: string; provider: string; prompt?: string | null; config?: Record<string, unknown> | null; autoStart?: boolean | null } },
    ) => sessionService.create({ ...input, autoStart: input.autoStart ?? true }),
    startSession: (_: unknown, args: { id: string }) => sessionService.start(args.id),
    stopSession: (_: unknown, args: { id: string }) => sessionService.stop(args.id),
    deleteSession: (_: unknown, args: { id: string }) => sessionService.delete(args.id),
    sendSessionMessage: (_: unknown, args: { id: string; text: string }) => sessionService.sendMessage(args.id, args.text),
    endSession: (_: unknown, args: { id: string }) => sessionService.end(args.id),
    interruptSession: (_: unknown, args: { id: string }) => sessionService.interrupt(args.id),
    answerRequest: (_: unknown, args: { id: string; response: Record<string, unknown> }) => requestService.answer(args.id, args.response ?? {}),
    cancelRequest: (_: unknown, args: { id: string }) => requestService.cancel(args.id),

    createTerminal: (_: unknown, args: { projectId: string; name?: string | null }) => terminalService.create(args.projectId, args.name),
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
  },
};
