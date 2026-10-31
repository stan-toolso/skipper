import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fusion de la base et opération en cours : dépôt git temporaire (sans remote) recréé pour chaque test.
const dirs = vi.hoisted(() => ({ root: '', cwd: '' }));
vi.mock('../files/service.js', () => ({ resolveRoot: async () => dirs.cwd }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, gitBranch: 'main', gitUrl: null }) } }));
vi.mock('../settings/github.js', () => ({ githubService: { gitConfigArgs: async () => [] } }));

const { gitService, operationOf } = await import('./service.js');

const ref = { projectId: 'p1', worksessionId: 'w1' };
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

beforeEach(async () => {
  dirs.root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skipper-merge-')));
  const r = (...a: string[]) => run(dirs.root, ...a);
  r('init', '-q', '-b', 'main');
  r('config', 'user.email', 'test@example.com');
  r('config', 'user.name', 'Test');
  await writeFile(path.join(dirs.root, 'a.txt'), 'un\n');
  await writeFile(path.join(dirs.root, 'b.txt'), 'bee\n');
  r('add', '-A');
  r('commit', '-q', '-m', 'départ');
  // La branche de travail est un worktree, comme les dossiers des sessions : .git y est un fichier.
  dirs.cwd = path.join(dirs.root, '..', `${path.basename(dirs.root)}-wt`);
  r('worktree', 'add', '-q', '-b', 'feature', dirs.cwd);
  await writeFile(path.join(dirs.cwd, 'a.txt'), 'un (branche)\n');
  run(dirs.cwd, 'commit', '-q', '-am', 'branche');
  await writeFile(path.join(dirs.root, 'a.txt'), 'un (base)\n');
  await writeFile(path.join(dirs.root, 'b.txt'), 'abeille\n');
  r('commit', '-q', '-am', 'base');
});

afterEach(async () => {
  await rm(dirs.cwd, { recursive: true, force: true });
  await rm(dirs.root, { recursive: true, force: true });
});

describe('fusion de la base et conflits', () => {
  it('un conflit laisse la fusion en cours, signalée par status', async () => {
    expect(await operationOf(dirs.cwd)).toBeNull();
    await gitService.mergeBase(ref);
    const status = await gitService.status(ref);
    expect(status.operation).toBe('merge');
    expect(status.changes.filter((c) => c.conflicted).map((c) => c.path)).toEqual(['a.txt']);
    // b.txt a fusionné sans conflit : indexé.
    expect(status.changes.find((c) => c.path === 'b.txt')).toMatchObject({ staged: true, conflicted: false });
    await expect(gitService.mergeBase(ref)).rejects.toThrow(/déjà en cours/);
  });

  it('résoudre puis valider termine la fusion : plus de conflit ni d\'opération', async () => {
    await gitService.mergeBase(ref);
    await writeFile(path.join(dirs.cwd, 'a.txt'), 'un (base et branche)\n');
    await gitService.stage(ref, ['a.txt']);
    expect((await gitService.status(ref)).changes.some((c) => c.conflicted)).toBe(false);
    await gitService.commit(ref, 'Fusion de main');
    const status = await gitService.status(ref);
    expect(status.operation).toBeNull();
    expect(status.changes).toEqual([]);
    expect(run(dirs.cwd, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3);
  });

  it('abandonner remet le dossier dans son état d\'avant la fusion', async () => {
    const before = run(dirs.cwd, 'rev-parse', 'HEAD');
    await gitService.mergeBase(ref);
    await gitService.abortOperation(ref);
    const status = await gitService.status(ref);
    expect(status.operation).toBeNull();
    expect(status.changes).toEqual([]);
    expect(run(dirs.cwd, 'rev-parse', 'HEAD')).toBe(before);
    await expect(gitService.abortOperation(ref)).rejects.toThrow(/Aucune opération/);
  });

  it('sans conflit, la fusion se termine d\'elle-même', async () => {
    await writeFile(path.join(dirs.cwd, 'a.txt'), 'un (base)\n');
    run(dirs.cwd, 'commit', '-q', '-am', 'même contenu que la base');
    await gitService.mergeBase(ref);
    const status = await gitService.status(ref);
    expect(status.operation).toBeNull();
    expect(run(dirs.cwd, 'show', 'HEAD:b.txt')).toBe('abeille');
  });

  it('détecte un rebase arrêté sur un conflit', async () => {
    try {
      run(dirs.cwd, 'rebase', 'main');
    } catch {
      /* conflit attendu */
    }
    const status = await gitService.status(ref);
    expect(status.operation).toBe('rebase');
    expect(status.changes.some((c) => c.conflicted)).toBe(true);
    await gitService.abortOperation(ref);
    expect((await gitService.status(ref)).operation).toBeNull();
  });
});
