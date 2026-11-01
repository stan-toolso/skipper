import { gql } from '@apollo/client';
import type { VaultItemKind } from './vault';

/** Fichier d'environnement d'un projet : modèle écrit dans chaque nouveau dossier de travail ({{vault:élément.champ}}). */
export interface EnvFile {
  id: string;
  path: string;
  content: string;
  applyOnCreate: boolean;
  dotenv: boolean;
  keys: { key: string; value: string; fromVault: boolean }[];
  problems: string[];
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
  updatedBySession: { id: string; name: string } | null;
}

export interface EnvVaultChoice {
  itemId: string;
  name: string;
  kind: VaultItemKind;
  envExport: boolean;
  canManage: boolean;
  fields: string[];
}

export interface EnvApplyResult {
  written: string[];
  skipped: string[];
  problems: string[];
}

const ENV_FILE_FIELDS = gql`
  fragment EnvFileFields on EnvFile {
    id
    path
    content
    applyOnCreate
    dotenv
    keys {
      key
      value
      fromVault
    }
    problems
    updatedAt
    updatedBy {
      id
      name
    }
    updatedBySession {
      id
      name
    }
  }
`;

export const ENV_FILES = gql`
  ${ENV_FILE_FIELDS}
  query EnvFiles($projectId: ID!) {
    project(id: $projectId) {
      id
      name
      description
      myRole
      isPersonal
    }
    envFiles(projectId: $projectId) {
      ...EnvFileFields
    }
    envVaultChoices(projectId: $projectId) {
      itemId
      name
      kind
      envExport
      canManage
      fields
    }
  }
`;

export const SAVE_ENV_FILE = gql`
  ${ENV_FILE_FIELDS}
  mutation SaveEnvFile($projectId: ID!, $id: ID, $path: String!, $content: String!, $applyOnCreate: Boolean, $expectedUpdatedAt: DateTime) {
    saveEnvFile(projectId: $projectId, id: $id, path: $path, content: $content, applyOnCreate: $applyOnCreate, expectedUpdatedAt: $expectedUpdatedAt) {
      ...EnvFileFields
    }
  }
`;

export const DELETE_ENV_FILE = gql`
  mutation DeleteEnvFile($id: ID!) {
    deleteEnvFile(id: $id)
  }
`;

export const APPLY_ENV_FILES = gql`
  mutation ApplyEnvFiles($worksessionId: ID!, $paths: [String!]) {
    applyEnvFiles(worksessionId: $worksessionId, paths: $paths) {
      written
      skipped
      problems
    }
  }
`;
