import { randomBytes } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import { worksessionHooks, worksessionPath, worksessionService, worksessionsRoot } from '../worksessions/service.js';
import type { Worksession } from '../worksessions/types.js';
import { PREVIEW_CONFIG_FILE, PreviewConfigError, resolvePreviewConfig, type PreviewConfig } from './config.js';
import { defaultInstallCommand, depsHash, depsStoreRoot, linkSnapshot, listSnapshots, readMarker, saveSnapshot, type DepsMode } from './deps.js';
import { freePort, newHostLabel, parsePreviewTemplate, previewOrigin, safeNext, type PreviewUrlTemplate } from './hosts.js';
import { previewRepository, type PreviewRow } from './repository.js';
import { INSTALL_SCRIPT, RUN_SCRIPT } from './scripts.js';
import { deriveState, parseEvents, type PreviewStatus } from './state.js';

/** Lien d'accès (iframe, QR code) : usage unique, quelques minutes pour être ouvert. */
const GRANT_TTL_MS = 10 * 60_000;
/** Cookie d'accès au sous-domaine d'un aperçu. */
export const ACCESS_TTL_MS = 12 * 3600_000;
export const ACCESS_COOKIE = 'skipper_apercu';
/** Chemin réservé par Skipper sur le sous-domaine d'un aperçu (échange du lien d'accès contre le cookie). */
export const ACCESS_PATH = '/__skipper/acces';
/** Journal renvoyé à l'interface : la fin seulement. */
const LOG_MAX_BYTES = 64 * 1024;

/** Ce que l'interface affiche d'un aperçu. */
export interface PreviewInfo {
  worksessionId: string;
  /** Aperçus activés sur ce serveur (PREVIEW_URL). */
  enabled: boolean;
  status: PreviewStatus;
  /** Une commande est connue (fichier ou détection). */
  configured: boolean;
  configSource: string | null;
  configError: string | null;
  command: string | null;
  /** Adresse de l'aperçu (sans accès : ouvrir par `accessUrl`). */
  url: string | null;
  error: string | null;
  startedAt: Date | null;
  readyAt: Date | null;
  /** Dépendances du dernier lancement : 'snapshot' (liées, rien à installer), 'nearest' (liées puis complétées), 'present', 'none'. */
  depsMode: DepsMode | null;
  /** Installation lancée au dernier lancement (null : aucune, dépendances à jour). */
  installCommand: string | null;
  installMs: number | null;
  /** Du clic au premier octet servi. */
  readyMs: number | null;
}

interface DepsRecord {
  mode: DepsMode;
  from: string | null;
  hash: string | null;
  installDir: string;
  install: string | null;
  linkMs: number;
}

const template = (): PreviewUrlTemplate | null => parsePreviewTemplate(config.previewUrl);

const exists = (p: string) => access(p).then(() => true, () => false);

/** Dossier d'état d'un aperçu : à côté des work sessions (monté dans le conteneur), lisible de toutes les instances et des agents. */
export const previewStateDir = (project: Pick<Project, 'slug'>, worksessionId: string) => path.join(worksessionsRoot(project), '.skipper-previews', worksessionId);

/** Le port répond-il ? (connexion TCP depuis le serveur vers l'adresse du conteneur) */
function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Fin d'une installation en arrière-plan : elle est attendue au plus ce temps avant d'enregistrer l'instantané. */
const INSTALL_WAIT_MS = 30 * 60_000;

/**
 * Capture d'écran d'une page de l'aperçu, depuis le conteneur (le serveur de développement y écoute sur localhost) :
 * Chromium headless de l'image (celui du navigateur des sessions), profil jetable, 30 s au plus.
 * Arguments : fichier PNG, largeur, hauteur, URL.
 */
const SCREENSHOT_SCRIPT = `set -e
bin=$(ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1)
if [ -z "$bin" ]; then echo "Chromium introuvable dans l'image (/opt/ms-playwright) : reconstruire skipper-runner" >&2; exit 1; fi
profile=$(mktemp -d /tmp/skipper-capture-XXXXXX)
trap 'rm -rf "$profile"' EXIT
timeout 30 "$bin" --headless --no-sandbox --disable-dev-shm-usage --no-first-run --disable-background-networking \\
  --disable-component-update --disable-sync --mute-audio --hide-scrollbars --user-data-dir="$profile" \\
  --window-size="$2,$3" --virtual-time-budget=8000 --run-all-compositor-stages-before-draw --screenshot="$1" "$4" >/dev/null 2>&1
test -s "$1"`;

/** Formats de capture proposés aux agents. */
export const CAPTURE_SIZES = { desktop: [1280, 800], mobile: [390, 844] } as const;
export type CaptureSize = keyof typeof CAPTURE_SIZES;

/** Lancements en cours, par work session (cette instance) : deux clics ne lancent pas deux serveurs. */
const starting = new Map<string, Promise<PreviewInfo>>();
/** Instantanés en cours d'enregistrement, par empreinte. */
const saving = new Set<string>();

async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8').catch(() => '');
}

async function readDeps(dir: string): Promise<DepsRecord | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'deps.json'), 'utf8')) as DepsRecord;
  } catch {
    return null;
  }
}

async function event(dir: string, name: string, arg = ''): Promise<void> {
  await appendFile(path.join(dir, 'events'), `${Date.now()} ${name}${arg ? ` ${arg}` : ''}\n`).catch(() => undefined);
}

/** Dossier de l'installation, relatif à la work session : `installCwd`, sinon la racine si elle a un package.json (monorepo), sinon `cwd`. */
async function installDirOf(dir: string, cfg: PreviewConfig | null): Promise<string> {
  return cfg?.installCwd ?? ((await exists(path.join(dir, 'package.json'))) ? '' : (cfg?.cwd ?? ''));
}

async function loadConfig(dir: string): Promise<{ config: PreviewConfig | null; error: string | null }> {
  try {
    return { config: await resolvePreviewConfig(dir), error: null };
  } catch (err) {
    if (err instanceof PreviewConfigError) return { config: null, error: err.message };
    throw err;
  }
}

export const previewService = {
  enabled: () => template() !== null,

  /** Ligne de l'aperçu (nom d'hôte et port stables), créée à la première demande. */
  async ensureRow(project: Project, ws: Worksession): Promise<PreviewRow> {
    const existing = await previewRepository.find(ws.id);
    if (existing) return existing;
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = freePort(await previewRepository.portsOfProject(project.id));
      if (port === null) throw new AppError('Plus aucun port libre pour les aperçus de ce projet');
      const row = await previewRepository.create(ws.id, project.id, newHostLabel(ws.name, project.slug), port);
      if (row) return row;
      const raced = await previewRepository.find(ws.id);
      if (raced) return raced;
    }
    throw new AppError("L'aperçu n'a pas pu être enregistré, réessayez");
  },

  async context(worksessionId: string): Promise<{ ws: Worksession; project: Project; dir: string; state: string }> {
    const ws = await worksessionService.get(worksessionId);
    const project = await projectService.get(ws.projectId);
    return { ws, project, dir: worksessionPath(project, ws), state: previewStateDir(project, ws.id) };
  },

  /** Processus du lancement vivant dans le conteneur ? */
  async alive(project: Project, state: string): Promise<boolean> {
    const pid = (await readText(path.join(state, 'pid'))).trim();
    if (!/^\d+$/.test(pid)) return false;
    const { code } = await runner.exec(project, ['kill', '-0', pid]).catch(() => ({ code: 1 }));
    return code === 0;
  },

  async get(worksessionId: string): Promise<PreviewInfo> {
    const { ws, project, dir, state } = await this.context(worksessionId);
    const t = template();
    const row = await previewRepository.find(ws.id);
    const { config: cfg, error: configError } = await loadConfig(dir);
    const events = parseEvents(await readText(path.join(state, 'events')));
    const deps = await readDeps(state);
    let alive = false;
    let open = false;
    if (row && events.length) {
      alive = await this.alive(project, state);
      const ip = alive ? await runner.containerAddress(project) : null;
      open = ip ? await portOpen(ip, row.port) : false;
    }
    let derived = deriveState(events, alive, open);
    if (derived.status === 'RUNNING' && !derived.readyAt) {
      await event(state, 'ready');
      derived = { ...derived, readyAt: new Date() };
    }
    if ((derived.status === 'RUNNING' || derived.status === 'STARTING') && deps?.hash) void this.snapshotIfNeeded(project, dir, deps);
    return {
      worksessionId: ws.id,
      enabled: t !== null,
      status: derived.status,
      configured: cfg !== null,
      configSource: cfg?.source ?? null,
      configError,
      command: cfg?.command ?? null,
      url: t && row ? previewOrigin(t, row.hostLabel) : null,
      error: derived.error,
      startedAt: derived.startedAt,
      readyAt: derived.readyAt,
      depsMode: deps?.mode ?? null,
      installCommand: deps?.install ?? null,
      installMs: derived.installMs,
      readyMs: derived.startedAt && derived.readyAt ? derived.readyAt.getTime() - derived.startedAt.getTime() : null,
    };
  },

  /**
   * Après une installation réussie (marqueur à l'empreinte du lancement), enregistre les `node_modules` comme instantané :
   * la prochaine work session de même empreinte les recevra sans rien installer.
   */
  async snapshotIfNeeded(project: Project, dir: string, deps: Pick<DepsRecord, 'hash' | 'installDir'>): Promise<void> {
    const hash = deps.hash;
    if (!hash || saving.has(hash)) return;
    const store = depsStoreRoot(worksessionsRoot(project));
    if ((await listSnapshots(store)).some((s) => s.hash === hash)) return;
    if ((await readMarker(path.join(dir, deps.installDir))) !== hash) return;
    saving.add(hash);
    try {
      const started = Date.now();
      if (await saveSnapshot(store, dir, hash)) log.info(`[previews] instantané des dépendances ${hash} enregistré pour ${project.slug} en ${Date.now() - started} ms`);
    } catch (err) {
      log.warn(`[previews] instantané des dépendances ${hash} (${project.slug}) : ${(err as Error).message}`);
    } finally {
      saving.delete(hash);
    }
  },

  /**
   * À la création d'une work session sans instantané exact (dépendances absentes, ou liées depuis l'instantané le plus
   * proche) : installe les dépendances en arrière-plan dans le conteneur, puis enregistre l'instantané de cette
   * empreinte, que les work sessions suivantes de même lockfile recevront toutes faites. Commande et dossier : ceux de
   * l'aperçu (`.skipper/preview.json`, sinon déduits du lockfile) ; `"install": ""` désactive l'installation.
   */
  async installInBackground(project: Project, ws: Worksession): Promise<'started' | 'running' | 'up-to-date' | 'skipped'> {
    const dir = worksessionPath(project, ws);
    const state = previewStateDir(project, ws.id);
    const hash = await depsHash(dir);
    if (!hash) return 'skipped';
    const { config: cfg } = await loadConfig(dir);
    if (cfg?.install === '') return 'skipped';
    const installRel = await installDirOf(dir, cfg);
    const installDir = path.join(dir, installRel);
    if ((await readMarker(installDir)) === hash) return 'up-to-date';
    const install = cfg?.install ?? (await defaultInstallCommand(installDir, await exists(path.join(installDir, 'node_modules'))));
    if (!install) return 'skipped';
    if (await this.installRunning(project, state)) return 'running';
    await mkdir(state, { recursive: true });
    await rm(path.join(state, 'install.exit'), { force: true });
    const script = path.join(state, 'install.sh');
    await writeFile(script, INSTALL_SCRIPT, { mode: 0o755 });
    await runner.execDetached(project, dir, ['setsid', 'sh', script], {
      SKIPPER_STATE: state,
      SKIPPER_INSTALL: install,
      SKIPPER_INSTALL_DIR: installDir,
      SKIPPER_DEPS_HASH: hash,
    });
    log.info(`[previews] ${project.slug}/${ws.name} : installation des dépendances en arrière-plan (${install})`);
    void this.snapshotAfterInstall(project, dir, state, { hash, installDir: installRel });
    return 'started';
  },

  /** Installation de la création en cours dans le conteneur ? (pid reconnu à sa ligne de commande : il peut être périmé) */
  async installRunning(project: Project, state: string): Promise<boolean> {
    const pid = (await readText(path.join(state, 'install.pid'))).trim();
    if (!/^\d+$/.test(pid)) return false;
    const { code } = await runner.exec(project, ['grep', '-qs', 'install.sh', `/proc/${pid}/cmdline`]).catch(() => ({ code: 1 }));
    return code === 0;
  },

  /** Attend la fin de l'installation de la création (`install.exit`), puis enregistre l'instantané si elle a réussi. */
  async snapshotAfterInstall(project: Project, dir: string, state: string, deps: { hash: string; installDir: string }, intervalMs = 5000): Promise<void> {
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const exit = (await readText(path.join(state, 'install.exit'))).trim();
      if (!exit) {
        if (!(await exists(dir))) return;
        continue;
      }
      if (exit === '0') await this.snapshotIfNeeded(project, dir, deps);
      else log.warn(`[previews] ${project.slug}/${path.basename(dir)} : l'installation des dépendances a échoué (code ${exit}, voir install.log)`);
      return;
    }
  },

  async start(worksessionId: string, userId: string | null): Promise<PreviewInfo> {
    const pending = starting.get(worksessionId);
    if (pending) return pending;
    const run = this.startNow(worksessionId, userId).finally(() => starting.delete(worksessionId));
    starting.set(worksessionId, run);
    return run;
  },

  async startNow(worksessionId: string, userId: string | null): Promise<PreviewInfo> {
    if (!this.enabled()) throw new AppError("Les aperçus ne sont pas activés sur ce serveur (PREVIEW_URL, voir DEPLOY.md)");
    const { ws, project, dir, state } = await this.context(worksessionId);
    if (ws.archivedAt) throw new AppError('Cette session est archivée : restaurez-la pour lancer son aperçu');
    if (!(await exists(dir))) throw new AppError("Le dossier de travail n'existe plus");
    const { config: cfg, error } = await loadConfig(dir);
    if (error) throw new AppError(error);
    if (!cfg) throw new AppError(`Aucune commande d'aperçu : ajoutez ${PREVIEW_CONFIG_FILE} au dépôt (ou demandez-le à l'agent)`);
    const row = await this.ensureRow(project, ws);
    await this.stopProcess(project, state);

    // Dossier d'état remis à zéro : journal, événements et pid du lancement précédent.
    await mkdir(state, { recursive: true });
    await Promise.all(['log', 'events', 'pid', 'deps.json'].map((f) => rm(path.join(state, f), { force: true })));

    // Dépendances : instantané lié si le dossier n'en a pas, puis installation seulement si l'empreinte a changé.
    const linkStarted = Date.now();
    const hash = await depsHash(dir);
    const installRel = await installDirOf(dir, cfg);
    const installDir = path.join(dir, installRel);
    let mode: DepsMode = 'none';
    let from: string | null = null;
    if (hash) ({ mode, from } = await linkSnapshot(depsStoreRoot(worksessionsRoot(project)), dir, hash, { allowNearest: true }));
    const upToDate = hash !== null && (await readMarker(installDir)) === hash;
    let install: string | null = null;
    if (cfg.install !== '' && !upToDate) {
      install = cfg.install ?? (hash ? await defaultInstallCommand(installDir, await exists(path.join(installDir, 'node_modules'))) : null);
    }
    const deps: DepsRecord = { mode, from, hash, installDir: installRel, install, linkMs: Date.now() - linkStarted };
    await writeFile(path.join(state, 'deps.json'), JSON.stringify(deps));
    const header = [
      `Aperçu de ${ws.branch} — ${new Date().toISOString()}`,
      `Configuration : ${cfg.source}`,
      mode === 'snapshot' ? `Dépendances liées depuis l'instantané ${from} (${deps.linkMs} ms)` : mode === 'nearest' ? `Dépendances liées depuis l'instantané le plus proche ${from} (${deps.linkMs} ms), complétées par l'installation` : '',
      upToDate ? 'Dépendances à jour : aucune installation' : '',
      '',
    ].filter((l, i, a) => l || i === a.length - 1);
    await writeFile(path.join(state, 'log'), `${header.join('\n')}\n`);
    const script = path.join(state, 'run.sh');
    await writeFile(script, RUN_SCRIPT, { mode: 0o755 });

    await runner.execDetached(project, dir, ['setsid', 'sh', script], {
      ...cfg.env,
      PORT: String(row.port),
      HOST: '0.0.0.0',
      BROWSER: 'none',
      SKIPPER_STATE: state,
      SKIPPER_INSTALL: install ?? '',
      SKIPPER_INSTALL_DIR: installDir,
      SKIPPER_DEPS_HASH: hash ?? '',
      SKIPPER_DEPS_WAIT: path.join(state, 'install.pid'),
      SKIPPER_APP_DIR: path.join(dir, cfg.cwd),
      SKIPPER_COMMAND: cfg.command,
    });
    await previewRepository.markStarted(ws.id, userId);
    log.info(`[previews] ${project.slug}/${ws.name} lancé (port ${row.port}, dépendances : ${mode}${install ? `, installation : ${install}` : ''})`);
    return this.get(ws.id);
  },

  /**
   * Attend que l'aperçu ait fini de s'installer et de démarrer (prêt, échoué, arrêté) ou que le délai soit écoulé ; renvoie le dernier état lu.
   * Sert aux agents, qui lancent puis vérifient sans sonder eux-mêmes.
   */
  async waitSettled(worksessionId: string, timeoutMs: number, intervalMs = 1500): Promise<PreviewInfo> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.get(worksessionId);
      if ((info.status !== 'INSTALLING' && info.status !== 'STARTING') || Date.now() >= deadline) return info;
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
  },

  /** Fin du journal : les `lines` dernières lignes. */
  async logTail(worksessionId: string, lines: number): Promise<string> {
    const text = (await this.log(worksessionId)).replace(/\n+$/, '');
    const all = text.split('\n');
    return all.length > lines ? `… (${all.length - lines} ligne(s) plus haut)\n${all.slice(-lines).join('\n')}` : text;
  },

  /** Adresse du serveur de développement vue de l'intérieur du conteneur (navigateur headless de la session, curl). */
  async internalUrl(worksessionId: string): Promise<string | null> {
    const row = await previewRepository.find(worksessionId);
    return row ? `http://localhost:${row.port}` : null;
  },

  /**
   * Capture d'écran PNG d'une page de l'aperçu en marche, faite dans le conteneur (adresse interne, sans accès à
   * gérer). Le fichier est rangé dans le dossier d'état de l'aperçu (hors du dépôt) ; renvoie son chemin et son contenu.
   */
  async screenshot(worksessionId: string, pagePath = '/', size: CaptureSize = 'desktop'): Promise<{ file: string; png: Buffer; url: string }> {
    const info = await this.get(worksessionId);
    if (info.status !== 'RUNNING') throw new AppError(`L'aperçu n'est pas prêt (état : ${info.status}) : lance-le et attends qu'il réponde avant de le capturer`);
    const { project, state } = await this.context(worksessionId);
    const base = await this.internalUrl(worksessionId);
    if (!base) throw new AppError("L'aperçu n'a jamais été lancé");
    const url = `${base}${safeNext(pagePath)}`;
    const dir = path.join(state, 'captures');
    await mkdir(dir, { recursive: true });
    // Les plus anciennes captures sont supprimées : dix gardées.
    const old = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.png')).sort();
    await Promise.all(old.slice(0, Math.max(0, old.length - 9)).map((f) => rm(path.join(dir, f), { force: true })));
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${size}.png`);
    const [w, h] = CAPTURE_SIZES[size];
    const { code } = await runner.exec(project, ['sh', '-c', SCREENSHOT_SCRIPT, 'sh', file, String(w), String(h), url]);
    const png = code === 0 ? await readFile(file).catch(() => null) : null;
    if (!png) throw new AppError(`La capture de ${url} a échoué (Chromium headless du conteneur, code ${code})`);
    return { file, png, url };
  },

  /**
   * Work sessions dont le serveur de développement tourne dans le conteneur du projet : une activité, comme une session
   * ou un terminal (le conteneur obsolète n'est pas recréé sous lui). Lit seulement le pid (`docker exec kill -0`, sans
   * démarrer le conteneur) : appelable depuis la vérification d'inactivité du runner.
   */
  async liveWorksessions(project: Project): Promise<string[]> {
    const rows = await previewRepository.startedOfProject(project.id);
    const live = await Promise.all(rows.map(async (r) => ((await this.alive(project, previewStateDir(project, r.worksessionId))) ? r.worksessionId : null)));
    return live.filter((id): id is string => id !== null);
  },

  /** Relance les aperçus qui tournaient avant la recréation du conteneur (au mieux : une erreur n'empêche pas les autres). */
  async restartAll(worksessionIds: string[]): Promise<string[]> {
    const restarted: string[] = [];
    for (const id of worksessionIds) {
      try {
        const row = await previewRepository.find(id);
        await this.start(id, row?.startedBy ?? null);
        restarted.push(id);
      } catch (err) {
        log.warn(`[previews] relance de l'aperçu ${id} après recréation du conteneur : ${(err as Error).message}`);
      }
    }
    return restarted;
  },

  /** Tue le groupe de processus du lancement (TERM, puis KILL au bout de 3 s). */
  async stopProcess(project: Project, state: string): Promise<boolean> {
    if (!(await this.alive(project, state))) return false;
    const pid = (await readText(path.join(state, 'pid'))).trim();
    await runner.exec(project, ['kill', '-TERM', '--', `-${pid}`]);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await this.alive(project, state))) break;
    }
    if (await this.alive(project, state)) await runner.exec(project, ['kill', '-KILL', '--', `-${pid}`]);
    await event(state, 'stopped');
    return true;
  },

  async stop(worksessionId: string): Promise<PreviewInfo> {
    const { project, state } = await this.context(worksessionId);
    if (!(await this.stopProcess(project, state))) await event(state, 'stopped');
    return this.get(worksessionId);
  },

  async log(worksessionId: string): Promise<string> {
    const { state } = await this.context(worksessionId);
    const text = await readText(path.join(state, 'log'));
    return text.length > LOG_MAX_BYTES ? `…\n${text.slice(-LOG_MAX_BYTES)}` : text;
  },

  /** Lien d'accès à usage unique (iframe du panneau, nouvel onglet, QR code), vers `next` sur l'aperçu. */
  async accessUrl(worksessionId: string, userId: string, next = '/'): Promise<string> {
    const t = template();
    if (!t) throw new AppError("Les aperçus ne sont pas activés sur ce serveur (PREVIEW_URL)");
    const { ws, project } = await this.context(worksessionId);
    const row = await this.ensureRow(project, ws);
    const token = randomBytes(24).toString('base64url');
    await previewRepository.createToken(token, 'grant', ws.id, userId, GRANT_TTL_MS);
    const params = new URLSearchParams({ t: token });
    if (next && next !== '/') params.set('next', next);
    return `${previewOrigin(t, row.hostLabel)}${ACCESS_PATH}?${params}`;
  },
};

// Une work session archivée ou supprimée n'a plus d'aperçu : son serveur de développement est arrêté.
worksessionHooks.beforeRetire.push(async (project, ws) => {
  const state = previewStateDir(project, ws.id);
  if (!(await exists(state))) return;
  await previewService.stopProcess(project, state).catch(() => false);
  // Installation de la création encore en cours : son groupe de processus est arrêté aussi.
  if (await previewService.installRunning(project, state)) {
    const pid = (await readText(path.join(state, 'install.pid'))).trim();
    await runner.exec(project, ['kill', '-TERM', '--', `-${pid}`]).catch(() => undefined);
  }
});

// Une nouvelle work session sans instantané exact de ses dépendances : installation en arrière-plan (voir installInBackground).
worksessionHooks.afterCreate.push(async (project, ws) => {
  await previewService.installInBackground(project, ws);
});
