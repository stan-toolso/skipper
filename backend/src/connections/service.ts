import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import * as postgres from './postgres.js';
import { connectionRepository, type ConnectionRecordInput } from './repository.js';
import * as ssh from './ssh.js';
import {
  CONNECTION_EXPOSURES,
  CONNECTION_KINDS,
  type Connection,
  type ConnectionInput,
  type ConnectionTestResult,
  type PostgresCredentials,
  type PostgresSettings,
  type SshCredentials,
  type SshSettings,
} from './types.js';

/**
 * Connexions des projets vers des systèmes externes. Le service est le seul à manipuler les secrets
 * en clair : il les déchiffre le temps d'un usage (test, outil MCP, mode direct) et ne les renvoie
 * jamais à l'interface.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DEFAULT_PORTS = { ssh: 22, postgres: 5432 } as const;

export const kindLabels: Record<Connection['kind'], string> = { ssh: 'Serveur SSH', postgres: 'Base PostgreSQL' };

function validateName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!NAME_RE.test(n)) throw new AppError('Nom de connexion invalide : lettres minuscules, chiffres, tirets et soulignés, 40 caractères maximum (ex. "prod", "rds-prod")');
  return n;
}

function requireText(value: string | null | undefined, label: string): string {
  const v = value?.trim();
  if (!v) throw new AppError(`${label} obligatoire`);
  return v;
}

function validatePort(port: number | null | undefined, fallback: number): number {
  if (port == null) return fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('Port invalide');
  return port;
}

function normalizeAllowlist(list: string[] | null | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean);
}

export const connectionService = {
  listByProject: (projectId: string) => connectionRepository.listByProject(projectId),

  async get(id: string): Promise<Connection> {
    const c = await connectionRepository.findById(id);
    if (!c) throw new NotFoundError('Connexion introuvable');
    return c;
  },

  /** Connexion d'un projet désignée par son nom (tel que les agents l'emploient). */
  async getByName(projectId: string, name: string): Promise<Connection> {
    const c = await connectionRepository.findByName(projectId, name.trim().toLowerCase());
    if (!c) {
      const names = (await connectionRepository.listByProject(projectId)).map((x) => x.name);
      throw new NotFoundError(`Connexion "${name}" introuvable dans ce projet${names.length ? ` (disponibles : ${names.join(', ')})` : ''}`);
    }
    return c;
  },

  hasSecret: (c: Connection) => Boolean(c.kind === 'ssh' ? c.secrets.privateKey : c.secrets.password),

  async create(projectId: string, input: ConnectionInput): Promise<Connection> {
    const project = await projectService.get(projectId);
    const kind = input.kind ?? 'ssh';
    if (!CONNECTION_KINDS.includes(kind)) throw new AppError(`Type de connexion inconnu : ${kind}`);
    const name = validateName(input.name ?? '');
    const record: ConnectionRecordInput = {
      name,
      kind,
      description: input.description?.trim() ?? '',
      settings: await this.buildSettings(kind, null, input, projectId),
      secrets: {},
      publicKey: null,
      exposure: this.validateExposure(input.exposure ?? 'mcp'),
      readOnly: input.readOnly ?? true,
      requireApproval: input.requireApproval ?? true,
      commandAllowlist: normalizeAllowlist(input.commandAllowlist),
    };
    if (kind === 'ssh') {
      // Par défaut Skipper génère la paire : la clé privée ne quitte jamais le serveur.
      const pair = input.privateKey?.trim() ? { privateKey: input.privateKey.trim(), publicKey: ssh.publicKeyOf(input.privateKey.trim()) } : ssh.generateKeyPair(`skipper-${project.slug}-${name}`);
      record.secrets = { privateKey: encryptSecret(pair.privateKey) };
      record.publicKey = pair.publicKey;
    } else if (input.password) {
      record.secrets = { password: encryptSecret(input.password) };
    }
    try {
      return await connectionRepository.create(projectId, record);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Une connexion "${name}" existe déjà dans ce projet`);
      throw err;
    }
  },

  async update(id: string, input: ConnectionInput): Promise<Connection> {
    const current = await this.get(id);
    const patch: Partial<ConnectionRecordInput> = {};
    if (input.name != null) patch.name = validateName(input.name);
    if (input.description != null) patch.description = input.description.trim();
    if (input.host != null || input.port != null || input.username != null || input.database != null || input.ssl != null || input.viaConnectionId !== undefined) {
      patch.settings = await this.buildSettings(current.kind, current.settings, input, current.projectId);
    }
    if (input.exposure != null) patch.exposure = this.validateExposure(input.exposure);
    if (input.readOnly != null) patch.readOnly = input.readOnly;
    if (input.requireApproval != null) patch.requireApproval = input.requireApproval;
    if (input.commandAllowlist != null) patch.commandAllowlist = normalizeAllowlist(input.commandAllowlist);
    if (current.kind === 'ssh' && input.privateKey?.trim()) {
      const privateKey = input.privateKey.trim();
      patch.secrets = { privateKey: encryptSecret(privateKey) };
      patch.publicKey = ssh.publicKeyOf(privateKey);
    }
    if (current.kind === 'postgres' && input.password != null) {
      patch.secrets = input.password ? { password: encryptSecret(input.password) } : {};
    }
    // Un changement d'hôte invalide la clé d'hôte mémorisée.
    if (patch.settings && current.kind === 'ssh' && ((patch.settings as SshSettings).host !== (current.settings as SshSettings).host || (patch.settings as SshSettings).port !== (current.settings as SshSettings).port)) {
      Object.assign(patch, { hostKey: null, hostKeySeenAt: null });
    }
    try {
      return await connectionRepository.update(id, patch);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Une connexion "${patch.name}" existe déjà dans ce projet`);
      throw err;
    }
  },

  async delete(id: string): Promise<boolean> {
    const dependents = await connectionRepository.listDependents(id);
    if (dependents.length) throw new AppError(`Cette connexion sert de tunnel à : ${dependents.map((d) => d.name).join(', ')}. Modifiez-les d'abord.`);
    return connectionRepository.delete(id);
  },

  /** Nouvelle paire de clés : l'ancienne clé publique cesse de fonctionner une fois retirée du serveur. */
  async regenerateKey(id: string): Promise<Connection> {
    const c = await this.get(id);
    if (c.kind !== 'ssh') throw new AppError("Seule une connexion SSH a une paire de clés");
    const project = await projectService.get(c.projectId);
    const pair = ssh.generateKeyPair(`skipper-${project.slug}-${c.name}`);
    return connectionRepository.update(id, { secrets: { privateKey: encryptSecret(pair.privateKey) }, publicKey: pair.publicKey });
  },

  /** Oublie la clé d'hôte mémorisée (serveur réinstallé, par exemple) : la prochaine connexion la réapprend. */
  async forgetHostKey(id: string): Promise<Connection> {
    await this.get(id);
    return connectionRepository.update(id, { hostKey: null, hostKeySeenAt: null });
  },

  /** Mémorise la clé d'hôte d'une connexion SSH qui n'en avait pas encore (première connexion réussie). */
  async rememberHostKey(connection: Connection, hostKey: string | null): Promise<void> {
    if (!hostKey || connection.hostKey) return;
    await connectionRepository.update(connection.id, { hostKey, hostKeySeenAt: new Date() });
    connection.hostKey = hostKey;
  },

  validateExposure(exposure: Connection['exposure']): Connection['exposure'] {
    if (!CONNECTION_EXPOSURES.includes(exposure)) throw new AppError(`Mode d'accès inconnu : ${exposure}`);
    return exposure;
  },

  async buildSettings(kind: Connection['kind'], current: Connection['settings'] | null, input: ConnectionInput, projectId: string): Promise<Connection['settings']> {
    const base = (current ?? {}) as Partial<SshSettings & PostgresSettings>;
    const host = requireText(input.host ?? base.host, "L'hôte est");
    const port = validatePort(input.port ?? base.port ?? null, DEFAULT_PORTS[kind]);
    const username = requireText(input.username ?? base.username, "L'utilisateur est");
    if (kind === 'ssh') return { host, port, username } satisfies SshSettings;
    const viaConnectionId = input.viaConnectionId !== undefined ? input.viaConnectionId : base.viaConnectionId ?? null;
    if (viaConnectionId) {
      const via = await connectionRepository.findById(viaConnectionId);
      if (!via || via.projectId !== projectId) throw new AppError('La connexion SSH de tunnel doit appartenir au même projet');
      if (via.kind !== 'ssh') throw new AppError('Le tunnel doit passer par une connexion SSH');
    }
    return {
      host,
      port,
      username,
      database: requireText(input.database ?? base.database, 'Le nom de la base est'),
      ssl: input.ssl ?? base.ssl ?? false,
      viaConnectionId,
    } satisfies PostgresSettings;
  },

  // ---- Identifiants déchiffrés --------------------------------------------------------------

  sshCredentials(c: Connection): SshCredentials {
    if (c.kind !== 'ssh') throw new AppError(`"${c.name}" n'est pas une connexion SSH`);
    if (!c.secrets.privateKey) throw new AppError(`La connexion "${c.name}" n'a pas de clé privée`);
    const s = c.settings as SshSettings;
    return { host: s.host, port: s.port, username: s.username, privateKey: decryptSecret(c.secrets.privateKey) };
  },

  async postgresCredentials(c: Connection): Promise<PostgresCredentials> {
    if (c.kind !== 'postgres') throw new AppError(`"${c.name}" n'est pas une connexion PostgreSQL`);
    const s = c.settings as PostgresSettings;
    let via: PostgresCredentials['via'] = null;
    if (s.viaConnectionId) {
      const tunnel = await this.get(s.viaConnectionId);
      via = { connection: tunnel, credentials: this.sshCredentials(tunnel) };
    }
    return { host: s.host, port: s.port, username: s.username, database: s.database, ssl: s.ssl, password: c.secrets.password ? decryptSecret(c.secrets.password) : null, via };
  },

  /** Vérifie qu'une commande respecte la liste blanche de préfixes de la connexion (vide = tout). */
  assertCommandAllowed(c: Connection, command: string): void {
    if (c.commandAllowlist.length === 0) return;
    const trimmed = command.trim();
    if (!c.commandAllowlist.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))) {
      throw new AppError(`Commande refusée par la politique de la connexion "${c.name}" : seules les commandes commençant par ${c.commandAllowlist.map((p) => `"${p}"`).join(', ')} sont autorisées`, 'FORBIDDEN');
    }
  },

  // ---- Test -----------------------------------------------------------------------------------

  async test(id: string): Promise<{ connection: Connection; result: ConnectionTestResult }> {
    const c = await this.get(id);
    let result: ConnectionTestResult;
    try {
      if (c.kind === 'ssh') {
        const session = await ssh.connect(this.sshCredentials(c), c.hostKey);
        try {
          const out = await ssh.exec(session, 'uname -srm && hostname', { timeoutMs: 10_000 });
          await this.rememberHostKey(c, session.hostKey);
          result = { ok: true, error: null, detail: out.stdout.trim().split('\n').join(' · ') };
        } finally {
          session.close();
        }
      } else {
        const creds = await this.postgresCredentials(c);
        const probe = await postgres.probe(creds);
        if (creds.via) await this.rememberHostKey(creds.via.connection, probe.sshHostKey);
        result = { ok: true, error: null, detail: probe.detail };
      }
    } catch (err) {
      result = { ok: false, error: (err as Error).message, detail: null };
    }
    await connectionRepository.recordTest(id, result.ok, result.error);
    return { connection: await this.get(id), result };
  },

  // ---- Prompt des agents ----------------------------------------------------------------------

  /** Description des connexions du projet pour le prompt système d'une session. */
  async promptSummary(project: Pick<Project, 'id' | 'runner'>): Promise<string> {
    const list = await connectionRepository.listByProject(project.id);
    if (list.length === 0) return '';
    const byId = new Map(list.map((c) => [c.id, c]));
    // Dans un conteneur Docker, le shell de l'agent n'a ni agent SSH ni tunnels : seuls les outils sont disponibles.
    const shellAvailable = project.runner === 'local';
    const lines = list.map((c) => {
      const viaMcp = c.exposure !== 'direct';
      const direct = c.exposure !== 'mcp' && shellAvailable;
      if (!viaMcp && !direct) return `- \`${c.name}\` : ${kindLabels[c.kind]} configurée en accès shell uniquement, indisponible dans cet environnement d'exécution.`;
      if (c.kind === 'ssh') {
        const s = c.settings as SshSettings;
        const how = [viaMcp && 'outils `ssh_run`, `ssh_upload`, `ssh_download`', direct && `dans le shell : \`ssh ${c.name}\`, \`scp fichier ${c.name}:chemin\``].filter(Boolean).join(' ; ');
        const policy = c.commandAllowlist.length ? ` ; commandes limitées aux préfixes ${c.commandAllowlist.map((p) => `\`${p}\``).join(', ')}` : '';
        return `- \`${c.name}\` : serveur SSH ${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}${c.description ? ` — ${c.description}` : ''}. Accès : ${how}${policy}.`;
      }
      const s = c.settings as PostgresSettings;
      const via = s.viaConnectionId ? byId.get(s.viaConnectionId)?.name : null;
      const how = [viaMcp && 'outils `sql_query`, `sql_schema`', direct && `dans le shell : \`psql service=${c.name}\``].filter(Boolean).join(' ; ');
      return `- \`${c.name}\` : base PostgreSQL ${s.database} sur ${s.host}${s.port !== 5432 ? `:${s.port}` : ''}${via ? ` (via le tunnel SSH \`${via}\`)` : ''}${c.description ? ` — ${c.description}` : ''}. ${c.readOnly ? 'Lecture seule.' : 'Écriture autorisée : prudence.'} Accès : ${how}.`;
    });
    return [
      "Le projet dispose de connexions vers des systèmes externes, utilisables avec les outils du serveur MCP `connections` (le serveur détient les identifiants : tu n'as pas à les connaître). Chaque appel peut être soumis à l'approbation d'un humain. Désigne une connexion par son nom.",
      ...lines,
    ].join('\n');
  },
};
