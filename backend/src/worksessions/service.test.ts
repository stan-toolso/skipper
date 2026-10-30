import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pas de base : le dépôt (repository) et les projets sont simulés ; git tourne pour de vrai dans des dépôts
// temporaires : un « origin » nu, le checkout principal cloné dessus, et un second clone qui fait avancer origin.
vi.mock('./repository.js', () => ({ worksessionRepository: {} }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, slug: id, gitUrl: 'x', gitBranch: null }) } }));
vi.mock('../settings/github.js', () => ({ githubService: { gitConfigArgs: async () => [] } }));

const { worksessionService, defaultStartPoint } = await import('./service.js');

let base: string;
let origin: string;
let main: string;
let other: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const commit = async (cwd: string, file: string, message: string) => {
  await writeFile(path.join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
const configure = (cwd: string) => {
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skipper-worksessions-')));
  origin = path.join(base, 'origin.git');
  main = path.join(base, 'main');
  other = path.join(base, 'other');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, other);
  configure(other);
  await commit(other, 'a.txt', 'départ');
  git(other, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', origin, main);
  configure(main);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('point de départ d’une nouvelle branche', () => {
  it('part de origin/main quand le checkout principal est en retard, et avance celui-ci', async () => {
    const behind = git(main, 'rev-parse', 'HEAD');
    const ahead = await commit(other, 'b.txt', 'fusionné sur GitHub');
    git(other, 'push', '-q');
    expect(git(main, 'rev-parse', 'HEAD')).toBe(behind);

    const dir = path.join(base, 'ws');
    const result = await worksessionService.checkout(main, dir, 'feature', { defaultBranch: null });
    expect(result).toEqual({ how: 'new', from: 'origin/main' });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(ahead);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    // Le checkout principal a été avancé (avance rapide) : il ne reste pas trois semaines en arrière.
    expect(git(main, 'rev-parse', 'HEAD')).toBe(ahead);
  });

  it('préfère la branche du projet quand elle est connue sur origin', async () => {
    git(other, 'checkout', '-q', '-b', 'develop');
    const dev = await commit(other, 'c.txt', 'develop');
    git(other, 'push', '-q', '-u', 'origin', 'develop');
    const dir = path.join(base, 'ws');
    const result = await worksessionService.checkout(main, dir, 'feature', { defaultBranch: 'develop' });
    expect(result).toEqual({ how: 'new', from: 'origin/develop' });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(dev);
  });

  it('respecte un point de départ explicite', async () => {
    const first = git(main, 'rev-parse', 'HEAD');
    await commit(other, 'b.txt', 'suite');
    git(other, 'push', '-q');
    const dir = path.join(base, 'ws');
    const result = await worksessionService.checkout(main, dir, 'feature', { base: first });
    expect(result).toEqual({ how: 'new', from: first });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(first);
  });

  it('extrait une branche qui existe déjà sur origin plutôt que d’en créer une', async () => {
    git(other, 'checkout', '-q', '-b', 'feature');
    const sha = await commit(other, 'f.txt', 'feature');
    git(other, 'push', '-q', '-u', 'origin', 'feature');
    const dir = path.join(base, 'ws');
    const result = await worksessionService.checkout(main, dir, 'feature', {});
    expect(result).toEqual({ how: 'remote', from: 'origin/feature' });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('ne perd pas de commits locaux du checkout principal (pas d’avance rapide possible) et part quand même de origin', async () => {
    const local = await commit(main, 'local.txt', 'commit local non poussé');
    const ahead = await commit(other, 'b.txt', 'origin avance');
    git(other, 'push', '-q');
    const dir = path.join(base, 'ws');
    const result = await worksessionService.checkout(main, dir, 'feature', {});
    expect(result).toEqual({ how: 'new', from: 'origin/main' });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(ahead);
    expect(git(main, 'rev-parse', 'HEAD')).toBe(local);
  });

  it('retombe sur HEAD sans origin', async () => {
    const lonely = path.join(base, 'lonely');
    git(base, 'init', '-q', '-b', 'main', lonely);
    configure(lonely);
    const sha = await commit(lonely, 'a.txt', 'seul');
    expect(await defaultStartPoint(lonely, null)).toBe('HEAD');
    const dir = path.join(base, 'ws');
    const result = await worksessionService.checkout(lonely, dir, 'feature', {});
    expect(result).toEqual({ how: 'new', from: 'HEAD' });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
  });
});
