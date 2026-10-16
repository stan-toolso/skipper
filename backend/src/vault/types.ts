/**
 * Coffre : éléments d'identification (serveur SSH, base PostgreSQL, API HTTP, site web, secret, compte Google)
 * appartenant à un utilisateur (coffre personnel) ou à un projet, partagés avec des personnes, reliés à des
 * projets et utilisés par les agents à travers des outils (le serveur détient les secrets).
 */
import type { TokenService } from './tokens.js';

export type VaultItemKind = 'ssh' | 'postgres' | 'website' | 'google' | 'api' | 'secret' | 'token' | 'litellm' | 'langfuse';
export const VAULT_KINDS: VaultItemKind[] = ['ssh', 'postgres', 'website', 'google', 'api', 'secret', 'token', 'litellm', 'langfuse'];
/** Types utilisables par les agents des sessions ; les jetons applicatifs, LiteLLM et Langfuse servent Skipper seul (vault/tokens.ts, vault/llm.ts). */
export const AGENT_KINDS: VaultItemKind[] = ['ssh', 'postgres', 'website', 'google', 'api', 'secret'];
/** Types réservés à Skipper lui-même : jamais reliés à un projet, sans outil MCP ni variable de navigateur. */
export const SKIPPER_KINDS: VaultItemKind[] = ['token', 'litellm', 'langfuse'];
/** Types dotés d'outils MCP soumis à approbation (hors navigateur et Google, qui ont leur propre politique). */
export const TOOL_KINDS: VaultItemKind[] = ['ssh', 'postgres', 'api'];

export const kindLabels: Record<VaultItemKind, string> = {
  ssh: 'Serveur SSH',
  postgres: 'Base PostgreSQL',
  website: 'Site web',
  google: 'Compte Google',
  api: 'API HTTP',
  secret: 'Secret',
  token: 'Jeton applicatif',
  litellm: 'Proxy LiteLLM',
  langfuse: 'Langfuse',
};

/** Permission d'une personne sur un élément, du plus faible au plus fort. */
export type VaultPermission = 'use' | 'read' | 'manage';
export const PERMISSION_RANK: Record<VaultPermission, number> = { use: 0, read: 1, manage: 2 };

/** Portée d'un lien vers un projet : tous ses agents, ou les seules sessions d'une personne. */
export type VaultLinkScope = 'project' | 'personal';

/** D'où un élément arrive dans la portée d'un projet : propriété du projet, lien projet, lien personnel. */
export type VaultItemVia = 'own' | 'project' | 'personal';

export interface SshSettings {
  host: string;
  port: number;
  username: string;
}

export interface PostgresSettings {
  host: string;
  port: number;
  username: string;
  /** Base rattachée ; null = le serveur entier : l'agent choisit la base à chaque appel (vault/postgres.ts, MAINTENANCE_DATABASE par défaut). */
  database: string | null;
  ssl: boolean;
  /** Certificat de l'autorité du serveur (PEM) : vérification de la chaîne sans contrôle du nom d'hôte (Cloud SQL). */
  sslCa: string | null;
  /** Élément SSH du même propriétaire à traverser (tunnel). */
  viaItemId: string | null;
}

export type ApiAuthScheme = 'bearer' | 'header' | 'basic' | 'query';
export const API_AUTH_SCHEMES: ApiAuthScheme[] = ['bearer', 'header', 'basic', 'query'];

export interface ApiSettings {
  baseUrl: string;
  authScheme: ApiAuthScheme;
  /** Nom de l'en-tête (header) ou du paramètre (query) qui porte le jeton. */
  authName: string | null;
  /** Utilisateur (basic). */
  username: string | null;
}

/** Champ d'un site web ou d'un secret : la valeur d'un champ public est ici, celle d'un secret est chiffrée. */
export interface VaultField {
  key: string;
  label: string;
  secret: boolean;
  value: string | null;
}

export interface WebsiteSettings {
  url: string;
  fields: VaultField[];
}

export interface SecretSettings {
  fields: VaultField[];
}

export type GoogleAccess = 'none' | 'read' | 'write';
export const GOOGLE_ACCESSES: GoogleAccess[] = ['none', 'read', 'write'];

export interface GoogleSettings {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  googleSub: string;
  gmailAccess: GoogleAccess;
  driveAccess: GoogleAccess;
  scopes: string[];
}

/**
 * Jeton applicatif (vault/tokens.ts) : un identifiant que Skipper utilise pour une personne (Claude,
 * fournisseur OpenCode, GitHub). Saisi à la main (`manual`, révélable avec READ) ou obtenu par un parcours
 * de connexion de Skipper (`oauth`, ne quitte jamais le serveur ; renouvelé par Skipper).
 */
export interface TokenSettings {
  service: TokenService;
  obtained: 'manual' | 'oauth';
  /** Compte auquel appartient le jeton, quand on le connaît (identifiant GitHub, adresse du compte Claude...). */
  account: string | null;
  /** oauth : expiration du jeton d'accès et du jeton de renouvellement (ISO), quand ils expirent. */
  tokenExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

/** Proxy LiteLLM des appels de modèle de Skipper ; la clé (secret `token`) n'est jamais offerte aux agents. */
export interface LitellmSettings {
  /** URL de base du proxy, sans barre finale. */
  baseUrl: string;
}

/** Projet Langfuse qui reçoit les traces des appels de modèle de Skipper ; la clé secrète (secret `secretKey`) n'est jamais offerte aux agents. */
export interface LangfuseSettings {
  /** URL de base de Langfuse, ex. https://cloud.langfuse.com (sans barre finale). */
  host: string;
  /** Clé publique (`pk-lf-...`), non secrète. */
  publicKey: string;
}

export type VaultSettings = SshSettings | PostgresSettings | ApiSettings | WebsiteSettings | SecretSettings | GoogleSettings | TokenSettings | LitellmSettings | LangfuseSettings;

export interface VaultItem {
  id: string;
  ownerUserId: string | null;
  ownerProjectId: string | null;
  name: string;
  kind: VaultItemKind;
  description: string;
  settings: VaultSettings;
  /** Secrets chiffrés par enveloppe, tels qu'en base (null : aucun secret). */
  secretCiphertext: string | null;
  wrappedKey: string | null;
  /** Secrets de l'ancien format (connexions), convertis au démarrage. */
  legacySecrets: Record<string, string> | null;
  publicKey: string | null;
  hostKey: string | null;
  hostKeySeenAt: Date | null;
  readOnly: boolean;
  requireApproval: boolean;
  commandAllowlist: string[];
  expiresAt: Date | null;
  secretUpdatedAt: Date | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultShare {
  itemId: string;
  userId: string;
  permission: VaultPermission;
  grantedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultLink {
  id: string;
  itemId: string;
  projectId: string;
  scope: VaultLinkScope;
  userId: string | null;
  linkedById: string | null;
  createdAt: Date;
}

export interface VaultAuditEvent {
  id: string;
  itemId: string | null;
  itemName: string;
  itemKind: string;
  action: string;
  actorUserId: string | null;
  sessionId: string | null;
  projectId: string | null;
  ok: boolean;
  detail: string | null;
  createdAt: Date;
}

/** Élément d'un projet tel que les agents le voient : d'où il vient et par quel lien. */
export interface ProjectVaultRow {
  item: VaultItem;
  via: VaultItemVia;
  link: VaultLink | null;
  /** false : élément du projet réservé à Skipper (jeton applicatif, LiteLLM, Langfuse), listé pour être géré, jamais offert aux agents. */
  forAgents?: boolean;
}

/** Qui agit : une personne (interface) ou une session d'agent. */
export interface VaultActor {
  userId: string | null;
  sessionId?: string | null;
  projectId?: string | null;
}

export interface VaultFieldInput {
  key: string;
  label?: string | null;
  secret?: boolean | null;
  /** Valeur ; pour un secret déjà enregistré, absente ou null = inchangée. */
  value?: string | null;
}

/** Entrée de création / mise à jour (les champs absents sont inchangés en mise à jour). */
export interface VaultItemInput {
  name?: string | null;
  kind?: VaultItemKind | null;
  description?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  /** postgres : base rattachée ; vide ou null = le serveur entier (toutes ses bases). */
  database?: string | null;
  ssl?: boolean | null;
  sslCa?: string | null;
  viaItemId?: string | null;
  readOnly?: boolean | null;
  requireApproval?: boolean | null;
  commandAllowlist?: string[] | null;
  expiresAt?: Date | string | null;
  /** ssh : clé privée importée (sinon une paire est générée). */
  privateKey?: string | null;
  /** postgres : mot de passe ('' pour l'effacer) ; api basic : mot de passe ; langfuse : clé secrète (sk-lf-..., absente = inchangée). */
  password?: string | null;
  /** website : adresse ; api, litellm : URL de base ; langfuse : hôte. */
  url?: string | null;
  authScheme?: ApiAuthScheme | null;
  authName?: string | null;
  /** api, litellm, token : jeton ou clé (absent = inchangé). */
  token?: string | null;
  /** website, secret : liste complète des champs. */
  fields?: VaultFieldInput[] | null;
  /** token : service du jeton (fixé à la création, voir vault/tokens.ts). */
  service?: string | null;
  /** langfuse : clé publique (pk-lf-...). */
  publicKey?: string | null;
}

export interface VaultTestResult {
  ok: boolean;
  error: string | null;
  detail: string | null;
}

// ---- Identifiants déchiffrés, en mémoire le temps d'un usage -----------------------------------

export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export interface PostgresCredentials {
  host: string;
  port: number;
  username: string;
  /** Base de la connexion, résolue : celle de l'élément, ou celle demandée (ou de maintenance) pour un serveur entier. */
  database: string;
  ssl: boolean;
  sslCa: string | null;
  password: string | null;
  /** Tunnel SSH à ouvrir avant de se connecter, le cas échéant. */
  via: { item: VaultItem; credentials: SshCredentials } | null;
}

export interface ApiCredentials extends ApiSettings {
  token: string;
}

/** Champs d'un site web ou d'un secret, valeurs déchiffrées. */
export interface FieldCredentials {
  url: string | null;
  fields: (VaultField & { value: string; variable: string })[];
}
