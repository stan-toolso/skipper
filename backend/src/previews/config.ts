import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Fichier de configuration de l'aperçu, versionné dans le dépôt (chaque branche peut avoir le sien). */
export const PREVIEW_CONFIG_FILE = '.skipper/preview.json';

/** Configuration résolue de l'aperçu d'une work session. */
export interface PreviewConfig {
  /** Commande du serveur de développement (shell), qui doit écouter sur 0.0.0.0 et le port `$PORT`. */
  command: string;
  /** Dossier de la commande, relatif à la work session ('' : la racine). */
  cwd: string;
  /**
   * Installation des dépendances avant le lancement : null = déduite du lockfile (npm, pnpm, yarn), '' = aucune.
   * Lancée dans `installCwd`.
   */
  install: string | null;
  /** Dossier de l'installation, relatif à la work session ; null : la racine si elle a un package.json (monorepo), sinon `cwd`. */
  installCwd: string | null;
  /** Variables d'environnement ajoutées (non secrètes : elles sont visibles dans le conteneur). */
  env: Record<string, string>;
  /** D'où vient la configuration : le fichier, ou la détection (« Vite détecté dans frontend/package.json »). */
  source: string;
}

export class PreviewConfigError extends Error {}

/** Chemin relatif sans remontée ni chemin absolu ('' : la racine). */
function relativeDir(raw: unknown, field: string): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') throw new PreviewConfigError(`« ${field} » doit être un chemin relatif`);
  const norm = path.posix.normalize(raw.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (norm === '.') return '';
  if (path.posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../')) throw new PreviewConfigError(`« ${field} » doit rester dans le dossier de travail : ${raw}`);
  return norm;
}

/** Lit et valide le contenu de `.skipper/preview.json`. */
export function parsePreviewConfig(text: string): PreviewConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} n'est pas un JSON valide : ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} doit contenir un objet`);
  const o = raw as Record<string, unknown>;
  if (typeof o.command !== 'string' || !o.command.trim()) throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} : « command » (commande du serveur de développement) est obligatoire`);
  if (o.install !== undefined && o.install !== null && typeof o.install !== 'string') throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} : « install » doit être une commande (ou "" pour ne rien installer)`);
  const env: Record<string, string> = {};
  if (o.env !== undefined) {
    if (!o.env || typeof o.env !== 'object' || Array.isArray(o.env)) throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} : « env » doit être un objet`);
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} : nom de variable invalide « ${k} »`);
      if (k === 'PORT' || k === 'HOST') throw new PreviewConfigError(`${PREVIEW_CONFIG_FILE} : ${k} est fixé par Skipper`);
      env[k] = String(v);
    }
  }
  return {
    command: o.command.trim(),
    cwd: relativeDir(o.cwd, 'cwd'),
    install: o.install === undefined || o.install === null ? null : String(o.install).trim(),
    installCwd: o.installCwd === undefined || o.installCwd === null ? null : relativeDir(o.installCwd, 'installCwd'),
    env,
    source: PREVIEW_CONFIG_FILE,
  };
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Commande déduite d'un package.json (sans fichier de configuration) : un script `dev` d'un outil connu, auquel on
 * passe l'hôte et le port. Null si rien de reconnu. `runner` : préfixe du gestionnaire de paquets (`npm run`…).
 */
export function detectFromPackage(pkg: PackageJson, runner = 'npm run'): { command: string; tool: string } | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dev = pkg.scripts?.dev;
  if (!dev) return null;
  const sep = runner === 'npm run' ? ' --' : '';
  if (/\bnext\b/.test(dev) || deps.next) return { command: `${runner} dev${sep} -H 0.0.0.0 -p $PORT`, tool: 'Next.js' };
  if (/\bnuxt\b/.test(dev) || deps.nuxt) return { command: `${runner} dev${sep} --host 0.0.0.0 --port $PORT`, tool: 'Nuxt' };
  if (/\bastro\b/.test(dev) || deps.astro) return { command: `${runner} dev${sep} --host 0.0.0.0 --port $PORT`, tool: 'Astro' };
  if (/\bvite\b/.test(dev) || deps.vite) return { command: `${runner} dev${sep} --host 0.0.0.0 --port $PORT --strictPort`, tool: 'Vite' };
  return null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Gestionnaire de paquets déduit des lockfiles présents à la racine. */
async function runnerOf(root: string): Promise<string> {
  const has = (f: string) => readFile(path.join(root, f)).then(() => true, () => false);
  if (await has('pnpm-lock.yaml')) return 'corepack pnpm';
  if (await has('yarn.lock')) return 'corepack yarn';
  return 'npm run';
}

/** Sous-dossiers essayés par la détection, dans l'ordre (monorepos courants). */
const DETECT_DIRS = ['', 'frontend', 'web', 'app', 'apps/web', 'client'];

/**
 * Configuration de l'aperçu d'un dossier de travail : `.skipper/preview.json` s'il existe (erreur s'il est invalide),
 * sinon une détection à partir des package.json (racine puis sous-dossiers courants). Null : rien à lancer.
 */
export async function resolvePreviewConfig(root: string): Promise<PreviewConfig | null> {
  let text: string | null = null;
  try {
    text = await readFile(path.join(root, PREVIEW_CONFIG_FILE), 'utf8');
  } catch {
    text = null;
  }
  if (text !== null) return parsePreviewConfig(text);
  const runner = await runnerOf(root);
  for (const dir of DETECT_DIRS) {
    const pkg = await readJson<PackageJson>(path.join(root, dir, 'package.json'));
    const found = pkg && detectFromPackage(pkg, runner);
    if (found) {
      return { command: found.command, cwd: dir, install: null, installCwd: null, env: {}, source: `${found.tool} détecté dans ${dir ? `${dir}/` : ''}package.json` };
    }
  }
  return null;
}

/**
 * Paragraphe du prompt système des sessions qui travaillent dans un dossier de travail : les dépendances (instantanés,
 * installation de la création) et, si `enabled` (aperçus activés sur ce serveur, PREVIEW_URL), l'aperçu en direct,
 * sa configuration et son journal. `worksessionId` : pour donner le vrai chemin du dossier d'état.
 */
export function previewPrompt(enabled: boolean, worksessionId?: string | null): string {
  const state = `../.skipper-previews/${worksessionId ?? '<identifiant de la work session>'}`;
  const deps = [
    "Les dépendances sont liées depuis un cache par empreinte du lockfile (liens physiques, quelques secondes) : quand `node_modules` est déjà présent, préfère `npm install` (qui ne fait que la différence) à `npm ci` (qui repart de zéro), et ne modifie jamais un fichier de `node_modules` en place.",
    `Quand aucun instantané ne correspondait exactement au lockfile, Skipper installe les dépendances en arrière-plan à la création du dossier de travail : elle tourne tant que le processus de \`${state}/install.pid\` existe (\`kill -0 $(cat ${state}/install.pid)\` réussit ; journal \`${state}/install.log\`, code de sortie dans \`${state}/install.exit\`) ; attends sa fin avant de lancer toi-même une installation ou un build, plutôt que d'en lancer une deuxième en parallèle.`,
  ];
  if (!enabled) return deps.join(' ');
  return [
    "Aperçu en direct : l'onglet « Aperçu » de la session lance le serveur de développement de ta branche dans l'environnement du projet et l'affiche aux membres du projet (ordinateur ou téléphone), sans déploiement.",
    `La commande vient de \`${PREVIEW_CONFIG_FILE}\` (\`{ "command": "…", "cwd": "sous-dossier", "install": "…", "env": {…} }\`), sinon d'un script \`dev\` Vite, Next, Nuxt ou Astro détecté ; elle doit écouter sur 0.0.0.0 et sur le port \`$PORT\`. Si on te demande de configurer l'aperçu, crée ce fichier, vérifie que la commande démarre, puis commite-le.`,
    ...deps,
    `Le journal du dernier lancement de l'aperçu (installation puis serveur) est dans \`${state}/log\`, à côté de ton dossier de travail.`,
  ].join(' ');
}
