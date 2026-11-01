import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { Worksession } from '../worksessions/types.js';

// Installation des dépendances à la création d'une work session : conteneur, base et dossiers simulés.
const root = vi.hoisted(() => ({ dir: '' }));
const runner = vi.hoisted(() => ({ execDetached: vi.fn(), exec: vi.fn() }));
const hooks = vi.hoisted(() => ({ afterCreate: [] as unknown[], beforeRetire: [] as unknown[] }));
vi.mock('../runners/index.js', () => ({ runner }));
vi.mock('../db/pool.js', () => ({ pool: {} }));
vi.mock('../projects/service.js', () => ({ projectService: {} }));
vi.mock('../worksessions/service.js', () => ({
  worksessionHooks: hooks,
  worksessionService: {},
  worksessionsRoot: (p: { slug: string }) => path.join(root.dir, `${p.slug}.worktrees`),
  worksessionPath: (p: { slug: string }, w: { name: string }) => path.join(root.dir, `${p.slug}.worktrees`, w.name),
}));

const { previewService } = await import('./service.js');
const { depsHash, depsStoreRoot, listSnapshots, writeMarker } = await import('./deps.js');

const project = { id: 'p1', slug: 'app' } as Project;
const ws = { id: 'w1', name: 'ma-branche' } as Worksession;

describe('installation des dépendances à la création d’une work session', () => {
  let dir: string;
  let state: string;
  const write = async (rel: string, content: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  };
  beforeEach(async () => {
    root.dir = await mkdtemp(path.join(os.tmpdir(), 'skipper-install-svc-'));
    dir = path.join(root.dir, 'app.worktrees', 'ma-branche');
    state = path.join(root.dir, 'app.worktrees', '.skipper-previews', 'w1');
    await write('package.json', '{"name":"app"}');
    await write('package-lock.json', '{"lockfileVersion":3}');
    runner.execDetached.mockReset().mockResolvedValue(undefined);
    runner.exec.mockReset().mockResolvedValue({ stdout: '', code: 1 });
  });
  afterEach(async () => {
    await rm(root.dir, { recursive: true, force: true });
  });

  it('est accrochée à la création des work sessions', () => {
    expect(hooks.afterCreate).toHaveLength(1);
  });

  it('lance l’installation dans le conteneur, puis enregistre l’instantané quand elle a réussi', async () => {
    const snapshot = vi.spyOn(previewService, 'snapshotAfterInstall').mockResolvedValue();
    expect(await previewService.installInBackground(project, ws)).toBe('started');
    expect(runner.execDetached).toHaveBeenCalledWith(project, dir, ['setsid', 'sh', path.join(state, 'install.sh')], {
      SKIPPER_STATE: state,
      SKIPPER_INSTALL: expect.stringMatching(/^npm ci /),
      SKIPPER_INSTALL_DIR: dir,
      SKIPPER_DEPS_HASH: await depsHash(dir),
    });
    expect(await readFile(path.join(state, 'install.sh'), 'utf8')).toMatch(/install\.exit/);
    snapshot.mockRestore();

    // Fin de l'installation simulée : marqueur et code de sortie, comme le ferait le script.
    const hash = (await depsHash(dir))!;
    await write('node_modules/pkg/index.js', '1');
    await writeMarker(dir, hash);
    await writeFile(path.join(state, 'install.exit'), '0\n');
    await previewService.snapshotAfterInstall(project, dir, state, { hash, installDir: '' }, 1);
    expect((await listSnapshots(depsStoreRoot(path.join(root.dir, 'app.worktrees')))).map((s) => s.hash)).toEqual([hash]);
  });

  it('ne fait rien quand les dépendances sont à jour, sans package.json, ou avec "install": ""', async () => {
    await write('node_modules/pkg/index.js', '1');
    await writeMarker(dir, (await depsHash(dir))!);
    expect(await previewService.installInBackground(project, ws)).toBe('up-to-date');
    await writeMarker(dir, 'autre');
    await write('.skipper/preview.json', '{"command":"npm run dev","install":""}');
    expect(await previewService.installInBackground(project, ws)).toBe('skipped');
    await rm(dir, { recursive: true });
    await mkdir(dir, { recursive: true });
    expect(await previewService.installInBackground(project, ws)).toBe('skipped');
    expect(runner.execDetached).not.toHaveBeenCalled();
  });

  it('n’en lance pas une deuxième si elle tourne encore, et fait la différence sur des dépendances déjà liées', async () => {
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'install.pid'), '42\n');
    runner.exec.mockResolvedValue({ stdout: '', code: 0 });
    expect(await previewService.installInBackground(project, ws)).toBe('running');
    expect(runner.exec).toHaveBeenCalledWith(project, ['grep', '-qs', 'install.sh', '/proc/42/cmdline']);
    runner.exec.mockResolvedValue({ stdout: '', code: 1 });
    await write('node_modules/pkg/index.js', '1');
    const snapshot = vi.spyOn(previewService, 'snapshotAfterInstall').mockResolvedValue();
    expect(await previewService.installInBackground(project, ws)).toBe('started');
    expect(runner.execDetached.mock.calls[0][3].SKIPPER_INSTALL).toMatch(/^npm install /);
    snapshot.mockRestore();
  });
});
