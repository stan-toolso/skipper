import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { envFileService } from '../envFiles/service.js';
import { runner } from '../runners/index.js';
import type { IsolatedResult } from '../runners/types.js';
import { quoteDotenv } from '../envFiles/template.js';
import { z } from 'zod';
import { browserFill } from '../browser/fill.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import * as api from './api.js';
import { awsService } from './awsService.js';
import * as postgres from './postgres.js';
import { scalewayService } from './scalewayService.js';
import { vaultService } from './service.js';
import * as ssh from './ssh.js';
import { kindLabels, type ApiSettings, type AwsSettings, type PostgresSettings, type ScalewaySettings, type SecretSettings, type SshSettings, type VaultItem, type WebsiteSettings } from './types.js';
import { describeField, siteAllows } from './website.js';
import { RequestCancelledError } from '../requests/service.js';
import type { CreateRequestInput } from '../requests/types.js';
import { sessionSecretService } from './sessionSecrets.js';
import { buildAgentEdit, secretRefsOf } from './agentEdit.js';
import { versionRepository } from './versions.js';
import { normalizeRequestedFields, parseSecretRef, prepareSecretsRequest, redactSecret, SECRETS_REQUEST, type SecretsResponse } from './secretRequests.js';

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
  /** Pose une demande à un humain et attend sa réponse (saisie de secrets) ; absent : `request_secrets` indisponible. */
  ask?(input: CreateRequestInput): Promise<Record<string, unknown>>;
}

/** Secret résolu pour un usage par le serveur (voir `secretOf`). */
interface ResolvedSecret {
  ref: string;
  value: string;
  /** La valeur peut-elle aboutir dans l'environnement de la session (fichier .env) ? Élément du coffre : option envExport. */
  envExport: boolean;
  check(tool: string, summary: string, input: Record<string, unknown>, always?: boolean): Promise<void>;
  use<T>(action: string, summary: string, fn: () => Promise<T>): Promise<T>;
}

/** Chemin local résolu dans le workspace de la session, sans en sortir. */
function localPath(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) throw new AppError(`Le chemin local doit rester dans le dossier de travail (${cwd})`);
  return resolved;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables que run_with_secrets ne laisse pas remplacer (conteneur, shell). */
const RESERVED_ENV = new Set(['HOME', 'PATH', 'SHELL', 'USER', 'PWD', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);

/**
 * Ajoute ou remplace `NAME=valeur` (citée si besoin) dans un fichier dotenv du dossier de travail (droits 600), et
 * l'exclut de git s'il ne l'est pas déjà (`info/exclude` du dépôt). Renvoie vrai si le fichier est exclu de git.
 */
export async function writeEnvLine(cwd: string, rel: string, name: string, value: string): Promise<boolean> {
  const file = path.join(cwd, rel);
  await mkdir(path.dirname(file), { recursive: true });
  const before = await readFile(file, 'utf8').catch(() => '');
  const line = `${name}=${quoteDotenv(value)}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, 'm');
  const next = re.test(before) ? before.replace(re, () => line) : `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`;
  await writeFile(file, next, { mode: 0o600 });
  await chmod(file, 0o600);
  return excludeFromGit(cwd, rel);
}

async function excludeFromGit(cwd: string, rel: string): Promise<boolean> {
  const git = (args: string[]) => promisify(execFile)('git', ['-C', cwd, ...args]);
  try {
    await git(['rev-parse', '--git-dir']);
  } catch {
    return false; // pas un dépôt git : rien à exclure
  }
  if (await git(['check-ignore', '-q', '--', rel]).then(() => true, () => false)) return true;
  const exclude = path.resolve(cwd, (await git(['rev-parse', '--git-path', 'info/exclude'])).stdout.trim());
  await mkdir(path.dirname(exclude), { recursive: true });
  const current = await readFile(exclude, 'utf8').catch(() => '');
  const entry = `/${rel.split(path.sep).join('/')}`;
  if (!current.split('\n').includes(entry)) await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
  return true;
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
      const scope = s.database ? `/${s.database}` : ` (serveur entier : toutes les bases, paramètre database, ${postgres.MAINTENANCE_DATABASE} par défaut)`;
      return `- ${i.name} · ${kindLabels.postgres} · ${s.username}@${s.host}:${s.port}${scope}${via ? ` via ${via}` : ''}${desc} [${approval}, ${i.readOnly ? 'lecture seule' : 'écriture autorisée'}]`;
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
    case 'aws': {
      const s = i.settings as AwsSettings;
      const who = s.auth === 'sso' ? `compte ${s.accountName ?? s.accountId ?? '?'} · rôle ${s.roleName ?? '?'}` : `clé ${s.accessKeyId ?? '?'}${s.roleArn ? ` · rôle ${s.roleArn}` : ''}`;
      return `- ${i.name} · ${kindLabels.aws} · ${who} · région ${s.region}${desc} [${approval}, ${i.readOnly ? 'lecture seule (describe, get, list…)' : 'écriture autorisée'}${i.commandAllowlist.length ? `, commandes : ${i.commandAllowlist.join(' | ')}` : ''}]`;
    }
    case 'scaleway': {
      const s = i.settings as ScalewaySettings;
      return `- ${i.name} · ${kindLabels.scaleway} · ${s.identity ?? `clé ${s.accessKey}`}${s.projectId ? ` · projet ${s.projectId}` : ''} · ${s.region} / ${s.zone}${desc} [${approval}, ${i.readOnly ? 'lecture seule (list, get ; GET)' : 'écriture autorisée'}${i.commandAllowlist.length ? `, commandes : ${i.commandAllowlist.join(' | ')}` : ''}]`;
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

  /**
   * Secret désigné par « élément.champ » (coffre : secret ou site web) ou « session:nom.champ » (secret saisi pour cette
   * session seulement, vault/sessionSecrets.ts), pour un usage par le serveur seul. `check` passe par la porte
   * d'approbation (ou l'impose avec `always`), `use` journalise l'usage (coffre et session).
   */
  const secretOf = async (ref: string): Promise<ResolvedSecret> => {
    const r = parseSecretRef(ref);
    if (r.session) {
      const secret = await sessionSecretService.find(ctx.sessionId, r.item);
      if (!secret) {
        const names = (await sessionSecretService.list(ctx.sessionId)).map((x) => x.name);
        throw new AppError(`Pas de secret de session « ${r.item} »${names.length ? ` (disponibles : ${names.join(', ')})` : ''} : demande-le avec request_secrets (il expire 24 h après sa saisie)`);
      }
      const field = secret.fields.find((f) => f.key === r.field);
      if (!field) throw new AppError(`Le secret de session « ${secret.name} » n'a pas de champ « ${r.field} » (champs : ${secret.fields.map((f) => f.key).join(', ')})`);
      const value = (await sessionSecretService.values(ctx.sessionId, secret.name))[field.key];
      if (!value) throw new AppError(`Le champ « ${r.field} » du secret de session « ${secret.name} » est vide`);
      const key = `session:${secret.name}`;
      const refText = `${key}.${field.key}`;
      return {
        ref: refText,
        value,
        envExport: true,
        check: async (tool, summary, input, always = false) => {
          if (!secret.requireApproval && !always) return;
          const toolName = `mcp__vault__${tool}`;
          if (await ctx.remembered(toolName, key, false)) return;
          await ctx.approve({ toolName, key, title: `Autoriser ${tool} avec le secret de session « ${secret.name} »`, message: summary, input: { item: key, secret: refText, ...input }, projectRules: false });
        },
        use: async (action, summary, fn) => {
          const started = Date.now();
          try {
            const result = await fn();
            await ctx.emit('connection', { connection: key, kind: 'session_secret', action, summary, ok: true, durationMs: Date.now() - started });
            return result;
          } catch (err) {
            await ctx.emit('connection', { connection: key, kind: 'session_secret', action, summary, ok: false, error: (err as Error).message, durationMs: Date.now() - started });
            throw err;
          }
        },
      };
    }
    const item = await byName(r.item);
    if (item.kind !== 'secret' && item.kind !== 'website') throw new AppError(`« ${item.name} » est un élément ${kindLabels[item.kind]} : seuls les secrets et les sites web ont des champs`);
    const field = vaultService.fieldCredentials(item).fields.find((f) => f.key === r.field);
    if (!field) throw new AppError(`« ${item.name} » n'a pas de champ « ${r.field} » (champs : ${(item.settings as SecretSettings).fields.map((f) => f.key).join(', ')})`);
    if (!field.value) throw new AppError(`Le champ « ${r.field} » de « ${item.name} » est vide`);
    const refText = `${item.name}.${field.key}`;
    return {
      ref: refText,
      value: field.value,
      envExport: item.envExport,
      check: async (tool, summary, input, always = false) => {
        if (!always) return gate(item, tool, summary, input);
        const toolName = `mcp__vault__${tool}`;
        const projectRules = item.ownerProjectId === ctx.project.id;
        if (await ctx.remembered(toolName, item.name, projectRules)) return;
        await ctx.approve({ toolName, key: item.name, title: `Autoriser ${tool} avec « ${item.name} »`, message: summary, input: { item: item.name, secret: refText, ...input }, projectRules });
      },
      use: async (action, summary, fn) => audited(item, action, summary, async () => ({ result: await fn() })),
    };
  };

  return createSdkMcpServer({
    name: 'vault',
    version: '1.0.0',
    instructions: `Coffre du projet "${ctx.project.name}" : serveurs SSH, bases PostgreSQL, API HTTP, comptes AWS (CLI aws), comptes Scaleway (CLI scw et API), sites web et secrets. Commence par \`list\` pour connaître les noms. Le serveur détient les identifiants : ne cherche jamais à les obtenir, les afficher ou les deviner. Un élément PostgreSQL rattaché à un serveur entier accepte le paramètre \`database\` (sql_schema sans base liste les bases). Pour un site web ou un secret, utilise le navigateur headless : clique le champ du formulaire (browser_click), puis appelle \`browser_fill\` avec l'élément et la clé du champ ; Skipper y saisit la valeur, que tu ne vois jamais. Un secret s'installe aussi sur un serveur SSH sans que tu le voies : \`ssh_write_secret\` (fichier) ou \`stdin_secret\` de \`ssh_run\` (entrée d'une commande). Pour un script ou une commande locale : \`run_with_secrets\` (variables d'environnement, conteneur jetable) ou, en dernier recours, \`write_env_secret\` (fichier .env du dossier de travail, avec accord). Besoin d'un secret que la personne détient (clé, jeton) : \`request_secrets\` lui ouvre une modale ; elle le range dans le coffre ou le confie à cette session seulement (référence \`session:nom.champ\`, effacé à l'archivage ou sous 24 h ; \`ephemeral: true\` pour un usage ponctuel) ; ne lui demande jamais de le coller dans la conversation. \`update_item\` modifie un élément (description, cible, champs ; secrets par référence seulement), avec l'accord de la personne, en gardant la version précédente. Les résultats volumineux sont tronqués : filtre côté distant (grep, LIMIT, pagination).`,
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
          stdin_secret: z
            .string()
            .optional()
            .describe("Secret à passer sur l'entrée standard de la commande, sous la forme élément.champ (coffre, ex. cle-api.token) ou session:nom.champ (secret saisi pour cette session) : le serveur l'y écrit sans te le montrer (ex. « docker login -u x --password-stdin », « sudo tee /etc/app/key >/dev/null »). Toute occurrence de la valeur dans la sortie est masquée."),
        },
        async ({ item, command, timeout_seconds, stdin_secret }) =>
          run(async () => {
            const i = await ofKind(item, 'ssh');
            vaultService.assertCommandAllowed(i, command);
            const secret = stdin_secret ? await secretOf(stdin_secret) : null;
            const summary = secret ? `${command} < ${secret.ref}` : command;
            if (secret) await secret.check('ssh_run', `${secret.ref} → ${i.name} : ${command}`, { target: i.name, command });
            await gate(i, 'ssh_run', summary, { command, ...(secret ? { stdin_secret: secret.ref } : {}) });
            const exec = async () =>
              audited(i, 'ssh_run', summary, async () => {
                const r = await withSsh(i, (s) => ssh.exec(s, command, { timeoutMs: (timeout_seconds ?? 120) * 1000, ...(secret ? { stdin: secret.value } : {}) }));
                return { result: r, note: `code ${r.exitCode ?? r.signal}` };
              });
            const result = secret ? await secret.use('ssh_run', `${secret.ref} → ${i.name} (entrée standard)`, exec) : await exec();
            const shown = secret ? { ...result, stdout: redactSecret(result.stdout, secret.value), stderr: redactSecret(result.stderr, secret.value) } : result;
            return renderExec(shown);
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
        'ssh_write_secret',
        "Écrit la valeur d'un secret du coffre dans un fichier d'un serveur SSH (créé ou remplacé, droits 600 par défaut), sans que tu voies la valeur : clé privée, jeton, fichier de configuration… Tes scripts sur le serveur lisent ensuite ce fichier. Le dossier doit exister.",
        {
          item: z.string().describe("Nom de l'élément SSH (serveur de destination)"),
          secret: z.string().describe('Secret à écrire : élément.champ (coffre, ex. cle-deploiement.private_key) ou session:nom.champ (secret saisi pour cette session)'),
          remote_path: z.string().describe('Chemin du fichier sur le serveur (ex. /home/ubuntu/.ssh/id_ed25519)'),
          mode: z.string().optional().describe('Droits octaux du fichier (défaut 600)'),
          newline: z.boolean().optional().describe('Ajouter un saut de ligne final si la valeur n\'en a pas (défaut : oui pour une valeur sur plusieurs lignes, non sinon)'),
        },
        async ({ item, secret: ref, remote_path, mode, newline }) =>
          run(async () => {
            const i = await ofKind(item, 'ssh');
            noTransfers(i);
            const m = (mode ?? '600').trim();
            if (!/^[0-7]{3,4}$/.test(m)) throw new AppError(`Droits invalides : « ${mode} » (ex. 600, 640)`);
            const secret = await secretOf(ref);
            const multiline = secret.value.includes('\n');
            const content = (newline ?? multiline) && !secret.value.endsWith('\n') ? `${secret.value}\n` : secret.value;
            const summary = `${secret.ref} → ${remote_path} (${m})`;
            await secret.check('ssh_write_secret', `${secret.ref} → ${i.name}:${remote_path}`, { target: i.name, remote_path, mode: m });
            await gate(i, 'ssh_write_secret', summary, { secret: secret.ref, remote_path, mode: m });
            await secret.use('ssh_write_secret', `${secret.ref} → ${i.name}:${remote_path}`, () =>
              audited(i, 'ssh_write_secret', summary, async () => ({ result: await withSsh(i, (s) => ssh.writeFile(s, remote_path, content, parseInt(m, 8))) })),
            );
            return `Secret « ${secret.ref} » écrit dans ${i.name}:${remote_path} (droits ${m}, ${Buffer.byteLength(content)} octets). La valeur ne t'est pas communiquée.`;
          }),
      ),

      tool(
        'run_with_secrets',
        "Exécute une commande shell avec des secrets en variables d'environnement, sans que tu voies leur valeur : script de déploiement, appel d'API, CLI qui lit un jeton dans l'environnement. Elle tourne dans un conteneur jetable de l'image du projet où seul ton dossier de travail est monté (dossier courant) : ni les processus ni les services du conteneur du projet, rien n'y reste après. Toute occurrence d'une valeur dans la sortie est masquée. N'écris pas les valeurs dans un fichier ni dans la sortie.",
        {
          command: z.string().describe('Commande shell (sh -c), ex. « ./scripts/deploy.sh » ou « curl -fsS -H \"Authorization: Bearer $API_TOKEN\" https://… »'),
          // Pas de z.record : le convertisseur du SDK le refuse et tout le serveur disparaît (voir mcp.test.ts).
          env: z.object({}).catchall(z.string()).describe('Variables → secret : { "API_TOKEN": "session:cle.token", "DB_PASSWORD": "prod-db.password" }'),
          timeout_seconds: z.number().int().min(1).max(600).optional().describe('Délai maximal (défaut 120 s)'),
        },
        async ({ command, env, timeout_seconds }) =>
          run(async () => {
            const entries = Object.entries(env ?? {});
            if (!entries.length) throw new AppError('Indique au moins une variable (env : { NOM: "élément.champ" })');
            if (entries.length > 20) throw new AppError('Au plus 20 variables');
            const secrets: Array<[string, ResolvedSecret]> = [];
            for (const [name, ref] of entries) {
              if (!ENV_NAME_RE.test(name) || RESERVED_ENV.has(name)) throw new AppError(`Nom de variable refusé : « ${name} » (majuscules, chiffres et soulignés ; ni ${[...RESERVED_ENV].join(', ')})`);
              secrets.push([name, await secretOf(ref)]);
            }
            const vars = secrets.map(([n, x]) => `${n}=${x.ref}`).join(', ');
            for (const [, x] of secrets) await x.check('run_with_secrets', `${command}\n(${vars})`, { command, env: vars });
            const exec = () => runner.runIsolated(ctx.project, { cwd: ctx.cwd, command: ['sh', '-c', command], env: Object.fromEntries(secrets.map(([n, x]) => [n, x.value])), timeoutMs: (timeout_seconds ?? 120) * 1000 });
            // Chaque secret journalise son usage ; la commande ne tourne qu'une fois.
            let pending: Promise<IsolatedResult> | null = null;
            const once = () => (pending ??= exec());
            let result: IsolatedResult | null = null;
            for (const [, x] of secrets) result = await x.use('run_with_secrets', `${command} (${vars})`, once);
            const mask = (t: string) => secrets.reduce((acc, [, x]) => redactSecret(acc, x.value), t);
            return renderExec({ ...result!, stdout: mask(result!.stdout), stderr: mask(result!.stderr) });
          }),
      ),

      tool(
        'write_env_secret',
        "Écrit un secret dans un fichier d'environnement (dotenv) de ton dossier de travail : ajoute ou remplace la ligne NOM=valeur, crée le fichier au besoin (droits 600) et l'exclut de git. La valeur arrive alors dans l'environnement de la session (tes scripts la lisent) : demande toujours l'accord de la personne. Préfère run_with_secrets quand une commande suffit. Ne lis pas ce fichier, ne l'affiche pas, ne le commite pas.",
        {
          path: z.string().describe('Fichier, relatif au dossier de travail (ex. .env, backend/.env.local)'),
          name: z.string().describe('Nom de la variable (ex. BREVO_API_KEY)'),
          secret: z.string().describe('Secret : session:nom.champ (saisi pour cette session) ou élément.champ (élément du coffre ouvert aux fichiers d\'environnement)'),
        },
        async ({ path: p, name, secret: ref }) =>
          run(async () => {
            if (!ENV_NAME_RE.test(name)) throw new AppError(`Nom de variable invalide : « ${name} » (majuscules, chiffres et soulignés)`);
            const file = localPath(ctx.cwd, p);
            const rel = path.relative(ctx.cwd, file);
            if (!rel || rel.split(path.sep).includes('.git')) throw new AppError(`Fichier refusé : ${p}`);
            const secret = await secretOf(ref);
            if (!secret.envExport) throw new AppError(`« ${secret.ref} » n'est pas ouvert aux fichiers d'environnement (option de l'élément dans le coffre) : utilise run_with_secrets, ou demande un secret de session avec request_secrets`, 'FORBIDDEN');
            const managed = (await envFileService.list(ctx.project.id)).some((f) => path.normalize(f.path) === path.normalize(rel));
            if (managed) throw new AppError(`${rel} est un fichier d'environnement du projet (serveur env), réécrit par Skipper : choisis un autre fichier (ex. ${rel}.local)`);
            await secret.check('write_env_secret', `${name}=${secret.ref} → ${rel} (la valeur sera lisible dans l'environnement de la session)`, { path: rel, name }, true);
            const excluded = await secret.use('write_env_secret', `${name} → ${rel}`, () => writeEnvLine(ctx.cwd, rel, name, secret.value));
            return `Variable ${name} écrite dans ${rel} (droits 600${excluded ? ', fichier exclu de git' : ''}). La valeur ne t'est pas communiquée : ne lis pas ce fichier.`;
          }),
      ),

      tool(
        'update_item',
        "Modifie un élément du coffre de ta portée : description, cible (hôte, port, utilisateur, base, adresse) ou champs d'un secret ou d'un site web. Toujours soumis à l'accord de la personne, qui voit le détail ; il faut que la session ait la permission « gérer » sur l'élément. Chaque modification est historisée (version restaurable depuis la page Coffre). Une valeur secrète ne se donne jamais en clair : passe une référence à un secret que tu ne vois pas (value_from, password_from, token_from : élément.champ ou session:nom.champ, obtenu par request_secrets). La politique d'accès (nom, lecture seule, accord à chaque usage, commandes autorisées, fichiers d'environnement, tunnel) ne se change pas par cet outil : demande-le à une personne.",
        {
          item: z.string().describe("Nom de l'élément"),
          description: z.string().optional().describe('Nouvelle description'),
          host: z.string().optional().describe('ssh, postgres : hôte'),
          port: z.number().int().optional().describe('ssh, postgres : port'),
          username: z.string().optional().describe('ssh, postgres, api (Basic) : utilisateur'),
          database: z.string().optional().describe('postgres : base rattachée ; chaîne vide = le serveur entier'),
          url: z.string().optional().describe("api : adresse de base ; website : adresse du site"),
          fields: z
            .array(
              z.object({
                key: z.string().describe('Clé du champ (existant : modifié ; nouveau : ajouté)'),
                label: z.string().optional(),
                value: z.string().optional().describe("Valeur d'un champ public (jamais d'un champ secret)"),
                value_from: z.string().optional().describe('Champ secret : référence du secret qui en devient la valeur (élément.champ ou session:nom.champ)'),
                secret: z.boolean().optional().describe('Le champ est secret (défaut : inchangé ; vrai avec value_from)'),
              }),
            )
            .optional()
            .describe('website, secret : champs à modifier ou ajouter (les autres restent tels quels)'),
          remove_fields: z.array(z.string()).optional().describe('website, secret : clés des champs à retirer'),
          password_from: z.string().optional().describe('postgres : référence du secret qui devient le mot de passe'),
          token_from: z.string().optional().describe("api : référence du secret qui devient le jeton (ou le mot de passe en Basic)"),
        },
        async ({ item, ...params }) =>
          run(async () => {
            if (!ctx.ownerId) throw new AppError("Cette session ne tourne au nom de personne : elle ne peut pas modifier le coffre");
            const i = await byName(item);
            if (!vaultService.isVersioned(i)) throw new AppError(`« ${i.name} » est un compte relié par une connexion : il se reconnecte depuis la page Coffre`);
            if (i.kind === 'aws' || i.kind === 'scaleway') {
              const extra = Object.entries(params).filter(([k, v]) => v !== undefined && k !== 'description');
              if (extra.length) throw new AppError(`Pour un compte ${kindLabels[i.kind]}, seule la description se modifie par cet outil : le reste se règle depuis la page Coffre`);
            }
            const permission = await vaultService.permissionFor(ctx.ownerId, i);
            if (permission !== 'manage') throw new AppError(`Modifier « ${i.name} » demande la permission « gérer » ; cette session ne l'a pas (${permission ?? 'aucune'}). Demande à une personne qui gère l'élément.`);
            const secrets = new Map<string, Awaited<ReturnType<typeof secretOf>>>();
            for (const ref of secretRefsOf(params)) secrets.set(ref, await secretOf(ref));
            const edit = buildAgentEdit(i, params, (ref) => secrets.get(ref)!.value);
            const warning = edit.retargets && vaultService.hasSecret(i) ? `\n\n⚠ La cible change : les identifiants de « ${i.name} » seront désormais envoyés à la nouvelle adresse.` : '';
            const summary = edit.summary.join(' ; ');
            await ctx.approve({
              toolName: 'mcp__vault__update_item',
              key: `update:${i.name}`,
              title: `Autoriser la modification de « ${i.name} » dans le coffre`,
              message: `${edit.summary.map((l) => `• ${l}`).join('\n')}${warning}`,
              input: { item: i.name, ...params },
              projectRules: false,
            });
            const started = Date.now();
            try {
              await vaultService.update({ userId: ctx.ownerId, sessionId: ctx.sessionId, projectId: ctx.project.id }, i.id, edit.input);
            } catch (err) {
              await ctx.emit('connection', { connection: i.name, itemId: i.id, kind: i.kind, action: 'update_item', summary, ok: false, error: (err as Error).message, durationMs: Date.now() - started });
              throw err;
            }
            for (const [ref, secret] of secrets) await secret.use('update_item', `${ref} → ${i.name}`, async () => undefined);
            await ctx.emit('connection', { connection: i.name, itemId: i.id, kind: i.kind, action: 'update_item', summary, ok: true, durationMs: Date.now() - started });
            const version = await versionRepository.latest(i.id);
            return [`« ${i.name} » modifié${version ? ` (version ${version.version})` : ''} :`, ...edit.summary.map((l) => `- ${l}`), 'La version précédente reste restaurable depuis la page Coffre (onglet Historique de l\'élément).'].join('\n');
          }),
      ),

      ...(ctx.ask
        ? [
            tool(
              'request_secrets',
              "Demande à la personne qui suit la session de saisir un ou plusieurs secrets (clé privée, jeton, mot de passe…) dans une modale de Skipper. Les valeurs sont rangées dans un élément « secret » du coffre (créé, ou mis à jour s'il existe déjà dans ta portée) sans jamais t'être montrées ; la personne choisit le coffre (projet ou personnel). Attend sa réponse. Ensuite, sers-t'en sans les voir : ssh_write_secret (fichier sur un serveur), stdin_secret de ssh_run (entrée d'une commande), browser_fill (formulaire). N'écris jamais de secret en clair dans un message, un fichier ou une commande.",
              {
                item: z.string().describe("Nom de l'élément du coffre à créer ou mettre à jour (minuscules, chiffres, tirets ; ex. cle-deploiement)"),
                reason: z.string().describe('Pourquoi tu en as besoin et ce que tu vas en faire (montré à la personne)'),
                fields: z
                  .array(
                    z.object({
                      key: z.string().describe('Clé du champ (minuscules, chiffres, soulignés ; ex. private_key, token)'),
                      label: z.string().optional().describe('Libellé montré à la personne'),
                      hint: z.string().optional().describe('Aide : format attendu, où trouver la valeur'),
                      multiline: z.boolean().optional().describe('Saisie sur plusieurs lignes (clé privée, certificat)'),
                    }),
                  )
                  .describe('Champs à saisir (10 au plus)'),
                description: z.string().optional().describe("Description de l'élément créé"),
                ephemeral: z
                  .boolean()
                  .optional()
                  .describe("Tu n'en as besoin que pendant cette session (usage ponctuel) : la modale propose d'abord de ne pas le garder dans le coffre. La personne choisit."),
              },
              async ({ item, reason, fields, description, ephemeral }) =>
                run(async () => {
                  const normalized = normalizeRequestedFields(fields);
                  const payload = await prepareSecretsRequest({ projectId: ctx.project.id, rightsHolderId: ctx.ownerId, item, description, fields: normalized, ephemeral });
                  const title = `${payload.itemId ? 'Mettre à jour' : 'Saisir'} le secret « ${payload.item} » (${normalized.map((f) => f.label).join(', ')})`;
                  let response: Partial<SecretsResponse>;
                  try {
                    response = (await ctx.ask!({ type: SECRETS_REQUEST, title, message: reason.trim() || null, payload: payload as unknown as Record<string, unknown> })) as Partial<SecretsResponse>;
                  } catch (err) {
                    if (err instanceof RequestCancelledError) throw new AppError("La personne n'a pas fourni les secrets (demande ignorée ou session arrêtée)");
                    throw err;
                  }
                  const session = response.destination === 'session';
                  const prefix = session ? 'session:' : '';
                  const where = session
                    ? `secret de cette session seulement, pas dans le coffre ; effacé à l'archivage de la session ou ${response.expiresAt ? `le ${new Date(response.expiresAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : 'sous 24 h'}`
                    : response.destination === 'project'
                      ? 'coffre du projet'
                      : response.destination === 'personal'
                        ? 'coffre personnel de la personne, ouvert à ses sessions de ce projet'
                        : 'élément existant mis à jour';
                  return [
                    `Secrets enregistrés (${where}) : ${(response.fields ?? []).map((f) => `\`${prefix}${response.item}.${f}\``).join(', ')}. Tu n'en vois pas la valeur.`,
                    response.requireApproval ? 'Chaque usage sera soumis à l\'accord de la personne.' : '',
                    `Pour les utiliser (référence ${prefix}${response.item}.<champ>) : ssh_write_secret (fichier sur un serveur SSH), ssh_run avec stdin_secret (entrée standard d'une commande), run_with_secrets (variables d'environnement d'une commande), write_env_secret (fichier .env du dossier de travail, avec accord)${session ? '' : ', browser_fill (champ mot de passe)'}.`,
                  ]
                    .filter(Boolean)
                    .join('\n');
                }),
            ),
          ]
        : []),

      tool(
        'sql_query',
        'Exécute une instruction SQL (une seule par appel) sur une base PostgreSQL et renvoie les lignes (200 au maximum : utilise LIMIT). Sur un élément en lecture seule, toute écriture est refusée par le serveur.',
        {
          item: z.string().describe("Nom de l'élément PostgreSQL"),
          sql: z.string().describe('Une instruction SQL'),
          database: z.string().optional().describe(`Base à interroger, pour un élément rattaché à un serveur entier (défaut : ${postgres.MAINTENANCE_DATABASE}) ; inutile pour un élément rattaché à une base`),
        },
        async ({ item, sql, database }) =>
          run(async () => {
            const i = await ofKind(item, 'postgres');
            const summary = database ? `[${database}] ${sql}` : sql;
            await gate(i, 'sql_query', summary, { sql, database: database ?? null });
            const result = await audited(i, 'sql_query', summary, async () => {
              const creds = await vaultService.postgresCredentials(i, database);
              const r = await postgres.query(creds, sql, i.readOnly);
              if (creds.via) await vaultService.rememberHostKey(creds.via.item, r.sshHostKey);
              return { result: r, note: r.statements.map((s) => `${s.command} ${s.rowCount ?? ''}`.trim()).join(', ') };
            });
            return postgres.renderResult(result);
          }),
      ),

      tool(
        'sql_schema',
        "Décrit le schéma d'une base PostgreSQL : la liste des tables, ou les colonnes d'une table. Sur un élément rattaché à un serveur entier, sans paramètre database : la liste des bases du serveur.",
        {
          item: z.string().describe("Nom de l'élément PostgreSQL"),
          table: z.string().optional().describe('Table à détailler (schema.table ou table) ; absent = liste des tables'),
          database: z.string().optional().describe('Base à décrire, pour un élément rattaché à un serveur entier ; absent = liste des bases'),
        },
        async ({ item, table, database }) =>
          run(async () => {
            const i = await ofKind(item, 'postgres');
            const listDatabases = !database && !(i.settings as PostgresSettings).database;
            const summary = listDatabases ? '(bases)' : `${database ? `[${database}] ` : ''}${table ?? '(tables)'}`;
            await gate(i, 'sql_schema', summary, { table: table ?? null, database: database ?? null });
            const result = await audited(i, 'sql_schema', summary, async () => {
              const creds = await vaultService.postgresCredentials(i, database);
              const r = await postgres.query(creds, listDatabases ? postgres.databasesSql() : postgres.schemaSql(table ?? null), true, 2000);
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
          // Pas de z.record : le convertisseur du SDK le refuse et tout le serveur disparaît (voir mcp.test.ts).
          query: z.object({}).catchall(z.string()).optional().describe('Paramètres de requête supplémentaires'),
          headers: z.object({}).catchall(z.string()).optional().describe("En-têtes (jamais d'authentification : elle est ajoutée par le serveur)"),
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
        'aws_run',
        "Exécute une commande du CLI AWS avec un compte AWS du coffre et renvoie sa sortie (stdout, stderr, code de sortie). Donne la commande sans « aws » (ex. « s3 ls s3://mon-bucket », « ec2 describe-instances --output table »). Le serveur l'exécute hors de ton environnement, avec les fichiers de ton dossier de travail (chemins relatifs) ; les identifiants ne te sont jamais communiqués. Sur un compte en lecture seule, seules les opérations de consultation (describe-*, get-*, list-*, s3 ls…) sont acceptées.",
        {
          item: z.string().describe("Nom de l'élément AWS"),
          command: z.string().describe('Commande du CLI sans « aws » : service, opération et options (guillemets acceptés ; aucun shell : pas de tubes ni de substitutions)'),
          timeout_seconds: z.number().int().min(1).max(600).optional().describe('Délai maximal (défaut 120 s)'),
        },
        async ({ item, command, timeout_seconds }) =>
          run(async () => {
            const i = await ofKind(item, 'aws');
            const inv = awsService.check(i, command);
            const line = inv.tokens.join(' ');
            await gate(i, 'aws_run', `aws ${line}`, { command: line });
            const result = await audited(i, 'aws_run', line, async () => {
              const r = await awsService.run(i, ctx.project, ctx.cwd, command, (timeout_seconds ?? 120) * 1000);
              return { result: r, note: `code ${r.exitCode ?? r.signal}` };
            });
            return renderExec(result);
          }),
      ),

      tool(
        'scw_run',
        "Exécute une commande du CLI Scaleway (scw) avec un compte Scaleway du coffre et renvoie sa sortie (stdout, stderr, code de sortie). Donne la commande sans « scw » (ex. « instance server list zone=fr-par-1 -o json », « rdb instance list », « account project list »). Ajoute « -o json » pour une sortie structurée. Le serveur l'exécute hors de ton environnement, avec les fichiers de ton dossier de travail (chemins relatifs) ; la clé secrète ne t'est jamais communiquée. Sur un compte en lecture seule, seuls les verbes de consultation (list, get, wait) sont acceptés, hors secrets et clés.",
        {
          item: z.string().describe("Nom de l'élément Scaleway"),
          command: z.string().describe('Commande du CLI sans « scw » : espace de noms, ressource, verbe, arguments clé=valeur et options (guillemets acceptés ; aucun shell : pas de tubes ni de substitutions)'),
          timeout_seconds: z.number().int().min(1).max(600).optional().describe('Délai maximal (défaut 120 s)'),
        },
        async ({ item, command, timeout_seconds }) =>
          run(async () => {
            const i = await ofKind(item, 'scaleway');
            const inv = scalewayService.check(i, command);
            const line = inv.tokens.join(' ');
            await gate(i, 'scw_run', `scw ${line}`, { command: line });
            const result = await audited(i, 'scw_run', line, async () => {
              const r = await scalewayService.run(i, ctx.project, ctx.cwd, command, (timeout_seconds ?? 120) * 1000);
              return { result: r, note: `code ${r.exitCode ?? r.signal}` };
            });
            return renderExec(result);
          }),
      ),

      tool(
        'scw_api',
        "Appelle l'API Scaleway (https://api.scaleway.com) avec un compte Scaleway du coffre : chemin relatif (ex. « instance/v1/zones/fr-par-1/servers », « account/v3/projects?organization_id=… »), authentification ajoutée par le serveur, redirections non suivies, réponse tronquée au-delà de 2 Mo. Sur un compte en lecture seule, GET seulement, hors chemins qui révèlent un secret ou un accès.",
        {
          item: z.string().describe("Nom de l'élément Scaleway"),
          method: z.enum(api.API_METHODS).optional().describe('Défaut : GET'),
          path: z.string().describe("Chemin relatif à https://api.scaleway.com (ex. instance/v1/zones/fr-par-1/servers)"),
          // Pas de z.record : le convertisseur du SDK le refuse et tout le serveur disparaît (voir mcp.test.ts).
          query: z.object({}).catchall(z.string()).optional().describe('Paramètres de requête supplémentaires (page, page_size, project_id…)'),
          body: z.string().optional().describe('Corps JSON (POST, PATCH, PUT), 1 Mo au plus'),
        },
        async ({ item, method, path: p, query, body }) =>
          run(async () => {
            const i = await ofKind(item, 'scaleway');
            const call = { method, path: p, query, body };
            scalewayService.checkApi(i, call);
            await gate(i, 'scw_api', `${method ?? 'GET'} ${p}`, { method: method ?? 'GET', path: p, query: query ?? null });
            const result = await audited(i, 'scw_api', `${method ?? 'GET'} ${p}`, async () => {
              const r = await scalewayService.api(i, call);
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
