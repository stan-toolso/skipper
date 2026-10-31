import { gql } from '@apollo/client';
import type { ProjectRole } from './operations';

/**
 * Page « Dépôt » d'un projet : le dépôt hébergé par Skipper (clone, sauvegardes, jetons d'accès) et la consultation
 * du dépôt (branches et tags, historique, détail d'un commit, arbre et fichiers à une révision), disponible aussi pour
 * un projet relié à un dépôt distant.
 */

export interface GitBackup {
  id: string;
  takenAt: string;
  size: number;
  refCount: number;
  head: string;
  downloadUrl: string;
}

export interface HostedGit {
  url: string;
  exists: boolean;
  defaultBranch: string;
  diskSize: number | null;
  lastBackup: GitBackup | null;
  backups: GitBackup[];
}

export interface RepoProject {
  id: string;
  name: string;
  description: string | null;
  myRole: ProjectRole;
  isPersonal: boolean;
  gitUrl: string | null;
  gitBranch: string | null;
  gitHosted: boolean;
  hostedGit: HostedGit | null;
}

export interface RepoRef {
  name: string;
  kind: 'BRANCH' | 'TAG';
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  isDefault: boolean;
}

export interface RepoCommit {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
}

export interface RepoCommitFile {
  path: string;
  origPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface RepoCommitDetail {
  commit: RepoCommit;
  files: RepoCommitFile[];
  diff: string;
  truncated: boolean;
}

export interface RepoEntry {
  name: string;
  path: string;
  kind: 'DIR' | 'FILE' | 'SYMLINK' | 'SUBMODULE';
  size: number | null;
}

export interface RepoFile {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

export interface GitAccessToken {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const GIT_BACKUP_FIELDS = gql`
  fragment GitBackupFields on GitBackup {
    id
    takenAt
    size
    refCount
    head
    downloadUrl
  }
`;

export const HOSTED_GIT_FIELDS = gql`
  ${GIT_BACKUP_FIELDS}
  fragment HostedGitFields on HostedGit {
    url
    exists
    defaultBranch
    diskSize
    lastBackup {
      ...GitBackupFields
    }
    backups {
      ...GitBackupFields
    }
  }
`;

export const REPO_PROJECT = gql`
  ${HOSTED_GIT_FIELDS}
  query RepoProject($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      gitUrl
      gitBranch
      gitHosted
      hostedGit {
        ...HostedGitFields
      }
    }
  }
`;

export const REPO_REFS = gql`
  query RepoRefs($projectId: ID!, $refresh: Boolean) {
    repoRefs(projectId: $projectId, refresh: $refresh) {
      name
      kind
      hash
      shortHash
      subject
      author
      date
      isDefault
    }
  }
`;

export const REPO_LOG = gql`
  query RepoLog($projectId: ID!, $ref: String!, $limit: Int, $skip: Int, $path: String) {
    repoLog(projectId: $projectId, ref: $ref, limit: $limit, skip: $skip, path: $path) {
      hash
      shortHash
      subject
      body
      author
      email
      date
      parents
    }
  }
`;

export const REPO_COMMIT = gql`
  query RepoCommit($projectId: ID!, $hash: String!) {
    repoCommit(projectId: $projectId, hash: $hash) {
      commit {
        hash
        shortHash
        subject
        body
        author
        email
        date
        parents
      }
      files {
        path
        origPath
        status
        additions
        deletions
      }
      diff
      truncated
    }
  }
`;

export const REPO_TREE = gql`
  query RepoTree($projectId: ID!, $ref: String!, $path: String) {
    repoTree(projectId: $projectId, ref: $ref, path: $path) {
      name
      path
      kind
      size
    }
  }
`;

export const REPO_FILE = gql`
  query RepoFile($projectId: ID!, $ref: String!, $path: String!) {
    repoFile(projectId: $projectId, ref: $ref, path: $path) {
      path
      content
      size
      binary
      truncated
    }
  }
`;

export const MY_GIT_TOKENS = gql`
  query MyGitTokens {
    myGitTokens {
      id
      label
      prefix
      createdAt
      lastUsedAt
      expiresAt
    }
  }
`;

export const CREATE_GIT_TOKEN = gql`
  mutation CreateGitToken($label: String!, $expiresInDays: Int) {
    createGitToken(label: $label, expiresInDays: $expiresInDays) {
      token {
        id
        label
        prefix
        createdAt
        lastUsedAt
        expiresAt
      }
      secret
    }
  }
`;

export const REVOKE_GIT_TOKEN = gql`
  mutation RevokeGitToken($id: ID!) {
    revokeGitToken(id: $id)
  }
`;

export const ROTATE_AGENT_GIT_TOKEN = gql`
  mutation RotateAgentGitToken {
    rotateAgentGitToken
  }
`;

export const BACKUP_HOSTED_GIT = gql`
  ${HOSTED_GIT_FIELDS}
  mutation BackupHostedGit($projectId: ID!) {
    backupHostedGit(projectId: $projectId) {
      ...HostedGitFields
    }
  }
`;
