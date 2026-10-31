import path from 'node:path';
import { config } from '../config.js';

/** Dossier des dépôts nus hébergés par Skipper : <WORKSPACES_ROOT>/.git-server/<slug>.git. */
export function gitServerRoot(): string {
  return path.join(config.workspacesRoot, '.git-server');
}

export function bareRepoPath(slug: string): string {
  return path.join(gitServerRoot(), `${slug}.git`);
}

/** Préfixe HTTP des dépôts hébergés : sous /api/, déjà proxifié par nginx vers le backend. */
export const HOSTED_GIT_PREFIX = '/api/git/';

/** URL de clone d'un dépôt hébergé, dérivée de l'adresse publique de l'API : la même depuis le serveur, les conteneurs et les postes. */
export function hostedGitUrl(slug: string): string {
  return `${config.apiUrl}${HOSTED_GIT_PREFIX}${slug}.git`;
}

export function isHostedGitUrl(url: string | null | undefined): boolean {
  return Boolean(url) && url!.startsWith(`${config.apiUrl}${HOSTED_GIT_PREFIX}`);
}

/** Branche principale d'un projet hébergé : celle du projet, sinon main. */
export function hostedDefaultBranch(project: { gitBranch: string | null }): string {
  return project.gitBranch?.trim() || 'main';
}
