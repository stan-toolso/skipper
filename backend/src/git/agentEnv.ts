import { log } from '../log.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { isHostedGitUrl } from '../gitServer/paths.js';
import { forgejoAccounts } from '../gitServer/forgejo.js';
import { userService } from '../users/service.js';
import { githubService } from '../settings/github.js';
import { gitlabRepoOf, gitlabService } from '../settings/gitlab.js';
import { ownAccounts, type OwnerAccounts } from '../agents/types.js';

const execFileAsync = promisify(execFile);

/** Noms des variables transmises aux processus des agents (sessions, terminaux, conteneurs). */
export const AGENT_GIT_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_HOST',
  'SKIPPER_GIT_TOKEN',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_KEY_2',
  'GIT_CONFIG_VALUE_2',
  'GIT_CONFIG_KEY_3',
  'GIT_CONFIG_VALUE_3',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

export type GitHostKind = 'github' | 'gitlab' | 'forge';

/**
 * Compte qui sert un dépôt pour un propriétaire de session : la forge de Skipper (dépôt hébergé), GitLab (gitlab.com ou
 * une instance des comptes GitLab en jeu) ou GitHub, avec la personne dont le compte sert, le prêt en lecture seule et
 * le droit d'ouvrir des pull requests par `tasks.pr_open` (vrai hors lecture seule, ou par option du prêt) et celui de
 * fusionner avec ce compte sans accord d'une personne (`merge`, prêt en écriture avec fusion permise).
 */
export async function gitAccountFor(accounts: OwnerAccounts, repoUrl: string | null | undefined): Promise<{ host: GitHostKind; userId: string; readOnly: boolean; pullRequests: boolean; merge: boolean }> {
  if (isHostedGitUrl(repoUrl)) return { host: 'forge', userId: accounts.forgeUserId, readOnly: false, pullRequests: true, merge: false };
  if (gitlabRepoOf(repoUrl, await gitlabService.hosts(accounts.gitlabUserId).catch(() => []))) return { host: 'gitlab', userId: accounts.gitlabUserId, readOnly: accounts.gitlabReadOnly, pullRequests: accounts.gitlabPullRequests, merge: accounts.gitlabMerge };
  return { host: 'github', userId: accounts.githubUserId, readOnly: accounts.githubReadOnly, pullRequests: accounts.githubPullRequests, merge: accounts.githubMerge };
}

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
 * des commits (celle du compte GitHub, sinon celle du serveur). Même chose pour GitLab : le jeton du compte GitLab qui
 * sert le dépôt (sinon le compte GitLab par défaut) pour son instance (GITLAB_TOKEN, GITLAB_HOST, lus aussi par glab), et
 * l'identité de ce compte quand le dépôt du projet est sur GitLab. Sans propriétaire ou sans compte : pas de
 * jeton (les dépôts publics restent accessibles). Un usage par une session est journalisé sur le jeton.
 * Dépôt hébergé par Skipper (Forgejo) : le jeton Forgejo des sessions du propriétaire (forge_accounts), servi de la même
 * façon pour l'origine de Forgejo, afin que fetch et push depuis le conteneur passent par la forge avec son compte.
 * `owner` : l'identifiant d'une personne (ses comptes), ou les comptes d'un agent (`agentService.accounts`) : GitHub et
 * GitLab peuvent alors venir de personnes différentes, et l'origine ne se pousse pas si le compte de son hébergeur est
 * prêté en lecture seule.
 */
export async function agentGitEnv(owner: string | OwnerAccounts | null | undefined, repoUrl?: string | null, actor: { sessionId?: string | null; projectId?: string | null } = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const accounts = typeof owner === 'string' ? ownAccounts(owner) : (owner ?? null);
  const hosted = isHostedGitUrl(repoUrl);
  const [auth, gitlab, gitlabHosts, identity, hostedToken] = await Promise.all([
    hosted ? null : githubService.gitAuth(accounts?.githubUserId, repoUrl, actor).catch(() => null),
    hosted ? null : gitlabService.gitAuth(accounts?.gitlabUserId, repoUrl, actor).catch(() => null),
    hosted ? [] : gitlabService.hosts(accounts?.gitlabUserId).catch(() => []),
    hostIdentity(),
    hosted && accounts ? userService.get(accounts.forgeUserId).then((u) => forgejoAccounts.agentToken(u)).catch((err) => (log.warn(`[forgejo] jeton des sessions : ${(err as Error).message}`), null)) : null,
  ]);
  const configs: [string, string][] = [];
  if (auth) {
    env.GITHUB_TOKEN = auth.token;
    env.GH_TOKEN = auth.token;
    configs.push(['credential.https://github.com.helper', '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f']);
  }
  if (gitlab) {
    env.GITLAB_TOKEN = gitlab.token;
    env.GITLAB_HOST = gitlab.host;
    configs.push([`credential.https://${gitlab.host}.helper`, '!f() { echo username=oauth2; echo "password=$GITLAB_TOKEN"; }; f']);
  }
  if (hostedToken) {
    env.SKIPPER_GIT_TOKEN = hostedToken;
    configs.push([`credential.${new URL(config.forgejo.url).origin}.helper`, '!f() { echo username=skipper; echo "password=$SKIPPER_GIT_TOKEN"; }; f']);
  }
  // Compte prêté en lecture seule (agent de projet) pour l'hébergeur de l'origine : elle ne se pousse pas (adresse de push inexistante, erreur explicite).
  if (accounts && !hosted && (gitlabRepoOf(repoUrl, gitlabHosts) ? accounts.gitlabReadOnly : accounts.githubReadOnly)) configs.push(['remote.origin.pushurl', 'https://lecture-seule.skipper.invalid/comptes-git-pretes-en-lecture-seule']);
  if (configs.length) {
    env.GIT_CONFIG_COUNT = String(configs.length);
    configs.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }
  // Dépôt GitLab : identité du compte GitLab ; sinon celle du compte GitHub, sinon celle du serveur.
  const author = gitlab && gitlabRepoOf(repoUrl, gitlabHosts) ? gitlab : auth;
  const name = author?.name ?? identity.name ?? null;
  const email = author?.email ?? identity.email ?? null;
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
