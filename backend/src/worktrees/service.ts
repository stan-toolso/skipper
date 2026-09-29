import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService, slugify } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { ensureWorkspace, git, isGitRepository, workspacePath } from '../projects/workspace.js';
import { worktreeRepository } from './repository.js';
import type { Worktree } from './types.js';

/** Dossier contenant les worktrees d'un projet, à côté du checkout principal : <root>/<slug>.worktrees/<name>. */
export function worktreesRoot(project: Pick<Project, 'slug'>): string {
  return path.join(config.workspacesRoot, `${project.slug}.worktrees`);
}
export function worktreePath(project: Pick<Project, 'slug'>, worktree: Pick<Worktree, 'name'>): string {
  return path.join(worktreesRoot(project), worktree.name);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function validateBranch(branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.endsWith('/') || branch.includes('..') || branch.endsWith('.lock')) {
    throw new AppError(`Nom de branche invalide : ${branch}`);
  }
}

export const worktreeService = {
  listByProject: (projectId: string) => worktreeRepository.listByProject(projectId),

  async get(id: string): Promise<Worktree> {
    const wt = await worktreeRepository.findById(id);
    if (!wt) throw new NotFoundError('Worktree introuvable');
    return wt;
  },

  exists: (project: Project, worktree: Worktree) => exists(worktreePath(project, worktree)),

  /** Branche et commit courants du worktree, ou null s'il n'existe plus sur disque. */
  async gitInfo(project: Project, worktree: Worktree): Promise<{ branch: string; commit: string } | null> {
    const dir = worktreePath(project, worktree);
    if (!(await exists(dir))) return null;
    try {
      const [branch, commit] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), git(['rev-parse', '--short', 'HEAD'], dir)]);
      return { branch, commit };
    } catch {
      return null;
    }
  },

  /**
   * Crée un worktree : `git worktree add`. Si la branche existe (localement ou sur origin), elle est
   * extraite ; sinon elle est créée à partir de `baseRef` (défaut : HEAD du checkout principal).
   */
  async create(projectId: string, input: { name?: string | null; branch: string; baseRef?: string | null }): Promise<Worktree> {
    const project = await projectService.get(projectId);
    if (!project.gitUrl) throw new AppError("Ce projet n'est pas relié à un dépôt git");
    const branch = input.branch.trim();
    validateBranch(branch);
    const name = slugify(input.name?.trim() || branch);
    if (!name) throw new AppError('Nom de worktree invalide');
    const main = await ensureWorkspace(project);
    if (!(await isGitRepository(main))) {
      throw new AppError(
        `Le dossier principal du projet (${main}) n'est pas un dépôt git. S'il est vide, « Créer le dossier » depuis la page du projet le clonera ; sinon videz-le ou clonez-y le dépôt à la main.`,
      );
    }
    const dir = path.join(worktreesRoot(project), name);
    if (await exists(dir)) throw new AppError(`Le dossier ${dir} existe déjà`);
    await mkdir(worktreesRoot(project), { recursive: true });

    // Rafraîchit les références distantes pour détecter une branche existante sur origin.
    await git(['fetch', '--prune', 'origin'], main).catch(() => undefined);
    const localBranches = (await git(['branch', '--list', branch], main)).trim();
    const remoteBranches = (await git(['branch', '-r', '--list', `origin/${branch}`], main)).trim();

    if (localBranches) {
      await git(['worktree', 'add', dir, branch], main);
    } else if (remoteBranches) {
      await git(['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`], main);
    } else {
      const base = input.baseRef?.trim() || 'HEAD';
      await git(['worktree', 'add', '-b', branch, dir, base], main);
    }

    try {
      return await worktreeRepository.create(projectId, name, branch);
    } catch (err) {
      await git(['worktree', 'remove', '--force', dir], main).catch(() => undefined);
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un worktree "${name}" existe déjà`);
      throw err;
    }
  },

  /** Supprime le worktree (dossier et enregistrement). La branche est conservée sauf `deleteBranch`. */
  async delete(id: string, deleteBranch = false): Promise<boolean> {
    const wt = await this.get(id);
    if ((await worktreeRepository.countRunningSessions(id)) > 0) throw new AppError('Des sessions tournent encore dans ce worktree');
    const project = await projectService.get(wt.projectId);
    const main = workspacePath(project);
    const dir = worktreePath(project, wt);
    if (await exists(dir)) await git(['worktree', 'remove', '--force', dir], main);
    await git(['worktree', 'prune'], main).catch(() => undefined);
    if (deleteBranch) await git(['branch', '-D', wt.branch], main).catch(() => undefined);
    return worktreeRepository.delete(id);
  },

  /** Dossier de travail effectif d'une session ou d'un terminal : worktree si précisé, sinon checkout principal. */
  async resolveCwd(project: Project, worktreeId: string | null | undefined): Promise<string> {
    if (!worktreeId) return ensureWorkspace(project);
    const wt = await this.get(worktreeId);
    if (wt.projectId !== project.id) throw new AppError('Ce worktree appartient à un autre projet');
    const dir = worktreePath(project, wt);
    if (!(await exists(dir))) throw new AppError(`Le worktree "${wt.name}" n'existe plus sur disque`);
    return dir;
  },
};
