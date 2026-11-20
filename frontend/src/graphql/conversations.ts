import type { AttachmentRef } from '../lib/attachments';
import { gql } from '@apollo/client';
import type { TaskMention, TaskMentionable, TaskReaction } from './operations';

/** Canal de conversation d'un projet. */
export interface Conversation {
  id: string;
  slug: string;
  name: string;
  topic: string;
  lastMessageAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  unreadCount: number;
  /** Dernière lecture par la personne connectée (null : jamais ouvert) : repère « Nouveaux messages ». */
  lastReadAt: string | null;
  messageCount?: number;
}

/** Message d'un canal : même forme qu'un commentaire de tâche, plus les réponses et les sessions qui répondent. */
export interface ChannelMessage {
  id: string;
  conversationId: string;
  parentId: string | null;
  authorType: 'human' | 'agent';
  authorName: string;
  author: { id: string; name: string } | null;
  authorSession: { id: string; name: string; owner: { id: string; name: string } | null } | null;
  agent?: { id: string; name: string; kind: 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM'; avatar: { emoji: string | null; color: string | null } } | null;
  body: string;
  mentions: TaskMention[];
  reactions: TaskReaction[];
  attachments: AttachmentRef[];
  editable: boolean;
  deletable: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  respondingSessions: { id: string; name: string; agent: { id: string; name: string } | null }[];
  /** Rôle de l'auteur sur le projet (GUEST : invité, signalé dans le fil) ; null pour une session ou un ancien membre. */
  authorRole: 'ADMIN' | 'MEMBER' | 'VIEWER' | 'GUEST' | null;
  createdAt: string;
  updatedAt: string;
}

export const CONVERSATION_FIELDS = gql`
  fragment ConversationFields on Conversation {
    id
    slug
    name
    topic
    lastMessageAt
    archivedAt
    createdAt
    unreadCount
    lastReadAt
  }
`;

export const MESSAGE_FIELDS = gql`
  fragment MessageFields on Message {
    id
    conversationId
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
    attachments {
      id
      name
      mediaType
      size
    }
    editable
    deletable
    replyCount
    lastReplyAt
    respondingSessions {
      id
      name
      agent {
        id
        name
      }
    }
    authorRole
    createdAt
    updatedAt
  }
`;

/** Les canaux d'un projet (page Conversations, sélecteur). */
export const PROJECT_CONVERSATIONS = gql`
  ${CONVERSATION_FIELDS}
  query ProjectConversations($id: ID!, $includeArchived: Boolean) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      unreadMessages
      conversations(includeArchived: $includeArchived) {
        ...ConversationFields
      }
      members {
        role
        user {
          id
          name
          email
          kind
          lastLoginAt
        }
      }
      agents {
        id
        name
        kind
        description
        enabled
        avatar {
          emoji
          color
        }
      }
    }
  }
`;

/** Un canal avec ses derniers messages (et qui l'on peut mentionner). Sondé régulièrement. */
export const CONVERSATION_MESSAGES = gql`
  ${CONVERSATION_FIELDS}
  ${MESSAGE_FIELDS}
  query ConversationMessages($id: ID!, $limit: Int, $before: DateTime) {
    conversation(id: $id) {
      ...ConversationFields
      messageCount
      mentionables {
        kind
        id
        label
        detail
        text
      }
      messages(limit: $limit, before: $before) {
        ...MessageFields
      }
    }
  }
`;

/** Non-lus d'un projet, pour l'onglet de l'en-tête. */
export const PROJECT_UNREAD_MESSAGES = gql`
  query ProjectUnreadMessages($id: ID!) {
    project(id: $id) {
      id
      unreadMessages
    }
  }
`;

export const CREATE_CONVERSATION = gql`
  ${CONVERSATION_FIELDS}
  mutation CreateConversation($projectId: ID!, $name: String!, $topic: String) {
    createConversation(projectId: $projectId, name: $name, topic: $topic) {
      ...ConversationFields
    }
  }
`;

export const UPDATE_CONVERSATION = gql`
  ${CONVERSATION_FIELDS}
  mutation UpdateConversation($id: ID!, $name: String, $topic: String) {
    updateConversation(id: $id, name: $name, topic: $topic) {
      ...ConversationFields
    }
  }
`;

export const SET_CONVERSATION_ARCHIVED = gql`
  ${CONVERSATION_FIELDS}
  mutation SetConversationArchived($id: ID!, $archived: Boolean!) {
    setConversationArchived(id: $id, archived: $archived) {
      ...ConversationFields
    }
  }
`;

export const POST_MESSAGE = gql`
  mutation PostMessage($conversationId: ID!, $body: String!, $parentId: ID, $attachments: [AttachmentInput!]) {
    postMessage(conversationId: $conversationId, body: $body, parentId: $parentId, attachments: $attachments) {
      id
    }
  }
`;

export const UPDATE_MESSAGE = gql`
  mutation UpdateMessage($id: ID!, $body: String!, $attachments: [AttachmentInput!], $removeAttachmentIds: [ID!]) {
    updateMessage(id: $id, body: $body, attachments: $attachments, removeAttachmentIds: $removeAttachmentIds) {
      id
      body
      updatedAt
      attachments {
        id
        name
        mediaType
        size
      }
    }
  }
`;

export const DELETE_MESSAGE = gql`
  mutation DeleteMessage($id: ID!) {
    deleteMessage(id: $id)
  }
`;

export const TOGGLE_MESSAGE_REACTION = gql`
  mutation ToggleMessageReaction($messageId: ID!, $emoji: String!) {
    toggleMessageReaction(messageId: $messageId, emoji: $emoji)
  }
`;

export const MARK_CONVERSATION_READ = gql`
  mutation MarkConversationRead($id: ID!) {
    markConversationRead(id: $id)
  }
`;

export type { TaskMentionable as Mentionable };

/** Non-lus des canaux par projet (bouton Messages de la barre du haut, sondé partout). */
export const UNREAD_MESSAGES_BY_PROJECT = gql`
  query UnreadMessagesByProject {
    unreadMessagesByProject {
      count
      project {
        id
        name
      }
    }
  }
`;

/** Fil d'une tâche suivi par l'utilisateur, dans l'onglet Conversations (route /projects/:id/conversations/task-<tâche>). */
export interface FollowedTaskThread {
  id: string;
  slug: string;
  messageCount: number;
  lastMessageAt: string | null;
  task: { id: string; title: string; status: string };
}

export const FOLLOWED_TASK_THREADS = gql`
  query FollowedTaskThreads($id: ID!) {
    project(id: $id) {
      id
      followedTaskThreads(limit: 30) {
        id
        slug
        messageCount
        lastMessageAt
        task {
          id
          title
          status
        }
      }
    }
  }
`;

/** Ce qu'il faut pour ouvrir le fil d'une tâche hors de sa page : le message d'ouverture (description). */
export const TASK_THREAD_OPENING = gql`
  query TaskThreadOpening($id: ID!) {
    task(id: $id) {
      id
      title
      status
      summary
      description
      createdAt
      createdByType
      createdBySession {
        id
        name
        owner {
          id
          name
        }
      }
      reporter {
        name
        email
      }
      attachments {
        id
        name
        mediaType
        size
      }
    }
  }
`;
