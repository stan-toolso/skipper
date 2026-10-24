import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { contextPluginDir } from '../context/skills.js';
import { runner } from '../runners/index.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import { terminalService } from '../terminals/service.js';
import { worksessionService, worksessionsRoot } from '../worksessions/service.js';
import { worksessionLabel, type Worksession } from '../worksessions/types.js';
import { projectService } from './service.js';
import { workspacePath } from './workspace.js';

/** Arrête et supprime toutes les sessions correspondant au filtre (par lots, la liste est paginée). */
async function deleteSessions(filter: { projectId?: string; worksessionId?: string; archived?: 'exclude' | 'only' | 'all' }): Promise<number> {
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

/** Ferme et supprime les terminaux d'une work session. */
async function deleteTerminals(projectId: string, worksessionId: string): Promise<void> {
  for (const t of (await terminalService.listByProject(projectId)).filter((t) => t.worksessionId === worksessionId)) await terminalService.delete(t.id);
}

/**
 * Retire une work session en gardant l'historique : ses sessions sont archivées (transcript, coût, planification et lien
 * de tâche conservés), détachées de la work session dont elles gardent le nom (`formerWorksession`), ses terminaux sont fermés,
 * son dossier et son enregistrement supprimés. Une session qui tourne encore est arrêtée si `stopSessions`, sinon
 * la suppression est refusée avant d'avoir touché à quoi que ce soit.
 */
export async function removeWorksessionKeepingSessions(id: string, opts: { deleteBranch?: boolean; stopSessions?: boolean } = {}): Promise<{ archivedSessionIds: string[] }> {
  const wt = await worksessionService.get(id);
  const live = (await sessionService.list({ worksessionId: id, archived: 'all', limit: 500 })).filter((s) => s.status === 'running' || s.status === 'queued');
  if (live.length && !opts.stopSessions) throw new AppError(`Des sessions tournent encore dans cette work session (${live.length}) : arrêtez-les d'abord`);
  for (const s of live) await sessionService.stop(s.id).catch(() => undefined);
  const archivedSessionIds = await sessionRepository.detachWorksession(id, new Date(), { name: wt.name, branch: wt.branch, label: worksessionLabel(wt) });
  await deleteTerminals(wt.projectId, id);
  await worksessionService.delete(id, opts.deleteBranch ?? false);
  return { archivedSessionIds };
}

/**
 * Supprime une work session (interface) : ses sessions sont arrêtées si elles tournent puis archivées avec le souvenir du
 * worksession (voir `removeWorksessionKeepingSessions`) ; avec `deleteSessions`, elles sont supprimées définitivement,
 * historique compris (les sessions déjà archivées restent). Terminaux fermés, dossier supprimé.
 */
export async function deleteWorksessionCascade(id: string, deleteBranch = false, opts: { deleteSessions?: boolean } = {}): Promise<boolean> {
  if (!opts.deleteSessions) {
    await removeWorksessionKeepingSessions(id, { deleteBranch, stopSessions: true });
    return true;
  }
  const wt = await worksessionService.get(id);
  await deleteSessions({ worksessionId: id, archived: 'exclude' });
  await deleteTerminals(wt.projectId, id);
  return worksessionService.delete(id, deleteBranch);
}

/** Archive une work session : ses sessions actives sont archivées (arrêtées si elles tournent), ses terminaux fermés. */
export async function archiveWorksessionCascade(id: string): Promise<Worksession> {
  const wt = await worksessionService.get(id);
  return worksessionService.archive(id, async (worksessionId, at) => {
    for (const s of await sessionService.list({ worksessionId, archived: 'exclude', limit: 500 })) {
      if (s.status === 'running' || s.status === 'queued') await sessionService.stop(s.id).catch(() => undefined);
    }
    await sessionRepository.archiveByWorksession(worksessionId, at);
    await deleteTerminals(wt.projectId, worksessionId);
  });
}

/** Restaure une work session archivée et les sessions archivées avec elle. */
export async function restoreWorksessionCascade(id: string): Promise<Worksession> {
  const before = await worksessionService.get(id);
  const wt = await worksessionService.restore(id);
  if (before.archivedAt) await sessionRepository.unarchiveByWorksession(id, before.archivedAt);
  return wt;
}

/**
 * Supprime un projet et tout ce qui en dépend : sessions (arrêtées, archivées comprises), terminaux (fermés),
 * worksessions, conteneur d'exécution, dossier de travail, skills générés et relais. Irréversible.
 */
export async function deleteProjectCascade(id: string): Promise<boolean> {
  const project = await projectService.get(id);
  await deleteSessions({ projectId: id, archived: 'all' });
  for (const t of await terminalService.listByProject(id)) await terminalService.delete(t.id);
  for (const w of await worksessionService.listByProject(id, { includeArchived: true })) {
    await worksessionService.delete(w.id, false).catch((err) => console.error('[projects] suppression de la work session', w.name, err));
  }
  await runner.remove(project).catch((err) => console.error('[projects] suppression du conteneur', err));
  for (const dir of [workspacePath(project), worksessionsRoot(project), contextPluginDir(project), path.join(config.workspacesRoot, '.runners', project.slug)]) {
    await rm(dir, { recursive: true, force: true }).catch((err) => console.error('[projects] suppression de', dir, err));
  }
  return projectService.delete(id);
}
