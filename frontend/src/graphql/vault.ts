import { gql } from '@apollo/client';
import type { User } from './operations';

export type VaultItemKind = 'ssh' | 'postgres' | 'website' | 'google' | 'api' | 'secret' | 'token' | 'litellm' | 'langfuse';
/** Types réservés à Skipper (jetons applicatifs, LiteLLM, Langfuse) : jamais offerts aux agents, ni reliés à un projet. */
export const SKIPPER_KINDS: VaultItemKind[] = ['token', 'litellm', 'langfuse'];

/** Service que sert un jeton applicatif (query vaultTokenServices). */
export interface VaultTokenService {
  id: string;
  label: string;
  prefix: string | null;
  opencode: boolean;
}

/** Jeton applicatif : ce qu'il sert ; sa valeur ne quitte jamais le coffre. */
export interface VaultTokenInfo {
  service: string;
  serviceLabel: string;
  obtained: 'manual' | 'oauth';
  account: string | null;
  tokenExpiresAt: string | null;
}
export type VaultPermission = 'USE' | 'READ' | 'MANAGE';
export type VaultLinkScope = 'PROJECT' | 'PERSONAL';
export type VaultApiAuth = 'bearer' | 'header' | 'basic' | 'query';
export type GoogleAccess = 'NONE' | 'READ' | 'WRITE';
export type VaultItemVia = 'OWN' | 'PROJECT' | 'PERSONAL';

export interface VaultField {
  key: string;
  label: string;
  secret: boolean;
  value: string | null;
  variable: string;
}

export interface VaultShare {
  user: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'>;
  permission: VaultPermission;
  grantedBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface VaultLink {
  id: string;
  project: { id: string; name: string } | null;
  projectName: string;
  scope: VaultLinkScope;
  user: { id: string; name: string; email: string } | null;
  linkedBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface VaultAuditEvent {
  id: string;
  action: string;
  actor: { id: string; name: string } | null;
  sessionId: string | null;
  project: { id: string; name: string } | null;
  projectName: string | null;
  ok: boolean;
  detail: string | null;
  createdAt: string;
}

export interface VaultItem {
  id: string;
  name: string;
  kind: VaultItemKind;
  description: string;
  ownerUser: Pick<User, 'id' | 'name' | 'email'> | null;
  ownerProject: { id: string; name: string } | null;
  ownerProjectName: string | null;
  myPermission: VaultPermission;
  myShare: VaultPermission | null;
  host: string | null;
  port: number | null;
  username: string | null;
  url: string | null;
  fields: VaultField[];
  database: string | null;
  ssl: boolean | null;
  sslCa: string | null;
  via: { id: string; name: string; host: string | null; username: string | null } | null;
  authScheme: VaultApiAuth | null;
  authName: string | null;
  /** Langfuse : clé publique du projet. */
  langfusePublicKey: string | null;
  /** Jeton applicatif : service et provenance. */
  token: VaultTokenInfo | null;
  google: { email: string; name: string | null; avatarUrl: string | null; gmailAccess: GoogleAccess; driveAccess: GoogleAccess; scopes: string[] } | null;
  readOnly: boolean;
  requireApproval: boolean;
  commandAllowlist: string[];
  publicKey: string | null;
  hostFingerprint: string | null;
  hostKeySeenAt: string | null;
  hasSecret: boolean;
  revealableFields: string[];
  secretUpdatedAt: string | null;
  expiresAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectVaultItem {
  item: VaultItem;
  via: VaultItemVia;
  link: VaultLink | null;
  /** false : élément réservé à Skipper (jeton, LiteLLM, Langfuse) détenu par le projet, invisible des agents. */
  forAgents: boolean;
}

export interface VaultFieldInput {
  key: string;
  label?: string | null;
  secret?: boolean | null;
  value?: string | null;
}

export interface VaultItemInput {
  name?: string | null;
  kind?: VaultItemKind | null;
  description?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  database?: string | null;
  ssl?: boolean | null;
  sslCa?: string | null;
  viaItemId?: string | null;
  readOnly?: boolean | null;
  requireApproval?: boolean | null;
  commandAllowlist?: string[] | null;
  expiresAt?: string | null;
  privateKey?: string | null;
  password?: string | null;
  url?: string | null;
  authScheme?: VaultApiAuth | null;
  authName?: string | null;
  token?: string | null;
  fields?: VaultFieldInput[] | null;
  /** token : service du jeton (fixé à la création). */
  service?: string | null;
  /** langfuse : clé publique. */
  publicKey?: string | null;
}

export const VAULT_ITEM_FIELDS = gql`
  fragment VaultItemFields on VaultItem {
    id
    name
    kind
    description
    ownerUser {
      id
      name
      email
    }
    ownerProject {
      id
      name
    }
    ownerProjectName
    myPermission
    myShare
    host
    port
    username
    url
    fields {
      key
      label
      secret
      value
      variable
    }
    database
    ssl
    sslCa
    via {
      id
      name
      host
      username
    }
    authScheme
    authName
    langfusePublicKey
    token {
      service
      serviceLabel
      obtained
      account
      tokenExpiresAt
    }
    google {
      email
      name
      avatarUrl
      gmailAccess
      driveAccess
      scopes
    }
    readOnly
    requireApproval
    commandAllowlist
    publicKey
    hostFingerprint
    hostKeySeenAt
    hasSecret
    revealableFields
    secretUpdatedAt
    expiresAt
    lastTestAt
    lastTestOk
    lastTestError
    createdBy {
      id
      name
    }
    createdAt
    updatedAt
  }
`;

export const VAULT_LINK_FIELDS = gql`
  fragment VaultLinkFields on VaultLink {
    id
    project {
      id
      name
    }
    projectName
    scope
    user {
      id
      name
      email
    }
    linkedBy {
      id
      name
    }
    createdAt
  }
`;

export const VAULT_ITEMS = gql`
  ${VAULT_ITEM_FIELDS}
  query VaultItems($kind: VaultItemKind) {
    vaultItems(kind: $kind) {
      ...VaultItemFields
    }
    vaultGoogleAvailable
  }
`;

export const VAULT_ITEM_DETAILS = gql`
  ${VAULT_LINK_FIELDS}
  query VaultItemDetails($id: ID!, $before: ID) {
    vaultItem(id: $id) {
      id
      myPermission
      shares {
        permission
        createdAt
        user {
          id
          name
          email
          avatarUrl
        }
        grantedBy {
          id
          name
        }
      }
      links {
        ...VaultLinkFields
      }
      audit(limit: 30, before: $before) {
        id
        action
        actor {
          id
          name
        }
        sessionId
        project {
          id
          name
        }
        projectName
        ok
        detail
        createdAt
      }
    }
  }
`;

export const VAULT_PROJECT = gql`
  ${VAULT_ITEM_FIELDS}
  ${VAULT_LINK_FIELDS}
  query VaultProject($id: ID!) {
    project(id: $id) {
      id
      name
      myRole
      runnerConfig
      vaultItems {
        via
        forAgents
        link {
          ...VaultLinkFields
        }
        item {
          ...VaultItemFields
        }
      }
    }
    vaultGoogleAvailable
  }
`;

export const VAULT_SHARE_CANDIDATES = gql`
  query VaultShareCandidates {
    vaultShareCandidates {
      id
      name
      email
    }
  }
`;

export const CREATE_VAULT_ITEM = gql`
  ${VAULT_ITEM_FIELDS}
  mutation CreateVaultItem($projectId: ID, $input: VaultItemInput!) {
    createVaultItem(projectId: $projectId, input: $input) {
      ...VaultItemFields
    }
  }
`;

export const UPDATE_VAULT_ITEM = gql`
  ${VAULT_ITEM_FIELDS}
  mutation UpdateVaultItem($id: ID!, $input: VaultItemInput!) {
    updateVaultItem(id: $id, input: $input) {
      ...VaultItemFields
    }
  }
`;

export const DELETE_VAULT_ITEM = gql`
  mutation DeleteVaultItem($id: ID!) {
    deleteVaultItem(id: $id)
  }
`;

export const TEST_VAULT_ITEM = gql`
  ${VAULT_ITEM_FIELDS}
  mutation TestVaultItem($id: ID!) {
    testVaultItem(id: $id) {
      ok
      error
      detail
      item {
        ...VaultItemFields
      }
    }
  }
`;

export const DUPLICATE_VAULT_DATABASE = gql`
  mutation DuplicateVaultDatabase($id: ID!, $target: String!, $source: String) {
    duplicateVaultDatabase(id: $id, target: $target, source: $source)
  }
`;

export const REGENERATE_VAULT_KEY = gql`
  ${VAULT_ITEM_FIELDS}
  mutation RegenerateVaultKey($id: ID!) {
    regenerateVaultKey(id: $id) {
      ...VaultItemFields
    }
  }
`;

export const FORGET_VAULT_HOST_KEY = gql`
  ${VAULT_ITEM_FIELDS}
  mutation ForgetVaultHostKey($id: ID!) {
    forgetVaultHostKey(id: $id) {
      ...VaultItemFields
    }
  }
`;

export const REVEAL_VAULT_SECRET = gql`
  mutation RevealVaultSecret($id: ID!, $field: String!) {
    revealVaultSecret(id: $id, field: $field) {
      field
      value
    }
  }
`;

export const SHARE_VAULT_ITEM = gql`
  mutation ShareVaultItem($id: ID!, $email: String!, $permission: VaultPermission!) {
    shareVaultItem(id: $id, email: $email, permission: $permission) {
      id
    }
  }
`;

export const UNSHARE_VAULT_ITEM = gql`
  mutation UnshareVaultItem($id: ID!, $userId: ID!) {
    unshareVaultItem(id: $id, userId: $userId)
  }
`;

export const LINK_VAULT_ITEM = gql`
  mutation LinkVaultItem($id: ID!, $projectId: ID!, $scope: VaultLinkScope!) {
    linkVaultItem(id: $id, projectId: $projectId, scope: $scope) {
      id
    }
  }
`;

export const UNLINK_VAULT_ITEM = gql`
  mutation UnlinkVaultItem($linkId: ID!) {
    unlinkVaultItem(linkId: $linkId)
  }
`;

export const COPY_VAULT_ITEM = gql`
  ${VAULT_ITEM_FIELDS}
  mutation CopyVaultItem($id: ID!, $projectId: ID!, $name: String) {
    copyVaultItem(id: $id, projectId: $projectId, name: $name) {
      ...VaultItemFields
    }
  }
`;

export const VAULT_TOKEN_SERVICES = gql`
  query VaultTokenServices {
    vaultTokenServices {
      id
      label
      prefix
      opencode
    }
  }
`;
