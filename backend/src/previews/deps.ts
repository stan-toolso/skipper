import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

/**
 * Réutilisation des dépendances d'un dossier de travail à l'autre.
 *
 * Chaque work session est un dossier neuf : sans rien faire, chaque aperçu (et chaque agent qui veut typechecker)
 * réinstalle des centaines de Mo de `node_modules`. Deux mécanismes accélèrent ça :
 *
 * - **Instantanés par empreinte** : après une installation réussie, les `node_modules` du dossier sont copiés par
 *   liens physiques (`cp -al` : quelques secondes, aucun espace disque en plus) dans
 *   `<projet>.worktrees/.skipper-deps/<empreinte>/`, l'empreinte étant celle des lockfiles et package.json. Un dossier
 *   de travail qui a la même empreinte reçoit ces `node_modules` de la même façon, sans rien installer ; s'il en a une
 *   autre, il reçoit l'instantané le plus récent et l'installation n'a que la différence à faire. Le magasin est dans le
 *   même volume que les work sessions (les liens physiques ne traversent pas les points de montage).
 * - **Caches persistants** des gestionnaires de paquets (`~/.npm`, `~/.cache`, où est aussi rangé le magasin pnpm) dans le conteneur, montés
 *   depuis `.runners/<projet>/cache` (voir runners/docker.ts) au lieu du tmpfs du dossier personnel.
 *
 * Les fichiers liés sont partagés : un outil qui modifierait un fichier de `node_modules` **en place** le modifierait
 * aussi dans l'instantané. npm, pnpm et yarn remplacent les fichiers (suppression puis écriture), ce qui casse le lien
 * sans toucher à l'original ; le marqueur d'empreinte est écrit de la même façon (fichier temporaire puis renommage).
 */

/** Fichiers qui déterminent le contenu des `node_modules`. */
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', '.npmrc', 'pnpm-workspace.yaml']);
/** Profondeur maximale explorée (racine = 0) : `packages/app/package.json` est à 2. */
const MAX_DEPTH = 3;
/** Instantanés gardés par projet (les plus récemment utilisés). */
export const SNAPSHOTS_KEPT = 4;
/** Marqueur posé dans les `node_modules` de la racine d'installation : empreinte des dépendances installées. */
export const MARKER = '.skipper-deps';
/** Sous-dossiers de `node_modules` écrits par les outils au fil de l'eau, propres à un dossier de travail. */
const VOLATILE = ['.vite', '.cache', '.vitest', '.tmp'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.turbo', '.cache']);

export const depsStoreRoot = (worksessionsRoot: string) => path.join(worksessionsRoot, '.skipper-deps');

const exists = (p: string) => access(p).then(() => true, () => false);

/** Manifestes (chemins relatifs, triés) et dossiers `node_modules` présents sous `root`. */
export async function scanTree(root: string): Promise<{ manifests: string[]; nodeModules: string[] }> {
  const manifests: string[] = [];
  const nodeModules: string[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'node_modules') nodeModules.push(child);
        else if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && depth < MAX_DEPTH) await walk(child, depth + 1);
      } else if (e.isFile() && MANIFESTS.has(e.name)) {
        manifests.push(child);
      }
    }
  };
  await walk('', 0);
  return { manifests: manifests.sort(), nodeModules: nodeModules.sort() };
}

/** Empreinte des dépendances : chemins et contenus des manifestes. Null sans aucun package.json (pas un projet Node). */
export async function depsHash(root: string, manifests?: string[]): Promise<string | null> {
  const files = manifests ?? (await scanTree(root)).manifests;
  if (!files.some((f) => path.posix.basename(f) === 'package.json')) return null;
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0`);
    h.update(await readFile(path.join(root, f)).catch(() => Buffer.alloc(0)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

/** Commande d'installation déduite du lockfile de `dir` ; `incremental` : des `node_modules` sont déjà là. */
export async function defaultInstallCommand(dir: string, incremental: boolean): Promise<string | null> {
  const has = (f: string) => exists(path.join(dir, f));
  if (!(await has('package.json'))) return null;
  if (await has('pnpm-lock.yaml')) return 'corepack pnpm install --frozen-lockfile --prefer-offline --store-dir ~/.cache/pnpm-store';
  if (await has('yarn.lock')) return 'corepack yarn install --frozen-lockfile --prefer-offline';
  if (await has('package-lock.json')) {
    // `npm ci` repart de zéro (il supprime node_modules) : sur des dépendances déjà là, `npm install` ne fait que la différence.
    return incremental ? 'npm install --prefer-offline --no-audit --no-fund' : 'npm ci --prefer-offline --no-audit --no-fund';
  }
  return 'npm install --prefer-offline --no-audit --no-fund';
}

/** Empreinte enregistrée dans les `node_modules` d'un dossier (dernière installation réussie), ou null. */
export async function readMarker(installDir: string): Promise<string | null> {
  const v = await readFile(path.join(installDir, 'node_modules', MARKER), 'utf8').catch(() => null);
  return v?.trim() || null;
}

/** Écrit le marqueur par renommage : jamais en place, le fichier peut être un lien vers un instantané. */
export async function writeMarker(installDir: string, hash: string): Promise<void> {
  const dir = path.join(installDir, 'node_modules');
  if (!(await exists(dir))) return;
  const tmp = path.join(dir, `${MARKER}.${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, `${hash}\n`);
  await rename(tmp, path.join(dir, MARKER));
}

interface SnapshotMeta {
  hash: string;
  /** Dossiers `node_modules` de l'instantané, relatifs à la racine du dossier de travail. */
  dirs: string[];
  createdAt: string;
}

async function readMeta(store: string, hash: string): Promise<SnapshotMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(store, hash, 'meta.json'), 'utf8')) as SnapshotMeta;
  } catch {
    return null;
  }
}

/** Instantanés du magasin, le plus récemment utilisé d'abord. */
export async function listSnapshots(store: string): Promise<{ hash: string; usedAt: number }[]> {
  let names: string[];
  try {
    names = await readdir(store);
  } catch {
    return [];
  }
  const out: { hash: string; usedAt: number }[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{24}$/.test(name)) continue;
    const s = await stat(path.join(store, name, 'meta.json')).catch(() => null);
    if (s) out.push({ hash: name, usedAt: s.mtimeMs });
  }
  return out.sort((a, b) => b.usedAt - a.usedAt);
}

/** Copie par liens physiques (`cp -al`), préserve les liens symboliques sans les suivre. */
async function linkCopy(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await execFileAsync('cp', ['-al', from, to], { timeout: 180_000 });
}

export type DepsMode = 'snapshot' | 'nearest' | 'present' | 'none';

/**
 * Donne au dossier de travail les `node_modules` d'un instantané : celui de son empreinte s'il existe (`snapshot` :
 * rien à installer), sinon le plus récent (`nearest` : l'installation fera la différence) si `allowNearest`. Ne touche
 * à rien si des `node_modules` sont déjà présents (`present`) ; `none` : aucun instantané utilisable.
 */
export async function linkSnapshot(store: string, root: string, hash: string, opts: { allowNearest?: boolean } = {}): Promise<{ mode: DepsMode; from: string | null }> {
  const { nodeModules } = await scanTree(root);
  if (nodeModules.length) return { mode: 'present', from: null };
  let chosen = (await readMeta(store, hash)) ? hash : null;
  let mode: DepsMode = 'snapshot';
  if (!chosen && opts.allowNearest) {
    chosen = (await listSnapshots(store))[0]?.hash ?? null;
    mode = 'nearest';
  }
  if (!chosen) return { mode: 'none', from: null };
  const meta = await readMeta(store, chosen);
  if (!meta) return { mode: 'none', from: null };
  for (const dir of meta.dirs) {
    // Un package.json disparu (workspace supprimé sur cette branche) : son node_modules n'a rien à faire ici.
    if (!(await exists(path.join(root, path.dirname(dir), 'package.json')))) continue;
    await linkCopy(path.join(store, chosen, 'tree', dir), path.join(root, dir));
  }
  const now = new Date();
  await utimes(path.join(store, chosen, 'meta.json'), now, now).catch(() => undefined);
  return { mode, from: chosen };
}

/**
 * Enregistre les `node_modules` du dossier de travail comme instantané de `hash` (s'il n'existe pas déjà), puis ne garde
 * que les `SNAPSHOTS_KEPT` plus récents. Écrit dans un dossier temporaire puis renommé : un instantané est complet ou absent.
 */
export async function saveSnapshot(store: string, root: string, hash: string): Promise<boolean> {
  if (await readMeta(store, hash)) {
    const now = new Date();
    await utimes(path.join(store, hash, 'meta.json'), now, now).catch(() => undefined);
    return false;
  }
  const { nodeModules } = await scanTree(root);
  if (!nodeModules.length) return false;
  await mkdir(store, { recursive: true });
  const tmp = path.join(store, `.tmp-${hash}-${randomBytes(4).toString('hex')}`);
  try {
    for (const dir of nodeModules) {
      await linkCopy(path.join(root, dir), path.join(tmp, 'tree', dir));
      // Caches propres au dossier d'origine (dépendances pré-optimisées de Vite, caches d'outils) : pas dans l'instantané.
      for (const cache of VOLATILE) await rm(path.join(tmp, 'tree', dir, cache), { recursive: true, force: true });
    }
    const meta: SnapshotMeta = { hash, dirs: nodeModules, createdAt: new Date().toISOString() };
    await writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta));
    await rename(tmp, path.join(store, hash));
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    // Un autre lancement a enregistré le même instantané entre-temps : rien de grave.
    if (await readMeta(store, hash)) return false;
    throw err;
  }
  await pruneSnapshots(store);
  return true;
}

/** Supprime les instantanés au-delà des `keep` plus récents, et les dossiers temporaires abandonnés. */
export async function pruneSnapshots(store: string, keep = SNAPSHOTS_KEPT): Promise<string[]> {
  const removed: string[] = [];
  for (const { hash } of (await listSnapshots(store)).slice(keep)) {
    await rm(path.join(store, hash), { recursive: true, force: true });
    removed.push(hash);
  }
  for (const name of await readdir(store).catch(() => [] as string[])) {
    if (!name.startsWith('.tmp-')) continue;
    const s = await stat(path.join(store, name)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > 3_600_000) await rm(path.join(store, name), { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}

/**
 * À la création d'une work session : lui donne tout de suite les `node_modules` de l'instantané de son empreinte s'il
 * existe (`snapshot` : les agents peuvent typechecker sans installer), sinon ceux de l'instantané le plus récent
 * (`nearest` : presque à jour, une installation ne fera que la différence ; pas de marqueur, elle reste à faire).
 * `none` : aucun instantané. Les erreurs sont journalisées, jamais levées.
 */
export async function seedWorksessionDeps(worksessionsRoot: string, dir: string): Promise<DepsMode> {
  try {
    const hash = await depsHash(dir);
    if (!hash) return 'none';
    const store = depsStoreRoot(worksessionsRoot);
    const started = Date.now();
    const { mode, from } = await linkSnapshot(store, dir, hash, { allowNearest: true });
    if (mode === 'snapshot') {
      // Les dépendances liées correspondent à l'empreinte : le marqueur évite une réinstallation au premier aperçu.
      await writeMarker(dir, hash);
      log.info(`[deps] ${path.basename(dir)} : node_modules liés depuis l'instantané ${hash} en ${Date.now() - started} ms`);
    } else if (mode === 'nearest') {
      log.info(`[deps] ${path.basename(dir)} : node_modules liés depuis l'instantané le plus proche ${from} (empreinte ${hash}) en ${Date.now() - started} ms`);
    }
    return mode;
  } catch (err) {
    log.warn(`[deps] ${path.basename(dir)} : instantané non appliqué : ${(err as Error).message}`);
    return 'none';
  }
}
