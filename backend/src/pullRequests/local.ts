import { access } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../projects/workspace.js';
import type { Project } from '../projects/types.js';
import { worksessionPath } from '../worksessions/service.js';
import type { Worksession } from '../worksessions/types.js';

/**
 * Travail local d'une work session (branche), pour la PR « en préparation » : commits en avance sur la branche de
 * base et fichiers non commités. Lu dans le dossier de la work session, sans contacter le dépôt distant.
 */
export interface LocalBranchWork {
  branch: string;
  baseBranch: string;
  /** Commits de la branche absents de la base (depuis `since` si donné : les commits postérieurs à une fusion). */
  commits: number;
  /** Fichiers modifiés, indexés ou non suivis. */
  changes: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Référence de la base : `origin/<base>` de préférence (à jour du dépôt), sinon la branche locale ; null si aucune. */
async function baseRef(cwd: string, base: string): Promise<string | null> {
  for (const ref of [`origin/${base}`, base]) {
    if (await git(['rev-parse', '--verify', '--quiet', ref], cwd).then(() => true, () => false)) return ref;
  }
  return null;
}

/**
 * État local d'une work session : null si son dossier n'existe pas (archivée, supprimée, jamais créée), n'est pas un
 * dépôt git, est en HEAD détaché, ou est sur la branche de base elle-même.
 */
export async function localBranchWork(project: Project, ws: Worksession, opts: { since?: Date | null } = {}): Promise<LocalBranchWork | null> {
  const cwd = worksessionPath(project, ws);
  if (!(await exists(path.join(cwd, '.git')))) return null;
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '');
  if (!branch || branch === 'HEAD') return null;
  const baseBranch = project.gitBranch || 'main';
  if (branch === baseBranch) return null;
  const base = await baseRef(cwd, baseBranch);
  const sinceArgs = opts.since ? [`--since=${opts.since.toISOString()}`] : [];
  const commits = base ? Number((await git(['rev-list', '--count', ...sinceArgs, `${base}..HEAD`], cwd).catch(() => '0')) || 0) : 0;
  const status = await git(['status', '--porcelain', '--untracked-files=normal'], cwd).catch(() => '');
  const changes = status ? status.split('\n').filter(Boolean).length : 0;
  return { branch, baseBranch, commits, changes };
}
