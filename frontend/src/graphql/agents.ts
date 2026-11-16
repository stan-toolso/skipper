import { gql } from '@apollo/client';
import { SESSION_FIELDS, type Session, type SessionStatus, type TaskStatus } from './operations';

export type AgentKind = 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM';
export type AgentManagerRole = 'OWNER' | 'MANAGER';

export const agentKindLabels: Record<AgentKind, string> = { PRODUCT_MANAGER: 'Product Manager', DEVELOPER: 'Developer', CUSTOM: 'Agent' };

export interface AgentAvatar {
  emoji: string | null;
  color: string | null;
}

export interface AgentTriggers {
  taskCreated: boolean;
  taskCreatedTag: string | null;
  threadFollowed: boolean;
  prMerged: boolean;
  deployed: boolean;
  taskReady: boolean;
  taskReadyTag: string | null;
}

export interface AgentAction {
  key: string;
  label: string;
  instruction: string;
  cron: string | null;
  timezone: string | null;
  schedule: { id: string; name: string; project: { id: string } } | null;
}

export interface AgentManager {
  user: { id: string; name: string; email: string };
  role: AgentManagerRole;
}

export interface AgentStats {
  activeSessions: number;
  sessions: number;
  tasks: number;
  monthCostUsd: number;
  totalCostUsd: number;
  lastActivityAt: string | null;
}

/** Ce que l'interface montre d'un agent partout (pastilles, listes). */
export interface AgentRef {
  id: string;
  name: string;
  kind: AgentKind;
  avatar: AgentAvatar;
}

export interface Agent extends AgentRef {
  description: string;
  instructions: string;
  taskFolder: boolean;
  /** Réglages par défaut de ses sessions : provider (type de session), model, permissionMode, allowedTools… */
  defaults: Record<string, unknown>;
  /** Modèles que ses sessions peuvent utiliser (vide : tous). */
  allowedModels: string[];
  /** En plus de sa propre bibliothèque de contexte, l'agent reçoit celle du projet. */
  inheritContext: boolean;
  /** Comptes prêtés par une personne (sinon les comptes propres de l'agent), GitHub et GitLab séparément. */
  delegations: {
    claude: { id: string; name: string } | null;
    github: { id: string; name: string } | null;
    githubReadOnly: boolean;
    /** Pull requests permises par tasks.pr_open, même en lecture seule. */
    githubPullRequests: boolean;
    /** Prêt en écriture, fusion permise : l'agent fusionne avec tasks.pr_merge sans demande. */
    githubMerge: boolean;
    gitlab: { id: string; name: string } | null;
    gitlabReadOnly: boolean;
    gitlabPullRequests: boolean;
    gitlabMerge: boolean;
  };
  triggers: AgentTriggers;
  actions: AgentAction[];
  enabled: boolean;
  archivedAt: string | null;
  managers: AgentManager[];
  canManage: boolean;
  stats: AgentStats;
  project: { id: string; name: string; myRole?: 'ADMIN' | 'MEMBER' | 'VIEWER' };
  user: { id: string; email: string };
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplate {
  kind: AgentKind;
  label: string;
  suggestedName: string;
  avatar: AgentAvatar;
  description: string;
  instructions: string;
  taskFolder: boolean;
  defaults: Record<string, unknown>;
  triggers: AgentTriggers;
  actions: { key: string; label: string; instruction: string; cron: string | null; timezone: string | null }[];
}

export interface AgentActionInput {
  key?: string | null;
  label: string;
  instruction: string;
  cron?: string | null;
  timezone?: string | null;
}

export interface AgentInput {
  name?: string | null;
  kind?: AgentKind | null;
  avatar?: Partial<AgentAvatar> | null;
  description?: string | null;
  instructions?: string | null;
  taskFolder?: boolean | null;
  defaults?: Record<string, unknown> | null;
  allowedModels?: string[] | null;
  triggers?: Partial<AgentTriggers> | null;
  actions?: AgentActionInput[] | null;
  inheritContext?: boolean | null;
}

export const AGENT_REF_FIELDS = gql`
  fragment AgentRefFields on Agent {
    id
    name
    kind
    avatar {
      emoji
      color
    }
  }
`;

export const AGENT_FIELDS = gql`
  ${AGENT_REF_FIELDS}
  fragment AgentFields on Agent {
    ...AgentRefFields
    description
    instructions
    taskFolder
    defaults
    allowedModels
    inheritContext
    delegations {
      claude {
        id
        name
      }
      github {
        id
        name
      }
      githubReadOnly
      githubPullRequests
      githubMerge
      gitlab {
        id
        name
      }
      gitlabReadOnly
      gitlabPullRequests
      gitlabMerge
    }
    triggers {
      taskCreated
      taskCreatedTag
      threadFollowed
      prMerged
      deployed
      taskReady
      taskReadyTag
    }
    actions {
      key
      label
      instruction
      cron
      timezone
      schedule {
        id
        name
        project {
          id
        }
      }
    }
    enabled
    archivedAt
    managers {
      role
      user {
        id
        name
        email
      }
    }
    canManage
    stats {
      activeSessions
      sessions
      tasks
      monthCostUsd
      totalCostUsd
      lastActivityAt
    }
    project {
      id
      name
      myRole
    }
    user {
      id
      email
    }
    createdAt
    updatedAt
  }
`;

export const PROJECT_AGENTS = gql`
  ${AGENT_FIELDS}
  query ProjectAgents($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      agents {
        ...AgentFields
      }
    }
  }
`;

/** Agents du projet pour un sélecteur (modale de tâche, lanceur) : léger. */
export const PROJECT_AGENT_REFS = gql`
  ${AGENT_REF_FIELDS}
  query ProjectAgentRefs($id: ID!) {
    project(id: $id) {
      id
      agents {
        ...AgentRefFields
        description
        enabled
        taskFolder
        defaults
        allowedModels
      }
    }
  }
`;

export const AGENT = gql`
  ${AGENT_FIELDS}
  query Agent($id: ID!) {
    agent(id: $id) {
      ...AgentFields
    }
  }
`;

export const AGENT_ACTIVITY = gql`
  ${SESSION_FIELDS}
  query AgentActivity($id: ID!, $limit: Int) {
    agent(id: $id) {
      id
      sessions(limit: $limit) {
        ...SessionFields
        requestedBy {
          id
          name
        }
      }
      tasks(limit: $limit) {
        id
        title
        status
        statusTag
        priority
        updatedAt
        project {
          id
          name
        }
      }
    }
  }
`;

export const AGENT_TEMPLATES = gql`
  query AgentTemplates {
    agentTemplates {
      kind
      label
      suggestedName
      avatar {
        emoji
        color
      }
      description
      instructions
      taskFolder
      defaults
      triggers {
        taskCreated
        taskCreatedTag
        threadFollowed
        prMerged
        deployed
        taskReady
        taskReadyTag
      }
      actions {
        key
        label
        instruction
        cron
        timezone
      }
    }
  }
`;

export const MY_AGENTS = gql`
  ${AGENT_REF_FIELDS}
  query MyAgents {
    myAgents {
      ...AgentRefFields
      description
      project {
        id
        name
      }
    }
  }
`;

export const CREATE_AGENT = gql`
  ${AGENT_FIELDS}
  mutation CreateAgent($projectId: ID!, $input: AgentInput!) {
    createAgent(projectId: $projectId, input: $input) {
      ...AgentFields
    }
  }
`;

export const UPDATE_AGENT = gql`
  ${AGENT_FIELDS}
  mutation UpdateAgent($id: ID!, $input: AgentInput!) {
    updateAgent(id: $id, input: $input) {
      ...AgentFields
    }
  }
`;

export const SET_AGENT_ENABLED = gql`
  ${AGENT_FIELDS}
  mutation SetAgentEnabled($id: ID!, $enabled: Boolean!) {
    setAgentEnabled(id: $id, enabled: $enabled) {
      ...AgentFields
    }
  }
`;

export const DELETE_AGENT = gql`
  mutation DeleteAgent($id: ID!) {
    deleteAgent(id: $id)
  }
`;

export const SET_AGENT_MANAGERS = gql`
  ${AGENT_FIELDS}
  mutation SetAgentManagers($id: ID!, $managers: [AgentManagerInput!]!) {
    setAgentManagers(id: $id, managers: $managers) {
      ...AgentFields
    }
  }
`;

export const SUMMON_AGENT = gql`
  mutation SummonAgent($id: ID!, $text: String!, $taskId: ID, $attachments: [AttachmentInput!]) {
    summonAgent(id: $id, text: $text, taskId: $taskId, attachments: $attachments) {
      id
      name
    }
  }
`;

export const SET_AGENT_DELEGATION = gql`
  ${AGENT_FIELDS}
  mutation SetAgentDelegation($id: ID!, $account: AgentAccountKind!, $delegate: Boolean!, $readOnly: Boolean, $pullRequests: Boolean, $merge: Boolean) {
    setAgentDelegation(id: $id, account: $account, delegate: $delegate, readOnly: $readOnly, pullRequests: $pullRequests, merge: $merge) {
      ...AgentFields
    }
  }
`;

export const RUN_AGENT_ACTION = gql`
  mutation RunAgentAction($id: ID!, $key: String!, $taskId: ID) {
    runAgentAction(id: $id, key: $key, taskId: $taskId) {
      id
      name
    }
  }
`;

export interface AgentActivityData {
  agent: {
    id: string;
    sessions: (Session & { requestedBy: { id: string; name: string } | null })[];
    tasks: { id: string; title: string; status: TaskStatus; statusTag: string | null; priority: string; updatedAt: string; project: { id: string; name: string } }[];
  } | null;
}

export type { SessionStatus };
