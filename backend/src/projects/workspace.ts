import { execFile } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { githubService } from '../settings/github.js';
import type { Project } from './types.js';

const execFileAsync = promisify(execFile);

/** Chemin absolu du dossier de travail d'un projet. */
export function workspacePath(project: Pick<Project, 'slug'>): string {
  return path.join(config.workspacesRoot, project.slug);
}

export async function workspaceExists(project: Pick<Project, 'slug'>): Promise<boolean> {
  try {
    await access(workspacePath(project));
    return true;
  } catch {
    return false;
  }
}

export async function git(args: string[], cwd?: string): Promise<string> {
  // Les dépôts GitHub en https utilisent le jeton de la connexion GitHub (Paramètres), s'il existe.
  const auth = await githubService.gitConfigArgs().catch(() => []);
  try {
    const { stdout } = await execFileAsync('git', [...auth, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    // Le jeton ne doit jamais apparaître dans un message d'erreur.
    const text = (e.stderr || e.message).replace(/AUTHORIZATION: basic \S+/g, 'AUTHORIZATION: basic ***');
    throw new AppError(`git ${args[0]} a échoué : ${text.trim()}`);
  }
}

/** Le dossier est-il un dépôt git (checkout principal) ? */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/**
 * Crée le dossier du projet s'il n'existe pas : clone du dépôt git si une URL est
 * configurée, simple dossier vide sinon. Un dossier existant mais vide est cloné également
 * (cas d'un projet auquel on associe un dépôt après coup). Un dossier non vide n'est jamais touché.
 */
export async function ensureWorkspace(project: Project): Promise<string> {
  const dir = workspacePath(project);
  if (await workspaceExists(project)) {
    if (project.gitUrl && (await isEmptyDir(dir))) {
      const args = ['clone'];
      if (project.gitBranch) args.push('--branch', project.gitBranch);
      args.push('--', project.gitUrl, dir);
      await git(args);
    }
    return dir;
  }
  await mkdir(config.workspacesRoot, { recursive: true });
  if (project.gitUrl) {
    const args = ['clone'];
    if (project.gitBranch) args.push('--branch', project.gitBranch);
    args.push('--', project.gitUrl, dir);
    await git(args);
  } else {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/** Informations git du workspace (branche et dernier commit), ou null si ce n'est pas un dépôt. */
export async function workspaceGitInfo(project: Project): Promise<{ branch: string; commit: string } | null> {
  if (!(await workspaceExists(project))) return null;
  try {
    const dir = workspacePath(project);
    const [branch, commit] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), git(['rev-parse', '--short', 'HEAD'], dir)]);
    return { branch, commit };
  } catch {
    return null;
  }
}
