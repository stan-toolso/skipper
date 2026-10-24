import { gql } from '@apollo/client';

// ---- Paramètres : par personne (Claude, OpenCode, GitHub, consommation) ; serveur pour les administrateurs ----

/** Comment les sessions d'une personne s'authentifient auprès de Claude : jeton OAuth de son abonnement, ou clé API. */
export type ClaudeAuthMode = 'oauth' | 'api_key';

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

/** Identifiants Claude de la personne : les jetons applicatifs du coffre choisis (abonnement et clé API). */
export interface ClaudeAuthStatus {
  mode: ClaudeAuthMode;
  hasOauthToken: boolean;
  oauthTokenSetAt: string | null;
  hasApiKey: boolean;
  apiKeySetAt: string | null;
  oauthItemId: string | null;
  oauthItemName: string | null;
  apiKeyItemId: string | null;
  apiKeyItemName: string | null;
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
  /** Seuil (tokens) de signalement du contexte d'une session ; null = jamais. */
  contextWarnTokens: number | null;
}

export interface UsageSummary {
  monthStart: string;
  monthUsd: number;
  totalUsd: number;
  byModel: { model: string; usd: number }[];
  bySession: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
}

/** Compte GitHub connecté par la personne (OAUTH : connexion par code ; PAT : jeton personnel du coffre). */
export interface GithubAccount {
  id: string;
  login: string;
  avatarUrl: string | null;
  method: 'OAUTH' | 'PAT';
  scopes: string[];
  organizations: string[];
  isDefault: boolean;
  vaultItemId: string;
  connectedAt: string;
  tokenExpiresAt: string | null;
}

export interface GithubAuthStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenSetAt: string | null;
  accounts: GithubAccount[];
  deviceAvailable: boolean;
}

export interface GithubDeviceLogin {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
}

export interface GithubDevicePoll {
  status: 'PENDING' | 'CONNECTED' | 'EXPIRED' | 'DENIED' | string;
  interval: number;
  account: GithubAccount | null;
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
  account: string;
}

export interface OpencodeProvider {
  id: string;
  label: string;
  keyPrefix: string | null;
}

export interface OpencodeApiKey {
  provider: string;
  label: string;
  itemId: string;
  itemName: string | null;
  usable: boolean;
  setAt: string | null;
}

export interface OpencodeModelList {
  listedAt: string;
  ok: boolean;
  error: string | null;
  models: string[];
}

export interface OpencodeSettings {
  defaultModel: string | null;
  sessionBudgetUsd: number | null;
  apiKeys: OpencodeApiKey[];
  providers: OpencodeProvider[];
  modelList: OpencodeModelList | null;
}

/** État du serveur (mode maintenance, sessions actives, reprise automatique). */
export interface ServerState {
  maintenance: boolean;
  maintenanceSince: string | null;
  maintenanceMessage: string | null;
  activeSessions: number;
  busySessions: number;
  autoResumeInterrupted: boolean;
  /** 0 : illimité. */
  maxConcurrentSessions: number;
  queuedSessions: number;
  /** 0 : jamais. */
  idleSessionTimeoutMinutes: number;
  /** 0 : jamais. */
  memoryAlertThresholdMb: number;
}

/** Santé du serveur (query serverHealth). */
export interface ServerHealth {
  checkedAt: string;
  hostname: string;
  uptimeSeconds: number;
  cpuCount: number;
  loadAverage: number[];
  memory: { totalMb: number; availableMb: number; swapTotalMb: number; swapFreeMb: number };
  sessions: { running: number; busy: number; idle: number; queued: number; maxConcurrent: number };
  terminals: number;
  claudeProcesses: { pid: number; rssMb: number; elapsedSeconds: number }[];
  docker: {
    available: boolean;
    version: string | null;
    error: string | null;
    containers: { name: string; project: { id: string; name: string } | null; state: string; status: string; memoryUsage: string | null; memoryPercent: number | null; cpuPercent: number | null; cpuPressurePercent: number | null }[];
  };
  disk: {
    path: string;
    totalMb: number | null;
    freeMb: number | null;
    workspaces: { name: string; project: { id: string; name: string } | null; sizeMb: number }[];
    workspacesMeasuredAt: string | null;
  };
}

export const SERVER_HEALTH = gql`
  query ServerHealth {
    serverHealth {
      checkedAt
      hostname
      uptimeSeconds
      cpuCount
      loadAverage
      memory {
        totalMb
        availableMb
        swapTotalMb
        swapFreeMb
      }
      sessions {
        running
        busy
        idle
        queued
        maxConcurrent
      }
      terminals
      claudeProcesses {
        pid
        rssMb
        elapsedSeconds
      }
      docker {
        available
        version
        error
        containers {
          name
          project {
            id
            name
          }
          state
          status
          memoryUsage
          memoryPercent
          cpuPercent
          cpuPressurePercent
        }
      }
      disk {
        path
        totalMb
        freeMb
        workspaces {
          name
          project {
            id
            name
          }
          sizeMb
        }
        workspacesMeasuredAt
      }
    }
  }
`;

/** Fenêtre de limite d'utilisation de l'abonnement Claude. */
export interface ClaudeRateLimitWindow {
  type: string;
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  observedAt: string;
}

/** Dernier état connu des limites d'utilisation de l'abonnement Claude. */
export interface ClaudeRateLimits {
  updatedAt: string;
  status: 'allowed' | 'allowed_warning' | 'rejected' | string;
  rateLimitType: string | null;
  rateLimitLabel: string | null;
  resetsAt: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean;
  windows: ClaudeRateLimitWindow[];
}

/** Paramètres de la personne connectée ; `rateLimits` et `server` ne sont remplis que pour un administrateur. */
export interface AppSettings {
  claude: ClaudeSettings;
  claudeAuth: ClaudeAuthStatus;
  models: ClaudeModel[];
  usage: UsageSummary;
  github: GithubAuthStatus;
  opencode: OpencodeSettings;
  rateLimits: ClaudeRateLimits | null;
  server: ServerState | null;
}

export interface ClaudeLogin {
  id: string;
  url: string;
  status: 'starting' | 'awaiting_code' | 'exchanging' | 'done' | 'failed';
  error: string | null;
  createdAt: string;
}

export const GITHUB_ACCOUNT_FIELDS = gql`
  fragment GithubAccountFields on GithubAccount {
    id
    login
    avatarUrl
    method
    scopes
    organizations
    isDefault
    vaultItemId
    connectedAt
    tokenExpiresAt
  }
`;

export const GITHUB_AUTH_FIELDS = gql`
  ${GITHUB_ACCOUNT_FIELDS}
  fragment GithubAuthFields on GithubAuthStatus {
    connected
    login
    avatarUrl
    scopes
    tokenSetAt
    deviceAvailable
    accounts {
      ...GithubAccountFields
    }
  }
`;

export const APP_SETTINGS_FIELDS = gql`
  ${GITHUB_AUTH_FIELDS}
  fragment AppSettingsFields on AppSettings {
    claude {
      authMode
      defaultModel
      allowedModels
      fallbackModel
      monthlyBudgetUsd
      sessionBudgetUsd
      defaultMaxTurns
      contextWarnTokens
    }
    claudeAuth {
      mode
      hasOauthToken
      oauthTokenSetAt
      hasApiKey
      apiKeySetAt
      oauthItemId
      oauthItemName
      apiKeyItemId
      apiKeyItemName
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
    github {
      ...GithubAuthFields
    }
    opencode {
      defaultModel
      sessionBudgetUsd
      apiKeys {
        provider
        label
        itemId
        itemName
        usable
        setAt
      }
      providers {
        id
        label
        keyPrefix
      }
      modelList {
        listedAt
        ok
        error
        models
      }
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
    server {
      maintenance
      maintenanceSince
      maintenanceMessage
      activeSessions
      busySessions
      autoResumeInterrupted
      maxConcurrentSessions
      queuedSessions
      idleSessionTimeoutMinutes
      memoryAlertThresholdMb
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
      account
    }
  }
`;

export const START_GITHUB_DEVICE_LOGIN = gql`
  mutation StartGithubDeviceLogin {
    startGithubDeviceLogin {
      id
      userCode
      verificationUri
      expiresAt
      interval
    }
  }
`;

export const POLL_GITHUB_DEVICE_LOGIN = gql`
  ${GITHUB_ACCOUNT_FIELDS}
  mutation PollGithubDeviceLogin($id: ID!) {
    pollGithubDeviceLogin(id: $id) {
      status
      interval
      account {
        ...GithubAccountFields
      }
    }
  }
`;

export const CONNECT_GITHUB_FROM_VAULT = gql`
  ${GITHUB_ACCOUNT_FIELDS}
  mutation ConnectGithubFromVault($itemId: ID!) {
    connectGithubFromVault(itemId: $itemId) {
      ...GithubAccountFields
    }
  }
`;

export const SET_DEFAULT_GITHUB_ACCOUNT = gql`
  ${APP_SETTINGS_FIELDS}
  mutation SetDefaultGithubAccount($accountId: ID!) {
    setDefaultGithubAccount(accountId: $accountId) {
      ...AppSettingsFields
    }
  }
`;

export const DISCONNECT_GITHUB = gql`
  ${APP_SETTINGS_FIELDS}
  mutation DisconnectGithub($accountId: ID) {
    disconnectGithub(accountId: $accountId) {
      ...AppSettingsFields
    }
  }
`;

export const SET_MAINTENANCE_MODE = gql`
  ${APP_SETTINGS_FIELDS}
  mutation SetMaintenanceMode($enabled: Boolean!, $message: String) {
    setMaintenanceMode(enabled: $enabled, message: $message) {
      ...AppSettingsFields
    }
  }
`;

export const UPDATE_SERVER_SETTINGS = gql`
  ${APP_SETTINGS_FIELDS}
  mutation UpdateServerSettings($autoResumeInterrupted: Boolean, $maxConcurrentSessions: Int, $idleSessionTimeoutMinutes: Int, $memoryAlertThresholdMb: Int) {
    updateServerSettings(
      autoResumeInterrupted: $autoResumeInterrupted
      maxConcurrentSessions: $maxConcurrentSessions
      idleSessionTimeoutMinutes: $idleSessionTimeoutMinutes
      memoryAlertThresholdMb: $memoryAlertThresholdMb
    ) {
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

export const SET_CLAUDE_API_KEY_ITEM = gql`
  ${APP_SETTINGS_FIELDS}
  mutation SetClaudeApiKeyItem($itemId: ID) {
    setClaudeApiKeyItem(itemId: $itemId) {
      ...AppSettingsFields
    }
  }
`;

export const SET_CLAUDE_OAUTH_ITEM = gql`
  ${APP_SETTINGS_FIELDS}
  mutation SetClaudeOauthItem($itemId: ID) {
    setClaudeOauthItem(itemId: $itemId) {
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
    url
    status
    error
    createdAt
  }
`;

export const START_CLAUDE_LOGIN = gql`
  ${CLAUDE_LOGIN_FIELDS}
  mutation StartClaudeLogin {
    startClaudeLogin {
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

export const CANCEL_CLAUDE_LOGIN = gql`
  mutation CancelClaudeLogin($id: ID!) {
    cancelClaudeLogin(id: $id)
  }
`;

export const UPDATE_OPENCODE_SETTINGS = gql`
  ${APP_SETTINGS_FIELDS}
  mutation UpdateOpencodeSettings($input: OpencodeSettingsInput!) {
    updateOpencodeSettings(input: $input) {
      ...AppSettingsFields
    }
  }
`;

export const SET_OPENCODE_KEY_ITEM = gql`
  ${APP_SETTINGS_FIELDS}
  mutation SetOpencodeKeyItem($provider: String!, $itemId: ID) {
    setOpencodeKeyItem(provider: $provider, itemId: $itemId) {
      ...AppSettingsFields
    }
  }
`;

export const REFRESH_OPENCODE_MODELS = gql`
  ${APP_SETTINGS_FIELDS}
  mutation RefreshOpencodeModels {
    refreshOpencodeModels {
      ...AppSettingsFields
    }
  }
`;
