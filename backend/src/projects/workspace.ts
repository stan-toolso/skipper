import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { AppError } from '../errors.js';
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

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new AppError(`git ${args[0]} a échoué : ${(e.stderr || e.message).trim()}`);
  }
}

/**
 * Crée le dossier du projet s'il n'existe pas : clone du dépôt git si une URL est
 * configurée, simple dossier vide sinon. Idempotent : ne touche pas à un dossier existant.
 */
export async function ensureWorkspace(project: Project): Promise<string> {
  const dir = workspacePath(project);
  if (await workspaceExists(project)) return dir;
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
