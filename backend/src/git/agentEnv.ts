import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubService } from '../settings/github.js';

const execFileAsync = promisify(execFile);

/** Noms des variables transmises aux processus des agents (sessions, terminaux, conteneurs). */
export const AGENT_GIT_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

let identityCache: { name: string | null; email: string | null } | null = null;

async function hostIdentity(): Promise<{ name: string | null; email: string | null }> {
  if (identityCache) return identityCache;
  const read = async (key: string) => {
    try {
      return (await execFileAsync('git', ['config', '--global', key])).stdout.trim() || null;
    } catch {
      return null;
    }
  };
  identityCache = { name: await read('user.name'), email: await read('user.email') };
  return identityCache;
}

/**
 * Environnement git des agents : identité pour les commits, et jeton GitHub servi par un credential
 * helper (via GIT_CONFIG_*) pour les URL https de github.com. Le jeton n'est jamais écrit sur disque.
 */
export async function agentGitEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const [token, status, identity] = await Promise.all([githubService.token().catch(() => null), githubService.status().catch(() => null), hostIdentity()]);
  if (token) {
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = token;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_0 = '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
  }
  const name = identity.name ?? status?.login ?? null;
  const email = identity.email ?? (status?.login ? `${status.login}@users.noreply.github.com` : null);
  if (name) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME = name;
  }
  if (email) {
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_EMAIL = email;
  }
  return env;
}
