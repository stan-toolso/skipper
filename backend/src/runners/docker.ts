import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { contextPluginDir } from '../context/skills.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { workspacePath } from '../projects/workspace.js';
import { attachmentsRoot } from '../sessions/attachments.js';
import { worktreesRoot } from '../worktrees/service.js';
import { PLAYWRIGHT_MCP_ARGS, sessionTag, type BrowserMcpOptions, type BrowserMcpServer, type Runner, type RunnerConfig, type RunnerStatus, type SpawnSpec } from './types.js';
import { AGENT_GIT_ENV_KEYS } from '../git/agentEnv.js';
import { renderSecretsFile } from '../connections/website.js';

const execFileAsync = promisify(execFile);

/** Variables transmises du backend au CLI dans le conteneur (authentification Claude et GitHub). */
const PASSTHROUGH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...AGENT_GIT_ENV_KEYS];

async function docker(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 8 * 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string; message: string };
    if (e.code === 'ENOENT') throw new AppError("Docker n'est pas installé sur le serveur (commande docker introuvable)");
    if (opts.allowFail && typeof e.code === 'number') return { stdout: '', code: e.code };
    throw new AppError(`docker ${args[0]} a échoué : ${(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}`);
  }
}

/** `docker` avec un contenu sur l'entrée standard (écriture d'un fichier dans le conteneur sans passer par un volume). */
function dockerWithInput(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new AppError(`docker ${args[0]} a échoué : ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new AppError(`docker ${args[0]} a échoué : ${err.trim() || `code ${code}`}`))));
    child.stdin.end(input);
  });
}

/** Conteneur Docker dédié au projet, code monté aux mêmes chemins absolus que sur l'hôte. */
export class DockerRunner implements Runner {
  readonly kind = 'docker' as const;

  containerName(project: Pick<Project, 'slug'>): string {
    return `skipper-${project.slug}`;
  }

  private settings(project: Project): Required<Pick<RunnerConfig, 'image' | 'memory' | 'cpus'>> {
    const c = (project.runnerConfig ?? {}) as RunnerConfig;
    return { image: c.image || config.runnerImage, memory: c.memory || config.runnerMemory, cpus: c.cpus || config.runnerCpus };
  }

  /** Script de relais donné au SDK : lance le CLI dans le conteneur, dans le même dossier, stdio relayés. */
  private relayPath(project: Project): string {
    return path.join(config.workspacesRoot, '.runners', project.slug, 'claude');
  }

  private async writeRelay(project: Project): Promise<string> {
    const file = this.relayPath(project);
    await mkdir(path.dirname(file), { recursive: true });
    const envFlags = PASSTHROUGH_ENV.map((v) => `-e ${v}`).join(' ');
    const script = `#!/bin/sh
# Généré par Skipper : exécute le CLI Claude Code dans le conteneur du projet ${project.slug}.
exec docker exec -i -w "$PWD" ${envFlags} ${this.containerName(project)} claude "$@"
`;
    await writeFile(file, script);
    await chmod(file, 0o755);
    return file;
  }

  async status(project: Project): Promise<RunnerStatus> {
    const s = this.settings(project);
    const base: RunnerStatus = { kind: 'docker', ready: false, state: 'absent', containerName: this.containerName(project), image: s.image, memory: s.memory, cpus: s.cpus, startedAt: null, error: null };
    try {
      const { stdout, code } = await docker(['inspect', '--format', '{{.State.Status}}|{{.State.StartedAt}}|{{.Config.Image}}', this.containerName(project)], { allowFail: true });
      if (code !== 0) return base;
      const [state, startedAt, image] = stdout.trim().split('|');
      return { ...base, state, ready: state === 'running', startedAt: state === 'running' ? new Date(startedAt) : null, image };
    } catch (err) {
      return { ...base, state: 'unavailable', error: (err as Error).message };
    }
  }

  async ensureReady(project: Project): Promise<RunnerStatus> {
    const current = await this.status(project);
    if (current.state === 'unavailable') throw new AppError(current.error ?? 'Docker indisponible');
    const name = this.containerName(project);
    const s = this.settings(project);
    const workspace = workspacePath(project);
    const worktrees = worktreesRoot(project);
    const plugin = contextPluginDir(project);
    const attachments = attachmentsRoot(project);
    // Les dossiers montés doivent exister avant `docker run`, sinon Docker les crée appartenant à root.
    await Promise.all([mkdir(worktrees, { recursive: true }), mkdir(plugin, { recursive: true }), mkdir(attachments, { recursive: true })]);
    const home = os.homedir();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;

    if (current.state === 'absent') {
      const args = [
        'run', '-d', '--name', name, '--restart', 'unless-stopped', '--memory', s.memory, '--cpus', s.cpus,
        '--user', `${uid}:${gid}`, '-e', `HOME=${home}`, '-w', workspace,
        // Le dossier personnel est un tmpfs inscriptible (caches npm, profil et rapports de plantage de
        // Chromium : sans dossier personnel inscriptible, Chromium meurt au lancement) ; les montages
        // ci-dessous (~/.claude, ~/.claude.json, ~/.gitconfig) viennent s'y superposer.
        '--tmpfs', `${home}:uid=${uid},gid=${gid},mode=0750,size=512m`,
        // Comptes de l'hôte en lecture seule : l'utilisateur a un nom, un home, et ssh/git fonctionnent.
        '-v', '/etc/passwd:/etc/passwd:ro', '-v', '/etc/group:/etc/group:ro',
        // Le code, les worktrees, les skills et les pièces jointes des sessions du projet, au même chemin que sur l'hôte.
        '-v', `${workspace}:${workspace}`, '-v', `${worktrees}:${worktrees}`, '-v', `${plugin}:${plugin}`, '-v', `${attachments}:${attachments}`,
      ];
      // Configuration et identifiants Claude Code de l'utilisateur système (dossier ~/.claude et fichier
      // ~/.claude.json), s'ils existent : le CLI du conteneur retrouve ainsi le compte du serveur.
      for (const entry of [path.join(home, '.claude'), path.join(home, '.claude.json'), path.join(home, '.gitconfig')]) {
        try {
          await execFileAsync('test', ['-e', entry]);
          args.push('-v', `${entry}:${entry}`);
        } catch {
          /* absent : l'authentification passe par les variables d'environnement */
        }
      }
      args.push(s.image, 'sleep', 'infinity');
      await docker(args);
    } else if (current.state !== 'running') {
      await docker(['start', name]);
    }
    await this.writeRelay(project);
    return this.status(project);
  }

  async stop(project: Project): Promise<RunnerStatus> {
    const current = await this.status(project);
    if (current.state === 'running') await docker(['stop', '-t', '5', this.containerName(project)]);
    return this.status(project);
  }

  async remove(project: Project): Promise<void> {
    await docker(['rm', '-f', this.containerName(project)], { allowFail: true });
  }

  async claudeExecutable(project: Project): Promise<string | undefined> {
    await this.ensureReady(project);
    return this.relayPath(project);
  }

  async terminalCommand(project: Project, cwd: string): Promise<SpawnSpec> {
    await this.ensureReady(project);
    return { command: 'docker', args: ['exec', '-it', '-w', cwd, '-e', 'TERM=xterm-256color', ...PASSTHROUGH_ENV.flatMap((v) => ['-e', v]), this.containerName(project), 'bash', '-l'] };
  }

  async shellCommand(project: Project, cwd: string, _shell: string, script: string): Promise<SpawnSpec> {
    await this.ensureReady(project);
    return { command: 'docker', args: ['exec', '-i', '-w', cwd, ...PASSTHROUGH_ENV.flatMap((v) => ['-e', v]), this.containerName(project), 'sh', '-c', script] };
  }

  /**
   * Playwright MCP installé dans l'image (`playwright-mcp`), captures d'écran dans le dossier de travail.
   * Les secrets sont écrits dans le /tmp du conteneur (hors des volumes, donc hors du dépôt) et supprimés en fin de session.
   * C'est le CLI qui lance ce serveur, et le CLI tourne déjà dans le conteneur (où `docker` n'existe pas) :
   * la commande s'exécute donc directement, sans `docker exec`.
   */
  async browserMcpCommand(project: Project, cwd: string, options: BrowserMcpOptions): Promise<BrowserMcpServer> {
    await this.ensureReady(project);
    const container = this.containerName(project);
    const args = [...PLAYWRIGHT_MCP_ARGS, '--output-dir', `${cwd}/.playwright-mcp`];
    let dir: string | null = null;
    if (Object.keys(options.secrets).length) {
      dir = `/tmp/${sessionTag(options.sessionId)}-browser`;
      await dockerWithInput(['exec', '-i', container, 'sh', '-c', 'umask 077 && rm -rf "$1" && mkdir -p "$1" && cat > "$1/secrets.env"', 'sh', dir], renderSecretsFile(options.secrets));
      args.push('--secrets', `${dir}/secrets.env`);
    }
    return { command: 'playwright-mcp', args, dispose: async () => (dir ? docker(['exec', container, 'rm', '-rf', dir], { allowFail: true }).then(() => undefined) : undefined) };
  }
}
