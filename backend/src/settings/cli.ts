import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { ServerAuthStatus } from './types.js';

const execFileAsync = promisify(execFile);

/** Binaire Claude Code pour les commandes d'authentification : CLAUDE_BIN, sinon le CLI installé pour l'utilisateur, sinon `claude` du PATH. */
export function claudeBinary(): string {
  if (config.claudeBin) return config.claudeBin;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  return 'claude';
}

/** Environnement pour les commandes du CLI : sans les secrets de l'application, pour refléter le compte du serveur seul. */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, BROWSER: '/usr/bin/true' };
  return env;
}

/** `claude auth status --json` : le compte connecté dans le magasin du CLI de l'utilisateur système. */
export async function serverAuthStatus(): Promise<ServerAuthStatus> {
  try {
    const { stdout } = await execFileAsync(claudeBinary(), ['auth', 'status', '--json'], { env: cliEnv(), timeout: 20_000, maxBuffer: 1 << 20 });
    const json = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { loggedIn?: boolean; authMethod?: string; email?: string; orgName?: string; subscriptionType?: string };
    return { loggedIn: Boolean(json.loggedIn), authMethod: json.authMethod ?? null, email: json.email ?? null, organization: json.orgName ?? null, subscriptionType: json.subscriptionType ?? null, error: null };
  } catch (err) {
    return { loggedIn: false, authMethod: null, email: null, organization: null, subscriptionType: null, error: (err as Error).message.slice(0, 300) };
  }
}

/** `claude auth logout` : oublie le compte du serveur. */
export async function serverLogout(): Promise<void> {
  await execFileAsync(claudeBinary(), ['auth', 'logout'], { env: cliEnv(), timeout: 20_000 });
}
