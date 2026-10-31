import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { resolveRoot, type WorkspaceRef } from '../files/service.js';
import { git, gitAuthFor } from '../projects/workspace.js';

const execFileAsync = promisify(execFile);

/** Authentification git de la personne qui agit, pour les opérations distantes d'un workspace. */
async function authOf(ref: WorkspaceRef, actorId: string | null | undefined): Promise<string[]> {
  return gitAuthFor(await projectService.get(ref.projectId), actorId);
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: Date;
}

export interface GitFileChange {
  path: string;
  origPath: string | null;
  /** Lettre de statut dans l'index (M, A, D, R, C, U, .) */
  indexStatus: string;
  /** Lettre de statut dans l'arbre de travail. */
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

/** Opération git interrompue (conflits à résoudre, ou en attente de se terminer). */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  changes: GitFileChange[];
  headCommit: GitCommit | null;
  /** Fusion, rebase, cherry-pick ou revert en cours (fichiers en conflit, ou à terminer) ; null sinon. */
  operation: GitOperation | null;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  commit: GitCommit | null;
}

export interface GitDiff {
  path: string;
  staged: boolean;
  text: string;
  binary: boolean;
  truncated: boolean;
}

/** Fichier modifié depuis un commit de référence (onglet « Modifications » d'une session). */
export interface GitChangeSince {
  path: string;
  origPath: string | null;
  /** A, M, D, R, C, T ; '?' pour un fichier non suivi. */
  status: string;
  additions: number | null;
  deletions: number | null;
  untracked: boolean;
}

/** Modifications d'une branche depuis son point de divergence avec sa branche de base. */
export interface GitBranchChanges {
  /** null : HEAD détaché. */
  branch: string | null;
  baseBranch: string;
  mergeBase: string;
  commits: number;
  files: GitChangeSince[];
}

export interface GitChangesSince {
  /** Référence effectivement utilisée : le commit demandé, sinon HEAD (commit inconnu ou introuvable). */
  base: string | null;
  baseFound: boolean;
  files: GitChangeSince[];
}

const DIFF_LIMIT = 400_000;
/** Arbre vide de git : référence d'un dépôt sans aucun commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Taille au-delà de laquelle les lignes d'un fichier non suivi ne sont pas comptées. */
const COUNT_LINES_LIMIT = 1024 * 1024;

function parseCommitLine(line: string): GitCommit | null {
  const [hash, shortHash, author, date, ...subject] = line.split('\u001f');
  if (!hash) return null;
  return { hash, shortHash, author, date: new Date(date), subject: subject.join('\u001f') };
}
const LOG_FORMAT = '%H\u001f%h\u001f%an\u001f%aI\u001f%s';

/** git brut, sans lever sur code de sortie non nul (utile pour diff --no-index). */
async function gitRaw(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number; stderr?: string; message: string };
    if (typeof e.code === 'number' && e.stdout !== undefined) return { stdout: e.stdout, code: e.code };
    throw new AppError(`git ${args[0]} a échoué : ${(e.stderr || e.message).replace(/AUTHORIZATION: basic \S+/g, '***').trim()}`);
  }
}

function checkPath(p: string): string {
  if (!p || p.startsWith('/') || p.includes('\0') || p.split('/').includes('..')) throw new AppError(`Chemin invalide : ${p}`);
  return p;
}

/** Hash du commit HEAD d'un dossier, null s'il n'est pas un dépôt git ou n'a aucun commit. */
export async function headCommitOf(cwd: string): Promise<string | null> {
  const { stdout, code } = await gitRaw(['rev-parse', '--verify', '-q', 'HEAD'], cwd).catch(() => ({ stdout: '', code: 1 }));
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}

/** Référence de comparaison : `base` s'il existe encore dans le dépôt, sinon HEAD, sinon l'arbre vide. */
async function resolveBase(cwd: string, base: string | null): Promise<{ ref: string; found: boolean }> {
  if (base && /^[0-9a-f]{7,40}$/i.test(base) && (await gitRaw(['cat-file', '-e', `${base}^{commit}`], cwd)).code === 0) return { ref: base, found: true };
  return { ref: (await headCommitOf(cwd)) ?? EMPTY_TREE, found: false };
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { stdout, code } = await gitRaw(['rev-parse', '--is-inside-work-tree'], cwd).catch(() => ({ stdout: '', code: 1 }));
  return code === 0 && stdout.trim() === 'true';
}

async function countLines(file: string): Promise<number | null> {
  try {
    if ((await stat(file)).size > COUNT_LINES_LIMIT) return null;
    const buf = await readFile(file);
    if (buf.includes(0)) return null;
    if (!buf.length) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}

function tidyDiff(path: string, text: string): GitDiff {
  const binary = /^Binary files .* differ$/m.test(text);
  const truncated = text.length > DIFF_LIMIT;
  return { path, staged: false, text: truncated ? `${text.slice(0, DIFF_LIMIT)}\n… (diff tronqué)` : text, binary, truncated };
}

/** Cache court des modifications de branche (le panneau les relit souvent) ; null : pas de branche de base. */
const branchCache = new Map<string, { at: number; value: GitBranchChanges | null }>();
const BRANCH_CACHE_MS = 2000;
const cacheKey = (ref: WorkspaceRef) => `${ref.projectId}|${ref.worksessionId ?? ''}`;

/**
 * Branche de base d'un dossier : la branche du projet (origin/… puis locale), sinon la cible de origin/HEAD,
 * sinon main ou master ; null s'il n'y en a aucune (dépôt local sans remote, par exemple).
 */
async function resolveBaseBranch(cwd: string, preferred: string | null): Promise<string | null> {
  const candidates = [...(preferred ? [`origin/${preferred}`, preferred] : [])];
  const head = (await gitRaw(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], cwd)).stdout.trim();
  if (head) candidates.push(head);
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  for (const c of candidates) if ((await gitRaw(['rev-parse', '--verify', '-q', `${c}^{commit}`], cwd)).code === 0) return c;
  return null;
}

/** Marqueurs de l'opération en cours dans le dossier .git (d'un worktree aussi : `git rev-parse --git-path`). */
const OPERATION_MARKERS: Array<[GitOperation, string]> = [
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
  ['merge', 'MERGE_HEAD'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
];

/** Opération git interrompue dans le dossier, null s'il n'y en a pas. */
export async function operationOf(cwd: string): Promise<GitOperation | null> {
  const { stdout, code } = await gitRaw(['rev-parse', ...OPERATION_MARKERS.flatMap(([, marker]) => ['--git-path', marker])], cwd).catch(() => ({ stdout: '', code: 1 }));
  if (code !== 0) return null;
  const paths = stdout.split('\n').map((p) => p.trim());
  for (let i = 0; i < OPERATION_MARKERS.length; i++) {
    if (!paths[i]) continue;
    const ok = await access(path.resolve(cwd, paths[i])).then(() => true, () => false);
    if (ok) return OPERATION_MARKERS[i][0];
  }
  return null;
}

const NO_BASE_BRANCH = 'Aucune branche de base à comparer (ni la branche du projet, ni origin/HEAD, main ou master)';

export const gitService = {
  /** Point de divergence de la branche courante avec sa base ; null sans branche de base (cas normal, pas une erreur). */
  async branchBase(ref: WorkspaceRef): Promise<{ cwd: string; baseBranch: string; mergeBase: string } | null> {
    const cwd = await resolveRoot(ref);
    const project = await projectService.get(ref.projectId);
    const baseBranch = await resolveBaseBranch(cwd, project.gitBranch);
    if (!baseBranch) return null;
    const mergeBase = (await gitRaw(['merge-base', 'HEAD', baseBranch], cwd)).stdout.trim();
    if (!mergeBase) throw new AppError(`La branche courante ne partage aucun historique avec ${baseBranch}`);
    return { cwd, baseBranch, mergeBase };
  },

  /** Fichiers modifiés sur la branche depuis sa base, travail non validé compris ; null sans branche de base. */
  async branchChanges(ref: WorkspaceRef): Promise<GitBranchChanges | null> {
    const cached = branchCache.get(cacheKey(ref));
    if (cached && Date.now() - cached.at < BRANCH_CACHE_MS) return cached.value;
    const base = await this.branchBase(ref);
    if (!base) {
      branchCache.set(cacheKey(ref), { at: Date.now(), value: null });
      return null;
    }
    const { cwd, baseBranch, mergeBase } = base;
    const since = await this.changesSince(ref, mergeBase);
    const branch = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim();
    const commits = Number((await gitRaw(['rev-list', '--count', `${mergeBase}..HEAD`], cwd)).stdout.trim() || 0);
    const value: GitBranchChanges = { branch: branch === 'HEAD' ? null : branch, baseBranch, mergeBase, commits, files: since.files };
    branchCache.set(cacheKey(ref), { at: Date.now(), value });
    return value;
  },

  /**
   * Diff complet de la branche depuis sa base (`preferredBase` : branche de base d'une PR, sinon celle du projet),
   * travail non validé compris, plus le contenu des fichiers non suivis : ce que relit une revue de code.
   * Null sans branche de base.
   */
  async branchPatch(ref: WorkspaceRef, preferredBase?: string | null): Promise<{ branch: string | null; baseBranch: string; mergeBase: string; commits: number; stat: string; patch: string } | null> {
    const cwd = await resolveRoot(ref);
    const project = await projectService.get(ref.projectId);
    const baseBranch = await resolveBaseBranch(cwd, preferredBase || project.gitBranch);
    if (!baseBranch) return null;
    const mergeBase = (await gitRaw(['merge-base', 'HEAD', baseBranch], cwd)).stdout.trim();
    if (!mergeBase) throw new AppError(`La branche courante ne partage aucun historique avec ${baseBranch}`);
    const branch = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim();
    const commits = Number((await gitRaw(['rev-list', '--count', `${mergeBase}..HEAD`], cwd)).stdout.trim() || 0);
    const stat = (await gitRaw(['diff', '--stat', '-M', mergeBase, '--'], cwd)).stdout;
    let patch = (await gitRaw(['diff', '-M', mergeBase, '--'], cwd)).stdout;
    const others = (await gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], cwd)).stdout.split('\0').filter(Boolean);
    for (const p of others) patch += (await gitRaw(['diff', '--no-index', '--', '/dev/null', p], cwd)).stdout;
    return { branch: branch === 'HEAD' ? null : branch, baseBranch, mergeBase, commits, stat, patch };
  },

  /** Diff d'un fichier entre la base de la branche et l'arbre de travail. */
  async branchDiff(ref: WorkspaceRef, file: string, origPath?: string | null): Promise<GitDiff> {
    const base = await this.branchBase(ref);
    if (!base) throw new AppError(NO_BASE_BRANCH);
    return this.diffSince(ref, base.mergeBase, file, origPath);
  },

  /** Oublie les lectures en cache (après une écriture git). */
  invalidate(ref: WorkspaceRef): void {
    branchCache.delete(cacheKey(ref));
  },

  isRepo: (ref: WorkspaceRef) => resolveRoot(ref).then(isGitRepo),

  /**
   * Fichiers modifiés dans l'arbre de travail depuis le commit `base` : commits faits depuis, modifications
   * indexées ou non, fichiers non suivis (hors .gitignore). Sans `base` exploitable, compare à HEAD.
   */
  async changesSince(ref: WorkspaceRef, base: string | null): Promise<GitChangesSince> {
    const cwd = await resolveRoot(ref);
    const { ref: from, found } = await resolveBase(cwd, base);
    const files = new Map<string, GitChangeSince>();
    const names = (await gitRaw(['diff', '--name-status', '-z', '-M', from, '--'], cwd)).stdout.split('\0');
    for (let i = 0; i < names.length; i++) {
      const code = names[i];
      if (!code) continue;
      const status = code[0];
      const renamed = status === 'R' || status === 'C';
      const origPath = renamed ? names[++i] : null;
      const p = names[++i];
      if (p) files.set(p, { path: p, origPath, status, additions: null, deletions: null, untracked: false });
    }
    // numstat -z : « ajouts\tsuppressions\tchemin\0 », ou pour un renommage « ajouts\tsuppressions\t\0ancien\0nouveau\0 » ; « - » pour un binaire.
    const nums = (await gitRaw(['diff', '--numstat', '-z', '-M', from, '--'], cwd)).stdout.split('\0');
    for (let i = 0; i < nums.length; i++) {
      const m = nums[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
      if (!m) continue;
      let p = m[3];
      if (!p) {
        i += 2;
        p = nums[i];
      }
      const entry = files.get(p);
      if (entry) {
        entry.additions = m[1] === '-' ? null : Number(m[1]);
        entry.deletions = m[2] === '-' ? null : Number(m[2]);
      }
    }
    const others = (await gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], cwd)).stdout.split('\0').filter(Boolean);
    for (const p of others) {
      if (files.has(p)) continue;
      files.set(p, { path: p, origPath: null, status: '?', additions: await countLines(path.join(cwd, p)), deletions: 0, untracked: true });
    }
    return { base: from === EMPTY_TREE ? null : from, baseFound: found, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  },

  /** Diff d'un fichier entre le commit `base` (ou HEAD) et l'arbre de travail ; `origPath` pour un renommage. */
  async diffSince(ref: WorkspaceRef, base: string | null, file: string, origPath?: string | null): Promise<GitDiff> {
    const cwd = await resolveRoot(ref);
    checkPath(file);
    if (origPath) checkPath(origPath);
    const { ref: from } = await resolveBase(cwd, base);
    const tracked = (await gitRaw(['ls-files', '--error-unmatch', '--', file], cwd)).code === 0;
    const inBase = (await gitRaw(['cat-file', '-e', `${from}:${file}`], cwd)).code === 0;
    const result =
      !tracked && !inBase && !origPath
        ? await gitRaw(['diff', '--no-index', '--', '/dev/null', file], cwd)
        : await gitRaw(['diff', '-M', from, '--', ...(origPath ? [origPath] : []), file], cwd);
    return tidyDiff(file, result.stdout);
  },

  /**
   * Remet un fichier dans son état du commit `base` (index et arbre de travail), sans toucher aux commits :
   * restauré s'il existait, supprimé sinon. Pour un renommage, l'ancien chemin est restauré aussi.
   */
  async restoreFromBase(ref: WorkspaceRef, base: string | null, file: string, origPath?: string | null): Promise<void> {
    const cwd = await resolveRoot(ref);
    const { ref: from } = await resolveBase(cwd, base);
    for (const p of [file, ...(origPath ? [origPath] : [])].map(checkPath)) {
      if ((await gitRaw(['cat-file', '-e', `${from}:${p}`], cwd)).code === 0) {
        await git(['checkout', from, '--', p], cwd);
      } else if ((await gitRaw(['ls-files', '--error-unmatch', '--', p], cwd)).code === 0) {
        await git(['rm', '-f', '-q', '--', p], cwd);
      } else {
        await git(['clean', '-f', '-q', '--', p], cwd);
      }
    }
  },

  async status(ref: WorkspaceRef): Promise<GitStatus> {
    const cwd = await resolveRoot(ref);
    const { stdout } = await gitRaw(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], cwd);
    const parts = stdout.split('\0');
    const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, changes: [], headCommit: null, operation: await operationOf(cwd) };
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length);
        status.detached = head === '(detached)';
        status.branch = status.detached ? null : head;
      } else if (line.startsWith('# branch.upstream ')) status.upstream = line.slice('# branch.upstream '.length);
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
        const fields = line.split(' ');
        const xy = fields[1];
        const kind = line[0];
        // Ordinaire : 8 champs avant le chemin ; renommage : 9 (score) ; conflit : 10.
        const pathIndex = kind === '1' ? 8 : kind === '2' ? 9 : 10;
        const p = fields.slice(pathIndex).join(' ');
        const orig = kind === '2' ? parts[++i] ?? null : null;
        const x = xy[0];
        const y = xy[1];
        status.changes.push({
          path: p,
          origPath: orig,
          indexStatus: x,
          worktreeStatus: y,
          staged: kind !== 'u' && x !== '.',
          unstaged: kind !== 'u' && y !== '.',
          untracked: false,
          conflicted: kind === 'u',
        });
      } else if (line.startsWith('? ')) {
        status.changes.push({ path: line.slice(2), origPath: null, indexStatus: '?', worktreeStatus: '?', staged: false, unstaged: true, untracked: true, conflicted: false });
      }
    }
    status.changes.sort((a, b) => a.path.localeCompare(b.path));
    const head = await gitRaw(['log', '-1', `--format=${LOG_FORMAT}`], cwd);
    if (head.code === 0 && head.stdout.trim()) status.headCommit = parseCommitLine(head.stdout.trim());
    return status;
  },

  /** Diff d'un fichier : index vs HEAD (`staged`), sinon arbre de travail vs index ; fichier entier pour un non suivi. */
  async diff(ref: WorkspaceRef, path: string, staged: boolean): Promise<GitDiff> {
    const cwd = await resolveRoot(ref);
    checkPath(path);
    const tracked = (await gitRaw(['ls-files', '--error-unmatch', '--', path], cwd)).code === 0;
    let result: { stdout: string; code: number };
    if (!tracked && !staged) {
      result = await gitRaw(['diff', '--no-index', '--', '/dev/null', path], cwd);
    } else {
      result = await gitRaw(staged ? ['diff', '--cached', '--', path] : ['diff', '--', path], cwd);
    }
    let text = result.stdout;
    const binary = /^Binary files .* differ$/m.test(text);
    const truncated = text.length > DIFF_LIMIT;
    if (truncated) text = `${text.slice(0, DIFF_LIMIT)}\n… (diff tronqué)`;
    return { path, staged, text, binary, truncated };
  },

  /** Diff complet d'un commit. */
  async show(ref: WorkspaceRef, hash: string): Promise<GitDiff> {
    const cwd = await resolveRoot(ref);
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new AppError('Identifiant de commit invalide');
    const { stdout } = await gitRaw(['show', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n    %s%n%n%b', '--stat', '-p', hash], cwd);
    const truncated = stdout.length > DIFF_LIMIT;
    return { path: hash, staged: false, text: truncated ? `${stdout.slice(0, DIFF_LIMIT)}\n… (diff tronqué)` : stdout, binary: false, truncated };
  },

  async branches(ref: WorkspaceRef): Promise<GitBranch[]> {
    const cwd = await resolveRoot(ref);
    const current = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim();
    const format = `--format=%(refname:short)\u001e%(upstream:short)\u001e%(objectname)\u001e%(objectname:short)\u001e%(authorname)\u001e%(committerdate:iso-strict)\u001e%(subject)`;
    const branches: GitBranch[] = [];
    for (const [refs, remote] of [
      ['refs/heads', false],
      ['refs/remotes', true],
    ] as const) {
      const { stdout } = await gitRaw(['for-each-ref', '--sort=-committerdate', format, refs], cwd);
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [name, upstream, hash, shortHash, author, date, subject] = line.split('\u001e');
        if (name.endsWith('/HEAD')) continue;
        branches.push({ name, current: !remote && name === current, remote, upstream: upstream || null, commit: { hash, shortHash, author, date: new Date(date), subject } });
      }
    }
    return branches;
  },

  async log(ref: WorkspaceRef, limit = 30): Promise<GitCommit[]> {
    const cwd = await resolveRoot(ref);
    const { stdout, code } = await gitRaw(['log', `-n${Math.min(Math.max(limit, 1), 200)}`, `--format=${LOG_FORMAT}`], cwd);
    if (code !== 0) return [];
    return stdout.split('\n').map(parseCommitLine).filter((c): c is GitCommit => Boolean(c));
  },

  async stage(ref: WorkspaceRef, paths: string[]): Promise<void> {
    const cwd = await resolveRoot(ref);
    if (paths.length === 0) await git(['add', '-A'], cwd);
    else await git(['add', '-A', '--', ...paths.map(checkPath)], cwd);
  },

  async unstage(ref: WorkspaceRef, paths: string[]): Promise<void> {
    const cwd = await resolveRoot(ref);
    if (paths.length === 0) await git(['reset', '-q'], cwd);
    else await git(['reset', '-q', '--', ...paths.map(checkPath)], cwd);
  },

  /** Abandonne les modifications non indexées d'un fichier ; supprime un fichier non suivi. */
  async discard(ref: WorkspaceRef, paths: string[]): Promise<void> {
    const cwd = await resolveRoot(ref);
    const list = paths.map(checkPath);
    if (list.length === 0) throw new AppError('Aucun fichier indiqué');
    for (const p of list) {
      const tracked = (await gitRaw(['ls-files', '--error-unmatch', '--', p], cwd)).code === 0;
      if (tracked) await git(['checkout', '--', p], cwd);
      else await git(['clean', '-f', '-q', '--', p], cwd);
    }
  },

  async commit(ref: WorkspaceRef, message: string, stageAll = false): Promise<GitCommit | null> {
    const cwd = await resolveRoot(ref);
    if (!message.trim()) throw new AppError('Le message de commit est vide');
    if (stageAll) await git(['add', '-A'], cwd);
    const staged = (await gitRaw(['diff', '--cached', '--quiet'], cwd)).code !== 0;
    if (!staged) throw new AppError('Rien à valider : indexez des modifications d\'abord');
    await git(['commit', '-q', '-m', message.trim()], cwd);
    const head = await gitRaw(['log', '-1', `--format=${LOG_FORMAT}`], cwd);
    return parseCommitLine(head.stdout.trim());
  },

  /** `actorId` : personne qui agit, dont le compte GitHub authentifie l'accès au dépôt distant. */
  async fetch(ref: WorkspaceRef, actorId?: string | null): Promise<void> {
    const cwd = await resolveRoot(ref);
    await git(['fetch', '--prune', 'origin'], cwd, await authOf(ref, actorId));
  },

  async pull(ref: WorkspaceRef, actorId?: string | null): Promise<string> {
    const cwd = await resolveRoot(ref);
    return git(['pull', '--ff-only'], cwd, await authOf(ref, actorId));
  },

  async push(ref: WorkspaceRef, actorId?: string | null): Promise<string> {
    const cwd = await resolveRoot(ref);
    const branch = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim();
    if (branch === 'HEAD') throw new AppError('HEAD détaché : rien à pousser');
    const hasUpstream = (await gitRaw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd)).code === 0;
    const auth = await authOf(ref, actorId);
    return hasUpstream ? git(['push'], cwd, auth) : git(['push', '-u', 'origin', branch], cwd, auth);
  },

  /**
   * Fusionne la branche de base (récupérée d'abord) dans la branche courante. Un conflit n'est pas une erreur : la
   * fusion reste en cours, les fichiers en conflit apparaissent dans `status` (à résoudre, à la main ou par un agent).
   */
  async mergeBase(ref: WorkspaceRef, actorId?: string | null): Promise<void> {
    const cwd = await resolveRoot(ref);
    if (await operationOf(cwd)) throw new AppError('Une opération git est déjà en cours : terminez-la ou abandonnez-la d\'abord');
    const project = await projectService.get(ref.projectId);
    if (project.gitUrl) await git(['fetch', '--prune', 'origin'], cwd, await authOf(ref, actorId));
    const baseBranch = await resolveBaseBranch(cwd, project.gitBranch);
    if (!baseBranch) throw new AppError(NO_BASE_BRANCH);
    try {
      await execFileAsync('git', ['merge', '--no-edit', baseBranch], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      // Conflit : la fusion reste en cours, ce n'est pas une erreur. Sinon (modifications locales qui seraient écrasées…), le message de git.
      if (await operationOf(cwd)) return;
      const e = err as { stderr?: string; stdout?: string; message: string };
      throw new AppError(`La fusion de ${baseBranch} a échoué : ${(e.stderr || e.stdout || e.message).trim()}`);
    }
  },

  /** Abandonne l'opération en cours (merge, rebase, cherry-pick, revert) : le dossier revient à son état d'avant. */
  async abortOperation(ref: WorkspaceRef): Promise<void> {
    const cwd = await resolveRoot(ref);
    const op = await operationOf(cwd);
    if (!op) throw new AppError('Aucune opération git en cours');
    await git([op, '--abort'], cwd);
  },

  /** Bascule sur une branche (locale, ou distante suivie automatiquement) ; `create` la crée depuis HEAD. */
  async checkout(ref: WorkspaceRef, branch: string, create = false): Promise<void> {
    const cwd = await resolveRoot(ref);
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes('..')) throw new AppError(`Nom de branche invalide : ${branch}`);
    if (create) await git(['checkout', '-q', '-b', branch], cwd);
    else if (branch.startsWith('origin/')) await git(['checkout', '-q', '--track', branch], cwd);
    else await git(['checkout', '-q', branch], cwd);
  },
};
