import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { contextPluginDir } from '../context/skills.js';
import { runner } from '../runners/index.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import { terminalService } from '../terminals/service.js';
import { worktreeService, worktreesRoot } from '../worktrees/service.js';
import type { Worktree } from '../worktrees/types.js';
import { projectService } from './service.js';
import { workspacePath } from './workspace.js';

/** Arrête et supprime toutes les sessions correspondant au filtre (par lots, la liste est paginée). */
async function deleteSessions(filter: { projectId?: string; worktreeId?: string; archived?: 'exclude' | 'only' | 'all' }): Promise<number> {
  let count = 0;
  for (;;) {
    const batch = await sessionService.list({ ...filter, limit: 200 });
    if (batch.length === 0) return count;
    for (const s of batch) {
      await sessionService.delete(s.id); // arrête la session si elle tourne encore
      count++;
    }
  }
}

/** Ferme et supprime les terminaux d'un worktree. */
async function deleteTerminals(projectId: string, worktreeId: string): Promise<void> {
  for (const t of (await terminalService.listByProject(projectId)).filter((t) => t.worktreeId === worktreeId)) await terminalService.delete(t.id);
}

/**
 * Supprime un worktree avec tout ce qui y est rattaché : sessions actives (arrêtées), terminaux (fermés),
 * dossier. Les sessions déjà archivées restent dans l'historique, sans leur worktree.
 */
export async function deleteWorktreeCascade(id: string, deleteBranch = false): Promise<boolean> {
  const wt = await worktreeService.get(id);
  await deleteSessions({ worktreeId: id, archived: 'exclude' });
  await deleteTerminals(wt.projectId, id);
  return worktreeService.delete(id, deleteBranch);
}

/** Archive un worktree : ses sessions actives sont archivées (arrêtées si elles tournent), ses terminaux fermés. */
export async function archiveWorktreeCascade(id: string): Promise<Worktree> {
  const wt = await worktreeService.get(id);
  return worktreeService.archive(id, async (worktreeId, at) => {
    for (const s of await sessionService.list({ worktreeId, archived: 'exclude', limit: 500 })) {
      if (s.status === 'running' || s.status === 'queued') await sessionService.stop(s.id).catch(() => undefined);
    }
    await sessionRepository.archiveByWorktree(worktreeId, at);
    await deleteTerminals(wt.projectId, worktreeId);
  });
}

/** Restaure un worktree archivé et les sessions archivées avec lui. */
export async function restoreWorktreeCascade(id: string): Promise<Worktree> {
  const before = await worktreeService.get(id);
  const wt = await worktreeService.restore(id);
  if (before.archivedAt) await sessionRepository.unarchiveByWorktree(id, before.archivedAt);
  return wt;
}

/**
 * Supprime un projet et tout ce qui en dépend : sessions (arrêtées, archivées comprises), terminaux (fermés),
 * worktrees, conteneur d'exécution, dossier de travail, skills générés et relais. Irréversible.
 */
export async function deleteProjectCascade(id: string): Promise<boolean> {
  const project = await projectService.get(id);
  await deleteSessions({ projectId: id, archived: 'all' });
  for (const t of await terminalService.listByProject(id)) await terminalService.delete(t.id);
  for (const w of await worktreeService.listByProject(id, { includeArchived: true })) {
    await worktreeService.delete(w.id, false).catch((err) => console.error('[projects] suppression du worktree', w.name, err));
  }
  await runner.remove(project).catch((err) => console.error('[projects] suppression du conteneur', err));
  for (const dir of [workspacePath(project), worktreesRoot(project), contextPluginDir(project), path.join(config.workspacesRoot, '.runners', project.slug)]) {
    await rm(dir, { recursive: true, force: true }).catch((err) => console.error('[projects] suppression de', dir, err));
  }
  return projectService.delete(id);
}
