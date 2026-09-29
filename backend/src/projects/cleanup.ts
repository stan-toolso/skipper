import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { contextPluginDir } from '../context/skills.js';
import { runnerFor } from '../runners/index.js';
import { sessionService } from '../sessions/service.js';
import { terminalService } from '../terminals/service.js';
import { worktreeService, worktreesRoot } from '../worktrees/service.js';
import { projectService } from './service.js';
import { workspacePath } from './workspace.js';

/** Arrête et supprime toutes les sessions correspondant au filtre (par lots, la liste est paginée). */
async function deleteSessions(filter: { projectId?: string; worktreeId?: string }): Promise<number> {
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

/** Supprime un worktree avec tout ce qui y est rattaché : sessions (arrêtées), terminaux (fermés), dossier. */
export async function deleteWorktreeCascade(id: string, deleteBranch = false): Promise<boolean> {
  const wt = await worktreeService.get(id);
  await deleteSessions({ worktreeId: id });
  for (const t of (await terminalService.listByProject(wt.projectId)).filter((t) => t.worktreeId === id)) await terminalService.delete(t.id);
  return worktreeService.delete(id, deleteBranch);
}

/**
 * Supprime un projet et tout ce qui en dépend : sessions (arrêtées), terminaux (fermés), worktrees,
 * conteneur d'exécution, dossier de travail, skills générés et relais. Irréversible.
 */
export async function deleteProjectCascade(id: string): Promise<boolean> {
  const project = await projectService.get(id);
  await deleteSessions({ projectId: id });
  for (const t of await terminalService.listByProject(id)) await terminalService.delete(t.id);
  for (const w of await worktreeService.listByProject(id)) {
    await worktreeService.delete(w.id, false).catch((err) => console.error('[projects] suppression du worktree', w.name, err));
  }
  await runnerFor(project).remove(project).catch((err) => console.error('[projects] suppression du conteneur', err));
  for (const dir of [workspacePath(project), worktreesRoot(project), contextPluginDir(project), path.join(config.workspacesRoot, '.runners', project.slug)]) {
    await rm(dir, { recursive: true, force: true }).catch((err) => console.error('[projects] suppression de', dir, err));
  }
  return projectService.delete(id);
}
