import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { depsShareState, depsStoreRoot, relinkDeps } from '../previews/deps.js';
import { previewService, previewStateDir } from '../previews/service.js';
import { removeWorksessionKeepingSessions } from '../projects/cleanup.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { git, gitAuthFor, isGitRepository, workspacePath } from '../projects/workspace.js';
import { pullRequestRepository } from '../pullRequests/repository.js';
import { taskRepository } from '../tasks/repository.js';
import type { TaskStatus } from '../tasks/types.js';
import { worksessionRepository, type WorksessionActivity } from './repository.js';
import { defaultStartPoint, worksessionsRoot } from './service.js';
import type { Worksession } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Dossiers de travail d'un projet tels qu'ils sont sur disque (`<slug>.worktrees/`) : place occupée, état de la branche
 * par rapport à la branche principale, occupation, et dossiers inconnus de Skipper (orphelins : créés à la main ou dont
 * l'enregistrement a disparu). Sert la liste de la page projet, le nettoyage des dossiers fusionnés et l'import ou la
 * suppression des orphelins.
 */
export interface WorksessionDiskEntry {
  /** Nom du dossier. */
  name: string;
  path: string;
  /** Enregistrement de Skipper ; null : dossier orphelin. */
  worksession: Worksession | null;
  /** Branche extraite (HEAD du dossier, sinon celle de l'enregistrement) ; null : HEAD détaché ou pas un dépôt. */
  branch: string | null;
  exists: boolean;
  /** Le dossier est un git worktree du checkout principal. */
  gitWorktree: boolean;
  /** Place occupée en propre (octets) : les fichiers partagés par liens physiques ne sont comptés qu'une fois, à l'instantané. */
  bytes: number | null;
  /** Commits de la branche absents de la branche principale sur origin ; null : inconnu. */
  aheadCount: number | null;
  /** Commits locaux absents de la branche du même nom sur origin ; null : pas de branche sur origin. */
  unpushedCount: number | null;
  /** Fichiers modifiés ou non suivis. */
  changes: number | null;
  /** La PR suivie de la branche est fusionnée. */
  prMerged: boolean;
  /** Fusionnée : PR fusionnée, ou aucun commit absent de la branche principale. */
  merged: boolean;
  taskStatus: TaskStatus | null;
  activity: WorksessionActivity | null;
  /** Dernière activité : session, dernier commit ou création. */
  lastActivityAt: Date | null;
  /** Dépendances : liées à l'instantané partagé, copie à part qu'il pourrait remplacer, sans instantané ; null : sans objet. */
  deps: 'linked' | 'copy' | 'no-snapshot' | null;
  /** Le nettoyage des dossiers fusionnés le supprimerait. */
  cleanable: boolean;
  /** Pourquoi il ne le serait pas. */
  blocker: string | null;
}

export interface WorksessionDiskReport {
  projectId: string;
  /** Date de la mesure des tailles (gardées 10 min) ; null : jamais mesurées. */
  computedAt: Date | null;
  /** Une mesure des tailles est en cours : les tailles rendues sont les précédentes. */
  measuring: boolean;
  /** Instantanés de dépendances partagés (`.skipper-deps`), comptés une fois. */
  sharedBytes: number | null;
  /** Tous les dossiers plus les instantanés. */
  totalBytes: number | null;
  entries: WorksessionDiskEntry[];
  /** Worktrees déclarés à git dont le dossier a disparu (retirés par `git worktree prune` au nettoyage). */
  prunable: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Le dossier peut-il être supprimé par « Nettoyer les dossiers fusionnés » sans rien perdre ? Rien n'y tourne, aucune
 * modification non commitée, la branche est fusionnée (ses commits sont dans la branche principale, ou sa PR est
 * fusionnée et tout est sur origin), et ce n'est pas le dossier encore vierge d'une session en cours de travail.
 */
export function assessCleanup(e: Pick<WorksessionDiskEntry, 'worksession' | 'exists' | 'aheadCount' | 'unpushedCount' | 'changes' | 'prMerged' | 'taskStatus' | 'activity'>): string | null {
  if (!e.worksession) return 'Dossier inconnu de Skipper';
  if (!e.exists) return 'Dossier absent du disque';
  if (e.activity?.busySessions) return 'Une session y tourne';
  if (e.activity?.terminals) return 'Un terminal y est ouvert';
  if (e.changes === null || e.aheadCount === null) return 'État git illisible';
  if (e.changes > 0) return plural(e.changes, 'fichier modifié non commité', 'fichiers modifiés non commités');
  if (e.aheadCount > 0) {
    if (!e.prMerged) return plural(e.aheadCount, 'commit non fusionné', 'commits non fusionnés');
    // PR fusionnée par squash ou rebase : ses commits ne sont pas dans la branche principale, ils doivent être sur origin.
    if (e.unpushedCount !== 0) return 'PR fusionnée, mais des commits locaux ne sont pas sur origin';
  }
  const finished = e.prMerged || e.taskStatus === 'done' || e.taskStatus === 'cancelled' || Boolean(e.worksession.archivedAt) || !e.activity?.activeSessions;
  if (!finished) return 'Session en cours, rien de fusionné encore';
  return null;
}

/**
 * Place propre d'un dossier (octets) : ses fichiers qui n'ont qu'un lien, c'est-à-dire hors dépendances liées à un instantané
 * (`.skipper-deps`, compté à part). Indépendant des autres dossiers : chaque mesure se garde et se refait seule.
 */
export async function ownBytes(dir: string): Promise<number> {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('find', [dir, '-xdev', '-links', '1', '-printf', '%b\\n'], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    // Fichiers illisibles (droits du conteneur) : find sort en erreur mais donne quand même ce qu'il a lu.
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  let blocks = 0;
  for (const line of stdout.split('\n')) if (line) blocks += Number(line) || 0;
  return blocks * 512;
}

/** Applique `fn` à chaque élément, `limit` à la fois, dans l'ordre d'origine. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `du -sk` en un seul appel : un fichier lié plusieurs fois n'est compté qu'au premier dossier qui le contient. */
export async function diskUsage(dirs: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!dirs.length) return sizes;
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('du', ['-sk', '-x', '--', ...dirs], { maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    // Fichiers illisibles (droits du conteneur) : du sort en erreur mais donne quand même ses totaux.
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  for (const line of stdout.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) sizes.set(m[2], Number(m[1]) * 1024);
  }
  return sizes;
}

/** Worktrees déclarés à git : dossier → branche (null : HEAD détaché), et s'il est marqué « prunable ». */
async function gitWorktrees(main: string): Promise<Map<string, { branch: string | null; prunable: boolean }>> {
  const found = new Map<string, { branch: string | null; prunable: boolean }>();
  const out = await git(['worktree', 'list', '--porcelain'], main).catch(() => '');
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n');
    const dir = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!dir) continue;
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null;
    found.set(path.resolve(dir), { branch: ref ? ref.replace(/^refs\/heads\//, '') : null, prunable: lines.some((l) => l.startsWith('prunable')) });
  }
  return found;
}

async function count(args: string[], cwd: string): Promise<number | null> {
  return git(args, cwd).then((out) => Number(out) || 0, () => null);
}

export async function gitState(dir: string, base: string | null): Promise<Pick<WorksessionDiskEntry, 'branch' | 'aheadCount' | 'unpushedCount' | 'changes'> & { lastCommitAt: Date | null }> {
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).catch(() => null);
  const branch = head && head !== 'HEAD' ? head : null;
  const [status, aheadCount, unpushedCount, lastCommit] = await Promise.all([
    git(['status', '--porcelain', '--untracked-files=normal'], dir).catch(() => null),
    base ? count(['rev-list', '--count', 'HEAD', `^${base}`], dir) : Promise.resolve(null),
    branch && (await git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], dir).then(() => true, () => false))
      ? count(['rev-list', '--count', 'HEAD', `^refs/remotes/origin/${branch}`], dir)
      : Promise.resolve(null),
    git(['log', '-1', '--format=%cI'], dir).catch(() => ''),
  ]);
  return {
    branch,
    aheadCount,
    unpushedCount,
    changes: status === null ? null : status.split('\n').filter(Boolean).length,
    lastCommitAt: lastCommit ? new Date(lastCommit) : null,
  };
}

const latest = (...dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && !Number.isNaN(d.getTime()) && (!a || d > a) ? d : a), null);

/**
 * Tailles, dossier par dossier : un seul `du` sur tous les dossiers d'un gros projet ne finissait plus (575 dossiers pour
 * Curso : plus de cinq minutes, refaites toutes les dix minutes). Chaque dossier est mesuré seul (`ownBytes`, les fichiers
 * liés à un instantané n'y comptent pas) et sa mesure gardée : 10 min pour un dossier actif, 6 h pour un dossier archivé,
 * qui ne bouge plus ; l'instantané (`du`) une heure. Les mesures manquantes ou périmées tournent en arrière-plan, trois à
 * la fois, une file par projet ; la liste attend au plus `SIZE_WAIT_MS` et rend ce qui est déjà mesuré.
 */
export const SIZE_TTL_MS = 10 * 60_000;
export const ARCHIVED_SIZE_TTL_MS = 6 * 60 * 60_000;
const STORE_SIZE_TTL_MS = 60 * 60_000;
const SIZE_WAIT_MS = 2_000;
const SIZE_CONCURRENCY = 3;
interface SizeTarget {
  path: string;
  ttlMs: number;
  /** Instantané des dépendances : mesuré par `du` (tout compte), pas par `ownBytes`. */
  store?: boolean;
}
const sizeCache = new Map<string, { at: number; bytes: number }>();
const sizeRuns = new Map<string, Promise<void>>();

/** Tailles connues des dossiers, date de la plus ancienne mesure rendue, mesure en cours. */
async function sizesFor(projectId: string, targets: SizeTarget[]): Promise<{ at: Date | null; sizes: Map<string, number>; measuring: boolean }> {
  const now = Date.now();
  const stale = targets.filter((t) => {
    const c = sizeCache.get(t.path);
    return !c || now - c.at >= t.ttlMs;
  });
  if (stale.length && !sizeRuns.has(projectId)) {
    const run = mapLimit(stale, SIZE_CONCURRENCY, async (t) => {
      try {
        const bytes = t.store ? ((await diskUsage([t.path])).get(t.path) ?? 0) : await ownBytes(t.path);
        sizeCache.set(t.path, { at: Date.now(), bytes });
      } catch (err) {
        log.warn(`[worksessions] mesure de ${t.path} : ${(err as Error).message}`);
      }
    })
      .then(() => undefined)
      .finally(() => sizeRuns.delete(projectId));
    sizeRuns.set(projectId, run);
  }
  const running = sizeRuns.get(projectId);
  if (running) await Promise.race([running, new Promise((r) => setTimeout(r, SIZE_WAIT_MS))]);
  const sizes = new Map<string, number>();
  let oldest: number | null = null;
  for (const t of targets) {
    const c = sizeCache.get(t.path);
    if (!c) continue;
    sizes.set(t.path, c.bytes);
    if (oldest === null || c.at < oldest) oldest = c.at;
  }
  return { at: oldest === null ? null : new Date(oldest), sizes, measuring: sizeRuns.has(projectId) };
}

/** Ces dossiers sont à remesurer (supprimés, dépendances remplacées). */
function invalidateSizes(paths: string[]): void {
  for (const p of paths) sizeCache.delete(p);
}

/** Oublie la taille d'un dossier qui vient de changer du tout au tout (archivé et allégé, supprimé). */
export function forgetSize(dir: string): void {
  sizeCache.delete(dir);
}

/** Nom de dossier acceptable pour un orphelin : enfant direct du dossier des work sessions, pas un dossier technique. */
function assertOrphanName(name: string): void {
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\') || name === '..') throw new AppError(`Nom de dossier invalide : ${name}`);
}

export const worksessionDisk = {
  /** État de tous les dossiers du projet ; `refresh` relance la mesure des tailles et met à jour les branches d'origin. */
  async report(projectId: string, opts: { refresh?: boolean; actorId?: string | null } = {}): Promise<WorksessionDiskReport> {
    const project = await projectService.get(projectId);
    const root = worksessionsRoot(project);
    const main = workspacePath(project);
    const isGit = Boolean(project.gitUrl) && (await isGitRepository(main));
    if (isGit && opts.refresh) await git(['fetch', '--prune', 'origin'], main, await gitAuthFor(project, opts.actorId)).catch(() => undefined);
    const base = isGit ? await defaultStartPoint(main, project.gitBranch) : null;

    const [records, activity, worktrees, onDisk] = await Promise.all([
      worksessionRepository.listByProject(projectId, { archived: 'all' }),
      worksessionRepository.activityByProject(projectId),
      isGit ? gitWorktrees(main) : Promise.resolve(new Map<string, { branch: string | null; prunable: boolean }>()),
      readdir(root, { withFileTypes: true }).then((list) => list.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name), () => [] as string[]),
    ]);
    const byName = new Map(records.map((w) => [w.name, w]));
    const names = [...new Set([...records.map((w) => w.name), ...onDisk, ...[...worktrees.keys()].filter((d) => path.dirname(d) === root && !worktrees.get(d)!.prunable).map((d) => path.basename(d))])];

    // Tâche liée (consacrée, sinon traitée sur la branche) et PR suivie, en deux requêtes.
    const taskIds = records.map((w) => w.taskId).filter((id): id is string => Boolean(id));
    const [tasks, branchTasks, prs] = await Promise.all([
      taskRepository.findByIds(taskIds),
      taskRepository.findForBranches(records.map((w) => ({ projectId, branch: w.branch }))),
      pullRequestRepository.findForWorksessions(records.map((w) => ({ id: w.id, projectId, branch: w.branch }))),
    ]);
    const taskOf = (w: Worksession) => (w.taskId ? tasks.find((t) => t.id === w.taskId) : undefined) ?? branchTasks.get(`${projectId}\u0000${w.branch}`) ?? null;

    // Un dossier à la fois prenait plusieurs minutes pour les gros projets (cinq commandes git chacun) : huit à la fois.
    const built = await mapLimit(names, 8, async (name): Promise<WorksessionDiskEntry | null> => {
      const dir = path.join(root, name);
      const worksession = byName.get(name) ?? null;
      const dirStat = await stat(dir).catch(() => null);
      const exists = Boolean(dirStat?.isDirectory());
      // Dossier archivé puis retiré du disque (allègement des archives) : rien à montrer ni à nettoyer, il sera recréé à la restauration.
      if (!exists && worksession?.archivedAt) return null;
      const wt = worktrees.get(dir);
      const state = exists && wt ? await gitState(dir, base) : null;
      const act = worksession ? (activity.get(worksession.id) ?? null) : null;
      const pr = worksession ? prs.get(worksession.id) : undefined;
      const entry: WorksessionDiskEntry = {
        name,
        path: dir,
        worksession,
        branch: state?.branch ?? wt?.branch ?? worksession?.branch ?? null,
        exists,
        gitWorktree: Boolean(wt),
        bytes: null,
        aheadCount: state?.aheadCount ?? null,
        unpushedCount: state?.unpushedCount ?? null,
        changes: state?.changes ?? (exists && !isGit ? 0 : null),
        prMerged: pr?.status === 'merged',
        merged: pr?.status === 'merged' || state?.aheadCount === 0,
        taskStatus: worksession ? (taskOf(worksession)?.status ?? null) : null,
        activity: act,
        lastActivityAt: latest(act?.lastActivityAt, state?.lastCommitAt, worksession?.createdAt, worksession ? null : dirStat?.mtime),
        deps: null,
        cleanable: false,
        blocker: null,
      };
      // Projet sans dépôt : rien à fusionner, le nettoyage ne le concerne pas.
      entry.blocker = isGit ? assessCleanup(entry) : 'Projet sans dépôt git';
      entry.cleanable = entry.blocker === null;
      return entry;
    });
    const entries = built.filter((e): e is WorksessionDiskEntry => e !== null);

    const store = depsStoreRoot(root);
    await mapLimit(
      entries.filter((e) => e.exists),
      8,
      async (e) => {
        const { state } = await depsShareState(store, e.path).catch(() => ({ state: 'none' as const }));
        e.deps = state === 'none' ? null : state;
      },
    );
    const hasStore = await stat(store).then((s) => s.isDirectory(), () => false);
    // L'instantané compte ses fichiers une fois ; chaque dossier, ses seuls fichiers propres. « Actualiser » remesure les
    // dossiers actifs, pas les archivés (qui ne bougent plus, remesurés toutes les 6 h).
    const refresh = Boolean(opts.refresh);
    const targets: SizeTarget[] = [
      ...(hasStore ? [{ path: store, ttlMs: refresh ? 0 : STORE_SIZE_TTL_MS, store: true }] : []),
      ...entries.filter((e) => e.exists).map((e) => ({ path: e.path, ttlMs: e.worksession?.archivedAt ? ARCHIVED_SIZE_TTL_MS : refresh ? 0 : SIZE_TTL_MS })),
    ];
    const { at: computedAt, sizes, measuring } = await sizesFor(projectId, targets);
    for (const e of entries) e.bytes = sizes.get(e.path) ?? null;
    const sharedBytes = hasStore ? (sizes.get(store) ?? null) : 0;
    const known = entries.filter((e) => e.bytes !== null);
    const totalBytes = computedAt ? (sharedBytes ?? 0) + known.reduce((s, e) => s + (e.bytes ?? 0), 0) : null;

    entries.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name));
    const prunable = [...worktrees.entries()].filter(([, w]) => w.prunable).map(([d]) => d);
    return { projectId, computedAt, measuring, sharedBytes, totalBytes, entries, prunable };
  },

  /**
   * Supprime les dossiers fusionnés (tous ceux que `assessCleanup` autorise, ou ceux nommés parmi eux) : leurs sessions sont
   * archivées avec leur historique, la branche locale supprimée (ses commits sont dans la branche principale ou sur origin),
   * les worktrees disparus retirés de git. L'état est recalculé juste avant (après un fetch) : rien qui ait bougé entretemps.
   */
  async cleanMerged(projectId: string, actorId: string | null, names?: string[] | null): Promise<{ removed: string[]; freedBytes: number; skipped: { name: string; reason: string }[] }> {
    const report = await this.report(projectId, { refresh: true, actorId });
    const wanted = names?.length ? new Set(names) : null;
    const removed: string[] = [];
    const removedPaths: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    let freedBytes = 0;
    for (const e of report.entries) {
      if (wanted && !wanted.has(e.name)) continue;
      if (!e.cleanable || !e.worksession) {
        if (wanted) skipped.push({ name: e.name, reason: e.blocker ?? 'Non nettoyable' });
        continue;
      }
      try {
        await removeWorksessionKeepingSessions(e.worksession.id, { deleteBranch: true });
        removed.push(e.name);
        removedPaths.push(e.path);
        freedBytes += e.bytes ?? 0;
      } catch (err) {
        skipped.push({ name: e.name, reason: (err as Error).message });
      }
    }
    const project = await projectService.get(projectId);
    if (project.gitUrl && (await isGitRepository(workspacePath(project)))) await git(['worktree', 'prune'], workspacePath(project)).catch(() => undefined);
    invalidateSizes(removedPaths);
    if (removed.length) log.info(`[worksessions] nettoyage de ${project.slug} : ${removed.join(', ')}`);
    return { removed, freedBytes, skipped };
  },

  /**
   * Remplace par l'instantané partagé (liens physiques) les copies à part des dépendances (`deps` : `copy`) des dossiers
   * où rien ne tourne : ni session, ni terminal, ni aperçu, ni installation. Tous ceux qui peuvent l'être, ou ceux de `names`.
   */
  async shareDeps(projectId: string, names?: string[] | null): Promise<{ relinked: string[]; skipped: { name: string; reason: string }[] }> {
    const project = await projectService.get(projectId);
    const report = await this.report(projectId);
    const wanted = names?.length ? new Set(names) : null;
    const store = depsStoreRoot(worksessionsRoot(project));
    const candidates = report.entries.filter((e) => (wanted ? wanted.has(e.name) : e.deps === 'copy'));
    const previews = candidates.length ? new Set(await previewService.liveWorksessions(project).catch(() => [] as string[])) : new Set<string>();
    const relinked: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const e of candidates) {
      let reason: string | null = null;
      if (e.deps !== 'copy') reason = e.deps === 'linked' ? 'Dépendances déjà partagées' : 'Pas de copie remplaçable par un instantané';
      else if (e.activity?.busySessions) reason = 'Une session y tourne';
      else if (e.activity?.terminals) reason = 'Un terminal y est ouvert';
      else if (e.worksession && previews.has(e.worksession.id)) reason = "Son aperçu tourne : arrêtez-le d'abord";
      else if (e.worksession && (await previewService.installRunning(project, previewStateDir(project, e.worksession.id)).catch(() => false))) reason = 'Installation des dépendances en cours';
      if (reason) {
        if (wanted) skipped.push({ name: e.name, reason });
        continue;
      }
      try {
        if (await relinkDeps(store, e.path)) {
          relinked.push(e.name);
          invalidateSizes([e.path]);
        }
        else skipped.push({ name: e.name, reason: 'Dépendances déjà partagées ou sans instantané' });
      } catch (err) {
        skipped.push({ name: e.name, reason: (err as Error).message });
      }
    }
    return { relinked, skipped };
  },

  /** Enregistre un dossier orphelin (git worktree sur une branche) comme work session : il réapparaît dans Skipper. */
  async importOrphan(projectId: string, name: string): Promise<Worksession> {
    assertOrphanName(name);
    const project = await projectService.get(projectId);
    const orphan = await this.orphan(project, name);
    if (!orphan.gitWorktree && project.gitUrl) throw new AppError(`Le dossier ${name} n'est pas un git worktree du projet : supprimez-le plutôt`);
    const branch = project.gitUrl ? orphan.branch : name;
    if (!branch) throw new AppError(`Le dossier ${name} n'est sur aucune branche (HEAD détaché) : extrayez-y une branche d'abord`);
    if (await worksessionRepository.findByBranch(projectId, branch)) throw new AppError(`La branche ${branch} est déjà celle d'une autre work session`);
    return worksessionRepository.create(projectId, name, branch);
  },

  /** Supprime un dossier orphelin (worktree retiré de git, branche conservée). */
  async deleteOrphan(projectId: string, name: string): Promise<boolean> {
    assertOrphanName(name);
    const project = await projectService.get(projectId);
    const orphan = await this.orphan(project, name);
    const main = workspacePath(project);
    if (orphan.gitWorktree) await git(['worktree', 'remove', '--force', orphan.path], main).catch(() => rm(orphan.path, { recursive: true, force: true }));
    else await rm(orphan.path, { recursive: true, force: true });
    if (project.gitUrl && (await isGitRepository(main))) await git(['worktree', 'prune'], main).catch(() => undefined);
    invalidateSizes([orphan.path]);
    log.info(`[worksessions] dossier orphelin supprimé : ${orphan.path}`);
    return true;
  },

  /** Le dossier orphelin de ce nom (présent sur disque, sans enregistrement), sinon une erreur. */
  async orphan(project: Project, name: string): Promise<{ path: string; gitWorktree: boolean; branch: string | null }> {
    const dir = path.join(worksessionsRoot(project), name);
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new AppError(`Dossier introuvable : ${name}`);
    if ((await worksessionRepository.listByProject(project.id, { archived: 'all' })).some((w) => w.name === name)) throw new AppError(`Le dossier ${name} est déjà celui d'une work session`);
    const main = workspacePath(project);
    const wt = project.gitUrl && (await isGitRepository(main)) ? (await gitWorktrees(main)).get(dir) : undefined;
    return { path: dir, gitWorktree: Boolean(wt), branch: wt?.branch ?? null };
  },
};
