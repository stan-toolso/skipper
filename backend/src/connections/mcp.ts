import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import * as postgres from './postgres.js';
import { connectionService, kindLabels } from './service.js';
import * as ssh from './ssh.js';
import type { Connection, PostgresSettings, SshSettings, WebsiteSettings } from './types.js';
import { describeField } from './website.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export interface ConnectionsMcpContext {
  project: Project;
  sessionId: string;
  /** Dossier de travail de la session : les fichiers transférés doivent s'y trouver. */
  cwd: string;
  /** Journalise un événement de session (audit des accès). */
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
}

/** Chemin local résolu dans le workspace de la session, sans en sortir. */
function localPath(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) throw new AppError(`Le chemin local doit rester dans le dossier de travail (${cwd})`);
  return resolved;
}

function describe(c: Connection, byId: Map<string, Connection>): string {
  const flags = [c.exposure !== 'direct' && 'outils', c.exposure !== 'mcp' && 'shell', c.requireApproval ? 'approbation requise' : 'sans approbation'].filter(Boolean);
  if (c.kind === 'ssh') {
    const s = c.settings as SshSettings;
    return `- ${c.name} · ${kindLabels.ssh} · ${s.username}@${s.host}:${s.port}${c.description ? ` — ${c.description}` : ''} [${flags.join(', ')}${c.commandAllowlist.length ? `, commandes : ${c.commandAllowlist.join(' | ')}` : ''}]`;
  }
  if (c.kind === 'website') {
    const s = c.settings as WebsiteSettings;
    const access = [c.exposure !== 'direct' && 'navigateur', c.exposure !== 'mcp' && 'shell (variables d\'environnement)'].filter(Boolean);
    return `- ${c.name} · ${kindLabels.website} · ${s.url}${c.description ? ` — ${c.description}` : ''} [${access.join(', ')}] champs : ${s.fields.length ? s.fields.map((f) => describeField(c, f)).join(', ') : 'aucun'}`;
  }
  const s = c.settings as PostgresSettings;
  const via = s.viaConnectionId ? byId.get(s.viaConnectionId)?.name : null;
  return `- ${c.name} · ${kindLabels.postgres} · ${s.username}@${s.host}:${s.port}/${s.database}${via ? ` via ${via}` : ''}${c.description ? ` — ${c.description}` : ''} [${flags.join(', ')}, ${c.readOnly ? 'lecture seule' : 'écriture autorisée'}]`;
}

/**
 * Serveur MCP in-process `connections` : accès courtier aux systèmes externes du projet.
 * L'agent désigne une connexion par son nom ; le backend déchiffre les identifiants, exécute,
 * et journalise chaque usage comme événement `connection` de la session.
 */
export function createConnectionsMcpServer(ctx: ConnectionsMcpContext): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };

  /** Exécute une action en la journalisant (succès ou échec, durée). */
  const audited = async <T>(c: Connection, action: string, summary: string, fn: () => Promise<{ result: T; note?: string }>): Promise<T> => {
    const started = Date.now();
    try {
      const { result, note } = await fn();
      await ctx.emit('connection', { connection: c.name, kind: c.kind, action, summary, ok: true, note: note ?? null, durationMs: Date.now() - started });
      return result;
    } catch (err) {
      await ctx.emit('connection', { connection: c.name, kind: c.kind, action, summary, ok: false, error: (err as Error).message, durationMs: Date.now() - started });
      throw err;
    }
  };

  const sshConnection = async (name: string) => {
    const c = await connectionService.getByName(ctx.project.id, name);
    if (c.kind !== 'ssh') throw new AppError(`"${c.name}" est une connexion ${kindLabels[c.kind]}, pas un serveur SSH`);
    if (c.exposure === 'direct') throw new AppError(`"${c.name}" n'est accessible que depuis le shell (ssh ${c.name}), pas par les outils`);
    return c;
  };
  const pgConnection = async (name: string) => {
    const c = await connectionService.getByName(ctx.project.id, name);
    if (c.kind !== 'postgres') throw new AppError(`"${c.name}" est une connexion ${kindLabels[c.kind]}, pas une base PostgreSQL`);
    if (c.exposure === 'direct') throw new AppError(`"${c.name}" n'est accessible que depuis le shell (psql service=${c.name}), pas par les outils`);
    return c;
  };

  /** Ouvre une session SSH, exécute `fn`, mémorise la clé d'hôte à la première connexion. */
  const withSsh = async <T>(c: Connection, fn: (session: ssh.SshSession) => Promise<T>): Promise<T> => {
    const session = await ssh.connect(connectionService.sshCredentials(c), c.hostKey);
    try {
      await connectionService.rememberHostKey(c, session.hostKey);
      return await fn(session);
    } finally {
      session.close();
    }
  };

  const renderExec = (r: ssh.ExecResult) =>
    [
      r.stdout.trimEnd() || '(pas de sortie standard)',
      r.stderr.trim() ? `\n--- stderr ---\n${r.stderr.trimEnd()}` : '',
      `\n--- code de sortie : ${r.exitCode ?? `signal ${r.signal}`} · ${r.durationMs} ms${r.truncated ? ' · sortie tronquée' : ''} ---`,
    ].join('');

  return createSdkMcpServer({
    name: 'connections',
    version: '1.0.0',
    instructions: `Connexions du projet "${ctx.project.name}" vers des serveurs SSH, des bases PostgreSQL et des sites web. Commence par \`list\` pour connaître les noms. Les identifiants sont gérés par le serveur : ne cherche jamais à les obtenir. Pour un site web, utilise le navigateur headless : tape le nom de variable d'un secret dans le champ du formulaire, il est remplacé par la valeur. Les résultats volumineux sont tronqués : filtre côté distant (grep, LIMIT).`,
    tools: [
      tool('list', 'Liste les connexions du projet, leur type, leur cible et leur politique d\'accès.', {}, async () =>
        run(async () => {
          const list = await connectionService.listByProject(ctx.project.id);
          if (list.length === 0) return 'Aucune connexion définie pour ce projet.';
          const byId = new Map(list.map((c) => [c.id, c]));
          return list.map((c) => describe(c, byId)).join('\n');
        }),
      ),

      tool(
        'ssh_run',
        'Exécute une commande shell sur un serveur SSH du projet et renvoie sa sortie (stdout, stderr, code de sortie). Non interactif : pas de sudo avec mot de passe ni d\'éditeur.',
        {
          connection: z.string().describe('Nom de la connexion SSH'),
          command: z.string().describe('Commande shell (exécutée par le shell de connexion de l\'utilisateur distant)'),
          timeout_seconds: z.number().int().min(1).max(600).optional().describe('Délai maximal (défaut 120 s)'),
        },
        async ({ connection, command, timeout_seconds }) =>
          run(async () => {
            const c = await sshConnection(connection);
            connectionService.assertCommandAllowed(c, command);
            const result = await audited(c, 'ssh_run', command, async () => {
              const r = await withSsh(c, (s) => ssh.exec(s, command, { timeoutMs: (timeout_seconds ?? 120) * 1000 }));
              return { result: r, note: `code ${r.exitCode ?? r.signal}` };
            });
            return renderExec(result);
          }),
      ),

      tool(
        'ssh_upload',
        'Envoie un fichier du dossier de travail vers un serveur SSH (SFTP).',
        {
          connection: z.string().describe('Nom de la connexion SSH'),
          local_path: z.string().describe('Chemin local, relatif au dossier de travail'),
          remote_path: z.string().describe('Chemin de destination sur le serveur'),
        },
        async ({ connection, local_path, remote_path }) =>
          run(async () => {
            const c = await sshConnection(connection);
            const local = localPath(ctx.cwd, local_path);
            await audited(c, 'ssh_upload', `${local_path} → ${remote_path}`, async () => ({ result: await withSsh(c, (s) => ssh.upload(s, local, remote_path)) }));
            return `Fichier envoyé : ${local_path} → ${c.name}:${remote_path}`;
          }),
      ),

      tool(
        'ssh_download',
        'Récupère un fichier d\'un serveur SSH dans le dossier de travail (SFTP).',
        {
          connection: z.string().describe('Nom de la connexion SSH'),
          remote_path: z.string().describe('Chemin du fichier sur le serveur'),
          local_path: z.string().describe('Chemin local de destination, relatif au dossier de travail'),
        },
        async ({ connection, remote_path, local_path }) =>
          run(async () => {
            const c = await sshConnection(connection);
            const local = localPath(ctx.cwd, local_path);
            await audited(c, 'ssh_download', `${remote_path} → ${local_path}`, async () => ({ result: await withSsh(c, (s) => ssh.download(s, remote_path, local)) }));
            return `Fichier récupéré : ${c.name}:${remote_path} → ${local_path}`;
          }),
      ),

      tool(
        'sql_query',
        'Exécute du SQL sur une base PostgreSQL du projet et renvoie les lignes (200 au maximum : utilise LIMIT). Sur une connexion en lecture seule, toute écriture est refusée par le serveur.',
        {
          connection: z.string().describe('Nom de la connexion PostgreSQL'),
          sql: z.string().describe('Une ou plusieurs instructions SQL'),
        },
        async ({ connection, sql }) =>
          run(async () => {
            const c = await pgConnection(connection);
            const result = await audited(c, 'sql_query', sql, async () => {
              const creds = await connectionService.postgresCredentials(c);
              const r = await postgres.query(creds, sql, c.readOnly);
              if (creds.via) await connectionService.rememberHostKey(creds.via.connection, r.sshHostKey);
              return { result: r, note: r.statements.map((s) => `${s.command} ${s.rowCount ?? ''}`.trim()).join(', ') };
            });
            return postgres.renderResult(result);
          }),
      ),

      tool(
        'sql_schema',
        'Décrit le schéma d\'une base PostgreSQL : la liste des tables, ou les colonnes d\'une table.',
        {
          connection: z.string().describe('Nom de la connexion PostgreSQL'),
          table: z.string().optional().describe('Table à détailler (schema.table ou table) ; absent = liste des tables'),
        },
        async ({ connection, table }) =>
          run(async () => {
            const c = await pgConnection(connection);
            const result = await audited(c, 'sql_schema', table ?? '(tables)', async () => {
              const creds = await connectionService.postgresCredentials(c);
              const r = await postgres.query(creds, postgres.schemaSql(table ?? null), true, 2000);
              if (creds.via) await connectionService.rememberHostKey(creds.via.connection, r.sshHostKey);
              return { result: r };
            });
            return postgres.renderResult(result);
          }),
      ),
    ],
  });
}
