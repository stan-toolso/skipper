import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError, NotFoundError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { gitAuthFor, isGitRepository, workspacePath } from '../projects/workspace.js';

const execFileAsync = promisify(execFile);

/**
 * Consultation en lecture du dépôt d'un projet (page « Dépôt ») : références, historique, détail d'un commit, arbre
 * et fichiers à une révision. On lit le checkout principal et ses références `origin/*` (dépôt GitHub, ou Forgejo pour
 * un projet hébergé), rafraîchies par un fetch au plus toutes les minutes.
 */

export interface RepoRef {
  name: string;
  kind: 'branch' | 'tag';
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: Date;
  isDefault: boolean;
}

export interface RepoCommit {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: Date;
  parents: string[];
}

export interface RepoCommitFile {
  path: string;
  origPath: string | null;
  /** A, M, D, R, C, T. */
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface RepoCommitDetail {
  commit: RepoCommit;
  files: RepoCommitFile[];
  diff: string;
  truncated: boolean;
}

export interface RepoEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink' | 'submodule';
  size: number | null;
}

export interface RepoFile {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

const DIFF_LIMIT = 400_000;
const FILE_LIMIT = 2 * 1024 * 1024;
const FETCH_THROTTLE_MS = 60_000;
const lastFetch = new Map<string, number>();
const COMMIT_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b%x1e';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new AppError(`git ${args[0]} a échoué : ${(e.stderr || e.message).trim()}`);
  }
}

/** Sortie binaire limitée : les `limit` premiers octets, et si le flux allait au-delà. */
function gitBuffer(args: string[], cwd: string, limit: number): Promise<{ data: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      if (truncated) return;
      size += c.length;
      chunks.push(c);
      if (size >= limit) {
        truncated = size > limit;
        child.kill();
      }
    });
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', (e) => reject(new AppError(e.message)));
    child.on('close', (code) => {
      if (code !== 0 && !truncated && size === 0) return reject(new AppError(`git ${args[0]} a échoué : ${err.trim() || `code ${code}`}`));
      resolve({ data: Buffer.concat(chunks).subarray(0, limit), truncated });
    });
  });
}

function parseCommits(out: string): RepoCommit[] {
  return out
    .split('\u001e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [hash, shortHash, author, email, date, parents, subject, ...body] = rec.split('\u001f');
      return { hash, shortHash, author, email, date: new Date(date), parents: parents ? parents.split(' ') : [], subject, body: body.join('\u001f').trim() };
    });
}

function checkRef(ref: string): string {
  const r = ref.trim();
  if (!r || r.startsWith('-') || r.includes('..') || r.includes('\0') || !/^[A-Za-z0-9][A-Za-z0-9._\/@-]*$/.test(r)) throw new AppError(`Référence invalide : ${ref}`);
  return r;
}

function checkPath(p: string): string {
  const cleaned = path.posix.normalize(p.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/\/+$/, '');
  if (cleaned === '.' || cleaned === '') return '';
  if (cleaned.startsWith('../') || cleaned === '..' || cleaned.includes('\0')) throw new AppError(`Chemin invalide : ${p}`);
  return cleaned;
}

/** Dépôt à consulter : le checkout principal (références origin/*). */
async function repoOf(project: Project): Promise<{ cwd: string; hosted: boolean }> {
  if (!project.gitUrl) throw new AppError("Ce projet n'a pas de dépôt git");
  const cwd = workspacePath(project);
  if (!(await exists(cwd)) || !(await isGitRepository(cwd))) throw new NotFoundError("Le dépôt n'a pas encore été récupéré sur le serveur");
  return { cwd, hosted: false };
}

/** Commit désigné par un nom de branche, de tag ou un hash, dans l'espace de noms du dépôt consulté. */
async function resolveRef(cwd: string, hosted: boolean, ref: string): Promise<string> {
  const r = checkRef(ref);
  const candidates = hosted ? [`refs/heads/${r}`, `refs/tags/${r}`] : [`refs/remotes/origin/${r}`, `refs/heads/${r}`, `refs/tags/${r}`];
  if (/^[0-9a-f]{4,40}$/i.test(r)) candidates.push(r);
  for (const c of candidates) {
    const hash = await gitOut(['rev-parse', '--verify', '-q', `${c}^{commit}`], cwd).catch(() => '');
    if (hash.trim()) return hash.trim();
  }
  throw new NotFoundError(`Référence introuvable : ${ref}`);
}

export const repoBrowser = {
  /** Projet distant : fetch des références au plus toutes les minutes (silencieux en cas d'échec). `force` ignore le délai. */
  async refresh(project: Project, actorId: string | null | undefined, force = false): Promise<void> {
    if (!project.gitUrl) return;
    const now = Date.now();
    if (!force && now - (lastFetch.get(project.id) ?? 0) < FETCH_THROTTLE_MS) return;
    lastFetch.set(project.id, now);
    const cwd = workspacePath(project);
    if (!(await exists(cwd)) || !(await isGitRepository(cwd))) return;
    const auth = await gitAuthFor(project, actorId);
    await execFileAsync('git', [...auth, 'fetch', '--prune', 'origin'], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).catch(() => undefined);
  },

  /** Branches (la principale d'abord) puis tags, les plus récents en tête. */
  async refs(project: Project): Promise<RepoRef[]> {
    const { cwd, hosted } = await repoOf(project);
    const format = '--format=%(refname)%1e%(objectname)%1e%(objectname:short)%1e%(*authorname)%(authorname)%1e%(*committerdate:iso-strict)%(committerdate:iso-strict)%1e%(*subject)%(subject)';
    const head = hosted ? (await gitOut(['symbolic-ref', '-q', 'HEAD'], cwd).catch(() => '')).trim().replace(/^refs\/heads\//, '') : (await gitOut(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], cwd).catch(() => '')).trim().replace(/^refs\/remotes\/origin\//, '');
    const defaultBranch = project.gitBranch?.trim() || head || 'main';
    const out = await gitOut(['for-each-ref', '--sort=-committerdate', format, hosted ? 'refs/heads' : 'refs/remotes/origin', 'refs/tags'], cwd);
    const refs: RepoRef[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [refname, hash, shortHash, author, date, subject] = line.split('\u001e');
      let kind: RepoRef['kind'];
      let name: string;
      if (refname.startsWith('refs/tags/')) {
        kind = 'tag';
        name = refname.slice('refs/tags/'.length);
      } else {
        kind = 'branch';
        name = refname.replace(/^refs\/(heads|remotes\/origin)\//, '');
        if (name === 'HEAD') continue;
      }
      refs.push({ name, kind, hash, shortHash, author, date: new Date(date), subject, isDefault: kind === 'branch' && name === defaultBranch });
    }
    refs.sort((a, b) => (a.kind === b.kind ? Number(b.isDefault) - Number(a.isDefault) : a.kind === 'branch' ? -1 : 1));
    return refs;
  },

  async log(project: Project, ref: string, limit = 50, skip = 0, filePath?: string | null): Promise<RepoCommit[]> {
    const { cwd, hosted } = await repoOf(project);
    const hash = await resolveRef(cwd, hosted, ref);
    const args = ['log', `-n${Math.min(Math.max(limit, 1), 200)}`, `--skip=${Math.max(skip, 0)}`, `--format=${COMMIT_FORMAT}`, hash];
    const p = filePath ? checkPath(filePath) : '';
    if (p) args.push('--', p);
    return parseCommits(await gitOut(args, cwd));
  },

  /** Détail d'un commit : métadonnées, fichiers (statut, lignes) et diff complet (tronqué au-delà de 400 Ko). */
  async commit(project: Project, hash: string): Promise<RepoCommitDetail> {
    const { cwd } = await repoOf(project);
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new AppError('Identifiant de commit invalide');
    const [commit] = parseCommits(await gitOut(['log', '-1', `--format=${COMMIT_FORMAT}`, hash], cwd).catch(() => ''));
    if (!commit) throw new NotFoundError('Commit introuvable');
    const files = new Map<string, RepoCommitFile>();
    // Statuts (-z : champs séparés par NUL ; un renommage ou une copie a deux chemins), puis compte des lignes.
    const status = (await gitOut(['show', '--format=', '--name-status', '-z', '-M', hash], cwd)).split('\0');
    for (let i = 0; i < status.length; ) {
      const st = status[i++];
      if (!st) continue;
      const code = st[0];
      const first = status[i++] ?? '';
      const second = code === 'R' || code === 'C' ? status[i++] ?? '' : null;
      const file = second !== null ? second : first;
      files.set(file, { path: file, origPath: second !== null ? first : null, status: code, additions: null, deletions: null });
    }
    const numstat = (await gitOut(['show', '--format=', '--numstat', '-z', '-M', hash], cwd)).split('\0');
    for (let i = 0; i < numstat.length; ) {
      const rec = numstat[i++];
      if (!rec) continue;
      const [add, del, inline] = rec.split('\t');
      let file = inline ?? '';
      if (!file) {
        i++; // ancien chemin
        file = numstat[i++] ?? '';
      }
      const entry = files.get(file);
      if (entry) {
        entry.additions = add === '-' ? null : Number(add);
        entry.deletions = del === '-' ? null : Number(del);
      }
    }
    const diff = await gitOut(['show', '--format=', '-p', '-M', hash], cwd);
    const truncated = diff.length > DIFF_LIMIT;
    return { commit, files: [...files.values()], diff: truncated ? `${diff.slice(0, DIFF_LIMIT)}\n… (diff tronqué)` : diff, truncated };
  },

  /** Entrées d'un dossier à une révision : dossiers d'abord, puis fichiers, par nom. */
  async tree(project: Project, ref: string, dirPath = ''): Promise<RepoEntry[]> {
    const { cwd, hosted } = await repoOf(project);
    const hash = await resolveRef(cwd, hosted, ref);
    const p = checkPath(dirPath);
    const out = await gitOut(['ls-tree', '-l', '-z', `${hash}:${p}`], cwd).catch(() => {
      throw new NotFoundError(`Dossier introuvable à cette révision : ${p || '/'}`);
    });
    const entries: RepoEntry[] = [];
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, , sizeText] = rec.slice(0, tab).split(/\s+/);
      const name = rec.slice(tab + 1);
      const kind: RepoEntry['kind'] = type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
      entries.push({ name, path: p ? `${p}/${name}` : name, kind, size: sizeText && sizeText !== '-' ? Number(sizeText) : null });
    }
    entries.sort((a, b) => (a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name, 'fr') : a.kind === 'dir' ? -1 : 1);
    return entries;
  },

  /** Contenu d'un fichier à une révision (2 Mo au plus ; un fichier binaire n'est pas renvoyé). */
  async file(project: Project, ref: string, filePath: string): Promise<RepoFile> {
    const { cwd, hosted } = await repoOf(project);
    const hash = await resolveRef(cwd, hosted, ref);
    const p = checkPath(filePath);
    if (!p) throw new AppError('Chemin de fichier attendu');
    const type = (await gitOut(['cat-file', '-t', `${hash}:${p}`], cwd).catch(() => '')).trim();
    if (type !== 'blob') throw new NotFoundError(`Fichier introuvable à cette révision : ${p}`);
    const size = Number((await gitOut(['cat-file', '-s', `${hash}:${p}`], cwd)).trim());
    const { data, truncated } = await gitBuffer(['cat-file', 'blob', `${hash}:${p}`], cwd, FILE_LIMIT);
    const binary = data.subarray(0, 8000).includes(0);
    return { path: p, content: binary ? '' : data.toString('utf8'), size, binary, truncated: truncated || size > data.length };
  },
};
