import path from 'node:path';
import { config } from '../config.js';

/**
 * Miroirs locaux des dépôts hébergés (dans Forgejo) : <WORKSPACES_ROOT>/.git-server/<slug>.git, tenus à jour pour les
 * sauvegardes en base. Les dépôts nus du serveur git minimal (avant Forgejo) y étaient aussi : ils servent à la reprise.
 */
export function gitServerRoot(): string {
  return path.join(config.workspacesRoot, '.git-server');
}

export function bareRepoPath(slug: string): string {
  return path.join(gitServerRoot(), `${slug}.git`);
}

/** Dépôt Forgejo d'un projet hébergé : l'organisation de Skipper, nommé d'après le slug. */
export function hostedRepo(slug: string): { owner: string; name: string } {
  return { owner: config.forgejo.org, name: slug };
}

/** Page web du dépôt dans Forgejo. */
export function hostedRepoWebUrl(slug: string): string {
  return `${config.forgejo.url}/${config.forgejo.org}/${slug}`;
}

/** URL de clone d'un dépôt hébergé : l'adresse publique de Forgejo, la même depuis le serveur, les conteneurs et les postes. */
export function hostedGitUrl(slug: string): string {
  return `${hostedRepoWebUrl(slug)}.git`;
}

export function isHostedGitUrl(url: string | null | undefined): boolean {
  return Boolean(url && config.forgejo.url) && url!.startsWith(`${config.forgejo.url}/`);
}

/** Branche principale d'un projet hébergé : celle du projet, sinon main. */
export function hostedDefaultBranch(project: { gitBranch: string | null }): string {
  return project.gitBranch?.trim() || 'main';
}
