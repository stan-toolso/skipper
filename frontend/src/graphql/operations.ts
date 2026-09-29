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

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  gitUrl: string | null;
  gitBranch: string | null;
  workspacePath: string;
  workspaceExists: boolean;
  git: { branch: string; commit: string } | null;
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
    workspacePath
    workspaceExists
    git {
      branch
      commit
    }
    createdAt
    updatedAt
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
    }
  }
`;

export const CREATE_TERMINAL = gql`
  mutation CreateTerminal($projectId: ID!, $name: String) {
    createTerminal(projectId: $projectId, name: $name) {
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

export interface AppSettings {
  claude: ClaudeSettings;
  claudeAuth: ClaudeAuthStatus;
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

export const SETTINGS = gql`
  ${APP_SETTINGS_FIELDS}
  query Settings {
    settings {
      ...AppSettingsFields
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
