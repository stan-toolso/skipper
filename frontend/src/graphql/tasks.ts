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

export const TASK_COMMENTS = gql`
  query TaskComments($id: ID!) {
    task(id: $id) {
      id
      commentCount
      comments {
        id
        authorType
        authorName
        author {
          id
          name
        }
        authorSession {
          id
          name
        }
        body
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
  mutation AddTaskComment($taskId: ID!, $body: String!, $attachments: [AttachmentInput!]) {
    addTaskComment(taskId: $taskId, body: $body, attachments: $attachments) {
      id
    }
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

export const PROJECT_API_KEYS = gql`
  query ProjectApiKeys($id: ID!) {
    project(id: $id) {
      id
      apiKeys {
        id
        name
        prefix
        createdAt
        lastUsedAt
        createdBy {
          id
          name
        }
      }
    }
  }
`;

export const CREATE_PROJECT_API_KEY = gql`
  mutation CreateProjectApiKey($projectId: ID!, $name: String!) {
    createProjectApiKey(projectId: $projectId, name: $name) {
      secret
      key {
        id
        name
        prefix
        createdAt
      }
    }
  }
`;

export const DELETE_PROJECT_API_KEY = gql`
  mutation DeleteProjectApiKey($id: ID!) {
    deleteProjectApiKey(id: $id)
  }
`;

export interface ProjectApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  createdBy: { id: string; name: string } | null;
}

/** Ce que « Confier à un agent » doit savoir : la branche de la tâche (dossier repris) et la session déjà en charge, qui sera archivée. */
export const TASK_LAUNCH_INFO = gql`
  query TaskLaunchInfo($id: ID!) {
    task(id: $id) {
      id
      branch
      session {
        id
        name
        archivedAt
      }
      worksession {
        id
        name
        branch
        label
        archivedAt
      }
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
