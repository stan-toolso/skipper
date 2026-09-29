/** Type de système distant. Ajouter un type = étendre cette liste, les clients (ssh.ts, postgres.ts) et le formulaire. */
export type ConnectionKind = 'ssh' | 'postgres';
export const CONNECTION_KINDS: ConnectionKind[] = ['ssh', 'postgres'];

/**
 * Comment les agents accèdent à la connexion :
 * - mcp : par les outils du serveur MCP `connections` ; le backend détient les identifiants, l'agent ne les voit jamais ;
 * - direct : depuis le shell de la session (`ssh <nom>`, `psql service=<nom>`) grâce à un agent SSH et des fichiers
 *   de configuration éphémères ; la clé SSH reste inaccessible, mais un mot de passe de base l'est ;
 * - both : les deux.
 */
export type ConnectionExposure = 'mcp' | 'direct' | 'both';
export const CONNECTION_EXPOSURES: ConnectionExposure[] = ['mcp', 'direct', 'both'];

/** Champs publics d'une connexion SSH. */
export interface SshSettings {
  host: string;
  port: number;
  username: string;
}

/** Champs publics d'une connexion PostgreSQL. */
export interface PostgresSettings {
  host: string;
  port: number;
  username: string;
  database: string;
  ssl: boolean;
  /** Connexion SSH du même projet à traverser (tunnel) pour atteindre la base. */
  viaConnectionId: string | null;
}

export type ConnectionSettings = SshSettings | PostgresSettings;

export interface Connection {
  id: string;
  projectId: string;
  name: string;
  kind: ConnectionKind;
  description: string;
  settings: ConnectionSettings;
  /** Secrets chiffrés, tels qu'en base. */
  secrets: Record<string, string>;
  publicKey: string | null;
  hostKey: string | null;
  hostKeySeenAt: Date | null;
  exposure: ConnectionExposure;
  readOnly: boolean;
  requireApproval: boolean;
  commandAllowlist: string[];
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Entrée de création / mise à jour (les champs absents sont inchangés en mise à jour). */
export interface ConnectionInput {
  name?: string | null;
  kind?: ConnectionKind | null;
  description?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  database?: string | null;
  ssl?: boolean | null;
  viaConnectionId?: string | null;
  exposure?: ConnectionExposure | null;
  readOnly?: boolean | null;
  requireApproval?: boolean | null;
  commandAllowlist?: string[] | null;
  /** ssh : clé privée collée (sinon Skipper génère une paire à la création). */
  privateKey?: string | null;
  /** postgres : mot de passe. */
  password?: string | null;
}

/** Identifiants déchiffrés, uniquement en mémoire le temps d'un usage. */
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
  database: string;
  ssl: boolean;
  password: string | null;
  /** Tunnel SSH à ouvrir avant de se connecter, le cas échéant. */
  via: { connection: Connection; credentials: SshCredentials } | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  error: string | null;
  /** Ce que la cible a répondu (uname, version de PostgreSQL...). */
  detail: string | null;
}
