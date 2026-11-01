import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFromPackage, parsePreviewConfig, PreviewConfigError, resolvePreviewConfig } from './config.js';
import { defaultInstallCommand, depsHash, linkSnapshot, listSnapshots, MARKER, pruneSnapshots, readMarker, saveSnapshot, scanTree, seedWorksessionDeps, writeMarker } from './deps.js';
import { freePort, labelFromHost, newHostLabel, parsePreviewTemplate, previewOrigin, PREVIEW_PORT_MIN, safeNext } from './hosts.js';
import { deriveState, parseEvents } from './state.js';

describe('configuration de l’aperçu', () => {
  it('lit .skipper/preview.json et normalise les dossiers', () => {
    const cfg = parsePreviewConfig(JSON.stringify({ command: 'npx vite --host 0.0.0.0 --port $PORT', cwd: './frontend/', install: '', env: { API_URL: 'http://localhost:4000' } }));
    expect(cfg).toMatchObject({ command: 'npx vite --host 0.0.0.0 --port $PORT', cwd: 'frontend', install: '', installCwd: null, env: { API_URL: 'http://localhost:4000' } });
  });
  it('refuse une commande absente, un dossier hors du dossier de travail et PORT dans env', () => {
    expect(() => parsePreviewConfig('{}')).toThrow(PreviewConfigError);
    expect(() => parsePreviewConfig('pas du json')).toThrow(/JSON valide/);
    expect(() => parsePreviewConfig(JSON.stringify({ command: 'x', cwd: '../ailleurs' }))).toThrow(/rester dans le dossier/);
    expect(() => parsePreviewConfig(JSON.stringify({ command: 'x', cwd: '/etc' }))).toThrow(/rester dans le dossier/);
    expect(() => parsePreviewConfig(JSON.stringify({ command: 'x', env: { PORT: '1' } }))).toThrow(/fixé par Skipper/);
  });
  it('déduit la commande des outils connus, avec hôte et port', () => {
    expect(detectFromPackage({ scripts: { dev: 'vite' } })?.command).toBe('npm run dev -- --host 0.0.0.0 --port $PORT --strictPort');
    expect(detectFromPackage({ scripts: { dev: 'next dev' } })?.command).toBe('npm run dev -- -H 0.0.0.0 -p $PORT');
    expect(detectFromPackage({ scripts: { dev: 'vite' } }, 'corepack pnpm')?.command).toBe('corepack pnpm dev --host 0.0.0.0 --port $PORT --strictPort');
    expect(detectFromPackage({ scripts: { dev: 'node server.js' } })).toBeNull();
    expect(detectFromPackage({ dependencies: { vite: '5' } })).toBeNull();
  });
});

describe('adresses des aperçus', () => {
  const t = parsePreviewTemplate('https://*.apercu.skipper.toolso.io')!;
  it('lit le gabarit et reconnaît les hôtes', () => {
    expect(t).toEqual({ protocol: 'https:', suffix: '.apercu.skipper.toolso.io', port: '' });
    expect(labelFromHost(t, 'ma-branche-skipper-3f9a1c.apercu.skipper.toolso.io')).toBe('ma-branche-skipper-3f9a1c');
    expect(labelFromHost(t, 'MA-BRANCHE.apercu.skipper.toolso.io:443')).toBe('ma-branche');
    expect(labelFromHost(t, 'skipper.toolso.io')).toBeNull();
    expect(labelFromHost(t, 'a.b.apercu.skipper.toolso.io')).toBeNull();
    expect(previewOrigin(parsePreviewTemplate('http://*.localhost:4000')!, 'x')).toBe('http://x.localhost:4000');
    expect(parsePreviewTemplate('')).toBeNull();
    expect(parsePreviewTemplate('https://apercu.exemple.fr')).toBeNull();
  });
  it('fabrique un nom DNS valide, lisible et unique', () => {
    const label = newHostLabel('Ma_Branche très longue '.repeat(5), 'skipper');
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^[a-z0-9][a-z0-9-]*-skipper-[0-9a-f]{6}$/);
    expect(labelFromHost(t, `${label}${t.suffix}`)).toBe(label);
  });
  it('attribue le premier port libre et n’accepte que des redirections locales', () => {
    expect(freePort([PREVIEW_PORT_MIN, PREVIEW_PORT_MIN + 2])).toBe(PREVIEW_PORT_MIN + 1);
    expect(safeNext('/app?x=1')).toBe('/app?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('état de l’aperçu', () => {
  const ev = (lines: string[]) => parseEvents(lines.join('\n'));
  it('suit les étapes du dernier lancement', () => {
    const events = ev(['1700000000000 begin', '1700000000100 installing', '1700000004100 installed', '1700000004200 starting']);
    expect(deriveState(events.slice(0, 2), true, false).status).toBe('INSTALLING');
    expect(deriveState(events, true, false).status).toBe('STARTING');
    const running = deriveState([...events, ...ev(['1700000006000 ready'])], true, true);
    expect(running).toMatchObject({ status: 'RUNNING', installMs: 4000 });
    expect(running.readyAt?.getTime()! - running.startedAt?.getTime()!).toBe(6000);
  });
  it('signale les échecs et le processus disparu', () => {
    expect(deriveState(ev(['1700000000000 begin', '1700000000100 installing', '1700000001000 failed install 1']), false, false)).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/installation des dépendances a échoué \(code 1\)/) });
    expect(deriveState(ev(['1700000000000 begin', '1700000000200 starting', '1700000009000 exited 137']), false, false).error).toMatch(/code 137/);
    expect(deriveState(ev(['1700000000000 begin', '1700000000200 starting']), false, false)).toMatchObject({ status: 'STOPPED', error: expect.stringMatching(/n'existe plus/) });
    expect(deriveState(ev(['1700000000000 begin', '1700000000200 starting', '1700000000300 ready', '1700000005000 stopped']), false, false)).toMatchObject({ status: 'STOPPED', error: null });
    expect(deriveState([], false, false).status).toBe('STOPPED');
  });
  it('ne regarde que le dernier lancement', () => {
    const events = ev(['1700000000000 begin', '1700000000100 failed install 1', '1700000010000 begin', '1700000010100 starting']);
    expect(deriveState(events, true, true)).toMatchObject({ status: 'RUNNING', error: null, installMs: null });
  });
});

describe('instantanés des dépendances', () => {
  let tmp: string;
  let store: string;
  const write = async (rel: string, content: string) => {
    await mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
    await writeFile(path.join(tmp, rel), content);
  };
  /** Un dossier de travail Node avec un workspace `frontend`, et ses node_modules « installés ». */
  const worktree = async (name: string, lock = '{"lockfileVersion":3}') => {
    await write(`${name}/package.json`, '{"name":"app","workspaces":["frontend"]}');
    await write(`${name}/package-lock.json`, lock);
    await write(`${name}/frontend/package.json`, '{"name":"front","scripts":{"dev":"vite"},"devDependencies":{"vite":"5"}}');
    return path.join(tmp, name);
  };
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'skipper-deps-'));
    store = path.join(tmp, '.skipper-deps');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('calcule une empreinte stable des manifestes, sans regarder node_modules', async () => {
    const a = await worktree('a');
    await write('a/node_modules/pkg/package.json', '{"name":"pkg"}');
    const scan = await scanTree(a);
    expect(scan.manifests).toEqual(['frontend/package.json', 'package-lock.json', 'package.json']);
    expect(scan.nodeModules).toEqual(['node_modules']);
    const b = await worktree('b');
    expect(await depsHash(a)).toBe(await depsHash(b));
    await write('b/package-lock.json', '{"lockfileVersion":3,"x":1}');
    expect(await depsHash(a)).not.toBe(await depsHash(b));
    await mkdir(path.join(tmp, 'vide'));
    expect(await depsHash(path.join(tmp, 'vide'))).toBeNull();
  });

  it('choisit la commande d’installation d’après le lockfile', async () => {
    const a = await worktree('a');
    expect(await defaultInstallCommand(a, false)).toMatch(/^npm ci /);
    expect(await defaultInstallCommand(a, true)).toMatch(/^npm install /);
    await write('p/package.json', '{}');
    await write('p/pnpm-lock.yaml', '');
    expect(await defaultInstallCommand(path.join(tmp, 'p'), false)).toMatch(/^corepack pnpm install --frozen-lockfile/);
  });

  it('enregistre un instantané par liens physiques et le redonne à une autre work session de même empreinte', async () => {
    const a = await worktree('a');
    await write('a/node_modules/pkg/index.js', 'module.exports = 1');
    await write('a/frontend/node_modules/vite/index.js', 'vite');
    await write('a/node_modules/.vite/deps/cache.js', 'propre à a');
    const hash = (await depsHash(a))!;
    await writeMarker(a, hash);
    expect(await saveSnapshot(store, a, hash)).toBe(true);
    expect(await saveSnapshot(store, a, hash)).toBe(false);

    const b = await worktree('b');
    expect(await linkSnapshot(store, b, hash)).toEqual({ mode: 'snapshot', from: hash });
    expect(await readFile(path.join(b, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = 1');
    expect(await readFile(path.join(b, 'frontend/node_modules/vite/index.js'), 'utf8')).toBe('vite');
    expect(await readMarker(b)).toBe(hash);
    // Même inode que l'original : aucun octet copié.
    expect((await stat(path.join(b, 'node_modules/pkg/index.js'))).ino).toBe((await stat(path.join(a, 'node_modules/pkg/index.js'))).ino);
    // Les caches d'outils du dossier d'origine ne voyagent pas.
    await expect(stat(path.join(b, 'node_modules/.vite'))).rejects.toThrow();
    // Le marqueur réécrit par renommage ne touche pas celui de l'instantané.
    await writeMarker(b, 'autre');
    expect(await readMarker(a)).toBe(hash);
    // Des node_modules déjà présents ne sont jamais remplacés.
    expect((await linkSnapshot(store, b, hash)).mode).toBe('present');
  });

  it('donne l’instantané le plus proche quand l’empreinte diffère, si on le demande', async () => {
    const a = await worktree('a');
    await write('a/node_modules/pkg/index.js', '1');
    const hash = (await depsHash(a))!;
    await saveSnapshot(store, a, hash);
    const c = await worktree('c', '{"lockfileVersion":3,"autre":true}');
    const other = (await depsHash(c))!;
    expect((await linkSnapshot(store, c, other)).mode).toBe('none');
    expect(await linkSnapshot(store, c, other, { allowNearest: true })).toEqual({ mode: 'nearest', from: hash });
    expect(await readFile(path.join(c, 'node_modules/pkg/index.js'), 'utf8')).toBe('1');
  });

  it('lie les dépendances à la création d’une work session quand l’instantané existe, et rien sinon', async () => {
    const a = await worktree('a');
    await write('a/node_modules/pkg/index.js', '1');
    expect(await seedWorksessionDeps(tmp, await worktree('sans-instantane'))).toBe('none');
    await saveSnapshot(store, a, (await depsHash(a))!);
    const d = await worktree('d');
    expect(await seedWorksessionDeps(tmp, d)).toBe('snapshot');
    expect(await readFile(path.join(d, 'node_modules', MARKER), 'utf8')).toMatch(/^[0-9a-f]{24}/);
  });

  it('ne garde que les instantanés les plus récents', async () => {
    for (let i = 0; i < 3; i++) {
      const w = await worktree(`w${i}`, `{"v":${i}}`);
      await write(`w${i}/node_modules/pkg/index.js`, String(i));
      await saveSnapshot(store, w, (await depsHash(w))!);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await listSnapshots(store)).toHaveLength(3);
    const removed = await pruneSnapshots(store, 2);
    expect(removed).toHaveLength(1);
    expect(await listSnapshots(store)).toHaveLength(2);
  });

  it('résout la configuration : fichier du dépôt d’abord, sinon détection dans un sous-dossier', async () => {
    const a = await worktree('a');
    expect(await resolvePreviewConfig(a)).toMatchObject({ cwd: 'frontend', installCwd: null, source: 'Vite détecté dans frontend/package.json' });
    await write('a/.skipper/preview.json', '{"command":"npm start","cwd":"frontend"}');
    expect(await resolvePreviewConfig(a)).toMatchObject({ command: 'npm start', source: '.skipper/preview.json' });
    await write('a/.skipper/preview.json', '{');
    await expect(resolvePreviewConfig(a)).rejects.toThrow(PreviewConfigError);
  });
});
