import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { projectService } from '../projects/service.js';
import type { CreateProjectInput, Project, UpdateProjectInput } from '../projects/types.js';
import { workspaceExists, workspaceGitInfo, workspacePath } from '../projects/workspace.js';
import { pubSub } from '../pubsub.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest, RequestStatus } from '../requests/types.js';
import { listProviders } from '../sessions/providers/registry.js';
import { sessionService } from '../sessions/service.js';
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

  Project: {
    workspacePath: (project: Project) => workspacePath(project),
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
    requests: (_: unknown, args: { status?: GqlRequestStatus | null; sessionId?: string | null; limit?: number | null }) =>
      requestService.list({ status: fromGqlRequestStatus(args.status), sessionId: args.sessionId ?? undefined, limit: args.limit ?? undefined }),
    request: (_: unknown, args: { id: string }) => requestService.get(args.id),
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
    answerRequest: (_: unknown, args: { id: string; response: Record<string, unknown> }) => requestService.answer(args.id, args.response ?? {}),
    cancelRequest: (_: unknown, args: { id: string }) => requestService.cancel(args.id),
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
