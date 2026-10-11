import { gql } from '@apollo/client';
import type { AttachmentRef } from '../lib/attachments';
import type { ClaudeRateLimits } from './settings';

export type SessionStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED' | 'INTERRUPTED';
export type RequestStatus = 'PENDING' | 'ANSWERED' | 'CANCELLED' | 'EXPIRED';
export type SessionActivity = 'BUSY' | 'IDLE';

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  description?: string | null;
  options?: { value: string; label: string; description?: string | null }[] | null;
  defaultValue?: string | null;
  advanced?: boolean | null;
}

/** Planification d'une session : l'instruction est envoyée à chaque échéance de l'expression cron. */
/** Nettoyage automatique de l'historique d'une session. */
export interface SessionCleanup {
  retentionDays: number | null;
  contextAction: 'compact' | 'reset' | null;
  contextMaxTokens: number | null;
}

export interface SessionSchedule {
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  endAfterRun: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  updatedAt: string;
}

export interface Provider {
  type: string;
  label: string;
  description: string;
  interactive: boolean;
  configFields: ConfigField[];
}

export type ProjectRole = 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface PermissionRule {
  id: string;
  projectId: string;
  toolName: string;
  ruleContent: string | null;
  rule: string;
  createdBySession: { id: string; name: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  usageTrackedSince: string;
}

export interface ProjectMember {
  user: Pick<User, 'id' | 'email' | 'name' | 'avatarUrl'>;
  role: ProjectRole;
  invitedBy: Pick<User, 'id' | 'name'> | null;
  pending: boolean;
  createdAt: string;
}

export interface RunnerStatus {
  kind: string;
  ready: boolean;
  state: string;
  containerName: string | null;
  image: string | null;
  memory: string | null;
  cpus: string | null;
  startedAt: string | null;
  error: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  gitUrl: string | null;
  gitBranch: string | null;
  runnerConfig: { image?: string; memory?: string; cpus?: string; browser?: boolean; maxSessions?: number };
  /** Mode d'autorisation des nouvelles sessions : default, acceptEdits, bypassPermissions ou plan. */
  defaultPermissionMode: string;
  /** Éléments du coffre soumis à approbation (requête PROJECT seulement). */
  approvalConnections?: string[];
  /** Faux quand le projet est atteint en tant que super administrateur sans en être membre. */
  isMember: boolean;
  runnerStatus: RunnerStatus;
  workspacePath: string;
  workspaceExists: boolean;
  git: { branch: string; commit: string } | null;
  myRole: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  name: string;
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  prompt: string | null;
  promptAttachments: AttachmentRef[];
  config: Record<string, unknown>;
  externalId: string | null;
  exitCode: number | null;
  error: string | null;
  costUsd: number;
  cleanup: SessionCleanup;
  /** Taille du contexte de l'agent au dernier tour (tokens), null si inconnue. */
  contextTokens: number | null;
  pendingRequestCount: number;
  /** Navigateur headless ouvert et utilisé par l'agent : vue en direct disponible. */
  browserActive: boolean;
  /** Mise en file d'attente (statut QUEUED), et rang dans la file (1 : la prochaine). */
  queuedAt: string | null;
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  project: Pick<Project, 'id' | 'name' | 'slug' | 'workspacePath' | 'approvalConnections'>;
  worktree: Pick<Worktree, 'id' | 'name' | 'branch' | 'label' | 'path'> | null;
  /** Session d'agent qui a lancé celle-ci (outil MCP sessions.create), null pour une session lancée par un humain. */
  parentSession: { id: string; name: string } | null;
  /** Sessions lancées par l'agent de cette session (requête Session seulement). */
  childSessions?: ChildSession[];
  /** Agent (configuration) et exécution qui ont ouvert la session ; null pour une session lancée à la main. */
  agent: { id: string; name: string } | null;
  agentRun: { id: string } | null;
  workflowRun: { id: string; workflow: { id: string; name: string } } | null;
  /** Utilisateur qui a lancé la session (null : session d'avant cette version). */
  owner: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'> | null;
  /** Archivée : consultable en lecture seule, relançable. */
  archivedAt: string | null;
  /** Tâche dont la session est en charge. */
  task: { id: string; title: string; status: TaskStatus } | null;
  /** Planification (null si la session n'est pas planifiée). */
  schedule: SessionSchedule | null;
}

/** Session lancée par l'agent d'une autre session, telle que la page de la session parente la liste. */
export interface ChildSession {
  id: string;
  name: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  pendingRequestCount: number;
  archivedAt: string | null;
}

export interface ContextFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  slug: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextInstructionVersion {
  id: string;
  version: number;
  name: string;
  description: string;
  content: string;
  changeNote: string | null;
  authorType: 'human' | 'agent';
  authorSession: { id: string; name: string } | null;
  createdAt: string;
}

export interface ContextInstruction {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  slug: string;
  path: string;
  description: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  versions?: ContextInstructionVersion[];
}

export interface ContextChange {
  id: string;
  kind: string;
  path: string;
  details: Record<string, unknown>;
  authorType: 'human' | 'agent';
  authorSession: { id: string; name: string } | null;
  createdAt: string;
}

export type TerminalStatus = 'RUNNING' | 'CLOSED';

export interface Terminal {
  id: string;
  name: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
  closedAt: string | null;
  project: { id: string; name: string; workspacePath: string };
  worktree: { id: string; name: string; branch: string; label: string; path: string } | null;
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface TaskField {
  key: string;
  value: string;
}

export interface TaskPerson {
  name: string | null;
  email: string | null;
}

export interface TaskComment {
  id: string;
  authorType: 'human' | 'agent';
  authorName: string;
  author: { id: string; name: string } | null;
  authorSession: { id: string; name: string } | null;
  body: string;
  editable: boolean;
  deletable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  createdByType: 'human' | 'agent';
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  customFields: TaskField[];
  assignee: TaskPerson | null;
  reporter: TaskPerson | null;
  commentCount: number;
  branch: string | null;
  project: { id: string; name: string };
  session: { id: string; name: string; status: SessionStatus; activity: SessionActivity | null; worktree: { id: string; branch: string; label: string } | null } | null;
  createdBySession: { id: string; name: string } | null;
  /** Présent seulement dans la query TASKS. */
  pullRequest?: PullRequestSummary | null;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  project: { id: string; name: string } | null;
}

export interface SearchHit {
  kind: 'PROJECT' | 'WORKTREE' | 'SESSION' | 'TERMINAL' | 'TASK' | 'VAULT_ITEM';
  id: string;
  title: string;
  detail: string | null;
  projectId: string | null;
  projectName: string | null;
  outsideProjects: boolean;
  worktreeBranch: string | null;
  status: string | null;
  activity: string | null;
  updatedAt: string;
}

export interface Worktree {
  id: string;
  name: string;
  branch: string;
  /** Libellé affiché : le libellé choisi, sinon la branche. */
  label: string;
  customLabel: string | null;
  path: string;
  exists: boolean;
  git: { branch: string; commit: string } | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}
export interface GitFileChange {
  path: string;
  origPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}
export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  changes: GitFileChange[];
  headCommit: GitCommit | null;
}
export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  commit: GitCommit | null;
}
export interface GitDiff {
  path: string;
  staged: boolean;
  text: string;
  binary: boolean;
  truncated: boolean;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface HumanRequest {
  id: string;
  type: string;
  status: RequestStatus;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  createdAt: string;
  answeredAt: string | null;
  session: { id: string; name: string; project: { id: string; name: string } };
}

export const PROJECT_FIELDS = gql`
  fragment ProjectFields on Project {
    id
    name
    slug
    description
    systemPrompt
    gitUrl
    gitBranch
    runnerConfig
    defaultPermissionMode
    runnerStatus {
      kind
      ready
      state
      containerName
      image
      memory
      cpus
      startedAt
      error
    }
    workspacePath
    workspaceExists
    git {
      branch
      commit
    }
    myRole
    isMember
    createdAt
    updatedAt
  }
`;

export const USER_FIELDS = gql`
  fragment UserFields on User {
    id
    email
    name
    avatarUrl
    isAdmin
    isSuperAdmin
    createdAt
    lastLoginAt
  }
`;

export const ME = gql`
  ${USER_FIELDS}
  query Me {
    me {
      ...UserFields
    }
  }
`;

export const PROJECT_MEMBERS = gql`
  query ProjectMembers($id: ID!) {
    project(id: $id) {
      id
      myRole
      members {
        role
        pending
        createdAt
        user {
          id
          email
          name
          avatarUrl
        }
        invitedBy {
          id
          name
        }
      }
    }
  }
`;

export const INVITE_PROJECT_MEMBER = gql`
  mutation InviteProjectMember($projectId: ID!, $email: String!, $role: ProjectRole) {
    inviteProjectMember(projectId: $projectId, email: $email, role: $role) {
      role
      user {
        id
        email
      }
    }
  }
`;

export const UPDATE_PROJECT_MEMBER_ROLE = gql`
  mutation UpdateProjectMemberRole($projectId: ID!, $userId: ID!, $role: ProjectRole!) {
    updateProjectMemberRole(projectId: $projectId, userId: $userId, role: $role) {
      role
      user {
        id
      }
    }
  }
`;

export const REMOVE_PROJECT_MEMBER = gql`
  mutation RemoveProjectMember($projectId: ID!, $userId: ID!) {
    removeProjectMember(projectId: $projectId, userId: $userId)
  }
`;

export const SESSION_FIELDS = gql`
  fragment SessionFields on Session {
    id
    name
    provider
    status
    activity
    prompt
    promptAttachments {
      id
      name
      mediaType
      size
    }
    config
    externalId
    exitCode
    error
    costUsd
    cleanup {
      retentionDays
      contextAction
      contextMaxTokens
    }
    contextTokens
    pendingRequestCount
    queuedAt
    queuePosition
    createdAt
    updatedAt
    startedAt
    endedAt
    project {
      id
      name
      slug
      workspacePath
    }
    worktree {
      id
      name
      branch
      label
      path
    }
    parentSession {
      id
      name
    }
    agent {
      id
      name
    }
    agentRun {
      id
    }
    workflowRun {
      id
      workflow {
        id
        name
      }
    }
    owner {
      id
      name
      email
      avatarUrl
    }
    archivedAt
    task {
      id
      title
      status
    }
    schedule {
      cron
      timezone
      prompt
      enabled
      endAfterRun
      nextRunAt
      lastRunAt
      lastResult
      updatedAt
    }
  }
`;

export const REQUEST_FIELDS = gql`
  fragment RequestFields on Request {
    id
    type
    status
    title
    message
    payload
    response
    createdAt
    answeredAt
    session {
      id
      name
      project {
        id
        name
      }
    }
  }
`;

export const PROVIDERS = gql`
  query Providers {
    providers {
      type
      label
      description
      interactive
      configFields {
        key
        label
        type
        required
        description
        options {
          value
          label
          description
        }
        defaultValue
        advanced
      }
    }
  }
`;

export const PROJECTS = gql`
  ${PROJECT_FIELDS}
  query Projects($all: Boolean) {
    projects(all: $all) {
      ...ProjectFields
    }
  }
`;

export const PROJECT = gql`
  ${PROJECT_FIELDS}
  ${SESSION_FIELDS}
  query Project($id: ID!) {
    project(id: $id) {
      ...ProjectFields
      approvalConnections
      sessions {
        ...SessionFields
      }
    }
  }
`;

export const CREATE_PROJECT = gql`
  ${PROJECT_FIELDS}
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      ...ProjectFields
    }
  }
`;

export const UPDATE_PROJECT = gql`
  ${PROJECT_FIELDS}
  mutation UpdateProject($id: ID!, $input: UpdateProjectInput!) {
    updateProject(id: $id, input: $input) {
      ...ProjectFields
    }
  }
`;

export const PREPARE_PROJECT_WORKSPACE = gql`
  ${PROJECT_FIELDS}
  mutation PrepareProjectWorkspace($id: ID!) {
    prepareProjectWorkspace(id: $id) {
      ...ProjectFields
    }
  }
`;

export const START_PROJECT_RUNNER = gql`
  ${PROJECT_FIELDS}
  mutation StartProjectRunner($id: ID!) {
    startProjectRunner(id: $id) {
      ...ProjectFields
    }
  }
`;

export const STOP_PROJECT_RUNNER = gql`
  ${PROJECT_FIELDS}
  mutation StopProjectRunner($id: ID!) {
    stopProjectRunner(id: $id) {
      ...ProjectFields
    }
  }
`;

export const RESET_PROJECT_RUNNER = gql`
  ${PROJECT_FIELDS}
  mutation ResetProjectRunner($id: ID!) {
    resetProjectRunner(id: $id) {
      ...ProjectFields
    }
  }
`;

export const DELETE_PROJECT = gql`
  mutation DeleteProject($id: ID!) {
    deleteProject(id: $id)
  }
`;

export const SESSIONS = gql`
  ${SESSION_FIELDS}
  query Sessions($projectId: ID, $status: SessionStatus, $provider: String, $ownerId: ID, $limit: Int) {
    sessions(projectId: $projectId, status: $status, provider: $provider, ownerId: $ownerId, limit: $limit) {
      ...SessionFields
    }
  }
`;

export const SESSION = gql`
  ${SESSION_FIELDS}
  ${REQUEST_FIELDS}
  query Session($id: ID!) {
    session(id: $id) {
      ...SessionFields
      project {
        id
        approvalConnections
      }
      requests(status: PENDING) {
        ...RequestFields
      }
      childSessions {
        id
        name
        status
        activity
        pendingRequestCount
        archivedAt
      }
    }
  }
`;

/** Une page d'événements d'une session, dans l'ordre, après l'événement `after` (voir useSessionEvents). */
export const SESSION_EVENTS = gql`
  query SessionEvents($id: ID!, $after: ID, $limit: Int) {
    session(id: $id) {
      id
      events(after: $after, limit: $limit) {
        id
        sessionId
        type
        payload
        createdAt
      }
    }
  }
`;

export const CREATE_SESSION = gql`
  ${SESSION_FIELDS}
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      ...SessionFields
    }
  }
`;

export const START_SESSION = gql`
  ${SESSION_FIELDS}
  mutation StartSession($id: ID!) {
    startSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const STOP_SESSION = gql`
  ${SESSION_FIELDS}
  mutation StopSession($id: ID!) {
    stopSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const SEND_SESSION_MESSAGE = gql`
  ${SESSION_FIELDS}
  mutation SendSessionMessage($id: ID!, $text: String!, $attachments: [AttachmentInput!]) {
    sendSessionMessage(id: $id, text: $text, attachments: $attachments) {
      ...SessionFields
    }
  }
`;

export const END_SESSION = gql`
  ${SESSION_FIELDS}
  mutation EndSession($id: ID!) {
    endSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const RESUME_SESSION = gql`
  ${SESSION_FIELDS}
  mutation ResumeSession($id: ID!) {
    resumeSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const INTERRUPT_SESSION = gql`
  ${SESSION_FIELDS}
  mutation InterruptSession($id: ID!) {
    interruptSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const UPDATE_SESSION_CONFIG = gql`
  ${SESSION_FIELDS}
  mutation UpdateSessionConfig($id: ID!, $config: JSON!) {
    updateSessionConfig(id: $id, config: $config) {
      ...SessionFields
    }
  }
`;

export const DELETE_SESSION = gql`
  mutation DeleteSession($id: ID!) {
    deleteSession(id: $id)
  }
`;

export const SET_SESSION_SCHEDULE = gql`
  ${SESSION_FIELDS}
  mutation SetSessionSchedule($id: ID!, $input: SessionScheduleInput!) {
    setSessionSchedule(id: $id, input: $input) {
      ...SessionFields
    }
  }
`;

export const CLEAR_SESSION_SCHEDULE = gql`
  ${SESSION_FIELDS}
  mutation ClearSessionSchedule($id: ID!) {
    clearSessionSchedule(id: $id) {
      ...SessionFields
    }
  }
`;

export const RUN_SESSION_SCHEDULE_NOW = gql`
  ${SESSION_FIELDS}
  mutation RunSessionScheduleNow($id: ID!) {
    runSessionScheduleNow(id: $id) {
      ...SessionFields
    }
  }
`;

export const UPDATE_SESSION = gql`
  ${SESSION_FIELDS}
  mutation UpdateSession($id: ID!, $input: UpdateSessionInput!) {
    updateSession(id: $id, input: $input) {
      ...SessionFields
    }
  }
`;

export const APPLY_SESSION_CLEANUP = gql`
  ${SESSION_FIELDS}
  mutation ApplySessionCleanup($id: ID!) {
    applySessionCleanup(id: $id) {
      ...SessionFields
    }
  }
`;

export const SCHEDULE_NEXT_RUNS = gql`
  query ScheduleNextRuns($cron: String!, $timezone: String, $count: Int) {
    scheduleNextRuns(cron: $cron, timezone: $timezone, count: $count)
  }
`;

export const REQUESTS = gql`
  ${REQUEST_FIELDS}
  query Requests($status: RequestStatus, $sessionId: ID, $limit: Int, $newestFirst: Boolean) {
    requests(status: $status, sessionId: $sessionId, limit: $limit, newestFirst: $newestFirst) {
      ...RequestFields
    }
  }
`;

export const ANSWER_REQUEST = gql`
  ${REQUEST_FIELDS}
  mutation AnswerRequest($id: ID!, $response: JSON!) {
    answerRequest(id: $id, response: $response) {
      ...RequestFields
    }
  }
`;

export const CANCEL_REQUEST = gql`
  ${REQUEST_FIELDS}
  mutation CancelRequest($id: ID!) {
    cancelRequest(id: $id) {
      ...RequestFields
    }
  }
`;

export const CONTEXT_INSTRUCTION_FIELDS = gql`
  fragment ContextInstructionFields on ContextInstruction {
    id
    projectId
    folderId
    name
    slug
    path
    description
    content
    version
    createdAt
    updatedAt
  }
`;

export const PROJECT_CONTEXT = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  query ProjectContext($id: ID!) {
    project(id: $id) {
      id
      name
      contextFolders {
        id
        projectId
        parentId
        name
        slug
        path
        createdAt
        updatedAt
      }
      contextInstructions {
        ...ContextInstructionFields
      }
      contextChanges(limit: 100) {
        id
        kind
        path
        details
        authorType
        authorSession {
          id
          name
        }
        createdAt
      }
    }
  }
`;

export const CONTEXT_INSTRUCTION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  query ContextInstruction($id: ID!) {
    contextInstruction(id: $id) {
      ...ContextInstructionFields
      versions {
        id
        version
        name
        description
        content
        changeNote
        authorType
        authorSession {
          id
          name
        }
        createdAt
      }
    }
  }
`;

export const CREATE_CONTEXT_FOLDER = gql`
  mutation CreateContextFolder($projectId: ID!, $parentId: ID, $name: String!) {
    createContextFolder(projectId: $projectId, parentId: $parentId, name: $name) {
      id
      path
    }
  }
`;

export const RENAME_CONTEXT_FOLDER = gql`
  mutation RenameContextFolder($id: ID!, $name: String!) {
    renameContextFolder(id: $id, name: $name) {
      id
      path
    }
  }
`;

export const DELETE_CONTEXT_FOLDER = gql`
  mutation DeleteContextFolder($id: ID!) {
    deleteContextFolder(id: $id)
  }
`;

export const CREATE_CONTEXT_INSTRUCTION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  mutation CreateContextInstruction($input: CreateContextInstructionInput!) {
    createContextInstruction(input: $input) {
      ...ContextInstructionFields
    }
  }
`;

export const UPDATE_CONTEXT_INSTRUCTION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  mutation UpdateContextInstruction($id: ID!, $input: UpdateContextInstructionInput!) {
    updateContextInstruction(id: $id, input: $input) {
      ...ContextInstructionFields
    }
  }
`;

export const DELETE_CONTEXT_INSTRUCTION = gql`
  mutation DeleteContextInstruction($id: ID!) {
    deleteContextInstruction(id: $id)
  }
`;

export const RESTORE_CONTEXT_INSTRUCTION_VERSION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  mutation RestoreContextInstructionVersion($id: ID!, $version: Int!) {
    restoreContextInstructionVersion(id: $id, version: $version) {
      ...ContextInstructionFields
    }
  }
`;

/** Explorateur de la sidebar : projets, dossiers de travail (checkout principal et worktrees) et leur contenu. */
export const SIDEBAR = gql`
  query Sidebar($open: OpenItemsInput) {
    projects: sidebarProjects(open: $open) {
      id
      name
      slug
      gitUrl
      gitBranch
      isMember
      myRole
      sessions(limit: 50) {
        ...SidebarSession
        worktree {
          id
        }
      }
      terminals {
        id
        name
        status
        worktree {
          id
        }
      }
      worktrees {
        id
        name
        branch
        label
        customLabel
        exists
        task {
          id
          title
          status
        }
        sessions {
          ...SidebarSession
        }
        terminals {
          id
          name
          status
        }
      }
    }
  }
  fragment SidebarSession on Session {
    id
    name
    status
    activity
    pendingRequestCount
    browserActive
    owner {
      id
      name
      avatarUrl
    }
    parentSession {
      id
    }
  }
`;

/** Pull requests des worktrees (requête lente : GitHub), interrogée moins souvent que la sidebar. */
export const SIDEBAR_WORKTREE_PULL_REQUESTS = gql`
  query SidebarWorktreePullRequests($open: OpenItemsInput) {
    projects: sidebarProjects(open: $open) {
      id
      worktrees {
        id
        pullRequest {
          number
          url
          state
          isDraft
        }
      }
    }
  }
`;

/** En-tête de la vue en direct du navigateur d'une session. */
export const SESSION_BROWSER = gql`
  query SessionBrowser($id: ID!) {
    session(id: $id) {
      id
      name
      status
      browserActive
      project {
        id
        name
      }
    }
  }
`;

export const PROJECT_WORKTREES = gql`
  query ProjectWorktrees($id: ID!) {
    project(id: $id) {
      id
      gitUrl
      defaultPermissionMode
      approvalConnections
      git {
        branch
        commit
      }
      worktrees {
        id
        name
        branch
        label
        customLabel
        path
        exists
        archivedAt
        git {
          branch
          commit
        }
        createdAt
      }
    }
  }
`;

export const CREATE_WORKTREE = gql`
  mutation CreateWorktree($projectId: ID!, $branch: String!, $name: String, $baseRef: String, $label: String) {
    createWorktree(projectId: $projectId, branch: $branch, name: $name, baseRef: $baseRef, label: $label) {
      id
      name
      branch
      label
    }
  }
`;

export const RENAME_WORKTREE = gql`
  mutation RenameWorktree($id: ID!, $label: String, $name: String) {
    renameWorktree(id: $id, label: $label, name: $name) {
      id
      name
      branch
      label
      customLabel
    }
  }
`;

export const ARCHIVE_WORKTREE = gql`
  mutation ArchiveWorktree($id: ID!) {
    archiveWorktree(id: $id) {
      id
      archivedAt
    }
  }
`;

export const RESTORE_WORKTREE = gql`
  mutation RestoreWorktree($id: ID!) {
    restoreWorktree(id: $id) {
      id
      archivedAt
    }
  }
`;

export const DELETE_WORKTREE = gql`
  mutation DeleteWorktree($id: ID!, $deleteBranch: Boolean) {
    deleteWorktree(id: $id, deleteBranch: $deleteBranch)
  }
`;

/** Ce qui reste dans un worktree (sessions, terminaux) : sert à proposer sa suppression quand on en retire le dernier élément. */
export const WORKTREE_CONTENTS = gql`
  query WorktreeContents($id: ID!) {
    worktree(id: $id) {
      id
      branch
      label
      sessions {
        id
      }
      terminals {
        id
      }
    }
  }
`;

export const TERMINAL = gql`
  query Terminal($id: ID!) {
    terminal(id: $id) {
      id
      name
      status
      exitCode
      createdAt
      closedAt
      project {
        id
        name
        workspacePath
      }
      worktree {
        id
        name
        branch
        label
        path
      }
    }
  }
`;

export const CREATE_TERMINAL = gql`
  mutation CreateTerminal($projectId: ID!, $name: String, $worktreeId: ID) {
    createTerminal(projectId: $projectId, name: $name, worktreeId: $worktreeId) {
      id
      name
      status
    }
  }
`;

export const CLOSE_TERMINAL = gql`
  mutation CloseTerminal($id: ID!) {
    closeTerminal(id: $id) {
      id
      status
      exitCode
    }
  }
`;

export const DELETE_TERMINAL = gql`
  mutation DeleteTerminal($id: ID!) {
    deleteTerminal(id: $id)
  }
`;

export const TASK_FIELDS = gql`
  fragment TaskFields on Task {
    id
    title
    description
    status
    priority
    dueDate
    createdByType
    createdAt
    updatedAt
    completedAt
    customFields {
      key
      value
    }
    assignee {
      name
      email
    }
    reporter {
      name
      email
    }
    commentCount
    branch
    project {
      id
      name
    }
    session {
      id
      name
      status
      activity
      worktree {
        id
        branch
        label
      }
    }
    createdBySession {
      id
      name
    }
  }
`;

export const TASKS = gql`
  ${TASK_FIELDS}
  query Tasks($projectId: ID, $status: [TaskStatus!], $priority: TaskPriority, $assignee: String, $reporter: String, $mine: Boolean) {
    tasks(projectId: $projectId, status: $status, priority: $priority, assignee: $assignee, reporter: $reporter, mine: $mine) {
      ...TaskFields
      pullRequest {
        number
        title
        url
        state
        isDraft
        mergeable
        reviewDecision
        checksState
        headRefName
        baseRefName
      }
    }
  }
`;

export const CREATE_TASK = gql`
  ${TASK_FIELDS}
  mutation CreateTask($input: CreateTaskInput!) {
    createTask(input: $input) {
      ...TaskFields
    }
  }
`;

export const UPDATE_TASK = gql`
  ${TASK_FIELDS}
  mutation UpdateTask($id: ID!, $input: UpdateTaskInput!) {
    updateTask(id: $id, input: $input) {
      ...TaskFields
    }
  }
`;

export const DELETE_TASK = gql`
  mutation DeleteTask($id: ID!) {
    deleteTask(id: $id)
  }
`;

export const START_TASK_SESSION = gql`
  mutation StartTaskSession($id: ID!, $worktreeId: ID, $dedicatedWorktree: Boolean, $provider: String, $config: JSON, $prompt: String) {
    startTaskSession(id: $id, worktreeId: $worktreeId, dedicatedWorktree: $dedicatedWorktree, provider: $provider, config: $config, prompt: $prompt) {
      id
    }
  }
`;

/** Où une tâche peut être confiée : projets reliés à git et leurs worktrees existants. */
export const TASK_LAUNCH_TARGETS = gql`
  query TaskLaunchTargets {
    projects {
      id
      gitUrl
      defaultPermissionMode
      approvalConnections
      worktrees {
        id
        branch
        label
        exists
      }
    }
  }
`;

export const NOTIFICATIONS = gql`
  query Notifications($limit: Int) {
    notifications(limit: $limit) {
      id
      type
      title
      message
      link
      readAt
      createdAt
      project {
        id
        name
      }
    }
    unreadNotificationCount
  }
`;

export const MARK_NOTIFICATION_READ = gql`
  mutation MarkNotificationRead($id: ID!) {
    markNotificationRead(id: $id) {
      id
      readAt
    }
  }
`;

export const MARK_ALL_NOTIFICATIONS_READ = gql`
  mutation MarkAllNotificationsRead {
    markAllNotificationsRead
  }
`;

// ---- Paramètres (voir settings.ts, ré-exporté ici pour les importeurs existants) -------------
export * from './settings';

// ---- Explorateur de fichiers ---------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
  size: number | null;
  modifiedAt: string | null;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  binary: boolean;
  content: string | null;
}

export const WORKTREE = gql`
  query Worktree($id: ID!) {
    worktree(id: $id) {
      id
      name
      branch
      label
      path
      exists
      archivedAt
      project {
        id
        name
        slug
      }
    }
  }
`;

const FILE_ENTRY_FIELDS = gql`
  fragment FileEntryFields on FileEntry {
    name
    path
    kind
    size
    modifiedAt
  }
`;

const FILE_CONTENT_FIELDS = gql`
  fragment FileContentFields on FileContent {
    path
    name
    size
    modifiedAt
    binary
    content
  }
`;

export const WORKSPACE_ENTRIES = gql`
  ${FILE_ENTRY_FIELDS}
  query WorkspaceEntries($projectId: ID!, $worktreeId: ID, $path: String) {
    workspaceEntries(projectId: $projectId, worktreeId: $worktreeId, path: $path) {
      ...FileEntryFields
    }
  }
`;

export const WORKSPACE_FILE = gql`
  ${FILE_CONTENT_FIELDS}
  query WorkspaceFile($projectId: ID!, $worktreeId: ID, $path: String!) {
    workspaceFile(projectId: $projectId, worktreeId: $worktreeId, path: $path) {
      ...FileContentFields
    }
  }
`;

export const WRITE_WORKSPACE_FILE = gql`
  ${FILE_CONTENT_FIELDS}
  mutation WriteWorkspaceFile($projectId: ID!, $worktreeId: ID, $path: String!, $content: String!, $expectedModifiedAt: DateTime) {
    writeWorkspaceFile(projectId: $projectId, worktreeId: $worktreeId, path: $path, content: $content, expectedModifiedAt: $expectedModifiedAt) {
      ...FileContentFields
    }
  }
`;

export const CREATE_WORKSPACE_ENTRY = gql`
  ${FILE_ENTRY_FIELDS}
  mutation CreateWorkspaceEntry($projectId: ID!, $worktreeId: ID, $path: String!, $kind: FileEntryKind!) {
    createWorkspaceEntry(projectId: $projectId, worktreeId: $worktreeId, path: $path, kind: $kind) {
      ...FileEntryFields
    }
  }
`;

export const RENAME_WORKSPACE_ENTRY = gql`
  ${FILE_ENTRY_FIELDS}
  mutation RenameWorkspaceEntry($projectId: ID!, $worktreeId: ID, $path: String!, $newPath: String!) {
    renameWorkspaceEntry(projectId: $projectId, worktreeId: $worktreeId, path: $path, newPath: $newPath) {
      ...FileEntryFields
    }
  }
`;

export const DELETE_WORKSPACE_ENTRY = gql`
  mutation DeleteWorkspaceEntry($projectId: ID!, $worktreeId: ID, $path: String!) {
    deleteWorkspaceEntry(projectId: $projectId, worktreeId: $worktreeId, path: $path)
  }
`;

export const GIT_STATUS_FIELDS = gql`
  fragment GitStatusFields on GitStatus {
    branch
    upstream
    ahead
    behind
    detached
    changes {
      path
      origPath
      indexStatus
      worktreeStatus
      staged
      unstaged
      untracked
      conflicted
    }
    headCommit {
      hash
      shortHash
      subject
      author
      date
    }
  }
`;

export const GIT_STATUS = gql`
  ${GIT_STATUS_FIELDS}
  query GitStatus($projectId: ID!, $worktreeId: ID) {
    gitStatus(projectId: $projectId, worktreeId: $worktreeId) {
      ...GitStatusFields
    }
  }
`;

export const GIT_DIFF = gql`
  query GitDiff($projectId: ID!, $worktreeId: ID, $path: String!, $staged: Boolean) {
    gitDiff(projectId: $projectId, worktreeId: $worktreeId, path: $path, staged: $staged) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export const GIT_COMMIT_DIFF = gql`
  query GitCommitDiff($projectId: ID!, $worktreeId: ID, $hash: String!) {
    gitCommitDiff(projectId: $projectId, worktreeId: $worktreeId, hash: $hash) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export const GIT_BRANCHES = gql`
  query GitBranches($projectId: ID!, $worktreeId: ID) {
    gitBranches(projectId: $projectId, worktreeId: $worktreeId) {
      name
      current
      remote
      upstream
      commit {
        hash
        shortHash
        subject
        author
        date
      }
    }
  }
`;

export const GIT_LOG = gql`
  query GitLog($projectId: ID!, $worktreeId: ID, $limit: Int) {
    gitLog(projectId: $projectId, worktreeId: $worktreeId, limit: $limit) {
      hash
      shortHash
      subject
      author
      date
    }
  }
`;

const gitMutation = (name: string, args: string, call: string) => gql`
  ${GIT_STATUS_FIELDS}
  mutation ${name}($projectId: ID!, $worktreeId: ID${args}) {
    ${call} {
      ...GitStatusFields
    }
  }
`;
export const GIT_STAGE = gitMutation('GitStage', ', $paths: [String!]!', 'gitStage(projectId: $projectId, worktreeId: $worktreeId, paths: $paths)');
export const GIT_UNSTAGE = gitMutation('GitUnstage', ', $paths: [String!]!', 'gitUnstage(projectId: $projectId, worktreeId: $worktreeId, paths: $paths)');
export const GIT_DISCARD = gitMutation('GitDiscard', ', $paths: [String!]!', 'gitDiscard(projectId: $projectId, worktreeId: $worktreeId, paths: $paths)');
export const GIT_COMMIT = gitMutation('GitCommit', ', $message: String!, $stageAll: Boolean', 'gitCommit(projectId: $projectId, worktreeId: $worktreeId, message: $message, stageAll: $stageAll)');
export const GIT_FETCH = gitMutation('GitFetch', '', 'gitFetch(projectId: $projectId, worktreeId: $worktreeId)');
export const GIT_PULL = gitMutation('GitPull', '', 'gitPull(projectId: $projectId, worktreeId: $worktreeId)');
export const GIT_PUSH = gitMutation('GitPush', '', 'gitPush(projectId: $projectId, worktreeId: $worktreeId)');
export const GIT_CHECKOUT = gitMutation('GitCheckout', ', $branch: String!, $create: Boolean', 'gitCheckout(projectId: $projectId, worktreeId: $worktreeId, branch: $branch, create: $create)');

// ---- Pull requests GitHub -----------------------------------------------------------------------

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
export type PullRequestMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

/** Champs d'une PR affichés sur une carte de tâche. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  checksState: string | null;
  headRefName: string;
  baseRefName: string;
}

export interface PullRequest extends PullRequestSummary {
  body: string;
  author: string | null;
  authorAvatarUrl: string | null;
  isCrossRepository: boolean;
  mergeStateStatus: string;
  checks: { name: string; state: string; url: string | null }[];
  reviews: { author: string; state: string }[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  worktree: { id: string; name: string; sessions: { id: string; name: string; status: SessionStatus }[] } | null;
  tasks: { id: string; title: string; status: TaskStatus }[];
}

export interface PullRequestDraft {
  branch: string;
  base: string;
  title: string;
  body: string;
  commits: { hash: string; subject: string }[];
  needsPush: boolean;
  existing: PullRequest | null;
}

export const PULL_REQUEST_FIELDS = gql`
  fragment PullRequestFields on PullRequest {
    number
    title
    body
    url
    state
    isDraft
    author
    authorAvatarUrl
    headRefName
    baseRefName
    isCrossRepository
    mergeable
    mergeStateStatus
    reviewDecision
    checksState
    checks {
      name
      state
      url
    }
    reviews {
      author
      state
    }
    additions
    deletions
    changedFiles
    commitCount
    createdAt
    updatedAt
    mergedAt
    worktree {
      id
      name
      sessions {
        id
        name
        status
      }
    }
    tasks {
      id
      title
      status
    }
  }
`;

export const GITHUB_PULL_REQUESTS = gql`
  ${PULL_REQUEST_FIELDS}
  query GithubPullRequests($projectId: ID!, $state: PullRequestFilter, $limit: Int) {
    githubPullRequests(projectId: $projectId, state: $state, limit: $limit) {
      ...PullRequestFields
    }
  }
`;

export const GITHUB_PULL_REQUEST = gql`
  ${PULL_REQUEST_FIELDS}
  query GithubPullRequest($projectId: ID!, $number: Int!) {
    githubPullRequest(projectId: $projectId, number: $number) {
      ...PullRequestFields
    }
  }
`;

export const GITHUB_PULL_REQUEST_DRAFT = gql`
  ${PULL_REQUEST_FIELDS}
  query GithubPullRequestDraft($projectId: ID!, $worktreeId: ID) {
    githubPullRequestDraft(projectId: $projectId, worktreeId: $worktreeId) {
      branch
      base
      title
      body
      commits {
        hash
        subject
      }
      needsPush
      existing {
        ...PullRequestFields
      }
    }
  }
`;

export const CREATE_PULL_REQUEST = gql`
  ${PULL_REQUEST_FIELDS}
  mutation CreatePullRequest($projectId: ID!, $worktreeId: ID, $title: String!, $body: String, $base: String, $draft: Boolean) {
    createPullRequest(projectId: $projectId, worktreeId: $worktreeId, title: $title, body: $body, base: $base, draft: $draft) {
      ...PullRequestFields
    }
  }
`;

export const MERGE_PULL_REQUEST = gql`
  ${PULL_REQUEST_FIELDS}
  mutation MergePullRequest($projectId: ID!, $number: Int!, $method: PullRequestMergeMethod, $cleanup: MergePullRequestCleanup) {
    mergePullRequest(projectId: $projectId, number: $number, method: $method, cleanup: $cleanup) {
      sha
      deletedWorktreeIds
      completedTaskIds
      warnings
      pullRequest {
        ...PullRequestFields
      }
    }
  }
`;

// ---- Tableau de bord ----------------------------------------------------------------------------

export interface DashboardCounts {
  pendingRequests: number;
  busySessions: number;
  idleSessions: number;
  failedSessions24h: number;
  endedSessions24h: number;
  todoTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
  doneTasks7d: number;
  unreadNotifications: number;
}

export interface DashboardUsage {
  monthStart: string;
  monthUsd: number;
  globalMonthUsd: number;
  monthlyBudgetUsd: number | null;
  todayUsd: number;
  last7DaysUsd: number;
  previous7DaysUsd: number;
  byDay: { day: string; usd: number }[];
  topSessions: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
  rateLimits: ClaudeRateLimits | null;
}

export interface DashboardProject {
  project: Pick<Project, 'id' | 'name' | 'slug' | 'gitUrl' | 'myRole'> & { git: { branch: string } | null };
  busySessions: number;
  idleSessions: number;
  pendingRequests: number;
  todoTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
  monthUsd: number;
  lastActivityAt: string | null;
}

export interface Dashboard {
  generatedAt: string;
  counts: DashboardCounts;
  usage: DashboardUsage;
  projects: DashboardProject[];
  pendingRequests: HumanRequest[];
  runningSessions: Session[];
  recentSessions: Session[];
  attentionTasks: Task[];
}

export const DASHBOARD = gql`
  ${SESSION_FIELDS}
  ${REQUEST_FIELDS}
  ${TASK_FIELDS}
  query Dashboard {
    dashboard {
      generatedAt
      counts {
        pendingRequests
        busySessions
        idleSessions
        failedSessions24h
        endedSessions24h
        todoTasks
        inProgressTasks
        overdueTasks
        doneTasks7d
        unreadNotifications
      }
      usage {
        monthStart
        monthUsd
        globalMonthUsd
        monthlyBudgetUsd
        todayUsd
        last7DaysUsd
        previous7DaysUsd
        byDay {
          day
          usd
        }
        topSessions {
          sessionId
          sessionName
          projectName
          usd
        }
        rateLimits {
          updatedAt
          status
          rateLimitType
          rateLimitLabel
          resetsAt
          overageStatus
          overageDisabledReason
          isUsingOverage
          windows {
            type
            label
            utilization
            resetsAt
            observedAt
          }
        }
      }
      projects {
        project {
          id
          name
          slug
          gitUrl
          myRole
          git {
            branch
          }
        }
        busySessions
        idleSessions
        pendingRequests
        todoTasks
        inProgressTasks
        overdueTasks
        monthUsd
        lastActivityAt
      }
      pendingRequests {
        ...RequestFields
      }
      runningSessions {
        ...SessionFields
      }
      recentSessions {
        ...SessionFields
      }
      attentionTasks {
        ...TaskFields
      }
    }
  }
`;

export const PROJECT_PERMISSION_RULES = gql`
  query ProjectPermissionRules($id: ID!) {
    project(id: $id) {
      id
      permissionRules {
        id
        projectId
        toolName
        ruleContent
        rule
        createdAt
        lastUsedAt
        useCount
        usageTrackedSince
        createdBySession {
          id
          name
        }
      }
    }
  }
`;

export const ADD_PROJECT_PERMISSION_RULE = gql`
  mutation AddProjectPermissionRule($projectId: ID!, $toolName: String!, $ruleContent: String) {
    addProjectPermissionRule(projectId: $projectId, toolName: $toolName, ruleContent: $ruleContent) {
      id
      rule
    }
  }
`;

export const UPDATE_PROJECT_PERMISSION_RULE = gql`
  mutation UpdateProjectPermissionRule($id: ID!, $rule: String!) {
    updateProjectPermissionRule(id: $id, rule: $rule) {
      id
      toolName
      ruleContent
      rule
    }
  }
`;

export const DELETE_PROJECT_PERMISSION_RULES = gql`
  mutation DeleteProjectPermissionRules($projectId: ID!, $ids: [ID!]!) {
    deleteProjectPermissionRules(projectId: $projectId, ids: $ids)
  }
`;

export const DELETE_PROJECT_PERMISSION_RULE = gql`
  mutation DeleteProjectPermissionRule($id: ID!) {
    deleteProjectPermissionRule(id: $id)
  }
`;

// ---- Modifications d'une session ----------------------------------------------------------------

export type SessionChangesMode = 'COMMIT' | 'HEAD' | 'MTIME';

export interface SessionFileChange {
  path: string;
  origPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  untracked: boolean;
}

export interface SessionChanges {
  mode: SessionChangesMode;
  baseCommit: string | null;
  files: SessionFileChange[];
  truncated: boolean;
}

const SESSION_CHANGES_FIELDS = gql`
  fragment SessionChangesFields on SessionChanges {
    mode
    baseCommit
    truncated
    files {
      path
      origPath
      status
      additions
      deletions
      untracked
    }
  }
`;

export const SESSION_CHANGES = gql`
  ${SESSION_CHANGES_FIELDS}
  query SessionChanges($sessionId: ID!) {
    sessionChanges(sessionId: $sessionId) {
      ...SessionChangesFields
    }
  }
`;

export const SESSION_FILE_DIFF = gql`
  query SessionFileDiff($sessionId: ID!, $path: String!, $origPath: String) {
    sessionFileDiff(sessionId: $sessionId, path: $path, origPath: $origPath) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export const DISCARD_SESSION_FILE = gql`
  ${SESSION_CHANGES_FIELDS}
  mutation DiscardSessionFile($sessionId: ID!, $path: String!, $origPath: String) {
    discardSessionFile(sessionId: $sessionId, path: $path, origPath: $origPath) {
      ...SessionChangesFields
    }
  }
`;

/** Nom déjà en cache (chargé par la sidebar ou une liste) : affiché pendant le chargement d'une page. */
export const SESSION_NAME = gql`
  fragment CachedSessionName on Session {
    name
  }
`;

export const TERMINAL_NAME = gql`
  fragment CachedTerminalName on Terminal {
    name
  }
`;

export const PROJECT_NAME = gql`
  fragment CachedProjectName on Project {
    name
  }
`;

export interface ContainerProcess {
  pid: number;
  rssMb: number;
  elapsedSeconds: number;
  sessionId: string | null;
  session: { id: string; name: string; status: SessionStatus; activity: SessionActivity | null; updatedAt: string } | null;
  childrenRssMb: number;
  cwd: string | null;
}

export interface ContainerStats {
  sampledAt: string;
  memoryUsedMb: number;
  memoryLimitMb: number | null;
  memoryPercent: number | null;
  swapUsedMb: number | null;
  cpuPercent: number | null;
  cpuLimit: number | null;
  oomKills: number;
  memoryHighSince: string | null;
  claudeProcesses: ContainerProcess[];
}

export const PROJECT_CONTAINER_STATS = gql`
  query ProjectContainerStats($id: ID!) {
    project(id: $id) {
      id
      containerStats {
        sampledAt
        memoryUsedMb
        memoryLimitMb
        memoryPercent
        swapUsedMb
        cpuPercent
        cpuLimit
        oomKills
        memoryHighSince
        claudeProcesses {
          pid
          rssMb
          elapsedSeconds
          sessionId
          childrenRssMb
          cwd
          session {
            id
            name
            status
            activity
            updatedAt
          }
        }
      }
    }
  }
`;
