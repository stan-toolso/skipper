import { gql } from '@apollo/client';
import { TASK_FIELDS } from './operations';
import { TASK_PULL_REQUEST_FIELDS } from './pullRequests';

export const TASK_PAGE = gql`
  ${TASK_FIELDS}
  ${TASK_PULL_REQUEST_FIELDS}
  query TaskPage($id: ID!) {
    task(id: $id) {
      ...TaskFields
      pullRequests {
        ...TaskPullRequestFields
      }
      sessionsInCharge {
        id
      }
      createdBySession {
        id
        name
        owner {
          id
          name
        }
      }
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
      sessionCosts {
        session {
          id
        }
        usd
      }
      sessions {
        id
        name
        provider
        status
        activity
        pendingRequestCount
        archivedAt
        costUsd
        startedAt
        endedAt
        owner {
          id
          name
        }
        worksession {
          id
          branch
        }
      }
    }
  }
`;

export const TASK_DETAIL = gql`
  ${TASK_FIELDS}
  query TaskDetail($id: ID!) {
    task(id: $id) {
      ...TaskFields
      pullRequest {
        number
        title
        url
        state
        isDraft
      }
    }
  }
`;

/** Le fil d'une tâche : réactions à la tâche, messages (racines et réponses à plat) avec leurs mentions et réactions, et qui l'on peut mentionner. */
export const TASK_THREAD = gql`
  query TaskThread($id: ID!) {
    task(id: $id) {
      id
      commentCount
      reactions {
        emoji
        count
        actors
        mine
      }
      mentionables {
        kind
        id
        label
        detail
        text
      }
      comments {
        id
        parentId
        authorType
        authorName
        author {
          id
          name
        }
        authorSession {
          id
          name
          owner {
            id
            name
          }
        }
        agent {
          id
          name
          kind
          avatar {
            emoji
            color
          }
        }
        body
        mentions {
          kind
          id
          label
          text
        }
        reactions {
          emoji
          count
          actors
          mine
        }
        editable
        deletable
        attachments {
          id
          name
          mediaType
          size
        }
        createdAt
        updatedAt
      }
    }
  }
`;

export const ADD_TASK_COMMENT = gql`
  mutation AddTaskComment($taskId: ID!, $body: String!, $attachments: [AttachmentInput!], $parentId: ID) {
    addTaskComment(taskId: $taskId, body: $body, attachments: $attachments, parentId: $parentId) {
      id
    }
  }
`;

export const TOGGLE_TASK_REACTION = gql`
  mutation ToggleTaskReaction($taskId: ID!, $commentId: ID, $emoji: String!) {
    toggleTaskReaction(taskId: $taskId, commentId: $commentId, emoji: $emoji)
  }
`;

export const UPDATE_TASK_COMMENT = gql`
  mutation UpdateTaskComment($id: ID!, $body: String!, $removeAttachmentIds: [ID!]) {
    updateTaskComment(id: $id, body: $body, removeAttachmentIds: $removeAttachmentIds) {
      id
      body
      updatedAt
    }
  }
`;

export const DELETE_TASK_COMMENT = gql`
  mutation DeleteTaskComment($id: ID!) {
    deleteTaskComment(id: $id)
  }
`;

export const TASK_PROMPT = gql`
  query TaskPrompt($id: ID!) {
    taskPrompt(id: $id)
  }
`;

/** Étiquettes déjà employées (suggestions des formulaires et filtres). */
export const TASK_TAGS = gql`
  query TaskTags($projectId: ID) {
    taskTags(projectId: $projectId)
  }
`;

export const TASK_PEOPLE = gql`
  query TaskPeople($projectId: ID) {
    taskPeople(projectId: $projectId) {
      name
      email
    }
  }
`;

const API_KEY_FIELDS = gql`
  fragment ApiKeyFields on ProjectApiKey {
    id
    name
    prefix
    createdAt
    lastUsedAt
    scopes
    signed
    triageAgent {
      id
      name
    }
    createdBy {
      id
      name
    }
  }
`;

export const PROJECT_API_KEYS = gql`
  ${API_KEY_FIELDS}
  query ProjectApiKeys($id: ID!) {
    project(id: $id) {
      id
      apiKeys {
        ...ApiKeyFields
      }
      agents {
        id
        name
        kind
        enabled
      }
      inboundEvents(limit: 10) {
        id
        keyName
        externalId
        source
        status
        error
        triage
        createdAt
        task {
          id
          title
        }
        session {
          id
          name
        }
        agent {
          id
          name
        }
      }
    }
  }
`;

export const CREATE_PROJECT_API_KEY = gql`
  ${API_KEY_FIELDS}
  mutation CreateProjectApiKey($projectId: ID!, $name: String!, $scopes: [String!], $triageAgentId: ID, $signed: Boolean) {
    createProjectApiKey(projectId: $projectId, name: $name, scopes: $scopes, triageAgentId: $triageAgentId, signed: $signed) {
      secret
      signingSecret
      key {
        ...ApiKeyFields
      }
    }
  }
`;

export const UPDATE_PROJECT_API_KEY = gql`
  ${API_KEY_FIELDS}
  mutation UpdateProjectApiKey($id: ID!, $name: String, $scopes: [String!], $triageAgentId: ID) {
    updateProjectApiKey(id: $id, name: $name, scopes: $scopes, triageAgentId: $triageAgentId) {
      ...ApiKeyFields
    }
  }
`;

export const SET_PROJECT_API_KEY_SIGNING = gql`
  ${API_KEY_FIELDS}
  mutation SetProjectApiKeySigning($id: ID!, $enabled: Boolean!) {
    setProjectApiKeySigning(id: $id, enabled: $enabled) {
      signingSecret
      key {
        ...ApiKeyFields
      }
    }
  }
`;

export const DELETE_PROJECT_API_KEY = gql`
  mutation DeleteProjectApiKey($id: ID!) {
    deleteProjectApiKey(id: $id)
  }
`;

/** Portées d'une clé d'API (voir backend tasks/types.ts API_KEY_SCOPES). */
export const API_KEY_SCOPES = [
  { value: 'tasks:read', label: 'Lire les tâches', hint: 'GET /api/v1/tasks' },
  { value: 'tasks:write', label: 'Créer et modifier les tâches', hint: 'POST, PATCH, DELETE /api/v1/tasks' },
  { value: 'inbound:task', label: 'Événements entrants : créer une tâche', hint: 'POST /api/v1/inbound avec task' },
  { value: 'inbound:triage', label: 'Événements entrants : convoquer un agent (triage)', hint: 'POST /api/v1/inbound avec triage' },
] as const;

export interface ProjectApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  scopes: string[];
  signed: boolean;
  triageAgent: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
}

export interface InboundEventRow {
  id: string;
  keyName: string;
  externalId: string | null;
  source: string | null;
  status: string;
  error: string | null;
  triage: boolean;
  createdAt: string;
  task: { id: string; title: string } | null;
  session: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
}

/**
 * Ce que « Confier à un agent » doit savoir : la branche de la tâche (dossier repris), la session déjà en charge (archivée
 * si l'on en lance une nouvelle) et celle dont on reprend la conversation par défaut.
 */
export const TASK_LAUNCH_INFO = gql`
  query TaskLaunchInfo($id: ID!) {
    task(id: $id) {
      id
      branch
      priority
      project {
        id
        defaultModel
        taskModels
        defaultPermissionMode
      }
      session {
        id
        name
        archivedAt
      }
      resumableSession {
        id
        name
        status
        archivedAt
      }
      worksession {
        id
        name
        branch
        label
        archivedAt
      }
      blockedBy {
        id
        title
        status
      }
      autoStartWhenUnblocked
    }
  }
`;

/** Membres d'un projet (choix du responsable et du rapporteur d'une tâche). */
export const TASK_PROJECT_MEMBERS = gql`
  query TaskProjectMembers($id: ID!) {
    project(id: $id) {
      id
      members {
        pending
        user {
          id
          name
          email
        }
      }
    }
  }
`;

/** Tâches du projet que l'on peut choisir comme dépendances (formulaire d'une tâche). */
export const TASK_DEPENDENCY_CHOICES = gql`
  query TaskDependencyChoices($projectId: ID) {
    tasks(projectId: $projectId, status: [TODO, IN_PROGRESS, DONE], limit: 500) {
      id
      title
      status
    }
  }
`;

const TASK_STATUS_FIELDS = `
  taskStatuses {
    key
    label
    category
    description
    attention
    isDefault
  }
  taskStatusesCustomized
`;

/** Statuts des tâches d'un projet (Configuration › Statuts des tâches, formulaire et kanban). */
export const PROJECT_TASK_STATUSES = gql`
  query ProjectTaskStatuses($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      ${TASK_STATUS_FIELDS}
    }
  }
`;

export const UPDATE_PROJECT_TASK_STATUSES = gql`
  mutation UpdateProjectTaskStatuses($id: ID!, $statuses: [TaskStatusDefinitionInput!]) {
    updateProject(id: $id, input: { taskStatuses: $statuses }) {
      id
      ${TASK_STATUS_FIELDS}
    }
  }
`;
