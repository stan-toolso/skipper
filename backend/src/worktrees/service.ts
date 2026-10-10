import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService, slugify } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { ensureWorkspace, git, gitAuthFor, isGitRepository, workspacePath } from '../projects/workspace.js';
import { worktreeRepository } from './repository.js';
import { worktreeLabel, type Worktree } from './types.js';

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

/** Libellé normalisé : espaces réduits, vide → null, 100 caractères au plus. */
export function normalizeLabel(raw: string | null | undefined): string | null {
  const label = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!label) return null;
  if (label.length > 100) throw new AppError('Le libellé est trop long (100 caractères au plus)');
  return label;
}

/** Restaurations de dossier en cours, par worktree : des appels concurrents partagent la même. */
const restoring = new Map<string, Promise<string>>();

export const worktreeService = {
  listByProject: (projectId: string, opts?: { includeArchived?: boolean; archived?: 'exclude' | 'only' | 'all' }) => worktreeRepository.listByProject(projectId, opts),
  findByBranch: (projectId: string, branch: string) => worktreeRepository.findByBranch(projectId, branch),

  async get(id: string): Promise<Worktree> {
    const wt = await worktreeRepository.findById(id);
    if (!wt) throw new NotFoundError('Worktree introuvable');
    return wt;
  },

  exists: (project: Project, worktree: Worktree) => exists(worktreePath(project, worktree)),

  /** Branche et commit courants du worktree, ou null s'il n'existe pas sur disque. */
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

  /** Un nom de dossier libre parmi tous les worktrees du projet (archivés compris). */
  async assertNameFree(projectId: string, name: string, exceptId: string | null = null): Promise<void> {
    const clash = (await worktreeRepository.listByProject(projectId, { includeArchived: true })).find((w) => w.name === name && w.id !== exceptId);
    if (clash) throw new AppError(`Un worktree « ${name} » existe déjà${clash.archivedAt ? ' (archivé : restaurez-le ou supprimez-le, ou choisissez un autre nom)' : ''}`);
  },

  /**
   * Crée un worktree : `git worktree add`. Si la branche existe (localement ou sur origin), elle est
   * extraite ; sinon elle est créée à partir de `baseRef` (défaut : HEAD du checkout principal).
   */
  async create(projectId: string, input: { name?: string | null; branch: string; baseRef?: string | null; label?: string | null }, actorId?: string | null): Promise<Worktree> {
    const project = await projectService.get(projectId);
    if (!project.gitUrl) throw new AppError("Ce projet n'est pas relié à un dépôt git");
    const branch = input.branch.trim();
    validateBranch(branch);
    const name = slugify(input.name?.trim() || branch).slice(0, 64);
    if (!name) throw new AppError('Nom de worktree invalide');
    await this.assertNameFree(projectId, name);
    const main = await ensureWorkspace(project, actorId);
    if (!(await isGitRepository(main))) {
      throw new AppError(
        `Le dossier principal du projet (${main}) n'est pas un dépôt git. S'il est vide, « Créer le dossier » depuis la page du projet le clonera ; sinon videz-le ou clonez-y le dépôt à la main.`,
      );
    }
    const dir = path.join(worktreesRoot(project), name);
    if (await exists(dir)) throw new AppError(`Le dossier ${dir} existe déjà`);
    await mkdir(worktreesRoot(project), { recursive: true });
    await this.checkout(main, dir, branch, input.baseRef?.trim() || 'HEAD', await gitAuthFor(project, actorId));
    try {
      return await worktreeRepository.create(projectId, name, branch, normalizeLabel(input.label));
    } catch (err) {
      await git(['worktree', 'remove', '--force', dir], main).catch(() => undefined);
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un worktree "${name}" existe déjà`);
      throw err;
    }
  },

  /** `git worktree add` : branche locale, distante, ou nouvelle depuis `base`. */
  async checkout(main: string, dir: string, branch: string, base: string, auth: string[] = []): Promise<'local' | 'remote' | 'new'> {
    await git(['fetch', '--prune', 'origin'], main, auth).catch(() => undefined);
    const localBranches = (await git(['branch', '--list', branch], main)).trim();
    const remoteBranches = (await git(['branch', '-r', '--list', `origin/${branch}`], main)).trim();
    if (localBranches) {
      await git(['worktree', 'add', dir, branch], main);
      return 'local';
    }
    if (remoteBranches) {
      await git(['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`], main);
      return 'remote';
    }
    await git(['worktree', 'add', '-b', branch, dir, base], main);
    return 'new';
  },

  /**
   * Renomme le libellé et/ou le dossier. Le dossier (`git worktree move`) ne change que si rien ne tourne
   * dans le worktree ; les sessions le retrouvent sous son nouveau nom à leur prochain tour.
   */
  async rename(id: string, input: { label?: string | null; name?: string | null }): Promise<Worktree> {
    const wt = await this.get(id);
    const patch: { label?: string | null; name?: string } = {};
    if (input.label !== undefined) patch.label = normalizeLabel(input.label);
    const newName = input.name?.trim() ? slugify(input.name.trim()).slice(0, 64) : null;
    if (newName && newName !== wt.name) {
      if (!newName) throw new AppError('Nom de dossier invalide');
      await this.assertNameFree(wt.projectId, newName, wt.id);
      const project = await projectService.get(wt.projectId);
      const from = worktreePath(project, wt);
      const to = worktreePath(project, { name: newName });
      if (!wt.archivedAt && (await exists(from))) {
        const busy = await worktreeRepository.countBusy(id);
        if (busy.sessions || busy.terminals) throw new AppError(`Le dossier ne peut pas être renommé pendant que quelque chose y tourne (${busy.sessions} session(s), ${busy.terminals} terminal(aux)) : arrêtez-les, ou changez seulement le libellé`);
        if (await exists(to)) throw new AppError(`Le dossier ${to} existe déjà`);
        const main = workspacePath(project);
        if (await isGitRepository(main)) await git(['worktree', 'move', from, to], main);
        else await rename(from, to);
        try {
          patch.name = newName;
          return (await worktreeRepository.update(id, patch)) ?? wt;
        } catch (err) {
          if (await isGitRepository(main)) await git(['worktree', 'move', to, from], main).catch(() => undefined);
          else await rename(to, from).catch(() => undefined);
          throw err;
        }
      }
      patch.name = newName;
    }
    return (await worktreeRepository.update(id, patch)) ?? wt;
  },

  /** Supprime le worktree (dossier et enregistrement). La branche est conservée sauf `deleteBranch`. Jamais de clone pour supprimer. */
  async delete(id: string, deleteBranch = false): Promise<boolean> {
    const wt = await this.get(id);
    if ((await worktreeRepository.countRunningSessions(id)) > 0) throw new AppError('Des sessions tournent encore dans ce worktree');
    const project = await projectService.get(wt.projectId);
    const main = workspacePath(project);
    const dir = worktreePath(project, wt);
    if (await isGitRepository(main)) {
      if (await exists(dir)) await git(['worktree', 'remove', '--force', dir], main).catch(() => rm(dir, { recursive: true, force: true }));
      await git(['worktree', 'prune'], main).catch(() => undefined);
      if (deleteBranch) await git(['branch', '-D', wt.branch], main).catch(() => undefined);
    } else if (await exists(dir)) {
      // Dossier principal absent ou vide : on retire simplement le dossier, sans cloner pour le faire.
      await rm(dir, { recursive: true, force: true });
    }
    return worktreeRepository.delete(id);
  },

  /** Archive le worktree : ses sessions actives sont archivées avec lui (date commune), son dossier est conservé. */
  async archive(id: string, archiveSessions: (worktreeId: string, at: Date) => Promise<void>): Promise<Worktree> {
    const wt = await this.get(id);
    if (wt.archivedAt) return wt;
    const at = new Date();
    const archived = (await worktreeRepository.setArchived(id, at)) ?? wt;
    try {
      await archiveSessions(id, at);
    } catch (err) {
      await worktreeRepository.setArchived(id, null);
      throw new AppError(`Le worktree n'a pas pu être archivé, son dossier est conservé : ${(err as Error).message}`);
    }
    return archived;
  },

  /** Restaure un worktree archivé ; refusé si sa branche est extraite dans un autre worktree actif. */
  async restore(id: string): Promise<Worktree> {
    const wt = await this.get(id);
    if (!wt.archivedAt) return wt;
    const other = await worktreeRepository.findByBranch(wt.projectId, wt.branch);
    if (other && other.id !== wt.id) throw new AppError(`La branche ${wt.branch} est extraite dans le worktree « ${worktreeLabel(other)} » : archivez-le ou supprimez-le d'abord`);
    return (await worktreeRepository.setArchived(id, null)) ?? wt;
  },

  /** Vérifie qu'un worktree peut recevoir une session ou un terminal : du projet, non archivé. */
  async assertUsable(project: Project, worktreeId: string): Promise<Worktree> {
    const wt = await this.get(worktreeId);
    if (wt.projectId !== project.id) throw new AppError('Ce worktree appartient à un autre projet');
    if (wt.archivedAt) throw new AppError(`Le worktree « ${worktreeLabel(wt)} » est archivé : restaurez-le d'abord`);
    return wt;
  },

  /**
   * Dossier du worktree, recréé s'il manque : branche locale, distante, ou — si elle a disparu — nouvelle
   * depuis le HEAD du checkout principal (jamais un dossier orphelin sans git). Sérialisé par worktree.
   */
  async ensureDir(project: Project, wt: Worktree): Promise<string> {
    const dir = worktreePath(project, wt);
    if ((await exists(path.join(dir, '.git'))) || (await isGitRepository(dir))) return dir;
    const pending = restoring.get(wt.id);
    if (pending) return pending;
    const task = (async () => {
      const main = await ensureWorkspace(project);
      if (!(await isGitRepository(main))) throw new AppError(`Le dossier principal du projet (${main}) n'est pas un dépôt git : impossible de recréer le worktree`);
      if (await exists(dir)) await rm(dir, { recursive: true, force: true }); // dossier sans son lien git : repris de zéro
      await git(['worktree', 'prune'], main).catch(() => undefined);
      await mkdir(worktreesRoot(project), { recursive: true });
      const how = await this.checkout(main, dir, wt.branch, 'HEAD');
      if (how === 'new') console.warn(`[worktrees] ${wt.name} : branche ${wt.branch} disparue, worktree recréé depuis le checkout principal`);
      else console.log(`[worktrees] dossier de ${wt.name} recréé (${how})`);
      return dir;
    })().finally(() => restoring.delete(wt.id));
    restoring.set(wt.id, task);
    return task;
  },

  /** Dossier de travail effectif d'une session ou d'un terminal : worktree si précisé (recréé au besoin), sinon checkout principal. */
  async resolveCwd(project: Project, worktreeId: string | null | undefined): Promise<string> {
    if (!worktreeId) return ensureWorkspace(project);
    const wt = await this.assertUsable(project, worktreeId);
    return this.ensureDir(project, wt);
  },

  /** Taille du dossier (octets) si présent, pour information. */
  async size(project: Project, wt: Worktree): Promise<number | null> {
    try {
      return (await stat(worktreePath(project, wt))).size;
    } catch {
      return null;
    }
  },
};
