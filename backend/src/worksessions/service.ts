import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { slugify } from '../projects/slug.js';
import type { Project } from '../projects/types.js';
import { ensureWorkspace, git, gitAuthFor, isGitRepository, workspacePath } from '../projects/workspace.js';
import { LABEL_MAX, uniqueName, uniqueNameAndBranch } from './names.js';
import { worksessionRepository } from './repository.js';
import { worksessionLabel, type Worksession } from './types.js';
import { log } from '../log.js';
import { removeNodeModules, seedWorksessionDeps } from '../previews/deps.js';

export { namesFromText, uniqueName } from './names.js';

/**
 * Dossier contenant les work sessions d'un projet, à côté du checkout principal : <root>/<slug>.worktrees/<name>.
 * Le nom sur disque date des worktrees : le garder évite de déplacer les dossiers existants (et leurs liens git).
 */
export function worksessionsRoot(project: Pick<Project, 'slug'>): string {
  return path.join(config.workspacesRoot, `${project.slug}.worktrees`);
}
export function worksessionPath(project: Pick<Project, 'slug'>, worksession: Pick<Worksession, 'name'>): string {
  return path.join(worksessionsRoot(project), worksession.name);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function validateBranch(branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.endsWith('/') || branch.includes('..') || branch.endsWith('.lock')) {
    throw new AppError(`Nom de branche invalide : ${branch}`);
  }
  return branch;
}

/** Point de départ d'une branche : pas d'option déguisée (`--…`) ni de caractère interdit par git. */
function validateBaseRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/@^~-]*$/.test(ref) || ref.includes('..')) throw new AppError(`Référence de départ invalide : ${ref}`);
  return ref;
}

/**
 * Point de départ par défaut d'une nouvelle branche : le dernier commit de la branche principale **sur
 * origin** (`origin/<branche du projet>`, sinon `origin/<branche du checkout principal>`, sinon
 * `origin/HEAD`), à appeler après un fetch. Le HEAD du checkout principal n'avance qu'aux fusions faites
 * depuis Skipper : il peut avoir des semaines de retard sur origin, alors que ce que l'on veut est de
 * partir du main à jour. Sans origin joignable ni branche connue, on retombe sur ce HEAD.
 */
export async function defaultStartPoint(main: string, preferred: string | null | undefined): Promise<string> {
  const candidates: string[] = [];
  if (preferred) candidates.push(`origin/${preferred}`);
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => '');
  if (current && current !== 'HEAD') candidates.push(`origin/${current}`);
  const originHead = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], main).catch(() => '');
  if (originHead) candidates.push(originHead);
  for (const c of candidates) {
    if (await git(['rev-parse', '--verify', '-q', `${c}^{commit}`], main).then(() => true, () => false)) return c;
  }
  return 'HEAD';
}

/**
 * Avance le checkout principal sur sa branche distante quand c'est une avance rapide (il n'y a pas de
 * commits locaux à préserver : rien ne tourne dans ce dossier). Échecs ignorés : HEAD détaché, pas de
 * branche distante, divergence, modifications locales qui seraient écrasées.
 */
async function fastForwardMain(main: string): Promise<void> {
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => '');
  if (!current || current === 'HEAD') return;
  await git(['merge', '--ff-only', '--quiet', `origin/${current}`], main).catch(() => undefined);
}

/** Libellé normalisé : espaces réduits, vide → null, 100 caractères au plus. */
export function normalizeLabel(raw: string | null | undefined): string | null {
  const label = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!label) return null;
  if (label.length > LABEL_MAX) throw new AppError(`Le libellé est trop long (${LABEL_MAX} caractères au plus)`);
  return label;
}

export interface CreateWorksessionInput {
  /** Branche à extraire (projet git) : créée depuis `baseRef` si elle n'existe pas ; défaut : le nom du dossier. */
  branch?: string | null;
  /** Nom du dossier (slugifié) ; défaut : dérivé de la branche, sinon du libellé. */
  name?: string | null;
  baseRef?: string | null;
  /** Libellé affiché (texte libre) : ce dont parle la work session. */
  label?: string | null;
  /** Tâche à laquelle la work session est consacrée. */
  taskId?: string | null;
  /**
   * Noms dérivés (de la consigne, du titre d'une tâche), pas choisis : dossier et branche reçoivent ensemble
   * un suffixe (`-2`, `-3`…) tant que la branche existe déjà, localement, sur origin ou dans un autre dossier
   * de travail. Sans cette option, une branche existante est extraite telle quelle.
   */
  uniqueBranch?: boolean;
}

/**
 * Crochets des modules qui accrochent quelque chose à une work session : `afterCreate` est lancé (sans être attendu)
 * après la création du dossier d'un projet git (aperçus : installation des dépendances en arrière-plan) ;
 * `beforeRetire` est appelé avant son archivage ou sa suppression (aperçus : arrêt du serveur de développement et de
 * l'installation) ; `onCreated` est attendu après la création de toute work session, avant de la rendre (fichiers
 * d'environnement : prêts quand l'agent démarre). Les erreurs sont journalisées, jamais bloquantes.
 */
export const worksessionHooks = {
  afterCreate: [] as ((project: Project, worksession: Worksession) => Promise<void>)[],
  beforeRetire: [] as ((project: Project, worksession: Worksession) => Promise<void>)[],
  /** Attendu après la création du dossier et de l'enregistrement (fichiers d'environnement), pour la personne qui la crée. */
  onCreated: [] as ((project: Project, worksession: Worksession, actorId: string | null) => Promise<void>)[],
};
async function runCreateHooks(project: Project, worksession: Worksession): Promise<void> {
  for (const hook of worksessionHooks.afterCreate) {
    await hook(project, worksession).catch((err) => log.warn(`[worksessions] ${worksession.name} : ${(err as Error).message}`));
  }
}
async function runRetireHooks(project: Project, worksession: Worksession): Promise<void> {
  for (const hook of worksessionHooks.beforeRetire) {
    await hook(project, worksession).catch((err) => log.warn(`[worksessions] ${worksession.name} : ${(err as Error).message}`));
  }
}

async function runOnCreatedHooks(project: Project, worksession: Worksession, actorId: string | null): Promise<void> {
  for (const hook of worksessionHooks.onCreated) {
    await hook(project, worksession, actorId).catch((err) => log.warn(`[worksessions] ${worksession.name} : ${(err as Error).message}`));
  }
}

/** Allègements en cours des dossiers archivés, par work session : la restauration attend le sien. */
const lightening = new Map<string, Promise<void>>();

/**
 * Allège le dossier d'une work session qui vient d'être archivée : ses `node_modules` sont retirés (de quelques Mo de liens
 * à 1 Go pour une copie installée à part), la restauration les reconstitue depuis l'instantané. Lancé sans être attendu ;
 * rien n'est retiré si la work session a été restaurée entre-temps.
 */
function lightenArchived(project: Project, wt: Worksession): void {
  if (!project.gitUrl) return;
  const dir = worksessionPath(project, wt);
  const task = (async () => {
    const current = await worksessionRepository.findById(wt.id);
    if (!current?.archivedAt || !(await exists(dir))) return;
    const removed = await removeNodeModules(dir);
    if (removed.length) log.info(`[worksessions] ${wt.name} archivée : ${removed.join(', ')} retiré(s)`);
  })()
    .catch((err) => log.warn(`[worksessions] ${wt.name} : dossier archivé non allégé : ${(err as Error).message}`))
    .finally(() => lightening.delete(wt.id));
  lightening.set(wt.id, task);
}

/** Restaurations de dossier en cours, par work session : des appels concurrents partagent la même. */
const restoring = new Map<string, Promise<string>>();

/** Dossier de chaque branche extraite dans un worktree du dépôt (checkout principal compris). */
async function worktreeBranches(main: string): Promise<Map<string, string>> {
  const out = await git(['worktree', 'list', '--porcelain'], main).catch(() => '');
  const map = new Map<string, string>();
  let dir = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/')) map.set(line.slice('branch refs/heads/'.length), dir);
  }
  return map;
}

/** Branches qui existent déjà : locales, sur origin (dernier fetch) et extraites dans un worktree. */
async function takenBranches(main: string): Promise<Set<string>> {
  const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], main).catch(() => '');
  const taken = new Set<string>();
  for (const ref of refs.split('\n').map((r) => r.trim())) {
    if (ref.startsWith('refs/heads/')) taken.add(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') taken.add(ref.slice('refs/remotes/origin/'.length));
  }
  for (const branch of (await worktreeBranches(main)).keys()) taken.add(branch);
  return taken;
}

export const worksessionService = {
  listByProject: (projectId: string, opts?: { includeArchived?: boolean; archived?: 'exclude' | 'only' | 'all' }) => worksessionRepository.listByProject(projectId, opts),
  findByBranch: (projectId: string, branch: string) => worksessionRepository.findByBranch(projectId, branch),

  async get(id: string): Promise<Worksession> {
    const wt = await worksessionRepository.findById(id);
    if (!wt) throw new NotFoundError('Work session introuvable');
    return wt;
  },

  exists: (project: Project, worksession: Worksession) => exists(worksessionPath(project, worksession)),

  /** Branche et commit courants de la work session, ou null si elle n'existe pas sur disque ou n'est pas un dépôt git. */
  async gitInfo(project: Project, worksession: Worksession): Promise<{ branch: string; commit: string } | null> {
    const dir = worksessionPath(project, worksession);
    if (!project.gitUrl || !(await exists(dir))) return null;
    try {
      const [branch, commit] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), git(['rev-parse', '--short', 'HEAD'], dir)]);
      return { branch, commit };
    } catch {
      return null;
    }
  },

  /** Un nom de dossier libre parmi toutes les work sessions du projet (archivées comprises). */
  async assertNameFree(projectId: string, name: string, exceptId: string | null = null): Promise<void> {
    const clash = (await worksessionRepository.listByProject(projectId, { includeArchived: true })).find((w) => w.name === name && w.id !== exceptId);
    if (clash) throw new AppError(`Une work session « ${name} » existe déjà${clash.archivedAt ? ' (archivée : restaurez-la ou supprimez-la, ou choisissez un autre nom)' : ''}`);
  },

  /**
   * Vérifie qu'une work session peut être créée et fixe ses noms : le dossier est un slug (du nom, sinon de
   * la branche, sinon du libellé), rendu unique dans le projet (archivées comprises) par un suffixe ; la
   * branche d'un projet git est celle donnée, sinon le nom du dossier ; un projet sans dépôt n'a pas de
   * branche (le nom du dossier en tient lieu).
   */
  async validate(project: Project, input: CreateWorksessionInput): Promise<{ branch: string; name: string; label: string | null; base: string; takenNames: string[] }> {
    const label = normalizeLabel(input.label);
    const base = slugify(input.name?.trim() || input.branch?.trim() || label || '');
    if (!base) throw new AppError('Donnez à la work session un nom, une branche ou un libellé');
    const existing = await worksessionRepository.listByProject(project.id, { includeArchived: true });
    const name = uniqueName(existing, base);
    const branch = project.gitUrl ? validateBranch(input.branch?.trim() || name) : name;
    return { branch, name, label, base, takenNames: existing.map((w) => w.name) };
  },

  /**
   * Crée une work session. Projet git : `git worktree add` — la branche est extraite si elle existe
   * (localement ou sur origin), sinon créée depuis `baseRef` (défaut : la branche principale sur origin,
   * voir `defaultStartPoint`). Projet sans dépôt : un simple dossier.
   */
  async create(projectId: string, input: CreateWorksessionInput, actorId?: string | null): Promise<Worksession> {
    const project = await projectService.get(projectId);
    const validated = await this.validate(project, input);
    const { label } = validated;
    let { branch, name } = validated;
    let main: string | null = null;
    let auth: string[] = [];
    if (project.gitUrl) {
      main = await ensureWorkspace(project, actorId);
      if (!(await isGitRepository(main))) {
        throw new AppError(
          `Le dossier principal du projet (${main}) n'est pas un dépôt git. S'il est vide, « Créer le dossier » depuis la page du projet le clonera ; sinon videz-le ou clonez-y le dépôt à la main.`,
        );
      }
      auth = await gitAuthFor(project, actorId);
      if (input.uniqueBranch) {
        // Branches à jour d'origin avant de choisir : le checkout qui suit n'a plus besoin de refaire le fetch.
        await git(['fetch', '--prune', 'origin'], main, auth).catch(() => undefined);
        const branchBase = validateBranch(input.branch?.trim() || validated.base);
        ({ name, branch } = uniqueNameAndBranch(validated.base, branchBase, validated.takenNames, await takenBranches(main)));
      }
    }
    const dir = worksessionPath(project, { name });
    if (await exists(dir)) throw new AppError(`Le dossier ${dir} existe déjà`);
    await mkdir(worksessionsRoot(project), { recursive: true });
    if (main) {
      const base = input.baseRef?.trim() ? validateBaseRef(input.baseRef.trim()) : null;
      await this.checkout(main, dir, branch, { base, defaultBranch: project.gitBranch, auth, fetched: Boolean(input.uniqueBranch) });
      // Dépendances déjà installées une fois pour ce lockfile (instantané des aperçus) : liées tout de suite, sans installation.
      await seedWorksessionDeps(worksessionsRoot(project), dir);
    } else {
      await mkdir(dir, { recursive: true });
    }
    let created: Worksession;
    try {
      created = await worksessionRepository.create(projectId, name, branch, label, input.taskId ?? null);
    } catch (err) {
      if (main) await git(['worktree', 'remove', '--force', dir], main).catch(() => undefined);
      else await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if ((err as { code?: string }).code === '23505') throw new AppError(`Une work session « ${name} » existe déjà`);
      throw err;
    }
    await runOnCreatedHooks(project, created, actorId ?? null);
    if (main) void runCreateHooks(project, created);
    return created;
  },

  /**
   * `git worktree add` après un fetch : branche locale, distante, ou nouvelle depuis `base` (sans `base` :
   * la branche principale sur origin, `defaultStartPoint`). Le checkout principal est au passage avancé
   * sur origin quand c'est une avance rapide. Renvoie comment la branche a été obtenue et d'où.
   */
  async checkout(
    main: string,
    dir: string,
    branch: string,
    opts: { base?: string | null; defaultBranch?: string | null; auth?: string[]; fetched?: boolean } = {},
  ): Promise<{ how: 'local' | 'remote' | 'new'; from: string }> {
    if (!opts.fetched) await git(['fetch', '--prune', 'origin'], main, opts.auth ?? []).catch(() => undefined);
    await fastForwardMain(main);
    const localBranches = (await git(['branch', '--list', branch], main)).trim();
    const remoteBranches = (await git(['branch', '-r', '--list', `origin/${branch}`], main)).trim();
    if (localBranches) {
      const usedBy = (await worktreeBranches(main)).get(branch);
      if (usedBy) {
        throw new AppError(
          `La branche « ${branch} » est déjà extraite dans le dossier de travail ${path.basename(usedBy)} : ouvrez la session de ce dossier, ou choisissez une autre branche.`,
        );
      }
      await git(['worktree', 'add', dir, branch], main);
      return { how: 'local', from: branch };
    }
    if (remoteBranches) {
      await git(['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`], main);
      return { how: 'remote', from: `origin/${branch}` };
    }
    const from = opts.base || (await defaultStartPoint(main, opts.defaultBranch));
    await git(['worktree', 'add', '-b', branch, '--', dir, from], main);
    return { how: 'new', from };
  },

  /**
   * La work session consacrée à une tâche, restaurée si elle était archivée ; null si la tâche n'en a pas
   * encore. Une tâche garde une seule work session : ses sessions suivantes y travaillent.
   */
  async forTask(taskId: string): Promise<Worksession | null> {
    const [first] = await worksessionRepository.findByTask(taskId);
    if (!first) return null;
    return first.archivedAt ? this.restore(first.id) : first;
  },

  /**
   * Renomme le libellé et/ou le dossier. Le dossier (`git worktree move`) ne change que si rien ne tourne
   * dans la work session ; les sessions le retrouvent sous son nouveau nom à leur prochain tour.
   */
  async rename(id: string, input: { label?: string | null; name?: string | null }): Promise<Worksession> {
    const wt = await this.get(id);
    const patch: { label?: string | null; name?: string } = {};
    if (input.label !== undefined) patch.label = normalizeLabel(input.label);
    const newName = input.name?.trim() ? slugify(input.name.trim()) : null;
    if (input.name?.trim() && !newName) throw new AppError('Nom de dossier invalide');
    if (newName && newName !== wt.name) {
      await this.assertNameFree(wt.projectId, newName, wt.id);
      const project = await projectService.get(wt.projectId);
      const from = worksessionPath(project, wt);
      const to = worksessionPath(project, { name: newName });
      if (!wt.archivedAt && (await exists(from))) {
        const busy = await worksessionRepository.countBusy(id);
        if (busy.sessions || busy.terminals) throw new AppError(`Le dossier ne peut pas être renommé pendant que quelque chose y tourne (${busy.sessions} session(s), ${busy.terminals} terminal(aux)) : arrêtez-les, ou changez seulement le libellé`);
        if (await exists(to)) throw new AppError(`Le dossier ${to} existe déjà`);
        const main = workspacePath(project);
        const isGit = Boolean(project.gitUrl) && (await isGitRepository(main));
        if (isGit) await git(['worktree', 'move', from, to], main);
        else await rename(from, to);
        try {
          patch.name = newName;
          return (await worksessionRepository.update(id, patch)) ?? wt;
        } catch (err) {
          if (isGit) await git(['worktree', 'move', to, from], main).catch(() => undefined);
          else await rename(to, from).catch(() => undefined);
          throw err;
        }
      }
      patch.name = newName;
    }
    return (await worksessionRepository.update(id, patch)) ?? wt;
  },

  /** Supprime la work session (dossier et enregistrement). La branche est conservée sauf `deleteBranch`. Jamais de clone pour supprimer. */
  async delete(id: string, deleteBranch = false): Promise<boolean> {
    const wt = await this.get(id);
    if ((await worksessionRepository.countRunningSessions(id)) > 0) throw new AppError('Des sessions tournent encore dans cette work session');
    const project = await projectService.get(wt.projectId);
    await runRetireHooks(project, wt);
    const main = workspacePath(project);
    const dir = worksessionPath(project, wt);
    if (project.gitUrl && (await isGitRepository(main))) {
      if (await exists(dir)) await git(['worktree', 'remove', '--force', dir], main).catch(() => rm(dir, { recursive: true, force: true }));
      await git(['worktree', 'prune'], main).catch(() => undefined);
      if (deleteBranch) await git(['branch', '-D', '--', wt.branch], main).catch(() => undefined);
    } else if (await exists(dir)) {
      // Projet sans dépôt, ou dossier principal absent : on retire simplement le dossier, sans cloner pour le faire.
      await rm(dir, { recursive: true, force: true });
    }
    return worksessionRepository.delete(id);
  },

  /**
   * Archive la work session : ses sessions actives sont archivées avec elle (date commune), son dossier est conservé,
   * allégé de ses dépendances (`lightenArchived`), puis retiré du disque quelques jours plus tard s'il n'a rien
   * d'unique (worksessions/housekeeping.ts) ; la restauration le reconstitue.
   */
  async archive(id: string, archiveSessions: (worksessionId: string, at: Date) => Promise<void>): Promise<Worksession> {
    const wt = await this.get(id);
    if (wt.archivedAt) return wt;
    const project = await projectService.get(wt.projectId);
    await runRetireHooks(project, wt);
    const at = new Date();
    const archived = (await worksessionRepository.setArchived(id, at)) ?? wt;
    try {
      await archiveSessions(id, at);
    } catch (err) {
      await worksessionRepository.setArchived(id, null);
      throw new AppError(`La work session n'a pas pu être archivée, son dossier est conservé : ${(err as Error).message}`);
    }
    lightenArchived(project, archived);
    return archived;
  },

  /** Attend la fin de l'allègement du dossier archivé (`lightenArchived`), s'il est en cours. */
  async whenLightened(id: string): Promise<void> {
    await lightening.get(id);
  },

  /** Restaure une work session archivée ; refusé si sa branche est extraite dans une autre work session active. */
  async restore(id: string): Promise<Worksession> {
    const wt = await this.get(id);
    if (!wt.archivedAt) return wt;
    const other = await worksessionRepository.findByBranch(wt.projectId, wt.branch);
    if (other && other.id !== wt.id) throw new AppError(`La branche ${wt.branch} est extraite dans la work session « ${worksessionLabel(other)} » : archivez-la ou supprimez-la d'abord`);
    await lightening.get(id);
    const restored = (await worksessionRepository.setArchived(id, null)) ?? wt;
    // Dépendances retirées à l'archivage : reliées depuis l'instantané (une seconde), installation de la différence en
    // arrière-plan. Dossier retiré du disque : `ensureDir` le recrée au démarrage de la session.
    const project = await projectService.get(wt.projectId);
    const dir = worksessionPath(project, restored);
    if (project.gitUrl && (await exists(dir))) {
      await seedWorksessionDeps(worksessionsRoot(project), dir);
      void runCreateHooks(project, restored);
    }
    return restored;
  },

  /** Vérifie qu'une work session peut recevoir une session ou un terminal : du projet, non archivée. */
  async assertUsable(project: Project, worksessionId: string): Promise<Worksession> {
    const wt = await this.get(worksessionId);
    if (wt.projectId !== project.id) throw new AppError('Cette work session appartient à un autre projet');
    if (wt.archivedAt) throw new AppError(`La work session « ${worksessionLabel(wt)} » est archivée : restaurez-la d'abord`);
    return wt;
  },

  /**
   * Dossier de la work session, recréé s'il manque. Projet git : branche locale, distante, ou — si elle a
   * disparu — nouvelle depuis la branche principale sur origin (jamais un dossier orphelin sans git). Projet
   * sans dépôt : un dossier vide. Sérialisé par work session.
   */
  async ensureDir(project: Project, wt: Worksession): Promise<string> {
    const dir = worksessionPath(project, wt);
    if (!project.gitUrl) {
      await mkdir(dir, { recursive: true });
      return dir;
    }
    if ((await exists(path.join(dir, '.git'))) || (await isGitRepository(dir))) return dir;
    const pending = restoring.get(wt.id);
    if (pending) return pending;
    const task = (async () => {
      const main = await ensureWorkspace(project);
      if (!(await isGitRepository(main))) throw new AppError(`Le dossier principal du projet (${main}) n'est pas un dépôt git : impossible de recréer la work session`);
      if (await exists(dir)) await rm(dir, { recursive: true, force: true }); // dossier sans son lien git : repris de zéro
      await git(['worktree', 'prune'], main).catch(() => undefined);
      await mkdir(worksessionsRoot(project), { recursive: true });
      const { how, from } = await this.checkout(main, dir, wt.branch, { defaultBranch: project.gitBranch });
      if (how === 'new') log.info(`[worksessions] ${wt.name} : branche ${wt.branch} absente, work session recréée depuis ${from}`);
      else log.info(`[worksessions] dossier de ${wt.name} recréé (${how})`);
      // Comme à la création : dépendances liées, fichiers d'environnement écrits, installation de la différence.
      await seedWorksessionDeps(worksessionsRoot(project), dir);
      await runOnCreatedHooks(project, wt, null);
      void runCreateHooks(project, wt);
      return dir;
    })().finally(() => restoring.delete(wt.id));
    restoring.set(wt.id, task);
    return task;
  },

  /**
   * Dossier de travail effectif d'une session ou d'un terminal : sa work session (recréée au besoin). Sans work
   * session : le checkout principal, réservé aux chats et aux terminaux d'avant les work sessions ; une session
   * sans work session n'arrive pas jusqu'ici (`assertHasWorksession` dans sessions/service.ts).
   */
  async resolveCwd(project: Project, worksessionId: string | null | undefined): Promise<string> {
    if (!worksessionId) return ensureWorkspace(project);
    const wt = await this.assertUsable(project, worksessionId);
    return this.ensureDir(project, wt);
  },

  /** Taille du dossier (octets) si présent, pour information. */
  async size(project: Project, wt: Worksession): Promise<number | null> {
    try {
      return (await stat(worksessionPath(project, wt))).size;
    } catch {
      return null;
    }
  },
};
