import { gql } from '@apollo/client';
import { SESSION_FIELDS } from './operations';

/** Espace personnel de la personne connectée (créé à la première demande). */
export const PERSONAL_SPACE = gql`
  query PersonalSpace {
    personalSpace {
      id
      name
      slug
      isPersonal
      myRole
    }
  }
`;

/** Chats de la personne connectée, les plus récents d'abord. */
export const CHATS = gql`
  ${SESSION_FIELDS}
  query Chats($limit: Int) {
    chats(limit: $limit) {
      ...SessionFields
    }
  }
`;

/** Ouvre un chat avec un premier message (config : permissionMode, model). */
export const CREATE_CHAT = gql`
  ${SESSION_FIELDS}
  mutation CreateChat($text: String!, $attachments: [AttachmentInput!], $config: JSON) {
    createChat(text: $text, attachments: $attachments, config: $config) {
      ...SessionFields
    }
  }
`;

export const ARCHIVE_SESSION = gql`
  mutation ArchiveSession($id: ID!) {
    archiveSession(id: $id) {
      id
      archivedAt
      status
    }
  }
`;

export const UNARCHIVE_SESSION = gql`
  mutation UnarchiveSession($id: ID!) {
    unarchiveSession(id: $id) {
      id
      archivedAt
    }
  }
`;

export const RELAUNCH_SESSION = gql`
  mutation RelaunchSession($id: ID!, $input: RelaunchSessionInput!) {
    relaunchSession(id: $id, input: $input) {
      id
    }
  }
`;

export const ARCHIVED_SESSIONS = gql`
  ${SESSION_FIELDS}
  query ArchivedSessions($projectId: ID!, $worksessionId: ID, $search: String, $limit: Int, $offset: Int) {
    archivedSessions(projectId: $projectId, worksessionId: $worksessionId, search: $search, limit: $limit, offset: $offset) {
      ...SessionFields
    }
  }
`;

export const HISTORY_PROJECT = gql`
  query HistoryProject($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      gitUrl
      worksessions {
        id
        branch
        label
      }
      archivedWorksessions {
        id
        name
        branch
        label
        archivedAt
        git {
          commit
        }
      }
    }
  }
`;

export const SESSION_OWNERS = gql`
  query SessionOwners($projectId: ID) {
    sessionOwners(projectId: $projectId) {
      id
      name
      email
    }
  }
`;

export const GIT_BRANCH_CHANGES = gql`
  query GitBranchChanges($projectId: ID!, $worksessionId: ID) {
    gitBranchChanges(projectId: $projectId, worksessionId: $worksessionId) {
      branch
      baseBranch
      mergeBase
      commits
      files {
        path
        origPath
        status
        additions
        deletions
        untracked
      }
    }
  }
`;

export const GIT_BRANCH_FILE_DIFF = gql`
  query GitBranchFileDiff($projectId: ID!, $worksessionId: ID, $path: String!, $origPath: String) {
    gitBranchFileDiff(projectId: $projectId, worksessionId: $worksessionId, path: $path, origPath: $origPath) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export interface GitBranchChanges {
  branch: string | null;
  baseBranch: string;
  mergeBase: string;
  commits: number;
  files: { path: string; origPath: string | null; status: string; additions: number | null; deletions: number | null; untracked: boolean }[];
}
