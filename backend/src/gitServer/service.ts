import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, forgejoConfigured } from '../config.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import type { Project } from '../projects/types.js';
import { ensureWorkspace, isGitRepository, workspacePath } from '../projects/workspace.js';
import { gitBackupRepository, type GitBackup } from './backups.js';
import { forgejoApi, forgejoGitAuthArgs, forgejoRepos, requireForgejo } from './forgejo.js';
import { bareRepoPath, gitServerRoot, hostedDefaultBranch, hostedGitUrl, hostedRepo, hostedRepoWebUrl } from './paths.js';

/**
 * Dépôts hébergés par Skipper, dans la forge Forgejo (voir forgejo.ts) : un dépôt privé par projet « hébergé »
 * (projects.git_hosted) dans l'organisation de Skipper, ses membres en collaborateurs. Le checkout principal et les
 * work sessions en sont des clones ordinaires (`origin` = l'URL publique de Forgejo ; depuis le serveur, git est
 * réécrit vers l'adresse directe avec le jeton administrateur, voir `gitAuthFor`). Le dépôt est aussi **sauvegardé dans
 * PostgreSQL** : un miroir local (<WORKSPACES_ROOT>/.git-server/<slug>.git) est rafraîchi depuis Forgejo et mis en
 * bundle quand ses références ont changé ; un dépôt absent de Forgejo est recréé depuis ce miroir ou la dernière
 * sauvegarde. Les dépôts nus du serveur git minimal d'avant Forgejo, au même endroit, sont repris de la même façon.
 */

/** Identité des commits faits par Skipper lui-même (import d'un dossier). */
const SKIPPER_IDENTITY = { GIT_AUTHOR_NAME: 'Skipper', GIT_AUTHOR_EMAIL: 'skipper@localhost', GIT_COMMITTER_NAME: 'Skipper', GIT_COMMITTER_EMAIL: 'skipper@localhost' };
/** Au-delà, le bundle n'est pas écrit en base (limite pratique d'un bytea : 1 Go). */
const MAX_BUNDLE_BYTES = 900 * 1024 * 1024;
/** Sauvegarde déclenchée par un push (webhook) : regroupée après un court délai. */
const AFTER_PUSH_DELAY_MS = 5000;
/** Passage de fond : dépôts présents dans Forgejo, collaborateurs à jour, sauvegarde si les références ont changé. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** git par spawn : entrée standard possible, sortie en Buffer, erreur lisible (jeton masqué). */
function run(args: string[], cwd?: string, opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', (e) => reject(new AppError(`git ${args[0]} a échoué : ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const verb = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? args[0];
      reject(new AppError(`git ${verb} a échoué : ${(err.trim() || `code ${code}`).replace(/AUTHORIZATION: basic \S+/gi, 'AUTHORIZATION: basic ***')}`));
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

/** Signature de l'état d'un dépôt : toutes ses branches et tags, triés. */
async function refsSignature(dir: string): Promise<string> {
  const out = await text(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'], dir).catch(() => '');
  return out.split('\n').filter(Boolean).sort().join('\n');
}

/** Pousse toutes les branches et tags d'un dépôt local vers le dépôt Forgejo du projet. */
async function pushAll(fromDir: string, project: Pick<Project, 'slug'>): Promise<void> {
  const url = hostedGitUrl(project.slug);
  await run([...forgejoGitAuthArgs(), 'push', '-q', url, '+refs/heads/*:refs/heads/*'], fromDir);
  await run([...forgejoGitAuthArgs(), 'push', '-q', url, '+refs/tags/*:refs/tags/*'], fromDir).catch(() => undefined);
}

/** Transforme un simple dossier en dépôt d'une branche (un commit avec tout son contenu) et la pousse dans Forgejo. */
async function importDirAsBranch(dir: string, branch: string, project: Pick<Project, 'slug'>): Promise<void> {
  await run(['init', '-q', `--initial-branch=${branch}`], dir);
  await run(['add', '-A'], dir);
  await run(['commit', '-q', '--allow-empty', '-m', 'Import du dossier existant'], dir, { env: SKIPPER_IDENTITY });
  await run([...forgejoGitAuthArgs(), 'push', '-q', hostedGitUrl(project.slug), `HEAD:refs/heads/${branch}`], dir);
}

/** Relie un checkout au dépôt hébergé : remote origin, références distantes, branche amont de la branche courante, origin/HEAD. */
async function attachOrigin(main: string, project: Pick<Project, 'slug'>, defaultBranch: string): Promise<void> {
  const remotes = (await text(['remote'], main)).split('\n');
  const url = hostedGitUrl(project.slug);
  if (remotes.includes('origin')) await run(['remote', 'set-url', 'origin', url], main);
  else await run(['remote', 'add', 'origin', url], main);
  await run([...forgejoGitAuthArgs(), 'fetch', '-q', '--prune', 'origin'], main);
  const current = await text(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => 'HEAD');
  if (current && current !== 'HEAD') await run(['branch', `--set-upstream-to=origin/${current}`, current], main).catch(() => undefined);
  await run(['remote', 'set-head', 'origin', defaultBranch], main).catch(() => undefined);
}

const ensuring = new Map<string, Promise<void>>();
const backing = new Map<string, Promise<GitBackup | null>>();
const pushTimers = new Map<string, NodeJS.Timeout>();
let sweepTimer: NodeJS.Timeout | null = null;

export interface HostedGitStatus {
  url: string;
  webUrl: string;
  exists: boolean;
  defaultBranch: string;
  /** Taille du dépôt dans Forgejo (octets), null s'il n'existe pas. */
  diskSize: number | null;
  lastBackup: GitBackup | null;
  backups: GitBackup[];
}

export const gitServer = {
  available: forgejoConfigured,
  url: (project: Pick<Project, 'slug'>) => hostedGitUrl(project.slug),
  webUrl: (project: Pick<Project, 'slug'>) => hostedRepoWebUrl(project.slug),
  mirrorPath: (project: Pick<Project, 'slug'>) => bareRepoPath(project.slug),

  /**
   * Dépôt Forgejo du projet prêt. S'il manque, il est recréé : depuis le miroir local (ou l'ancien dépôt nu du serveur
   * git minimal), sinon depuis la dernière sauvegarde en base, sinon avec un premier commit. Sérialisé par projet.
   */
  ensure(project: Project): Promise<void> {
    const pending = ensuring.get(project.id);
    if (pending) return pending;
    const task = (async () => {
      requireForgejo();
      const { name } = hostedRepo(project.slug);
      if (await forgejoRepos.exists(name)) return;
      const branch = hostedDefaultBranch(project);
      const mirror = bareRepoPath(project.slug);
      const latest = await gitBackupRepository.latest(project.id);
      if ((await exists(mirror)) && (await refsSignature(mirror))) {
        log.warn(`[git-server] ${project.slug} absent de Forgejo : recréé depuis le dépôt local ${mirror}`);
        await forgejoRepos.create(name, { description: project.description, defaultBranch: branch, autoInit: false });
        await pushAll(mirror, project);
      } else if (latest) {
        log.warn(`[git-server] ${project.slug} absent de Forgejo : restauration de la sauvegarde du ${latest.takenAt.toISOString()}`);
        await this.restore(project, latest.id);
        return;
      } else {
        await forgejoRepos.create(name, { description: project.description, defaultBranch: branch, autoInit: true });
      }
      await forgejoRepos.setDefaultBranch(name, branch).catch(() => undefined);
      await this.syncMembers(project).catch((err) => log.warn(`[git-server] collaborateurs de ${project.slug} : ${(err as Error).message}`));
    })().finally(() => ensuring.delete(project.id));
    ensuring.set(project.id, task);
    return task;
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
    requireForgejo();
    const project: Project = { ...before, gitHosted: true, gitUrl: hostedGitUrl(before.slug) };
    const { name } = hostedRepo(project.slug);
    if (await forgejoRepos.exists(name)) throw new AppError(`Un dépôt « ${config.forgejo.org}/${name} » existe déjà dans Forgejo (ancien projet du même nom ?) : renommez-le ou supprimez-le d'abord`);
    const main = workspacePath(project);
    const branch = hostedDefaultBranch(project);
    const mainExists = await exists(main);
    const mainIsGit = mainExists && (await isGitRepository(main));
    const mainEmpty = !mainExists || (await readdir(main)).length === 0;
    if (mainEmpty) {
      await forgejoRepos.create(name, { description: project.description, defaultBranch: branch, autoInit: true });
      await ensureWorkspace(project, null);
    } else if (mainIsGit) {
      const heads = (await text(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], main)).split('\n').filter(Boolean);
      if (!heads.length) throw new AppError('Le dossier du projet est un dépôt git sans aucun commit : faites un premier commit, ou videz le dossier');
      const current = await text(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => 'HEAD');
      const head = heads.includes(branch) ? branch : current !== 'HEAD' ? current : heads[0];
      await forgejoRepos.create(name, { description: project.description, defaultBranch: head, autoInit: false });
      await pushAll(main, project);
      await forgejoRepos.setDefaultBranch(name, head).catch(() => undefined);
      await attachOrigin(main, project, head);
    } else {
      await forgejoRepos.create(name, { description: project.description, defaultBranch: branch, autoInit: false });
      await importDirAsBranch(main, branch, project);
      await forgejoRepos.setDefaultBranch(name, branch).catch(() => undefined);
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
      if ((await readdir(dir)).length) await importDirAsBranch(dir, wt.branch, project);
      await rm(dir, { recursive: true, force: true });
      await worksessionService.checkout(main, dir, wt.branch, { defaultBranch: branch, auth: forgejoGitAuthArgs() });
    }
    await this.syncMembers(project).catch((err) => log.warn(`[git-server] collaborateurs de ${project.slug} : ${(err as Error).message}`));
    await this.backup(project, { force: true }).catch((err) => log.warn(`[git-server] première sauvegarde de ${project.slug} impossible : ${(err as Error).message}`));
  },

  /** Membres du projet → collaborateurs du dépôt Forgejo (comptes créés au besoin). */
  async syncMembers(project: Project): Promise<void> {
    if (!project.gitHosted || !forgejoConfigured()) return;
    const { userService } = await import('../users/service.js');
    const members = await userService.members(project.id);
    const withUsers = await Promise.all(members.map(async (m) => ({ user: await userService.get(m.userId), role: m.role })));
    await forgejoRepos.syncCollaborators(hostedRepo(project.slug).name, withUsers);
  },

  /** Rafraîchit le miroir local depuis Forgejo (créé au besoin) ; renvoie son chemin. */
  async refreshMirror(project: Project): Promise<string> {
    const dir = bareRepoPath(project.slug);
    if (!(await exists(dir))) {
      await mkdir(gitServerRoot(), { recursive: true });
      await run(['init', '-q', '--bare', dir]);
    }
    await run([...forgejoGitAuthArgs(), 'fetch', '-q', '--prune', hostedGitUrl(project.slug), '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], dir);
    const head = await forgejoApi<{ default_branch: string }>('GET', `/repos/${config.forgejo.org}/${hostedRepo(project.slug).name}`).then((r) => r.default_branch).catch(() => hostedDefaultBranch(project));
    await run(['symbolic-ref', 'HEAD', `refs/heads/${head}`], dir).catch(() => undefined);
    return dir;
  },

  /**
   * Sauvegarde le dépôt dans PostgreSQL (bundle de toutes les branches et tags du miroir, rafraîchi depuis Forgejo) si
   * son état a changé depuis la dernière prise, ou toujours avec `force`. Renvoie la sauvegarde courante ; null pour un
   * dépôt sans référence.
   */
  backup(project: Project, opts: { force?: boolean } = {}): Promise<GitBackup | null> {
    const pending = backing.get(project.id);
    if (pending) return pending;
    const task = (async () => {
      const dir = await this.refreshMirror(project);
      const refs = await refsSignature(dir);
      if (!refs) return null;
      const head = (await text(['symbolic-ref', '-q', 'HEAD'], dir).catch(() => '')).replace(/^refs\/heads\//, '') || hostedDefaultBranch(project);
      const latest = await gitBackupRepository.latest(project.id);
      if (!opts.force && latest && latest.refs === refs && latest.head === head) return latest;
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'skipper-bundle-'));
      try {
        const file = path.join(tmp, 'repo.bundle');
        await run(['bundle', 'create', '-q', file, '--branches', '--tags'], dir);
        const bundle = await readFile(file);
        if (bundle.length > MAX_BUNDLE_BYTES) throw new AppError(`Le dépôt est trop volumineux pour être sauvegardé en base (${Math.round(bundle.length / 1024 / 1024)} Mo)`);
        const saved = await gitBackupRepository.save(project.id, { refs, head, bundle });
        log.info(`[git-server] ${project.slug} sauvegardé en base (${Math.round(bundle.length / 1024)} Ko, ${saved.refCount} référence(s))`);
        return saved;
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    })().finally(() => backing.delete(project.id));
    backing.set(project.id, task);
    return task;
  },

  /** Recrée le dépôt Forgejo depuis une sauvegarde (la plus récente par défaut). Ne remplace jamais un dépôt présent. */
  async restore(project: Project, backupId?: string | null): Promise<void> {
    const { name } = hostedRepo(project.slug);
    if (await forgejoRepos.exists(name)) throw new AppError('Le dépôt existe dans Forgejo : la restauration ne remplace pas un dépôt présent');
    const id = backupId ?? (await gitBackupRepository.latest(project.id))?.id;
    const content = id ? await gitBackupRepository.content(id) : null;
    if (!content || content.projectId !== project.id) throw new AppError('Aucune sauvegarde de ce dépôt');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'skipper-bundle-'));
    try {
      const file = path.join(tmp, 'repo.bundle');
      await writeFile(file, content.bundle);
      const bare = path.join(tmp, 'repo.git');
      await run(['clone', '-q', '--bare', file, bare]);
      await forgejoRepos.create(name, { description: project.description, defaultBranch: content.head, autoInit: false });
      await pushAll(bare, project);
      await forgejoRepos.setDefaultBranch(name, content.head).catch(() => undefined);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.syncMembers(project).catch((err) => log.warn(`[git-server] collaborateurs de ${project.slug} : ${(err as Error).message}`));
  },

  /**
   * Retire le dépôt d'un projet qu'on supprime. `delete` : supprimé de Forgejo, avec son miroir local. Sinon il est
   * conservé dans Forgejo, archivé (lecture seule) et renommé `<slug>-supprime-<date>` : un futur projet du même slug
   * ne le reprend pas en silence, et l'on peut encore le cloner ou le désarchiver depuis Forgejo. Les sauvegardes en
   * base partent avec le projet.
   */
  async retire(project: Project, opts: { delete: boolean }): Promise<string | null> {
    if (!project.gitHosted || !forgejoConfigured()) return null;
    const { name } = hostedRepo(project.slug);
    await rm(bareRepoPath(project.slug), { recursive: true, force: true });
    if (!(await forgejoRepos.exists(name))) return null;
    const repoPath = `/repos/${config.forgejo.org}/${name}`;
    if (opts.delete) {
      await forgejoApi('DELETE', repoPath);
      log.info(`[git-server] dépôt ${config.forgejo.org}/${name} supprimé de Forgejo avec le projet`);
      return null;
    }
    const kept = `${name}-supprime-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;
    await forgejoApi('PATCH', repoPath, { name: kept, archived: true });
    log.info(`[git-server] dépôt ${config.forgejo.org}/${name} conservé dans Forgejo, archivé sous ${kept}`);
    return kept;
  },

  /** Après un push (webhook de Forgejo) : sauvegarde regroupée quelques secondes plus tard. */
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

  /** État du dépôt hébergé pour l'interface : adresses, présence dans Forgejo, branche principale, taille, sauvegardes. */
  async status(project: Project): Promise<HostedGitStatus> {
    const backups = await gitBackupRepository.list(project.id);
    const repo = forgejoConfigured()
      ? await forgejoApi<{ default_branch: string; size: number }>('GET', `/repos/${config.forgejo.org}/${hostedRepo(project.slug).name}`).catch(() => null)
      : null;
    return {
      url: hostedGitUrl(project.slug),
      webUrl: hostedRepoWebUrl(project.slug),
      exists: Boolean(repo),
      defaultBranch: repo?.default_branch ?? hostedDefaultBranch(project),
      diskSize: repo ? repo.size * 1024 : null,
      lastBackup: backups[0] ?? null,
      backups,
    };
  },

  /** Ce que les sessions d'un projet hébergé doivent savoir de leur dépôt (prompt système). */
  promptSummary(project: Project): string {
    if (!project.gitHosted) return '';
    return [
      `Le dépôt git du projet est hébergé par Skipper dans sa forge Forgejo (${hostedRepoWebUrl(project.slug)}, remote \`origin\`, branche principale \`${hostedDefaultBranch(project)}\`), pas sur GitHub.`,
      'Tes identifiants git sont déjà configurés : `git fetch`, `git pull` et `git push -u origin <branche>` fonctionnent tels quels. Les pull requests de ce dépôt sont dans Forgejo ; les outils `tasks` (pr_open, pr_register avec un numéro, pr_list, pr_update) les gèrent comme celles de GitHub.',
    ].join(' ');
  },

  /** Passage de fond : chaque dépôt hébergé présent dans Forgejo, ses collaborateurs à jour, sauvegardé s'il a changé. */
  async sweep(): Promise<void> {
    if (!forgejoConfigured()) return;
    await forgejoRepos.ensureOrg().catch((err) => log.warn(`[git-server] organisation Forgejo : ${(err as Error).message}`));
    for (const project of (await projectRepository.list()).filter((p) => p.gitHosted)) {
      try {
        await this.ensure(project);
        await this.syncMembers(project);
        await this.backup(project);
      } catch (err) {
        log.warn(`[git-server] ${project.slug} : ${(err as Error).message}`);
      }
    }
  },

  startBackgroundBackups(): void {
    if (sweepTimer || !forgejoConfigured()) return;
    sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    sweepTimer.unref();
    setTimeout(() => void this.sweep(), 30_000).unref();
  },

  stopBackgroundBackups(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    for (const t of pushTimers.values()) clearTimeout(t);
    pushTimers.clear();
  },
};
