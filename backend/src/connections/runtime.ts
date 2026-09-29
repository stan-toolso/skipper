import { spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { connectionService } from './service.js';
import * as ssh from './ssh.js';
import type { Connection, PostgresSettings, SshSettings, WebsiteSettings } from './types.js';
import { variableName } from './website.js';

/**
 * Mode « accès direct » : pour la durée d'une session, l'agent peut utiliser `ssh <nom>`, `scp`,
 * `psql service=<nom>` depuis son shell.
 *
 * - SSH : un agent SSH (`ssh-agent`) propre à la session détient les clés privées ; l'agent d'IA
 *   ne peut que s'en servir, pas les lire. Des enveloppes `ssh`/`scp`/`sftp` placées en tête du
 *   PATH imposent un fichier de configuration avec un alias par connexion et un known_hosts dédié.
 * - PostgreSQL : un fichier de services (`PGSERVICEFILE`) et un fichier de mots de passe
 *   (`PGPASSFILE`) éphémères ; les bases atteintes par tunnel SSH passent par un port local ouvert
 *   par le backend. Le mot de passe est lisible par l'agent : réserver ce mode aux bases où c'est acceptable.
 * - Sites web : chaque champ devient une variable d'environnement (`ADMIN_SITE_PASSWORD`), pour curl
 *   ou des scripts. L'agent lit donc les valeurs : réserver ce mode aux comptes où c'est acceptable.
 *
 * Tout est détruit à la fin de la session (`dispose`). Le fichier de secrets du navigateur headless
 * (sites web en mode « outils ») est géré par le runner (`browserMcpCommand`), pas ici.
 */

export interface DirectAccess {
  /** Variables à ajouter à l'environnement de la session. */
  env: Record<string, string>;
  /** Ce qui a été mis en place, pour le journal de la session. */
  summary: string[];
  dispose(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SESSION_DIR_PREFIX = 'skipper-session-';
const sessionDir = (sessionId: string) => path.join(os.tmpdir(), `${SESSION_DIR_PREFIX}${sessionId.slice(0, 8)}`);

/** Agents SSH lancés par ce processus, pour les arrêter si le serveur s'interrompt. */
const liveAgents = new Set<ChildProcess>();
process.once('exit', () => {
  for (const agent of liveAgents) agent.kill('SIGTERM');
});

/**
 * Au démarrage du serveur : supprime les dossiers de sessions laissés par une exécution précédente
 * (arrêt brutal) et termine leurs agents SSH. Renvoie le nombre de dossiers nettoyés.
 */
export async function sweepStaleSessionDirs(): Promise<number> {
  const entries = await readdir(os.tmpdir()).catch(() => [] as string[]);
  let count = 0;
  for (const name of entries.filter((n) => n.startsWith(SESSION_DIR_PREFIX))) {
    const dir = path.join(os.tmpdir(), name);
    await runCommand('pkill', ['-f', `ssh-agent -D -a ${path.join(dir, 'agent.sock')}`], process.env).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    count++;
  }
  return count;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Exécute une commande et renvoie sa sortie ; rejette si le code de sortie est non nul. */
function runCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args[0] ?? ''} : ${err.trim() || `code ${code}`}`))));
  });
}

/** Ligne known_hosts d'une connexion : hôte simple sur le port 22, sinon la forme [hôte]:port. */
function knownHostsLine(s: SshSettings, hostKey: string): string {
  return `${s.port === 22 ? s.host : `[${s.host}]:${s.port}`} ${hostKey}`;
}

/** Échappement d'un champ de .pgpass (":" et "\" sont réservés). */
const pgpassField = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

/**
 * L'accès direct suppose que le CLI tourne sur la machine du backend (agent SSH, fichiers, tunnels locaux).
 * Les sessions tournent toujours dans le conteneur du projet : il n'est jamais disponible.
 */
export const supportsDirectAccess = () => false;

export async function prepareDirectAccess(project: Project, sessionId: string, baseEnv: NodeJS.ProcessEnv): Promise<DirectAccess | null> {
  const all = await connectionService.listByProject(project.id);
  const direct = all.filter((c) => c.exposure !== 'mcp');
  if (direct.length === 0) return null;
  if (!supportsDirectAccess()) {
    throw new AppError(`l'accès depuis le shell (${direct.map((c) => c.name).join(', ')}) n'est pas disponible dans le conteneur du projet ; seuls les outils restent utilisables`);
  }

  // Dossier éphémère (0700) de la session, dans le dossier temporaire : le chemin d'un socket Unix doit rester court.
  const dir = sessionDir(sessionId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const cleanups: (() => Promise<void>)[] = [];
  const env: Record<string, string> = {};
  const summary: string[] = [];
  const dispose = async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const sshConnections = direct.filter((c) => c.kind === 'ssh');
    if (sshConnections.length) await setupSsh(dir, sshConnections, baseEnv, env, summary, cleanups);
    const pgConnections = direct.filter((c) => c.kind === 'postgres');
    if (pgConnections.length) await setupPostgres(dir, pgConnections, all, env, summary, cleanups);
    for (const c of direct.filter((c) => c.kind === 'website')) {
      const creds = connectionService.websiteCredentials(c);
      for (const f of creds.fields) env[f.variable] = f.value;
      summary.push(`site ${c.name} (${(c.settings as WebsiteSettings).url}) : ${creds.fields.map((f) => variableName(c.name, f.key)).join(', ')}`);
    }
  } catch (err) {
    await dispose();
    throw err instanceof AppError ? err : new AppError(`Préparation de l'accès direct impossible : ${(err as Error).message}`);
  }
  return { env, summary, dispose };
}

async function setupSsh(dir: string, connections: Connection[], baseEnv: NodeJS.ProcessEnv, env: Record<string, string>, summary: string[], cleanups: (() => Promise<void>)[]): Promise<void> {
  const sock = path.join(dir, 'agent.sock');
  let agentOutput = '';
  const agent: ChildProcess = spawn('ssh-agent', ['-D', '-a', sock], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  agent.stdout?.on('data', (d: Buffer) => (agentOutput += d.toString()));
  agent.stderr?.on('data', (d: Buffer) => (agentOutput += d.toString()));
  agent.on('error', (err) => (agentOutput += err.message));
  liveAgents.add(agent);
  agent.on('exit', () => liveAgents.delete(agent));
  cleanups.push(async () => {
    agent.kill('SIGTERM');
  });
  for (let i = 0; i < 40 && !(await exists(sock)); i++) await sleep(50);
  if (!(await exists(sock))) throw new AppError(`ssh-agent n'a pas démarré : ${agentOutput.trim() || 'socket absent'}`);
  const agentEnv = { ...baseEnv, SSH_AUTH_SOCK: sock };

  const configLines: string[] = ['# Généré par Skipper pour la durée de la session. Ne pas modifier.', ''];
  const known: string[] = [];
  for (const c of connections) {
    const s = c.settings as SshSettings;
    const creds = connectionService.sshCredentials(c);
    // La clé n'est écrite que le temps de la charger dans l'agent, puis effacée.
    const keyFile = path.join(dir, `key-${c.name}`);
    await writeFile(keyFile, creds.privateKey.endsWith('\n') ? creds.privateKey : `${creds.privateKey}\n`, { mode: 0o600 });
    try {
      await runCommand('ssh-add', ['-q', keyFile], agentEnv);
    } finally {
      await unlink(keyFile).catch(() => undefined);
    }
    if (c.hostKey) known.push(knownHostsLine(s, c.hostKey));
    configLines.push(
      `Host ${c.name}`,
      `  HostName ${s.host}`,
      `  Port ${s.port}`,
      `  User ${s.username}`,
      `  IdentityAgent ${sock}`,
      `  UserKnownHostsFile ${path.join(dir, 'known_hosts')}`,
      `  StrictHostKeyChecking ${c.hostKey ? 'yes' : 'accept-new'}`,
      '  ServerAliveInterval 15',
      '',
    );
    summary.push(`ssh ${c.name} (${s.username}@${s.host})`);
  }
  await writeFile(path.join(dir, 'known_hosts'), known.length ? `${known.join('\n')}\n` : '', { mode: 0o600 });
  await writeFile(path.join(dir, 'ssh_config'), configLines.join('\n'), { mode: 0o600 });

  // Enveloppes ssh/scp/sftp : imposent notre configuration, avec le PATH d'origine pour trouver le vrai binaire.
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { mode: 0o700 });
  const originalPath = baseEnv.PATH ?? '/usr/bin:/bin';
  for (const tool of ['ssh', 'scp', 'sftp']) {
    const file = path.join(bin, tool);
    await writeFile(file, `#!/bin/sh\n# Enveloppe Skipper : configuration SSH de la session.\nPATH=${JSON.stringify(originalPath)} exec ${tool} -F ${JSON.stringify(path.join(dir, 'ssh_config'))} "$@"\n`);
    await chmod(file, 0o700);
  }
  env.SSH_AUTH_SOCK = sock;
  env.PATH = `${bin}:${originalPath}`;

  // En fin de session, les clés d'hôte apprises (accept-new) sont mémorisées pour les prochaines fois.
  cleanups.push(async () => {
    const content = await readFile(path.join(dir, 'known_hosts'), 'utf8').catch(() => '');
    for (const c of connections.filter((x) => !x.hostKey)) {
      const s = c.settings as SshSettings;
      const prefix = `${s.port === 22 ? s.host : `[${s.host}]:${s.port}`} `;
      const line = content.split('\n').find((l) => l.startsWith(prefix));
      if (line) await connectionService.rememberHostKey(c, line.slice(prefix.length).trim().split(' ').slice(0, 2).join(' ')).catch(() => undefined);
    }
  });
}

async function setupPostgres(dir: string, connections: Connection[], all: Connection[], env: Record<string, string>, summary: string[], cleanups: (() => Promise<void>)[]): Promise<void> {
  const services: string[] = ['# Généré par Skipper pour la durée de la session.', ''];
  const pgpass: string[] = [];
  for (const c of connections) {
    const s = c.settings as PostgresSettings;
    const creds = await connectionService.postgresCredentials(c);
    let host = s.host;
    let port = s.port;
    if (creds.via) {
      // Tunnel maintenu ouvert pendant toute la session.
      const session = await ssh.connect(creds.via.credentials, creds.via.connection.hostKey);
      await connectionService.rememberHostKey(creds.via.connection, session.hostKey);
      const tunnel = await ssh.openTunnel(session, s.host, s.port);
      cleanups.push(async () => {
        await tunnel.close();
        session.close();
      });
      host = '127.0.0.1';
      port = tunnel.port;
    }
    services.push(`[${c.name}]`, `host=${host}`, `port=${port}`, `dbname=${s.database}`, `user=${s.username}`, `sslmode=${s.ssl ? 'require' : 'prefer'}`);
    if (c.readOnly) services.push('options=-c default_transaction_read_only=on');
    services.push('');
    if (creds.password) pgpass.push([host, String(port), s.database, s.username, creds.password].map(pgpassField).join(':'));
    const via = s.viaConnectionId ? all.find((x) => x.id === s.viaConnectionId)?.name : null;
    summary.push(`psql service=${c.name} (${s.database}@${s.host}${via ? ` via ${via}` : ''}${c.readOnly ? ', lecture seule' : ''})`);
  }
  await writeFile(path.join(dir, 'pg_service.conf'), services.join('\n'), { mode: 0o600 });
  await writeFile(path.join(dir, 'pgpass'), pgpass.length ? `${pgpass.join('\n')}\n` : '', { mode: 0o600 });
  env.PGSERVICEFILE = path.join(dir, 'pg_service.conf');
  env.PGPASSFILE = path.join(dir, 'pgpass');
}
