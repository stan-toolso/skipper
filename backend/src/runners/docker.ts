import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { contextPluginDir } from '../context/skills.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { workspacePath } from '../projects/workspace.js';
import { attachmentsRoot } from '../sessions/attachments.js';
import { worksessionsRoot } from '../worksessions/service.js';
import { sessionTag, type BrowserMcpOptions, type BrowserMcpServer, type IsolatedCommand, type IsolatedResult, type Runner, type RunnerConfig, type RunnerStatus, type SpawnSpec } from './types.js';
import { containerDrift, countZombies, cpusArgs, SPEC_LABEL, updateCpusValue, splitInspect, type ContainerSpec, type ImageInfo } from './spec.js';
import { AGENT_GIT_ENV_KEYS } from '../git/agentEnv.js';
import { invalidateContainerStats, parseDockerSize, readContainerStats, SESSION_ENV, type ContainerStats } from './stats.js';
import { log } from '../log.js';
import { FIND_CHROMIUM, LAZY_BROWSER_MCP, parseDevToolsActivePort, START_CHROMIUM } from './browserLauncher.js';
import { claudeConfigFile, trustDirectories } from './trust.js';

const execFileAsync = promisify(execFile);

/** Variables transmises du backend au CLI dans le conteneur (authentification Claude et GitHub). */
const PASSTHROUGH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...AGENT_GIT_ENV_KEYS];

async function docker(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 8 * 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: unknown; stderr?: string; message: string };
    if (e.code === 'ENOENT') throw new AppError("Docker n'est pas installé sur le serveur (commande docker introuvable)");
    // La sortie d'une commande qui échoue est gardée (journal d'un contrôle qui échoue).
    if (opts.allowFail && typeof e.code === 'number') return { stdout: typeof e.stdout === 'string' ? e.stdout : '', code: e.code };
    throw new AppError(`docker ${args[0]} a échoué : ${(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}`);
  }
}

/** `docker` avec un contenu sur l'entrée standard (écriture d'un fichier dans le conteneur). */
function dockerWithInput(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new AppError(`docker ${args[0]} a échoué : ${stderr.trim().split('\n').slice(-2).join(' ')}`))));
    child.stdin.end(input);
  });
}

/** Dossier de configuration de Claude Code dans le conteneur : `~/.claude`, monté depuis le dossier persistant du projet. */
function claudeConfigDir(home: string): string {
  return path.join(home, '.claude');
}

/** Durée pendant laquelle l'identifiant d'une image est gardé en mémoire (la page du projet interroge l'état toutes les 3 s). */
const IMAGE_CACHE_MS = 30_000;
/** Durée pendant laquelle l'adresse IP d'un conteneur est gardée en mémoire (elle change à sa recréation). */
const ADDRESS_CACHE_MS = 10_000;

/** Conteneur Docker dédié au projet, code monté aux mêmes chemins absolus que sur l'hôte. */
export class DockerRunner implements Runner {
  readonly kind = 'docker' as const;

  /** Un seul `ensureReady` à la fois par projet : deux démarrages simultanés ne créent pas deux fois le conteneur. */
  private readonly pending = new Map<string, Promise<RunnerStatus>>();
  private readonly images = new Map<string, { at: number; info: ImageInfo | null }>();
  private idleCheck: ((project: Project) => Promise<boolean>) | null = null;
  /** Adresse IP des conteneurs (proxy des aperçus, à chaque requête) : gardée quelques secondes. */
  private readonly addresses = new Map<string, { at: number; ip: string | null }>();

  containerName(project: Pick<Project, 'slug'>): string {
    return `skipper-${project.slug}`;
  }

  setIdleCheck(check: (project: Project) => Promise<boolean>): void {
    this.idleCheck = check;
  }

  private settings(project: Project): Required<Pick<RunnerConfig, 'image' | 'memory' | 'cpus'>> {
    const c = (project.runnerConfig ?? {}) as RunnerConfig;
    return { image: c.image || config.runnerImage, memory: c.memory || config.runnerMemory, cpus: c.cpus || config.runnerCpus };
  }

  /** Script de relais donné au SDK : lance le CLI dans le conteneur, dans le même dossier, stdio relayés. */
  private relayPath(project: Project): string {
    return path.join(config.workspacesRoot, '.runners', project.slug, 'claude');
  }

  /**
   * Caches persistants des gestionnaires de paquets (npm, pnpm, yarn, pip…) : montés sur `~/.npm` et `~/.cache` (où l'installation
   * par défaut range aussi le magasin pnpm : `~/.local` n'est pas monté, Docker y créerait des dossiers de root), ils survivent à la recréation du conteneur et ne pèsent plus sur le tmpfs (en mémoire) du dossier
   * personnel ; une installation déjà faite une fois dans le projet se refait sans réseau (`--prefer-offline`).
   */
  packageCaches(project: Pick<Project, 'slug'>, home: string): { host: string; target: string }[] {
    const root = path.join(config.workspacesRoot, '.runners', project.slug, 'cache');
    return [
      { host: path.join(root, 'npm'), target: path.join(home, '.npm') },
      { host: path.join(root, 'xdg'), target: path.join(home, '.cache') },
    ];
  }

  /** Dossier `~/.claude` persistant du conteneur : conversations Claude Code du projet (reprises après recréation), sans les identifiants de l'hôte. */
  private claudeHome(project: Pick<Project, 'slug'>): string {
    return path.join(config.workspacesRoot, '.runners', project.slug, 'claude-home');
  }

  claudeConfigHostDir(project: Pick<Project, 'slug'>): string {
    return this.claudeHome(project);
  }

  /**
   * Inscrit les dossiers comme « trusted » pour Claude Code (voir trust.ts) dans le `.claude.json` du conteneur,
   * rangé dans `~/.claude` (CLAUDE_CONFIG_DIR) et donc écrit depuis l'hôte dans le dossier persistant du projet.
   */
  async trustDirectories(project: Project, dirs: string[]): Promise<void> {
    await trustDirectories(claudeConfigFile(this.claudeHome(project)), dirs);
  }

  /** Checkout principal et dossiers de travail existants du projet. */
  private async workingDirectories(project: Project): Promise<string[]> {
    const root = worksessionsRoot(project);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    return [workspacePath(project), ...entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(root, e.name))];
  }

  private async writeRelay(project: Project): Promise<string> {
    const file = this.relayPath(project);
    await mkdir(path.dirname(file), { recursive: true });
    // La variable de session relie le processus du CLI à sa session (mémoire par session sur la page du projet).
    // CLAUDE_CONFIG_DIR aussi posé ici : un conteneur créé avant qu'il fasse partie de sa configuration l'ignore tant qu'il n'est pas recréé.
    const envFlags = [`-e CLAUDE_CONFIG_DIR=${claudeConfigDir(os.homedir())}`, ...[...PASSTHROUGH_ENV, SESSION_ENV].map((v) => `-e ${v}`)].join(' ');
    const script = `#!/bin/sh
# Généré par Skipper : exécute le CLI Claude Code dans le conteneur du projet ${project.slug}.
exec docker exec -i -w "$PWD" ${envFlags} ${this.containerName(project)} claude "$@"
`;
    await writeFile(file, script);
    await chmod(file, 0o755);
    return file;
  }

  /** Identifiant et date de construction de l'image attendue, telle qu'elle existe localement (null si absente) ; mis en cache 30 s. */
  private async imageInfo(image: string): Promise<ImageInfo | null> {
    const cached = this.images.get(image);
    if (cached && Date.now() - cached.at < IMAGE_CACHE_MS) return cached.info;
    const { stdout, code } = await docker(['image', 'inspect', '--format', '{{.Id}}|{{.Created}}', image], { allowFail: true });
    let info: ImageInfo | null = null;
    if (code === 0) {
      const [id, created] = stdout.trim().split('|');
      const createdAt = new Date(created ?? '');
      info = { id, createdAt: Number.isNaN(createdAt.getTime()) ? null : createdAt };
    }
    this.images.set(image, { at: Date.now(), info });
    return info;
  }

  async stats(project: Project, opts: { fresh?: boolean } = {}): Promise<ContainerStats | null> {
    const name = this.containerName(project);
    if (opts.fresh) invalidateContainerStats(name);
    return readContainerStats(name);
  }

  async applyLimits(project: Project): Promise<boolean> {
    const current = await this.status(project);
    if (current.state === 'absent' || current.state === 'unavailable') return false;
    const s = this.settings(project);
    const memory = parseDockerSize(s.memory);
    if (!memory) throw new AppError(`Limite mémoire illisible : ${s.memory}`);
    // Même règle que `docker run --memory` sans --memory-swap : autant de swap que de mémoire. Sans plafond CPU : tous les cœurs de l'hôte (`--cpus 0` ne retire pas un plafond existant).
    await docker(['update', '--memory', String(memory), '--memory-swap', String(memory * 2), '--cpus', updateCpusValue(s.cpus, os.availableParallelism()), this.containerName(project)]);
    invalidateContainerStats(this.containerName(project));
    return true;
  }

  /**
   * Configuration attendue du conteneur : tout ce qui est passé à `docker run`, et son empreinte posée
   * en label (`skipper.spec`) pour reconnaître plus tard un conteneur créé avec d'autres paramètres.
   */
  private async containerSpec(project: Project): Promise<{ spec: ContainerSpec; dirs: string[] }> {
    const s = this.settings(project);
    const workspace = workspacePath(project);
    const worksessions = worksessionsRoot(project);
    const plugin = contextPluginDir(project);
    const attachments = attachmentsRoot(project);
    const claudeHome = this.claudeHome(project);
    const home = os.homedir();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    const caches = this.packageCaches(project, home);
    const mounts = [
      // ~/.claude propre au projet : ses conversations, qui survivent à la recréation. Les identifiants Claude
      // de l'hôte ne sont jamais montés : chaque session reçoit ceux de son propriétaire par variables d'environnement.
      `${claudeHome}:${path.join(home, '.claude')}`,
      // Comptes de l'hôte en lecture seule : l'utilisateur a un nom, un home, et ssh/git fonctionnent.
      '/etc/passwd:/etc/passwd:ro',
      '/etc/group:/etc/group:ro',
      // Le code, les work sessions, les skills et les pièces jointes des sessions du projet, au même chemin que sur l'hôte.
      `${workspace}:${workspace}`,
      `${worksessions}:${worksessions}`,
      `${plugin}:${plugin}`,
      `${attachments}:${attachments}`,
      ...caches.map((c) => `${c.host}:${c.target}`),
    ];
    // Identité git de l'utilisateur système (repli quand le propriétaire de la session n'a pas de compte GitHub) ;
    // absente : l'identité des commits vient des variables d'environnement, ou reste celle du conteneur.
    const gitconfig = path.join(home, '.gitconfig');
    if (await access(gitconfig).then(() => true, () => false)) mounts.push(`${gitconfig}:${gitconfig}`);
    const image = await this.imageInfo(s.image);
    const spec: ContainerSpec = {
      image: s.image,
      imageId: image?.id ?? null,
      // Processus init (tini) : récolte les processus orphelins et terminés (dont ceux de Chromium, lancé par
      // `docker exec -d`) ; sans lui, `sleep infinity` en PID 1 laisse des zombies s'accumuler.
      init: true,
      memory: s.memory,
      cpus: s.cpus,
      user: `${uid}:${gid}`,
      home,
      // Configuration globale du CLI (`.claude.json` : confiance des dossiers, réglages) dans ~/.claude, persistant,
      // plutôt qu'à la racine du dossier personnel (tmpfs, perdu à chaque recréation) ; le serveur y inscrit la confiance.
      env: [`CLAUDE_CONFIG_DIR=${claudeConfigDir(home)}`],
      workdir: workspace,
      restart: 'unless-stopped',
      mounts,
      // Le dossier personnel est un tmpfs inscriptible (caches npm, profil et rapports de plantage de Chromium :
      // sans dossier personnel inscriptible, Chromium meurt au lancement) ; ~/.claude et ~/.gitconfig s'y superposent.
      tmpfs: [`${home}:uid=${uid},gid=${gid},mode=0750,size=512m`],
      // Le serveur Skipper reste joignable depuis le conteneur (ponts MCP des sessions OpenCode), y compris sous Linux.
      hosts: ['host.docker.internal:host-gateway'],
      command: ['sleep', 'infinity'],
    };
    return { spec, dirs: [worksessions, plugin, attachments, claudeHome, ...caches.map((c) => c.host)] };
  }

  /** Arguments de `docker run` dérivés de la configuration, label compris. */
  private runArgs(name: string, spec: ContainerSpec): string[] {
    return [
      'run', '-d', '--name', name, '--restart', spec.restart, '--memory', spec.memory, ...cpusArgs(spec.cpus),
      ...(spec.init ? ['--init'] : []),
      '--user', spec.user, '-e', `HOME=${spec.home}`, ...(spec.env ?? []).flatMap((e) => ['-e', e]), '-w', spec.workdir,
      ...spec.hosts.flatMap((h) => ['--add-host', h]),
      ...spec.tmpfs.flatMap((t) => ['--tmpfs', t]),
      ...spec.mounts.flatMap((m) => ['-v', m]),
      '--label', `${SPEC_LABEL}=${JSON.stringify(spec)}`,
      spec.image, ...spec.command,
    ];
  }

  async status(project: Project): Promise<RunnerStatus> {
    const s = this.settings(project);
    const name = this.containerName(project);
    const base: RunnerStatus = { kind: 'docker', ready: false, state: 'absent', containerName: name, image: s.image, memory: s.memory, cpus: s.cpus || null, startedAt: null, error: null, outdated: false, outdatedReasons: [], zombies: null };
    try {
      const format = `{{.State.Status}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.Image}}|{{.HostConfig.Init}}|{{index .Config.Labels "${SPEC_LABEL}"}}`;
      const { stdout, code } = await docker(['inspect', '--format', format, name], { allowFail: true });
      if (code !== 0) return base;
      const [state, startedAt, image, imageId, init, specLabel] = splitInspect(stdout, 6);
      const running = state === 'running';
      const { spec } = await this.containerSpec(project);
      const outdatedReasons = containerDrift(spec, { specLabel, init: init === null ? null : init === 'true', imageId }, await this.imageInfo(s.image));
      const zombies = running ? await this.zombieCount(name) : null;
      return { ...base, state: state ?? 'unknown', ready: running, startedAt: running && startedAt ? new Date(startedAt) : null, image: image ?? s.image, outdated: outdatedReasons.length > 0, outdatedReasons, zombies };
    } catch (err) {
      return { ...base, state: 'unavailable', error: (err as Error).message };
    }
  }

  /** Processus zombies du conteneur (`docker top` lit la table des processus depuis l'hôte, sans `exec`). */
  private async zombieCount(name: string): Promise<number | null> {
    const { stdout, code } = await docker(['top', name, '-o', 'pid,stat'], { allowFail: true });
    return code === 0 ? countZombies(stdout) : null;
  }

  async ensureReady(project: Project): Promise<RunnerStatus> {
    const previous = this.pending.get(project.id) ?? Promise.resolve();
    const run = previous.then(
      () => this.ensureReadyNow(project),
      () => this.ensureReadyNow(project),
    );
    this.pending.set(project.id, run);
    try {
      return await run;
    } finally {
      if (this.pending.get(project.id) === run) this.pending.delete(project.id);
    }
  }

  private async ensureReadyNow(project: Project): Promise<RunnerStatus> {
    let current = await this.status(project);
    if (current.state === 'unavailable') throw new AppError(current.error ?? 'Docker indisponible');
    const name = this.containerName(project);
    // Conteneur créé avec d'autres paramètres ou une image depuis reconstruite : recréé dès que rien n'y tourne.
    if (current.state !== 'absent' && current.outdated && (await this.isIdle(project))) {
      log.info(`[runner] ${name} recréé : ${current.outdatedReasons.join(' ; ')}`);
      await this.remove(project);
      current = await this.status(project);
    }
    if (current.state === 'absent') {
      const { spec, dirs } = await this.containerSpec(project);
      // Les dossiers montés doivent exister avant `docker run`, sinon Docker les crée appartenant à root.
      await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true, ...(dir === this.claudeHome(project) ? { mode: 0o700 } : {}) })));
      await docker(this.runArgs(name, spec));
    } else if (current.state !== 'running') {
      await docker(['start', name]);
    }
    await this.writeRelay(project);
    await this.trustDirectories(project, await this.workingDirectories(project));
    return this.status(project);
  }

  /** Rien ne tourne dans le conteneur du projet ? Sans vérification déclarée (ou si elle échoue), on ne recrée jamais de nous-mêmes. */
  private async isIdle(project: Project): Promise<boolean> {
    if (!this.idleCheck) return false;
    try {
      return await this.idleCheck(project);
    } catch (err) {
      log.error('[runner] vérification d’inactivité', err);
      return false;
    }
  }

  async recreateOutdated(projects: Project[]): Promise<string[]> {
    const recreated: string[] = [];
    for (const project of projects) {
      try {
        const current = await this.status(project);
        if (current.state === 'absent' || current.state === 'unavailable' || !current.outdated) continue;
        log.info(`[runner] ${current.containerName} supprimé au démarrage, sera recréé à la demande : ${current.outdatedReasons.join(' ; ')}`);
        await this.remove(project);
        recreated.push(project.slug);
      } catch (err) {
        log.error(`[runner] ${this.containerName(project)} : recréation au démarrage`, err);
      }
    }
    return recreated;
  }

  async stop(project: Project): Promise<RunnerStatus> {
    const current = await this.status(project);
    if (current.state === 'running') await docker(['stop', '-t', '5', this.containerName(project)]);
    return this.status(project);
  }

  async remove(project: Project): Promise<void> {
    this.addresses.delete(this.containerName(project));
    await docker(['rm', '-f', this.containerName(project)], { allowFail: true });
  }

  async claudeExecutable(project: Project, cwd?: string): Promise<string | undefined> {
    await this.ensureReady(project);
    // Dossier de la session (worktree créé depuis le démarrage du conteneur, sous-dossier) : « trusted » avant le lancement.
    if (cwd) await this.trustDirectories(project, [cwd]);
    return this.relayPath(project);
  }

  async terminalCommand(project: Project, cwd: string, options: { rcfile?: string } = {}): Promise<SpawnSpec> {
    await this.ensureReady(project);
    const shell = options.rcfile ? ['bash', '--rcfile', options.rcfile, '-i'] : ['bash', '-l'];
    return { command: 'docker', args: ['exec', '-it', '-w', cwd, '-e', 'TERM=xterm-256color', ...PASSTHROUGH_ENV.flatMap((v) => ['-e', v]), this.containerName(project), ...shell] };
  }

  async putFile(project: Project, filePath: string, content: string): Promise<void> {
    await this.ensureReady(project);
    const dir = path.posix.dirname(filePath);
    await dockerWithInput(['exec', '-i', this.containerName(project), 'sh', '-c', 'umask 077 && mkdir -p "$1" && cat > "$2"', 'sh', dir, filePath], content);
  }

  async getFile(project: Project, filePath: string): Promise<string> {
    const { stdout } = await docker(['exec', this.containerName(project), 'cat', filePath]);
    return stdout;
  }

  async pathExists(project: Project, filePath: string): Promise<boolean> {
    await this.ensureReady(project);
    return docker(['exec', this.containerName(project), 'test', '-e', filePath]).then(() => true, () => false);
  }

  async removePath(project: Project, filePath: string): Promise<void> {
    await docker(['exec', this.containerName(project), 'rm', '-rf', filePath], { allowFail: true });
  }

  async shellCommand(project: Project, cwd: string, _shell: string, script: string): Promise<SpawnSpec> {
    await this.ensureReady(project);
    return { command: 'docker', args: ['exec', '-i', '-w', cwd, ...PASSTHROUGH_ENV.flatMap((v) => ['-e', v]), this.containerName(project), 'sh', '-c', script] };
  }

  /**
   * Navigateur de la session, lancé au premier usage (browserLauncher.ts) : le CLI lance un relais qui démarre
   * `playwright-mcp` tout de suite et Chromium seulement au premier outil du navigateur (profil jetable dans le
   * /tmp du conteneur, hors des volumes). Le backend retrouve ensuite le même Chromium par CDP (vue en direct,
   * saisie des secrets du coffre). C'est le CLI qui lance le relais, et le CLI tourne déjà dans le conteneur (où
   * `docker` n'existe pas) : la commande s'exécute donc directement, sans `docker exec`.
   */
  async browserMcpCommand(project: Project, cwd: string, options: BrowserMcpOptions): Promise<BrowserMcpServer> {
    await this.ensureReady(project);
    const container = this.containerName(project);
    const dir = `/tmp/${sessionTag(options.sessionId)}-browser`;
    const dispose = async () => {
      await docker(['exec', container, 'sh', '-c', STOP_CHROMIUM, 'sh', dir], { allowFail: true });
    };
    // Reste d'une session précédente (serveur arrêté brutalement) : on repart d'un dossier propre.
    await dispose();
    // Sans lancer Chromium, on vérifie qu'il est dans l'image : sinon la session part sans navigateur, avec la raison.
    const { stdout: bin } = await docker(['exec', container, 'sh', '-c', FIND_CHROMIUM], { allowFail: true });
    if (!bin.trim()) throw new AppError("Le navigateur headless n'a pas démarré : Chromium introuvable dans l'image (/opt/ms-playwright) : reconstruire skipper-runner");
    // Relu à chaque appel (vue en direct, saisie du coffre) : le relais relance Chromium, sur un autre port, s'il s'arrête.
    const cdp = async () => {
      const { stdout, code } = await docker(['exec', container, 'cat', `${dir}/profile/DevToolsActivePort`], { allowFail: true });
      return code === 0 ? parseDevToolsActivePort(stdout) : null;
    };
    const args = ['-e', LAZY_BROWSER_MCP, dir, START_CHROMIUM, '--output-dir', `${cwd}/.playwright-mcp`];
    return { command: 'node', args, cdp, dispose };
  }

  cdpTunnelCommand(project: Project, port: number): SpawnSpec {
    return { command: 'docker', args: ['exec', '-i', this.containerName(project), 'node', '-e', CDP_RELAY, String(port)] };
  }

  async opencodeCommand(project: Project, cwd: string, envKeys: string[]): Promise<SpawnSpec> {
    await this.ensureReady(project);
    return { command: 'docker', args: ['exec', '-i', '-w', cwd, ...[...PASSTHROUGH_ENV, ...envKeys].flatMap((v) => ['-e', v]), this.containerName(project), 'opencode'] };
  }

  /**
   * Conteneur jetable (`docker run --rm`) de l'image du projet : même uid que l'hôte, dossier personnel en tmpfs,
   * `cwd` seul monté. Les variables de la commande sont passées par l'environnement du client `docker` (`-e NOM`
   * sans valeur), jamais sur sa ligne de commande (visible de tout utilisateur du serveur par `ps`). Au-delà du
   * délai, le conteneur est supprimé de force (un signal ne suffit pas toujours à un processus qui l'ignore).
   */
  async runIsolated(project: Project | null, cmd: IsolatedCommand): Promise<IsolatedResult> {
    const s = project ? this.settings(project) : { image: config.runnerImage, memory: config.runnerMemory, cpus: config.runnerCpus };
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    const name = `skipper-run-${randomBytes(6).toString('hex')}`;
    const home = '/tmp/home';
    const args = [
      'run', '--rm', '-i', '--name', name, '--memory', cmd.memory ?? '512m', ...cpusArgs(s.cpus), '--init',
      '--user', `${uid}:${gid}`, '-v', '/etc/passwd:/etc/passwd:ro', '-v', '/etc/group:/etc/group:ro',
      '--tmpfs', `${home}:uid=${uid},gid=${gid},mode=0700,size=64m`,
      '-v', `${cmd.cwd}:${cmd.cwd}`, '-w', cmd.cwd,
      '--label', 'skipper.ephemeral=1', '-e', `HOME=${home}`,
      ...Object.keys(cmd.env).flatMap((k) => ['-e', k]),
      s.image, ...cmd.command,
    ];
    const maxBytes = cmd.maxBytes ?? 64 * 1024;
    const started = Date.now();
    return new Promise<IsolatedResult>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...cmd.env } });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const append = (current: string, chunk: Buffer) => {
        if (current.length >= maxBytes) {
          truncated = true;
          return current;
        }
        const next = current + chunk.toString('utf8');
        if (next.length > maxBytes) {
          truncated = true;
          return next.slice(0, maxBytes);
        }
        return next;
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void docker(['rm', '-f', name], { allowFail: true }).catch(() => undefined);
        child.kill('SIGKILL');
      }, cmd.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
      child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new AppError("Docker n'est pas installé sur le serveur (commande docker introuvable)") : err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return reject(new AppError(`Commande interrompue après ${Math.round(cmd.timeoutMs / 1000)} s`, 'TIMEOUT'));
        // Codes du démon ou du client docker (pas de la commande) : image absente, programme introuvable dans l'image.
        if (code === 125) return reject(new AppError(`docker run a échoué : ${stderr.trim().split('\n').slice(-2).join(' ')}`));
        if (code === 127 && /executable file not found|no such file or directory/i.test(stderr)) {
          return reject(new AppError(`« ${cmd.command[0]} » est absent de l'image ${s.image} : reconstruisez l'image du runner (deploy/runner/Dockerfile)`));
        }
        resolve({ stdout, stderr, exitCode: code ?? null, signal: signal ?? null, truncated, durationMs: Date.now() - started });
      });
    });
  }

  async execDetached(project: Project, cwd: string, command: string[], env: Record<string, string> = {}): Promise<void> {
    await this.ensureReady(project);
    await docker(['exec', '-d', '-w', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), this.containerName(project), ...command]);
  }

  async exec(project: Project, command: string[], opts: { cwd?: string; timeoutSeconds?: number; output?: boolean } = {}): Promise<{ stdout: string; code: number }> {
    // `timeout` (coreutils) tue la commande dans le conteneur ; tuer `docker exec` ne l'arrêterait pas.
    const wrapped = opts.timeoutSeconds ? ['timeout', '-k', '10', String(Math.ceil(opts.timeoutSeconds)), ...command] : command;
    const args = ['exec', ...(opts.cwd ? ['-w', opts.cwd] : []), this.containerName(project), ...(opts.output ? ['sh', '-c', 'exec "$@" 2>&1', 'sh', ...wrapped] : wrapped)];
    return docker(args, { allowFail: true });
  }

  async containerAddress(project: Project): Promise<string | null> {
    const name = this.containerName(project);
    const cached = this.addresses.get(name);
    if (cached && Date.now() - cached.at < ADDRESS_CACHE_MS) return cached.ip;
    const { stdout, code } = await docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', name], { allowFail: true });
    const ip = code === 0 ? stdout.trim().split(/\s+/)[0] || null : null;
    this.addresses.set(name, { at: Date.now(), ip });
    return ip;
  }

  /** `host.docker.internal` quand le conteneur le résout (Docker Desktop, ou `--add-host` sous Linux), sinon la passerelle du réseau. */
  async hostAddress(project: Project): Promise<string> {
    const name = this.containerName(project);
    const { code } = await docker(['exec', name, 'getent', 'hosts', 'host.docker.internal'], { allowFail: true });
    if (code === 0) return 'host.docker.internal';
    const { stdout } = await docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', name]);
    const gateway = stdout.trim();
    if (!gateway) throw new AppError("Impossible de joindre le serveur depuis l'environnement du projet : recréez l'environnement (page du projet)");
    return gateway;
  }
}

/**
 * Arrêt de Chromium puis suppression du dossier de la session (profil, secrets). On attend la fin du
 * processus (5 s, puis SIGKILL) : sinon Chromium réécrit son profil pendant la suppression. Un zombie
 * (état Z, pas encore récolté) compte comme arrêté.
 */
const STOP_CHROMIUM = `pid=$(cat "$1/chromium.pid" 2>/dev/null || true)
alive() { [ -n "$pid" ] && [ -n "$(ps -o stat= -p "$pid" 2>/dev/null | grep -v '^Z')" ]; }
if alive; then
  kill "$pid" 2>/dev/null || true
  i=0; while alive && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if alive; then kill -9 "$pid" 2>/dev/null || true; sleep 0.2; fi
fi
rm -rf "$1"`;

/** Relais TCP ↔ stdio vers 127.0.0.1:<port> (argument), exécuté par Node dans le conteneur. */
const CDP_RELAY = `const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));s.on('error',(e)=>{console.error(e.message);process.exit(1)});process.stdin.on('end',()=>s.end())`;
