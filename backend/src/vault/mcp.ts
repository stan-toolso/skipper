import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { z } from 'zod';
import { browserFill } from '../browser/fill.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import * as api from './api.js';
import * as postgres from './postgres.js';
import { vaultService } from './service.js';
import * as ssh from './ssh.js';
import { kindLabels, type ApiSettings, type PostgresSettings, type SecretSettings, type SshSettings, type VaultItem, type WebsiteSettings } from './types.js';
import { describeField, siteAllows } from './website.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Demande d'approbation humaine émise par un outil du coffre (saisie dans le navigateur). */
export interface VaultApproval {
  toolName: string;
  /** Clé mémorisable : nom de l'élément, `.champ`, `@origine` pour un secret sans site. */
  key: string;
  title: string;
  message: string;
  input: Record<string, unknown>;
  /** Mémorisation « pour le projet » possible (élément du projet). */
  projectRules: boolean;
}

export interface VaultMcpContext {
  project: Project;
  sessionId: string;
  /** Propriétaire de la session : ses éléments personnels reliés au projet entrent dans la portée. */
  ownerId: string | null;
  /** Dossier de travail de la session : les fichiers transférés doivent s'y trouver. */
  cwd: string;
  /** Journalise un événement de session (audit des accès). */
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
  /** Soumet une saisie dans le navigateur à un humain ; lève si refusée. */
  approve(approval: VaultApproval): Promise<void>;
  /** Une approbation déjà mémorisée pour cette clé (session ou projet) ? */
  remembered(toolName: string, key: string, projectRules: boolean): Promise<boolean>;
}

/** Chemin local résolu dans le workspace de la session, sans en sortir. */
function localPath(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) throw new AppError(`Le chemin local doit rester dans le dossier de travail (${cwd})`);
  return resolved;
}

function describe(i: VaultItem, byId: Map<string, VaultItem>): string {
  const desc = i.description ? ` — ${i.description}` : '';
  const approval = i.requireApproval ? 'approbation requise' : 'sans approbation';
  switch (i.kind) {
    case 'ssh': {
      const s = i.settings as SshSettings;
      return `- ${i.name} · ${kindLabels.ssh} · ${s.username}@${s.host}:${s.port}${desc} [${approval}${i.commandAllowlist.length ? `, commandes : ${i.commandAllowlist.join(' | ')}` : ''}]`;
    }
    case 'postgres': {
      const s = i.settings as PostgresSettings;
      const via = s.viaItemId ? byId.get(s.viaItemId)?.name : null;
      return `- ${i.name} · ${kindLabels.postgres} · ${s.username}@${s.host}:${s.port}/${s.database}${via ? ` via ${via}` : ''}${desc} [${approval}, ${i.readOnly ? 'lecture seule' : 'écriture autorisée'}]`;
    }
    case 'api': {
      const s = i.settings as ApiSettings;
      return `- ${i.name} · ${kindLabels.api} · ${s.baseUrl}${desc} [${approval}, ${i.readOnly ? 'lecture seule (GET, HEAD, OPTIONS)' : 'toutes méthodes'}]`;
    }
    case 'website':
    case 'secret': {
      const s = i.settings as WebsiteSettings | SecretSettings;
      return `- ${i.name} · ${kindLabels[i.kind]}${'url' in s ? ` · ${s.url}` : ''}${desc} [navigateur] champs : ${s.fields.length ? s.fields.map(describeField).join(', ') : 'aucun'}`;
    }
    default:
      return `- ${i.name} · ${kindLabels[i.kind]}${desc}`;
  }
}

/**
 * Serveur MCP in-process `vault` : accès courtier aux systèmes externes de la portée de la session.
 * L'agent désigne un élément par son nom ; le serveur déchiffre les identifiants, exécute, et journalise
 * chaque usage dans le coffre et comme événement `connection` de la session. La portée est relue à
 * chaque appel : un partage ou un lien retiré prend effet aussitôt.
 */
export function createVaultMcpServer(ctx: VaultMcpContext): McpSdkServerConfigWithInstance {
  const actor = { userId: ctx.ownerId, sessionId: ctx.sessionId, projectId: ctx.project.id };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const byName = (name: string) => vaultService.agentItemByName(ctx.project.id, ctx.ownerId, name);
  const ofKind = async (name: string, kind: VaultItem['kind']) => {
    const item = await byName(name);
    if (item.kind !== kind) throw new AppError(`« ${item.name} » est un élément ${kindLabels[item.kind]}, pas ${kindLabels[kind]}`);
    return item;
  };

  /** Exécute une action en la journalisant (coffre et session), succès ou échec, avec sa durée. */
  const audited = async <T>(item: VaultItem, action: string, summary: string, fn: () => Promise<{ result: T; note?: string }>): Promise<T> => {
    const started = Date.now();
    try {
      const { result, note } = await fn();
      await ctx.emit('connection', { connection: item.name, itemId: item.id, kind: item.kind, action, summary, ok: true, note: note ?? null, durationMs: Date.now() - started });
      await vaultService.audit(item, 'used', actor, `${action} : ${summary}`);
      return result;
    } catch (err) {
      await ctx.emit('connection', { connection: item.name, itemId: item.id, kind: item.kind, action, summary, ok: false, error: (err as Error).message, durationMs: Date.now() - started });
      await vaultService.audit(item, 'used', actor, `${action} : ${summary} — ${(err as Error).message}`, false);
      throw err;
    }
  };

  const withSsh = async <T>(item: VaultItem, fn: (session: ssh.SshSession) => Promise<T>): Promise<T> => {
    const session = await ssh.connect(vaultService.sshCredentials(item), item.hostKey);
    try {
      await vaultService.rememberHostKey(item, session.hostKey);
      return await fn(session);
    } finally {
      session.close();
    }
  };

  const renderExec = (r: ssh.ExecResult) =>
    [r.stdout.trimEnd() || '(pas de sortie standard)', r.stderr.trim() ? `\n--- stderr ---\n${r.stderr.trimEnd()}` : '', `\n--- code de sortie : ${r.exitCode ?? `signal ${r.signal}`} · ${r.durationMs} ms${r.truncated ? ' · sortie tronquée' : ''} ---`].join('');

  const noTransfers = (item: VaultItem) => {
    if (item.commandAllowlist.length) throw new AppError(`Transferts de fichiers désactivés sur « ${item.name} » : ses commandes sont restreintes`, 'FORBIDDEN');
  };

  /**
   * Porte d'approbation : un élément « avec approbation » soumet chaque usage à un humain, quel que soit le
   * mode d'autorisation de la session, sauf approbation déjà mémorisée pour cet élément (session ou projet).
   */
  const gate = async (item: VaultItem, tool: string, summary: string, input: Record<string, unknown>) => {
    if (!item.requireApproval) return;
    const toolName = `mcp__vault__${tool}`;
    const projectRules = item.ownerProjectId === ctx.project.id;
    if (await ctx.remembered(toolName, item.name, projectRules)) return;
    await ctx.approve({ toolName, key: item.name, title: `Autoriser ${tool} sur « ${item.name} »`, message: summary, input: { item: item.name, ...input }, projectRules });
  };

  return createSdkMcpServer({
    name: 'vault',
    version: '1.0.0',
    instructions: `Coffre du projet "${ctx.project.name}" : serveurs SSH, bases PostgreSQL, API HTTP, sites web et secrets. Commence par \`list\` pour connaître les noms. Le serveur détient les identifiants : ne cherche jamais à les obtenir, les afficher ou les deviner. Pour un site web ou un secret, utilise le navigateur headless : clique le champ du formulaire (browser_click), puis appelle \`browser_fill\` avec l'élément et la clé du champ ; Skipper y saisit la valeur, que tu ne vois jamais. Les résultats volumineux sont tronqués : filtre côté distant (grep, LIMIT, pagination).`,
    tools: [
      tool('list', "Liste les éléments du coffre disponibles pour cette session, leur type, leur cible et leur politique d'accès.", {}, async () =>
        run(async () => {
          const items = await vaultService.agentItems(ctx.project.id, ctx.ownerId);
          if (!items.length) return 'Aucun élément du coffre pour cette session.';
          const byId = new Map(items.map((i) => [i.id, i]));
          return items.map((i) => describe(i, byId)).join('\n');
        }),
      ),

      tool(
        'ssh_run',
        "Exécute une commande shell sur un serveur SSH et renvoie sa sortie (stdout, stderr, code de sortie). Non interactif : pas de sudo avec mot de passe ni d'éditeur.",
        {
          item: z.string().describe("Nom de l'élément SSH"),
          command: z.string().describe("Commande shell (exécutée par le shell de connexion de l'utilisateur distant)"),
          timeout_seconds: z.number().int().min(1).max(600).optional().describe('Délai maximal (défaut 120 s)'),
        },
        async ({ item, command, timeout_seconds }) =>
          run(async () => {
            const i = await ofKind(item, 'ssh');
            vaultService.assertCommandAllowed(i, command);
            await gate(i, 'ssh_run', command, { command });
            const result = await audited(i, 'ssh_run', command, async () => {
              const r = await withSsh(i, (s) => ssh.exec(s, command, { timeoutMs: (timeout_seconds ?? 120) * 1000 }));
              return { result: r, note: `code ${r.exitCode ?? r.signal}` };
            });
            return renderExec(result);
          }),
      ),

      tool(
        'ssh_upload',
        'Envoie un fichier du dossier de travail vers un serveur SSH (SFTP).',
        { item: z.string().describe("Nom de l'élément SSH"), local_path: z.string().describe('Chemin local, relatif au dossier de travail'), remote_path: z.string().describe('Chemin de destination sur le serveur') },
        async ({ item, local_path, remote_path }) =>
          run(async () => {
            const i = await ofKind(item, 'ssh');
            noTransfers(i);
            const local = localPath(ctx.cwd, local_path);
            await gate(i, 'ssh_upload', `${local_path} → ${remote_path}`, { local_path, remote_path });
            await audited(i, 'ssh_upload', `${local_path} → ${remote_path}`, async () => ({ result: await withSsh(i, (s) => ssh.upload(s, local, remote_path)) }));
            return `Fichier envoyé : ${local_path} → ${i.name}:${remote_path}`;
          }),
      ),

      tool(
        'ssh_download',
        "Récupère un fichier d'un serveur SSH dans le dossier de travail (SFTP).",
        { item: z.string().describe("Nom de l'élément SSH"), remote_path: z.string().describe('Chemin du fichier sur le serveur'), local_path: z.string().describe('Chemin local de destination, relatif au dossier de travail') },
        async ({ item, remote_path, local_path }) =>
          run(async () => {
            const i = await ofKind(item, 'ssh');
            noTransfers(i);
            const local = localPath(ctx.cwd, local_path);
            await gate(i, 'ssh_download', `${remote_path} → ${local_path}`, { remote_path, local_path });
            await audited(i, 'ssh_download', `${remote_path} → ${local_path}`, async () => ({ result: await withSsh(i, (s) => ssh.download(s, remote_path, local)) }));
            return `Fichier récupéré : ${i.name}:${remote_path} → ${local_path}`;
          }),
      ),

      tool(
        'sql_query',
        'Exécute une instruction SQL (une seule par appel) sur une base PostgreSQL et renvoie les lignes (200 au maximum : utilise LIMIT). Sur un élément en lecture seule, toute écriture est refusée par le serveur.',
        { item: z.string().describe("Nom de l'élément PostgreSQL"), sql: z.string().describe('Une instruction SQL') },
        async ({ item, sql }) =>
          run(async () => {
            const i = await ofKind(item, 'postgres');
            await gate(i, 'sql_query', sql, { sql });
            const result = await audited(i, 'sql_query', sql, async () => {
              const creds = await vaultService.postgresCredentials(i);
              const r = await postgres.query(creds, sql, i.readOnly);
              if (creds.via) await vaultService.rememberHostKey(creds.via.item, r.sshHostKey);
              return { result: r, note: r.statements.map((s) => `${s.command} ${s.rowCount ?? ''}`.trim()).join(', ') };
            });
            return postgres.renderResult(result);
          }),
      ),

      tool(
        'sql_schema',
        "Décrit le schéma d'une base PostgreSQL : la liste des tables, ou les colonnes d'une table.",
        { item: z.string().describe("Nom de l'élément PostgreSQL"), table: z.string().optional().describe('Table à détailler (schema.table ou table) ; absent = liste des tables') },
        async ({ item, table }) =>
          run(async () => {
            const i = await ofKind(item, 'postgres');
            await gate(i, 'sql_schema', table ?? '(tables)', { table: table ?? null });
            const result = await audited(i, 'sql_schema', table ?? '(tables)', async () => {
              const creds = await vaultService.postgresCredentials(i);
              const r = await postgres.query(creds, postgres.schemaSql(table ?? null), true, 2000);
              if (creds.via) await vaultService.rememberHostKey(creds.via.item, r.sshHostKey);
              return { result: r };
            });
            return postgres.renderResult(result);
          }),
      ),

      tool(
        'http_request',
        "Appelle une API HTTP du coffre : chemin relatif à l'adresse de base, authentification ajoutée par le serveur, redirections non suivies, réponse tronquée au-delà de 2 Mo.",
        {
          item: z.string().describe("Nom de l'élément API"),
          method: z.enum(api.API_METHODS).optional().describe('Défaut : GET'),
          path: z.string().describe("Chemin relatif à l'adresse de base (ex. v1/customers?limit=10)"),
          query: z.record(z.string(), z.string()).optional().describe('Paramètres de requête supplémentaires'),
          headers: z.record(z.string(), z.string()).optional().describe("En-têtes (jamais d'authentification : elle est ajoutée par le serveur)"),
          body: z.string().optional().describe('Corps (JSON par défaut), 1 Mo au plus'),
        },
        async ({ item, method, path: p, query, headers, body }) =>
          run(async () => {
            const i = await ofKind(item, 'api');
            const creds = vaultService.apiCredentials(i);
            api.validateCall(creds, i.readOnly, { method, path: p, query, headers, body });
            api.resolveTarget(creds.baseUrl, p, query);
            await gate(i, 'http_request', `${method ?? 'GET'} ${p}`, { method: method ?? 'GET', path: p, query: query ?? null });
            const result = await audited(i, 'http_request', `${method ?? 'GET'} ${p}`, async () => {
              const r = await api.execute(creds, i.readOnly, { method, path: p, query, headers, body });
              return { result: r, note: `HTTP ${r.status}` };
            });
            return result.text;
          }),
      ),


      tool(
        'browser_fill',
        "Saisit la valeur d'un champ d'un site web ou d'un secret dans le champ qui a le focus dans le navigateur headless (clique-le d'abord avec browser_click). Le serveur vérifie que la page est bien celle du site, et qu'un secret va dans un champ mot de passe ; tu ne vois jamais la valeur.",
        { item: z.string().describe("Nom de l'élément (site web ou secret)"), field: z.string().describe('Clé du champ (ex. password)') },
        async ({ item, field }) =>
          run(async () => {
            const i = await byName(item);
            if (i.kind !== 'website' && i.kind !== 'secret') throw new AppError(`« ${i.name} » est un élément ${kindLabels[i.kind]} : seuls les sites web et les secrets se saisissent dans le navigateur`);
            const creds = vaultService.fieldCredentials(i);
            const f = creds.fields.find((x) => x.key === field.trim().toLowerCase());
            if (!f) throw new AppError(`« ${i.name} » n'a pas de champ « ${field} » (champs : ${creds.fields.map((x) => x.key).join(', ')})`);
            const target = await browserFill.focus(ctx.sessionId);
            if (creds.url && !siteAllows(creds.url, target.origin)) throw new AppError(`Saisie refusée : la page ${target.origin} n'est pas le site de « ${i.name} » (${vaultService.hostOf(creds.url)})`, 'FORBIDDEN');
            if (f.secret && target.type !== 'password') throw new AppError(`Saisie refusée : un secret ne se tape que dans un champ mot de passe (le champ actif « ${target.field} » est de type ${target.type} : sa valeur serait lisible dans la page)`, 'FORBIDDEN');
            if (f.secret && (!creds.url || i.requireApproval)) {
              const key = creds.url ? `${i.name}.${f.key}` : `${i.name}.${f.key}@${target.origin}`;
              const projectRules = i.ownerProjectId === ctx.project.id;
              if (!(await ctx.remembered('mcp__vault__browser_fill', key, projectRules))) {
                await ctx.approve({
                  toolName: 'mcp__vault__browser_fill',
                  key,
                  title: `Saisir « ${f.label} » de « ${i.name} » sur ${target.origin}`,
                  message: `Champ « ${target.field} » de la page ${target.url}. La valeur n'est pas montrée à l'agent.`,
                  input: { item: i.name, field: f.key, page: target.url, target: target.field },
                  projectRules,
                });
              }
            }
            await audited(i, 'browser_fill', `${f.key} → ${target.url} (${target.field})`, async () => ({ result: await browserFill.fill(ctx.sessionId, target.targetId, target.origin, f.value) }));
            return `Champ « ${f.label} » de « ${i.name} » saisi dans « ${target.field} » sur ${target.url}. La valeur ne t'est pas communiquée.`;
          }),
      ),
    ],
  });
}
