/** Type de système distant. Ajouter un type = étendre cette liste, les clients (ssh.ts, postgres.ts, website.ts) et le formulaire. */
export type ConnectionKind = 'ssh' | 'postgres' | 'website';
export const CONNECTION_KINDS: ConnectionKind[] = ['ssh', 'postgres', 'website'];

/**
 * Comment les agents accèdent à la connexion :
 * - mcp : par les outils du serveur MCP `connections` ; le backend détient les identifiants, l'agent ne les voit jamais.
 *   Pour un site web : les champs secrets sont fournis au navigateur headless (option `--secrets` de Playwright MCP),
 *   l'agent tape le nom d'une variable et le navigateur saisit la valeur à sa place ;
 * - direct : depuis le shell de la session (`ssh <nom>`, `psql service=<nom>`) grâce à un agent SSH et des fichiers
 *   de configuration éphémères ; la clé SSH reste inaccessible, mais un mot de passe de base l'est.
 *   Pour un site web : tous les champs deviennent des variables d'environnement du shell ;
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

/**
 * Champ d'un site web : identifiant, mot de passe, code d'organisation, URL d'un formulaire... Autant qu'on veut.
 * La valeur d'un champ public est ici ; celle d'un champ secret est chiffrée dans `secrets[key]` et `value` vaut null.
 */
export interface WebsiteField {
  /** Clé technique (minuscules, chiffres, soulignés), ex. "username", "password", "otp_secret". */
  key: string;
  /** Libellé pour l'interface et les agents, ex. "Adresse e-mail". */
  label: string;
  secret: boolean;
  value: string | null;
}

/** Champs publics d'un site web. */
export interface WebsiteSettings {
  /** Adresse du site ou de sa page de connexion. */
  url: string;
  fields: WebsiteField[];
}

export type ConnectionSettings = SshSettings | PostgresSettings | WebsiteSettings;

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
  /** website : adresse du site. */
  url?: string | null;
  /** website : liste complète des champs (elle remplace la précédente en mise à jour). */
  fields?: ConnectionFieldInput[] | null;
}

/** Champ d'un site web en entrée. Pour un secret, `value` absent ou null conserve la valeur enregistrée. */
export interface ConnectionFieldInput {
  key: string;
  label?: string | null;
  secret?: boolean | null;
  value?: string | null;
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

/** Champs d'un site web, valeurs déchiffrées, avec le nom de variable sous lequel les agents les désignent. */
export interface WebsiteCredentials {
  url: string;
  fields: (WebsiteField & { value: string; variable: string })[];
}

export interface ConnectionTestResult {
  ok: boolean;
  error: string | null;
  /** Ce que la cible a répondu (uname, version de PostgreSQL...). */
  detail: string | null;
}
