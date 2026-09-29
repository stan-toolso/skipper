import { gql } from '@apollo/client';

export type SessionStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED' | 'INTERRUPTED';
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
  createdAt: string;
  lastLoginAt: string | null;
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
  runner: 'local' | 'docker';
  runnerConfig: { image?: string; memory?: string; cpus?: string };
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
  config: Record<string, unknown>;
  externalId: string | null;
  exitCode: number | null;
  error: string | null;
  pendingRequestCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  project: Pick<Project, 'id' | 'name' | 'slug' | 'workspacePath'>;
  worktree: Pick<Worktree, 'id' | 'name' | 'branch' | 'path'> | null;
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
  worktree: { id: string; name: string; branch: string; path: string } | null;
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

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
  project: { id: string; name: string };
  session: { id: string; name: string; status: SessionStatus; activity: SessionActivity | null } | null;
  createdBySession: { id: string; name: string } | null;
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

export interface Worktree {
  id: string;
  name: string;
  branch: string;
  path: string;
  exists: boolean;
  git: { branch: string; commit: string } | null;
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
    runner
    runnerConfig
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
    config
    externalId
    exitCode
    error
    pendingRequestCount
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
      path
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
  query Projects {
    projects {
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
  query Sessions($projectId: ID, $status: SessionStatus, $provider: String) {
    sessions(projectId: $projectId, status: $status, provider: $provider) {
      ...SessionFields
    }
  }
`;

export const SESSION = gql`
  ${SESSION_FIELDS}
  ${REQUEST_FIELDS}
  query Session($id: ID!, $after: ID) {
    session(id: $id) {
      ...SessionFields
      events(after: $after) {
        id
        sessionId
        type
        payload
        createdAt
      }
      requests(status: PENDING) {
        ...RequestFields
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
  mutation SendSessionMessage($id: ID!, $text: String!) {
    sendSessionMessage(id: $id, text: $text) {
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

export const INTERRUPT_SESSION = gql`
  ${SESSION_FIELDS}
  mutation InterruptSession($id: ID!) {
    interruptSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const DELETE_SESSION = gql`
  mutation DeleteSession($id: ID!) {
    deleteSession(id: $id)
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

/** Explorateur de la sidebar : projets et leurs sessions. */
export const SIDEBAR = gql`
  query Sidebar {
    projects {
      id
      name
      slug
      gitUrl
      sessions(limit: 50) {
        id
        name
        status
        activity
        pendingRequestCount
      }
      terminals {
        id
        name
        status
      }
      worktrees {
        id
        name
        branch
        exists
        sessions {
          id
          name
          status
          activity
          pendingRequestCount
        }
        terminals {
          id
          name
          status
        }
      }
    }
  }
`;

export const PROJECT_WORKTREES = gql`
  query ProjectWorktrees($id: ID!) {
    project(id: $id) {
      id
      gitUrl
      git {
        branch
        commit
      }
      worktrees {
        id
        name
        branch
        path
        exists
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
  mutation CreateWorktree($projectId: ID!, $branch: String!, $name: String, $baseRef: String) {
    createWorktree(projectId: $projectId, branch: $branch, name: $name, baseRef: $baseRef) {
      id
      name
      branch
    }
  }
`;

export const DELETE_WORKTREE = gql`
  mutation DeleteWorktree($id: ID!, $deleteBranch: Boolean) {
    deleteWorktree(id: $id, deleteBranch: $deleteBranch)
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
    project {
      id
      name
    }
    session {
      id
      name
      status
      activity
    }
    createdBySession {
      id
      name
    }
  }
`;

export const TASKS = gql`
  ${TASK_FIELDS}
  query Tasks($projectId: ID, $status: [TaskStatus!], $priority: TaskPriority) {
    tasks(projectId: $projectId, status: $status, priority: $priority) {
      ...TaskFields
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
  mutation StartTaskSession($id: ID!) {
    startTaskSession(id: $id) {
      id
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

// ---- Paramètres généraux ---------------------------------------------------------------------

export type ClaudeAuthMode = 'server' | 'oauth' | 'api_key';

export interface ClaudeModel {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  description: string;
}

export interface ClaudeAccount {
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  apiProvider: string | null;
}

export interface ClaudeVerification {
  verifiedAt: string;
  authMode: ClaudeAuthMode;
  ok: boolean;
  error: string | null;
  account: ClaudeAccount | null;
  models: ClaudeModel[];
}

export type ClaudeLoginKind = 'oauth' | 'server';

export interface ServerAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  error: string | null;
}

export interface ClaudeAuthStatus {
  mode: ClaudeAuthMode;
  server: ServerAuthStatus;
  hasOauthToken: boolean;
  oauthTokenSetAt: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  apiKeySetAt: string | null;
  serverHasApiKey: boolean;
  verification: ClaudeVerification | null;
}

export interface ClaudeSettings {
  authMode: ClaudeAuthMode;
  defaultModel: string | null;
  allowedModels: string[];
  fallbackModel: string | null;
  monthlyBudgetUsd: number | null;
  sessionBudgetUsd: number | null;
  defaultMaxTurns: number | null;
}

export interface UsageSummary {
  monthStart: string;
  monthUsd: number;
  totalUsd: number;
  byModel: { model: string; usd: number }[];
  bySession: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
}

export interface GithubLogin {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  status: 'pending' | 'done' | 'failed' | 'expired' | 'cancelled';
  error: string | null;
  createdAt: string;
}

export interface GithubAuthStatus {
  clientId: string | null;
  clientIdSource: 'env' | 'settings' | null;
  connected: boolean;
  method: 'pat' | 'oauth' | null;
  login: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenSetAt: string | null;
  currentLogin: GithubLogin | null;
}

export interface GithubRepository {
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  pushedAt: string | null;
}

export interface AppSettings {
  claude: ClaudeSettings;
  claudeAuth: ClaudeAuthStatus;
  github: GithubAuthStatus;
  models: ClaudeModel[];
  usage: UsageSummary;
}

export interface ClaudeLogin {
  id: string;
  kind: ClaudeLoginKind;
  url: string;
  status: 'starting' | 'awaiting_code' | 'exchanging' | 'done' | 'failed';
  error: string | null;
  createdAt: string;
}

export const APP_SETTINGS_FIELDS = gql`
  fragment AppSettingsFields on AppSettings {
    claude {
      authMode
      defaultModel
      allowedModels
      fallbackModel
      monthlyBudgetUsd
      sessionBudgetUsd
      defaultMaxTurns
    }
    claudeAuth {
      mode
      server {
        loggedIn
        authMethod
        email
        organization
        subscriptionType
        error
      }
      hasOauthToken
      oauthTokenSetAt
      hasApiKey
      apiKeyHint
      apiKeySetAt
      serverHasApiKey
      verification {
        verifiedAt
        authMode
        ok
        error
        account {
          email
          organization
          subscriptionType
          apiProvider
        }
        models {
          value
          resolvedModel
          displayName
          description
        }
      }
    }
    models {
      value
      resolvedModel
      displayName
      description
    }
    usage {
      monthStart
      monthUsd
      totalUsd
      byModel {
        model
        usd
      }
      bySession {
        sessionId
        sessionName
        projectName
        usd
      }
    }
  }
`;

export const GITHUB_AUTH_FIELDS = gql`
  fragment GithubAuthFields on GithubAuthStatus {
    clientId
    clientIdSource
    connected
    method
    login
    avatarUrl
    scopes
    tokenSetAt
    currentLogin {
      id
      userCode
      verificationUri
      expiresAt
      intervalSeconds
      status
      error
      createdAt
    }
  }
`;

export const SETTINGS = gql`
  ${APP_SETTINGS_FIELDS}
  ${GITHUB_AUTH_FIELDS}
  query Settings {
    settings {
      ...AppSettingsFields
      github {
        ...GithubAuthFields
      }
    }
  }
`;

export const GITHUB_STATUS = gql`
  ${GITHUB_AUTH_FIELDS}
  query GithubStatus {
    settings {
      github {
        ...GithubAuthFields
      }
    }
  }
`;

export const GITHUB_REPOSITORIES = gql`
  query GithubRepositories($query: String) {
    githubRepositories(query: $query) {
      fullName
      name
      owner
      description
      private
      defaultBranch
      cloneUrl
      htmlUrl
      pushedAt
    }
  }
`;

export const SET_GITHUB_CLIENT_ID = gql`
  ${GITHUB_AUTH_FIELDS}
  mutation SetGithubClientId($clientId: String) {
    setGithubClientId(clientId: $clientId) {
      github {
        ...GithubAuthFields
      }
    }
  }
`;

export const SET_GITHUB_PERSONAL_TOKEN = gql`
  ${GITHUB_AUTH_FIELDS}
  mutation SetGithubPersonalToken($token: String!) {
    setGithubPersonalToken(token: $token) {
      github {
        ...GithubAuthFields
      }
    }
  }
`;

export const START_GITHUB_LOGIN = gql`
  mutation StartGithubLogin {
    startGithubLogin {
      id
      userCode
      verificationUri
      expiresAt
      intervalSeconds
      status
      error
      createdAt
    }
  }
`;

export const CANCEL_GITHUB_LOGIN = gql`
  ${GITHUB_AUTH_FIELDS}
  mutation CancelGithubLogin {
    cancelGithubLogin {
      github {
        ...GithubAuthFields
      }
    }
  }
`;

export const DISCONNECT_GITHUB = gql`
  ${GITHUB_AUTH_FIELDS}
  mutation DisconnectGithub {
    disconnectGithub {
      github {
        ...GithubAuthFields
      }
    }
  }
`;

export const UPDATE_CLAUDE_SETTINGS = gql`
  ${APP_SETTINGS_FIELDS}
  mutation UpdateClaudeSettings($input: ClaudeSettingsInput!) {
    updateClaudeSettings(input: $input) {
      ...AppSettingsFields
    }
  }
`;

export const SET_CLAUDE_API_KEY = gql`
  ${APP_SETTINGS_FIELDS}
  mutation SetClaudeApiKey($apiKey: String) {
    setClaudeApiKey(apiKey: $apiKey) {
      ...AppSettingsFields
    }
  }
`;

export const CLEAR_CLAUDE_OAUTH_TOKEN = gql`
  ${APP_SETTINGS_FIELDS}
  mutation ClearClaudeOauthToken {
    clearClaudeOauthToken {
      ...AppSettingsFields
    }
  }
`;

export const VERIFY_CLAUDE_AUTH = gql`
  ${APP_SETTINGS_FIELDS}
  mutation VerifyClaudeAuth($mode: ClaudeAuthMode) {
    verifyClaudeAuth(mode: $mode) {
      ...AppSettingsFields
    }
  }
`;

const CLAUDE_LOGIN_FIELDS = gql`
  fragment ClaudeLoginFields on ClaudeLogin {
    id
    kind
    url
    status
    error
    createdAt
  }
`;

export const START_CLAUDE_LOGIN = gql`
  ${CLAUDE_LOGIN_FIELDS}
  mutation StartClaudeLogin($kind: ClaudeLoginKind) {
    startClaudeLogin(kind: $kind) {
      ...ClaudeLoginFields
    }
  }
`;

export const COMPLETE_CLAUDE_LOGIN = gql`
  ${CLAUDE_LOGIN_FIELDS}
  mutation CompleteClaudeLogin($id: ID!, $code: String!) {
    completeClaudeLogin(id: $id, code: $code) {
      ...ClaudeLoginFields
    }
  }
`;

export const LOGOUT_SERVER_CLAUDE = gql`
  ${APP_SETTINGS_FIELDS}
  mutation LogoutServerClaude {
    logoutServerClaude {
      ...AppSettingsFields
    }
  }
`;

export const CANCEL_CLAUDE_LOGIN = gql`
  mutation CancelClaudeLogin($id: ID!) {
    cancelClaudeLogin(id: $id)
  }
`;

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
      path
      exists
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

// ---- Connexions ---------------------------------------------------------------------------------

export type ConnectionKind = 'ssh' | 'postgres';
export type ConnectionExposure = 'mcp' | 'direct' | 'both';

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  description: string;
  host: string;
  port: number;
  username: string;
  database: string | null;
  ssl: boolean | null;
  viaConnection: { id: string; name: string } | null;
  exposure: ConnectionExposure;
  readOnly: boolean;
  requireApproval: boolean;
  commandAllowlist: string[];
  publicKey: string | null;
  hostFingerprint: string | null;
  hostKeySeenAt: string | null;
  hasSecret: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInput {
  name?: string | null;
  kind?: ConnectionKind | null;
  description?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  database?: string | null;
  ssl?: boolean | null;
  viaConnectionId?: string | null;
  exposure?: ConnectionExposure | null;
  readOnly?: boolean | null;
  requireApproval?: boolean | null;
  commandAllowlist?: string[] | null;
  privateKey?: string | null;
  password?: string | null;
}

const CONNECTION_FIELDS = gql`
  fragment ConnectionFields on Connection {
    id
    name
    kind
    description
    host
    port
    username
    database
    ssl
    viaConnection {
      id
      name
    }
    exposure
    readOnly
    requireApproval
    commandAllowlist
    publicKey
    hostFingerprint
    hostKeySeenAt
    hasSecret
    lastTestAt
    lastTestOk
    lastTestError
    createdAt
    updatedAt
  }
`;

export const PROJECT_CONNECTIONS = gql`
  ${CONNECTION_FIELDS}
  query ProjectConnections($id: ID!) {
    project(id: $id) {
      id
      name
      slug
      runner
      myRole
      connections {
        ...ConnectionFields
      }
    }
  }
`;

export const CREATE_CONNECTION = gql`
  ${CONNECTION_FIELDS}
  mutation CreateConnection($projectId: ID!, $input: ConnectionInput!) {
    createConnection(projectId: $projectId, input: $input) {
      ...ConnectionFields
    }
  }
`;

export const UPDATE_CONNECTION = gql`
  ${CONNECTION_FIELDS}
  mutation UpdateConnection($id: ID!, $input: ConnectionInput!) {
    updateConnection(id: $id, input: $input) {
      ...ConnectionFields
    }
  }
`;

export const DELETE_CONNECTION = gql`
  mutation DeleteConnection($id: ID!) {
    deleteConnection(id: $id)
  }
`;

export const TEST_CONNECTION = gql`
  ${CONNECTION_FIELDS}
  mutation TestConnection($id: ID!) {
    testConnection(id: $id) {
      ok
      error
      detail
      connection {
        ...ConnectionFields
      }
    }
  }
`;

export const REGENERATE_CONNECTION_KEY = gql`
  ${CONNECTION_FIELDS}
  mutation RegenerateConnectionKey($id: ID!) {
    regenerateConnectionKey(id: $id) {
      ...ConnectionFields
    }
  }
`;

export const FORGET_CONNECTION_HOST_KEY = gql`
  ${CONNECTION_FIELDS}
  mutation ForgetConnectionHostKey($id: ID!) {
    forgetConnectionHostKey(id: $id) {
      ...ConnectionFields
    }
  }
`;
