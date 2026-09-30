import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { resolveRoot, type WorkspaceRef } from '../files/service.js';
import { gitService, type GitChangeSince, type GitDiff } from '../git/service.js';
import type { Session } from './types.js';

/**
 * Mode de comparaison de l'onglet « Modifications » :
 * - commit : depuis le commit HEAD enregistré au premier démarrage de la session (commits de l'agent compris) ;
 * - head : modifications non validées seulement (commit de départ inconnu ou disparu du dépôt) ;
 * - mtime : dossier sans git, fichiers modifiés depuis la création de la session, sans diff.
 */
export type SessionChangesMode = 'commit' | 'head' | 'mtime';

export interface SessionChanges {
  mode: SessionChangesMode;
  baseCommit: string | null;
  files: GitChangeSince[];
  truncated: boolean;
}

/** Dossiers ignorés par le parcours d'un dossier sans git. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
/** Limites du parcours d'un dossier sans git (le serveur a peu de ressources). */
const MAX_SCANNED = 20_000;
const MAX_FILES = 500;

const refOf = (session: Session): WorkspaceRef => ({ projectId: session.projectId, worktreeId: session.worktreeId });

/** Fichiers modifiés depuis `since` dans un dossier sans git (date de modification). */
async function modifiedSince(root: string, since: Date): Promise<{ files: GitChangeSince[]; truncated: boolean }> {
  const files: GitChangeSince[] = [];
  const queue = [''];
  let scanned = 0;
  let truncated = false;
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++scanned > MAX_SCANNED || files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) queue.push(rel);
      } else if (e.isFile()) {
        const s = await stat(path.join(root, rel)).catch(() => null);
        if (!s || s.mtimeMs < since.getTime()) continue;
        const created = s.birthtimeMs > 0 && s.birthtimeMs >= since.getTime();
        files.push({ path: rel, origPath: null, status: created ? 'A' : 'M', additions: null, deletions: null, untracked: false });
      }
    }
    if (truncated) break;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

/** Modifications du dossier de travail d'une session depuis son démarrage. */
export const sessionChangesService = {
  async list(session: Session): Promise<SessionChanges> {
    const ref = refOf(session);
    if (!(await gitService.isRepo(ref))) {
      const { files, truncated } = await modifiedSince(await resolveRoot(ref), session.createdAt);
      return { mode: 'mtime', baseCommit: null, files, truncated };
    }
    const result = await gitService.changesSince(ref, session.baseCommit);
    return { mode: result.baseFound ? 'commit' : 'head', baseCommit: result.base, files: result.files, truncated: false };
  },

  async diff(session: Session, file: string, origPath?: string | null): Promise<GitDiff> {
    const ref = refOf(session);
    if (!(await gitService.isRepo(ref))) throw new AppError("Le dossier de travail n'est pas un dépôt git : pas de diff disponible");
    return gitService.diffSince(ref, session.baseCommit, file, origPath);
  },

  /** Remet le fichier dans son état du début de la session (les commits ne sont pas modifiés). */
  async discard(session: Session, file: string, origPath?: string | null): Promise<SessionChanges> {
    const ref = refOf(session);
    if (!(await gitService.isRepo(ref))) throw new AppError("Le dossier de travail n'est pas un dépôt git : impossible de restaurer l'état de départ");
    await gitService.restoreFromBase(ref, session.baseCommit, file, origPath);
    return this.list(session);
  },
};
