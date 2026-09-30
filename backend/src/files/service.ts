import { access, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { workspacePath } from '../projects/workspace.js';
import { worktreePath, worktreeService } from '../worktrees/service.js';

/**
 * Explorateur de fichiers d'un workspace (checkout principal d'un projet ou worktree) : lecture,
 * écriture et opérations de base, toutes confinées au dossier racine (aucun chemin ne peut en
 * sortir, même via `..` ou un lien symbolique).
 */

export type EntryKind = 'dir' | 'file' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  /** Chemin relatif à la racine, séparateur `/`. */
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: Date | null;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: Date;
  /** true si le fichier semble binaire : `content` est alors null. */
  binary: boolean;
  content: string | null;
}

export interface WorkspaceRef {
  projectId: string;
  worktreeId?: string | null;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Racine (chemin réel) du workspace ou du worktree. */
export async function resolveRoot(ref: WorkspaceRef): Promise<string> {
  const project = await projectService.get(ref.projectId);
  let dir: string;
  if (ref.worktreeId) {
    const wt = await worktreeService.get(ref.worktreeId);
    if (wt.projectId !== project.id) throw new AppError('Ce worktree appartient à un autre projet');
    dir = worktreePath(project, wt);
  } else {
    dir = workspacePath(project);
  }
  if (!(await exists(dir))) throw new NotFoundError("Le dossier n'existe pas encore sur le serveur");
  return realpath(dir);
}

/** Normalise un chemin relatif fourni par le client ("a/b/../c" -> "a/c") ; "" = racine. */
function normalizeRelative(rel: string): string {
  // Barres finales retirées avant les contrôles : "./" et "a/../" désignent aussi la racine.
  const cleaned = path.posix.normalize(rel.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/\/+$/, '');
  if (cleaned === '.' || cleaned === '') return '';
  if (cleaned.startsWith('../') || cleaned === '..') throw new AppError('Chemin hors du dossier du projet');
  return cleaned;
}

/**
 * Chemin absolu sûr : à l'intérieur de la racine, y compris après résolution des liens symboliques
 * (pour la partie du chemin qui existe déjà).
 */
async function safePath(root: string, rel: string): Promise<{ abs: string; rel: string }> {
  const cleaned = normalizeRelative(rel);
  const abs = path.join(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new AppError('Chemin hors du dossier du projet');
  // Résolution des liens : on remonte jusqu'au premier ancêtre existant.
  let probe = abs;
  while (!(await exists(probe))) probe = path.dirname(probe);
  const real = await realpath(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new AppError('Chemin hors du dossier du projet (lien symbolique)');
  return { abs, rel: cleaned };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function assertValidName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new AppError(`Nom invalide : "${name}"`);
}

export const fileService = {
  async list(ref: WorkspaceRef, rel = ''): Promise<FileEntry[]> {
    const root = await resolveRoot(ref);
    const { abs, rel: dir } = await safePath(root, rel);
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError('Dossier introuvable');
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') throw new AppError("Ce chemin n'est pas un dossier");
      throw err;
    }
    const entries = await Promise.all(
      dirents.map(async (d): Promise<FileEntry> => {
        const p = dir ? `${dir}/${d.name}` : d.name;
        const kind: EntryKind = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other';
        let size: number | null = null;
        let modifiedAt: Date | null = null;
        try {
          const s = await stat(path.join(abs, d.name));
          size = s.isFile() ? s.size : null;
          modifiedAt = s.mtime;
          // Un lien vers un dossier se parcourt comme un dossier (safePath protège des sorties de racine).
          if (kind === 'symlink' && s.isDirectory()) return { name: d.name, path: p, kind: 'dir', size: null, modifiedAt };
          if (kind === 'symlink' && s.isFile()) return { name: d.name, path: p, kind: 'file', size, modifiedAt };
        } catch {
          /* lien cassé ou fichier disparu : on l'affiche tel quel */
        }
        return { name: d.name, path: p, kind, size, modifiedAt };
      }),
    );
    const order: Record<EntryKind, number> = { dir: 0, file: 1, symlink: 2, other: 3 };
    return entries.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  },

  async read(ref: WorkspaceRef, rel: string): Promise<FileContent> {
    const root = await resolveRoot(ref);
    const { abs, rel: p } = await safePath(root, rel);
    let s;
    try {
      s = await stat(abs);
    } catch {
      throw new NotFoundError('Fichier introuvable');
    }
    if (!s.isFile()) throw new AppError("Ce chemin n'est pas un fichier");
    const base = { path: p, name: path.posix.basename(p), size: s.size, modifiedAt: s.mtime };
    if (s.size > MAX_READ_BYTES) throw new AppError(`Fichier trop volumineux pour l'éditeur (${(s.size / 1024 / 1024).toFixed(1)} Mo, maximum 2 Mo)`, 'FILE_TOO_LARGE');
    const buf = await readFile(abs);
    if (looksBinary(buf)) return { ...base, binary: true, content: null };
    return { ...base, binary: false, content: buf.toString('utf8') };
  },

  /**
   * Écrit le fichier. Si `expectedModifiedAt` est fourni et que le fichier a changé depuis,
   * refuse (FILE_CONFLICT) : l'interface propose alors de recharger ou d'écraser.
   */
  async write(ref: WorkspaceRef, rel: string, content: string, expectedModifiedAt?: Date | null): Promise<FileContent> {
    const root = await resolveRoot(ref);
    const { abs } = await safePath(root, rel);
    let current: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      current = await stat(abs);
    } catch {
      current = null;
    }
    if (current && !current.isFile()) throw new AppError("Ce chemin n'est pas un fichier");
    if (current && expectedModifiedAt && Math.abs(current.mtime.getTime() - expectedModifiedAt.getTime()) > 1) {
      throw new AppError('Le fichier a été modifié sur le serveur depuis son ouverture', 'FILE_CONFLICT');
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return this.read(ref, rel);
  },

  async create(ref: WorkspaceRef, rel: string, kind: 'dir' | 'file'): Promise<FileEntry> {
    const root = await resolveRoot(ref);
    const { abs, rel: p } = await safePath(root, rel);
    if (!p) throw new AppError('Chemin vide');
    assertValidName(path.posix.basename(p));
    if (await exists(abs)) throw new AppError('Un élément porte déjà ce nom');
    if (kind === 'dir') await mkdir(abs, { recursive: true });
    else {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, '', { flag: 'wx' });
    }
    const s = await stat(abs);
    return { name: path.posix.basename(p), path: p, kind, size: kind === 'file' ? s.size : null, modifiedAt: s.mtime };
  },

  async rename(ref: WorkspaceRef, rel: string, newRel: string): Promise<FileEntry> {
    const root = await resolveRoot(ref);
    const from = await safePath(root, rel);
    const to = await safePath(root, newRel);
    if (!from.rel || !to.rel) throw new AppError('Impossible de renommer la racine');
    assertValidName(path.posix.basename(to.rel));
    if (from.rel === '.git' || to.rel === '.git') throw new AppError('Le dossier .git ne se renomme pas');
    if (await exists(to.abs)) throw new AppError('Un élément porte déjà ce nom');
    await mkdir(path.dirname(to.abs), { recursive: true });
    await rename(from.abs, to.abs);
    const s = await stat(to.abs);
    return { name: path.posix.basename(to.rel), path: to.rel, kind: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : null, modifiedAt: s.mtime };
  },

  async delete(ref: WorkspaceRef, rel: string): Promise<boolean> {
    const root = await resolveRoot(ref);
    const { abs, rel: p } = await safePath(root, rel);
    if (!p) throw new AppError('Impossible de supprimer la racine');
    if (p === '.git') throw new AppError('Le dossier .git ne se supprime pas depuis l’explorateur');
    const s = await lstat(abs).catch(() => null);
    if (!s) throw new NotFoundError('Élément introuvable');
    await rm(abs, { recursive: true, force: false });
    return true;
  },
};
