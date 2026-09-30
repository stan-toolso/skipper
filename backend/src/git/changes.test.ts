import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Le dossier de travail est un dépôt git temporaire recréé pour chaque test.
const dirs = vi.hoisted(() => ({ root: '' }));
vi.mock('../files/service.js', () => ({ resolveRoot: async () => dirs.root }));
vi.mock('../settings/github.js', () => ({ githubService: { gitConfigArgs: async () => [] } }));

const { gitService, headCommitOf } = await import('./service.js');

const ref = { projectId: 'p1' };
const run = (...args: string[]) => execFileSync('git', args, { cwd: dirs.root, encoding: 'utf8' }).trim();
const write = async (rel: string, content: string) => {
  await mkdir(path.dirname(path.join(dirs.root, rel)), { recursive: true });
  await writeFile(path.join(dirs.root, rel), content);
};

beforeEach(async () => {
  dirs.root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skipper-changes-')));
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  await write('a.txt', 'un\ndeux\n');
  await write('b.txt', 'bee\n');
  await write('old.txt', 'contenu assez long pour que le renommage soit reconnu\nligne 2\nligne 3\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'départ');
});

afterEach(async () => {
  await rm(dirs.root, { recursive: true, force: true });
});

describe('modifications depuis le commit de départ', () => {
  it('liste commits, modifications non validées, suppressions, renommages et fichiers non suivis', async () => {
    const base = await headCommitOf(dirs.root);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // Commit fait par l'agent, puis modifications non validées.
    await write('a.txt', 'un\ndeux\ntrois\n');
    run('commit', '-q', '-am', 'agent');
    await write('b.txt', 'abeille\n');
    run('rm', '-q', 'old.txt');
    await write('new.txt', 'contenu assez long pour que le renommage soit reconnu\nligne 2\nligne 3\n');
    run('add', 'new.txt');
    await write('dir/untracked.txt', 'x\ny\n');

    const result = await gitService.changesSince(ref, base);
    expect(result.baseFound).toBe(true);
    expect(result.base).toBe(base);
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'b.txt', 'dir/untracked.txt', 'new.txt']);
    expect(byPath['a.txt']).toMatchObject({ status: 'M', additions: 1, deletions: 0 });
    expect(byPath['b.txt']).toMatchObject({ status: 'M', additions: 1, deletions: 1 });
    expect(byPath['new.txt']).toMatchObject({ status: 'R', origPath: 'old.txt' });
    expect(byPath['dir/untracked.txt']).toMatchObject({ status: '?', untracked: true, additions: 2 });

    const diff = await gitService.diffSince(ref, base, 'a.txt');
    expect(diff.text).toContain('+trois');
    const untracked = await gitService.diffSince(ref, base, 'dir/untracked.txt');
    expect(untracked.text).toContain('+x');
  });

  it('se replie sur HEAD quand le commit de départ est inconnu', async () => {
    await write('a.txt', 'changé\n');
    const result = await gitService.changesSince(ref, null);
    expect(result.baseFound).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual(['a.txt']);
    const missing = await gitService.changesSince(ref, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(missing.baseFound).toBe(false);
  });

  it("restaure l'état de départ : fichier modifié et commité, fichier créé, renommage", async () => {
    const base = await headCommitOf(dirs.root);
    await write('a.txt', 'agent\n');
    run('commit', '-q', '-am', 'agent');
    await write('created.txt', 'nouveau\n');
    run('add', 'created.txt');
    await write('scratch.txt', 'brouillon\n');
    run('mv', 'old.txt', 'renamed.txt');

    await gitService.restoreFromBase(ref, base, 'a.txt');
    expect(await readFile(path.join(dirs.root, 'a.txt'), 'utf8')).toBe('un\ndeux\n');
    await gitService.restoreFromBase(ref, base, 'created.txt');
    expect(existsSync(path.join(dirs.root, 'created.txt'))).toBe(false);
    await gitService.restoreFromBase(ref, base, 'scratch.txt');
    expect(existsSync(path.join(dirs.root, 'scratch.txt'))).toBe(false);
    await gitService.restoreFromBase(ref, base, 'renamed.txt', 'old.txt');
    expect(existsSync(path.join(dirs.root, 'renamed.txt'))).toBe(false);
    expect(existsSync(path.join(dirs.root, 'old.txt'))).toBe(true);

    expect((await gitService.changesSince(ref, base)).files).toEqual([]);
    // Le commit de l'agent est conservé.
    expect(run('log', '--format=%s', '-1')).toBe('agent');
  });

  it('refuse un chemin qui sort du dossier', async () => {
    await expect(gitService.restoreFromBase(ref, null, '../x')).rejects.toThrow(/Chemin invalide/);
    await expect(gitService.diffSince(ref, null, '/etc/passwd')).rejects.toThrow(/Chemin invalide/);
  });
});
