import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import type { Project } from '../projects/types.js';
import { ensureWorkspace, isGitRepository, workspacePath } from '../projects/workspace.js';
import { gitBackupRepository, type GitBackup } from './backups.js';
import { bareRepoPath, gitServerRoot, hostedDefaultBranch, hostedGitUrl } from './paths.js';
import { gitTokenService } from './tokens.js';

/**
 * Serveur git hébergé par Skipper : un dépôt nu par projet « hébergé » (projects.git_hosted), sous
 * <WORKSPACES_ROOT>/.git-server/<slug>.git, servi en smart HTTP par `httpRoute.ts` et sauvegardé dans PostgreSQL
 * (`backups.ts`, un bundle complet par état distinct des références). Le checkout principal et les work sessions
 * d'un projet hébergé sont des clones ordinaires de ce dépôt : le reste de Skipper (worktrees, panneau git, PR en
 * préparation) ne voit qu'un `origin` comme un autre. Sur le serveur, les commandes git atteignent le dépôt nu par
 * son chemin (`url.<chemin>.insteadOf=<url>`, voir `gitAuthFor`) ; les conteneurs et les postes passent par HTTP
 * avec un jeton (`tokens.ts`).
 */

/** Identité des commits faits par Skipper lui-même (premier commit, import d'un dossier). */
const SKIPPER_IDENTITY = { GIT_AUTHOR_NAME: 'Skipper', GIT_AUTHOR_EMAIL: 'skipper@localhost', GIT_COMMITTER_NAME: 'Skipper', GIT_COMMITTER_EMAIL: 'skipper@localhost' };
/** Au-delà, le bundle n'est pas écrit en base (limite pratique d'un bytea : 1 Go). */
const MAX_BUNDLE_BYTES = 900 * 1024 * 1024;
/** Sauvegarde déclenchée par un push : regroupée après un court délai (plusieurs pushes se suivent souvent). */
const AFTER_PUSH_DELAY_MS = 3000;
/** Passage de fond : chaque dépôt hébergé dont les références ont changé est sauvegardé. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** git par spawn : entrée standard possible, sortie en Buffer (bundles, objets), erreur lisible. */
function run(args: string[], cwd?: string, opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', (e) => reject(new AppError(`git ${args[0]} a échoué : ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new AppError(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]} a échoué : ${err.trim() || `code ${code}`}`));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
const text = async (args: string[], cwd?: string, opts?: { input?: string | Buffer; env?: Record<string, string> }) => (await run(args, cwd, opts)).toString('utf8').trim();

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Réglages d'un dépôt nu servi par Skipper : pushes HTTP acceptés, reflog (une référence écrasée reste retrouvable). */
async function configureBare(dir: string): Promise<void> {
  await run(['config', 'http.receivepack', 'true'], dir);
  await run(['config', 'core.logAllRefUpdates', 'true'], dir);
}

/** Branche de HEAD d'un dépôt nu (sans refs/heads/), ou la branche par défaut du projet si HEAD est détaché. */
async function headBranch(dir: string, project: Pick<Project, 'gitBranch'>): Promise<string> {
  const ref = await text(['symbolic-ref', '-q', 'HEAD'], dir).catch(() => '');
  return ref.replace(/^refs\/heads\//, '') || hostedDefaultBranch(project);
}

/** Signature de l'état du dépôt : toutes ses références et leur commit, triées. */
async function refsSignature(dir: string): Promise<string> {
  const out = await text(['for-each-ref', '--format=%(objectname) %(refname)'], dir);
  return out.split('\n').filter(Boolean).sort().join('\n');
}

/** Vue « hébergée » d'un projet dont la ligne ne l'est pas encore : l'URL dérivée, pour cloner avant d'enregistrer. */
export const asHosted = (project: Project): Project => ({ ...project, gitHosted: true, gitUrl: hostedGitUrl(project.slug) });

/** Arguments `-c` qui envoient les commandes du serveur vers le dépôt nu plutôt que vers son URL HTTP. */
export function hostedInsteadOf(project: Pick<Project, 'slug'>): string[] {
  return ['-c', `url.${bareRepoPath(project.slug)}.insteadOf=${hostedGitUrl(project.slug)}`];
}

/** Transforme un simple dossier en dépôt d'une branche (un commit avec tout son contenu) et la pousse dans le dépôt nu. */
async function importDirAsBranch(dir: string, branch: string, bare: string): Promise<void> {
  await run(['init', '-q', `--initial-branch=${branch}`], dir);
  await run(['add', '-A'], dir);
  await run(['commit', '-q', '--allow-empty', '-m', 'Import du dossier existant'], dir, { env: SKIPPER_IDENTITY });
  await run(['push', '-q', bare, `HEAD:refs/heads/${branch}`], dir);
}

/** Relie un checkout au dépôt hébergé : remote origin, références distantes, branche amont de la branche courante, origin/HEAD. */
async function attachOrigin(main: string, project: Project, defaultBranch: string): Promise<void> {
  const remotes = (await text(['remote'], main)).split('\n');
  const url = hostedGitUrl(project.slug);
  if (remotes.includes('origin')) await run(['remote', 'set-url', 'origin', url], main);
  else await run(['remote', 'add', 'origin', url], main);
  await run([...hostedInsteadOf(project), 'fetch', '-q', '--prune', 'origin'], main);
  const current = await text(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => 'HEAD');
  if (current && current !== 'HEAD') await run(['branch', `--set-upstream-to=origin/${current}`, current], main).catch(() => undefined);
  await run(['remote', 'set-head', 'origin', defaultBranch], main).catch(() => undefined);
}

const backing = new Map<string, Promise<GitBackup | null>>();
const pushTimers = new Map<string, NodeJS.Timeout>();
let sweepTimer: NodeJS.Timeout | null = null;

export interface HostedGitStatus {
  url: string;
  exists: boolean;
  defaultBranch: string;
  /** Taille des objets du dépôt nu sur disque (octets), null s'il n'existe pas. */
  diskSize: number | null;
  lastBackup: GitBackup | null;
  backups: GitBackup[];
}

export const gitServer = {
  path: (project: Pick<Project, 'slug'>) => bareRepoPath(project.slug),
  url: (project: Pick<Project, 'slug'>) => hostedGitUrl(project.slug),
  exists: (project: Pick<Project, 'slug'>) => exists(bareRepoPath(project.slug)),

  /** Dépôt nu prêt : existant, sinon restauré depuis la dernière sauvegarde, sinon créé avec un premier commit. */
  async ensure(project: Project): Promise<string> {
    const dir = bareRepoPath(project.slug);
    if (await exists(dir)) return dir;
    const latest = await gitBackupRepository.latest(project.id);
    if (latest) {
      log.warn(`[git-server] dépôt ${project.slug}.git absent : restauration de la sauvegarde du ${latest.takenAt.toISOString()}`);
      await this.restore(project, latest.id);
      return dir;
    }
    return this.init(project, { initialCommit: true });
  },

  /** Crée le dépôt nu ; `initialCommit` : un README sur la branche principale, pour que les clones aient un point de départ. */
  async init(project: Project, opts: { initialCommit: boolean }): Promise<string> {
    const dir = bareRepoPath(project.slug);
    if (await exists(dir)) throw new AppError(`Un dépôt hébergé « ${project.slug}.git » existe déjà sur le serveur (ancien projet du même nom ?) : déplacez-le ou supprimez-le d'abord`);
    const branch = hostedDefaultBranch(project);
    await mkdir(gitServerRoot(), { recursive: true });
    await run(['init', '-q', '--bare', `--initial-branch=${branch}`, dir]);
    await configureBare(dir);
    if (opts.initialCommit) {
      const readme = `# ${project.name}\n\n${project.description?.trim() ? `${project.description.trim()}\n\n` : ''}Dépôt git hébergé par Skipper.\n`;
      const blob = await text(['hash-object', '-w', '--stdin'], dir, { input: readme });
      const tree = await text(['mktree'], dir, { input: `100644 blob ${blob}\tREADME.md\n` });
      const commit = await text(['commit-tree', tree, '-m', 'Premier commit'], dir, { env: SKIPPER_IDENTITY });
      await run(['update-ref', `refs/heads/${branch}`, commit], dir);
    }
    return dir;
  },

  /**
   * Héberge le dépôt d'un projet qui n'en avait pas. Le dossier du projet est repris tel quel : vide ou absent, il
   * sera cloné ; déjà un dépôt git, ses branches et tags sont poussés ; un simple dossier devient le premier commit
   * de la branche principale. Les dossiers des work sessions (simples dossiers d'un projet sans dépôt) deviennent
   * chacun une branche, puis sont recréés en worktree de cette branche. À appeler avant d'enregistrer git_hosted.
   */
  async enable(before: Project): Promise<void> {
    if (before.gitHosted) return;
    if (before.gitUrl) throw new AppError("Ce projet est relié à un dépôt distant : Skipper n'héberge que les projets sans dépôt");
    const project = asHosted(before);
    const bare = bareRepoPath(project.slug);
    const main = workspacePath(project);
    const branch = hostedDefaultBranch(project);
    const mainExists = await exists(main);
    const mainIsGit = mainExists && (await isGitRepository(main));
    const mainEmpty = !mainExists || (await readdir(main)).length === 0;
    if (mainEmpty) {
      await this.init(project, { initialCommit: true });
      await ensureWorkspace(project, null);
    } else if (mainIsGit) {
      const heads = (await text(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], main)).split('\n').filter(Boolean);
      if (!heads.length) throw new AppError('Le dossier du projet est un dépôt git sans aucun commit : faites un premier commit, ou videz le dossier');
      await this.init(project, { initialCommit: false });
      await run(['push', '-q', '--all', bare], main);
      await run(['push', '-q', '--tags', bare], main).catch(() => undefined);
      const current = await text(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => 'HEAD');
      const head = heads.includes(branch) ? branch : current !== 'HEAD' ? current : heads[0];
      await run(['symbolic-ref', 'HEAD', `refs/heads/${head}`], bare);
      await attachOrigin(main, project, head);
    } else {
      await this.init(project, { initialCommit: false });
      await importDirAsBranch(main, branch, bare);
      await attachOrigin(main, project, branch);
    }
    // Work sessions : simples dossiers → une branche chacun, puis un worktree ordinaire de cette branche.
    const { worksessionPath, worksessionService } = await import('../worksessions/service.js');
    for (const wt of await worksessionService.listByProject(project.id, { includeArchived: true })) {
      const dir = worksessionPath(project, wt);
      if (!(await exists(dir))) continue;
      if (await exists(path.join(dir, '.git'))) {
        log.warn(`[git-server] ${project.slug} : la work session ${wt.name} est déjà un dépôt git, laissée telle quelle`);
        continue;
      }
      if ((await readdir(dir)).length) await importDirAsBranch(dir, wt.branch, bare);
      await rm(dir, { recursive: true, force: true });
      await worksessionService.checkout(main, dir, wt.branch, { defaultBranch: branch, auth: hostedInsteadOf(project) });
    }
    await this.backup(project, { force: true }).catch((err) => log.warn(`[git-server] première sauvegarde de ${project.slug} impossible : ${(err as Error).message}`));
  },

  /**
   * Sauvegarde le dépôt dans PostgreSQL (bundle de toutes les références) si son état a changé depuis la dernière
   * prise, ou toujours avec `force`. Renvoie la sauvegarde courante ; null pour un dépôt absent ou sans référence.
   */
  backup(project: Project, opts: { force?: boolean } = {}): Promise<GitBackup | null> {
    const pending = backing.get(project.id);
    if (pending) return pending;
    const task = (async () => {
      const dir = bareRepoPath(project.slug);
      if (!(await exists(dir))) return null;
      const refs = await refsSignature(dir);
      if (!refs) return null;
      const head = await headBranch(dir, project);
      const latest = await gitBackupRepository.latest(project.id);
      if (!opts.force && latest && latest.refs === refs && latest.head === head) return latest;
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'skipper-bundle-'));
      try {
        const file = path.join(tmp, 'repo.bundle');
        await run(['bundle', 'create', '-q', file, '--all'], dir);
        const bundle = await readFile(file);
        if (bundle.length > MAX_BUNDLE_BYTES) throw new AppError(`Le dépôt est trop volumineux pour être sauvegardé en base (${Math.round(bundle.length / 1024 / 1024)} Mo)`);
        const saved = await gitBackupRepository.save(project.id, { refs, head, bundle });
        log.info(`[git-server] ${project.slug}.git sauvegardé (${Math.round(bundle.length / 1024)} Ko, ${saved.refCount} référence(s))`);
        return saved;
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    })().finally(() => backing.delete(project.id));
    backing.set(project.id, task);
    return task;
  },

  /** Recrée le dépôt nu depuis une sauvegarde (la plus récente par défaut). Ne remplace jamais un dépôt présent. */
  async restore(project: Project, backupId?: string | null): Promise<void> {
    const dir = bareRepoPath(project.slug);
    if (await exists(dir)) throw new AppError('Le dépôt existe sur le serveur : la restauration ne remplace pas un dépôt présent');
    const id = backupId ?? (await gitBackupRepository.latest(project.id))?.id;
    const content = id ? await gitBackupRepository.content(id) : null;
    if (!content || content.projectId !== project.id) throw new AppError('Aucune sauvegarde de ce dépôt');
    await mkdir(gitServerRoot(), { recursive: true });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'skipper-bundle-'));
    try {
      const file = path.join(tmp, 'repo.bundle');
      await writeFile(file, content.bundle);
      await run(['clone', '-q', '--bare', file, dir]);
      await run(['remote', 'remove', 'origin'], dir).catch(() => undefined);
      await configureBare(dir);
      await run(['symbolic-ref', 'HEAD', `refs/heads/${content.head}`], dir);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  },

  /** Après un push reçu : sauvegarde regroupée quelques secondes plus tard. */
  afterPush(project: Project): void {
    const timer = pushTimers.get(project.id);
    if (timer) clearTimeout(timer);
    pushTimers.set(
      project.id,
      setTimeout(() => {
        pushTimers.delete(project.id);
        void this.backup(project).catch((err) => log.error(`[git-server] sauvegarde de ${project.slug} après push`, err));
      }, AFTER_PUSH_DELAY_MS),
    );
  },

  /** État du dépôt hébergé pour l'interface : URL, présence, branche principale, taille, sauvegardes. */
  async status(project: Project): Promise<HostedGitStatus> {
    const dir = bareRepoPath(project.slug);
    const present = await exists(dir);
    let diskSize: number | null = null;
    let defaultBranch = hostedDefaultBranch(project);
    if (present) {
      defaultBranch = await headBranch(dir, project);
      const counts = await text(['count-objects', '-v'], dir).catch(() => '');
      const kib = (key: string) => Number(counts.match(new RegExp(`^${key}: (\\d+)$`, 'm'))?.[1] ?? 0);
      diskSize = (kib('size') + kib('size-pack')) * 1024;
    }
    const backups = await gitBackupRepository.list(project.id);
    return { url: hostedGitUrl(project.slug), exists: present, defaultBranch, diskSize, lastBackup: backups[0] ?? null, backups };
  },

  /** Ce que les sessions d'un projet hébergé doivent savoir de leur dépôt (prompt système). */
  promptSummary(project: Project): string {
    if (!project.gitHosted) return '';
    return [
      `Le dépôt git du projet est hébergé par Skipper (remote \`origin\` = ${hostedGitUrl(project.slug)}, branche principale \`${hostedDefaultBranch(project)}\`).`,
      "Tes identifiants git sont déjà configurés : `git fetch`, `git pull` et `git push -u origin <branche>` fonctionnent tels quels. Ce dépôt n'est pas sur GitHub : il n'y a ni pull request ni CI à ouvrir pour lui ; pousse ta branche et signale-la dans la tâche.",
    ].join(' ');
  },

  /** Passage de fond : sauvegarde les dépôts qui ont changé (pushes faits sans passer par HTTP, par exemple) et purge les jetons expirés. */
  async sweep(): Promise<void> {
    const purged = await gitTokenService.purgeExpired().catch(() => 0);
    if (purged) log.info(`[git-server] ${purged} jeton(s) d'accès expiré(s) supprimé(s)`);
    for (const project of (await projectRepository.list()).filter((p) => p.gitHosted)) {
      await this.backup(project).catch((err) => log.warn(`[git-server] sauvegarde de ${project.slug} : ${(err as Error).message}`));
    }
  },

  startBackgroundBackups(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    setTimeout(() => void this.sweep(), 60_000).unref();
  },

  stopBackgroundBackups(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    for (const t of pushTimers.values()) clearTimeout(t);
    pushTimers.clear();
  },
};
