import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import { resolveRoot, type WorkspaceRef } from '../files/service.js';
import { git } from '../projects/workspace.js';
import { githubService } from '../settings/github.js';

const execFileAsync = promisify(execFile);

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

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  changes: GitFileChange[];
  headCommit: GitCommit | null;
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

const DIFF_LIMIT = 400_000;

function parseCommitLine(line: string): GitCommit | null {
  const [hash, shortHash, author, date, ...subject] = line.split('\u001f');
  if (!hash) return null;
  return { hash, shortHash, author, date: new Date(date), subject: subject.join('\u001f') };
}
const LOG_FORMAT = '%H\u001f%h\u001f%an\u001f%aI\u001f%s';

/** git brut, sans lever sur code de sortie non nul (utile pour diff --no-index). */
async function gitRaw(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  const auth = await githubService.gitConfigArgs().catch(() => []);
  try {
    const { stdout } = await execFileAsync('git', [...auth, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
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

export const gitService = {
  async status(ref: WorkspaceRef): Promise<GitStatus> {
    const cwd = await resolveRoot(ref);
    const { stdout } = await gitRaw(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], cwd);
    const parts = stdout.split('\0');
    const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, changes: [], headCommit: null };
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

  async fetch(ref: WorkspaceRef): Promise<void> {
    const cwd = await resolveRoot(ref);
    await git(['fetch', '--prune', 'origin'], cwd);
  },

  async pull(ref: WorkspaceRef): Promise<string> {
    const cwd = await resolveRoot(ref);
    return git(['pull', '--ff-only'], cwd);
  },

  async push(ref: WorkspaceRef): Promise<string> {
    const cwd = await resolveRoot(ref);
    const branch = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim();
    if (branch === 'HEAD') throw new AppError('HEAD détaché : rien à pousser');
    const hasUpstream = (await gitRaw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd)).code === 0;
    return hasUpstream ? git(['push'], cwd) : git(['push', '-u', 'origin', branch], cwd);
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
