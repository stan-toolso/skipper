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
 * Environnement git des agents d'une session : le jeton GitHub du compte de SON PROPRIÉTAIRE qui sert le
 * dépôt du projet (servi par un credential helper via GIT_CONFIG_*, jamais écrit sur disque), et l'identité
 * des commits (celle du compte GitHub, sinon celle du serveur). Sans propriétaire ou sans compte : pas de
 * jeton (les dépôts publics restent accessibles). Un usage par une session est journalisé sur le jeton.
 */
export async function agentGitEnv(ownerId: string | null | undefined, repoUrl?: string | null, actor: { sessionId?: string | null; projectId?: string | null } = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const [auth, identity] = await Promise.all([githubService.gitAuth(ownerId, repoUrl, actor).catch(() => null), hostIdentity()]);
  if (auth) {
    env.GITHUB_TOKEN = auth.token;
    env.GH_TOKEN = auth.token;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_0 = '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
  }
  const name = auth?.name ?? identity.name ?? null;
  const email = auth?.email ?? identity.email ?? null;
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
