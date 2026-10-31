import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { hostedRepo } from '../gitServer/paths.js';
import type { WorkspaceRef } from '../files/service.js';
import { buildDraftText, parseGithubRepo, parseRepoFullName, pullRequestService, repoFullName, type GithubRepoRef, type PullRequest } from '../git/pullRequests.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { taskService } from '../tasks/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { localBranchWork } from './local.js';
import { pullRequestRepository } from './repository.js';
import {
  describePullRequest,
  PR_STAGES,
  sameRepo,
  SETTABLE_PR_STATUSES,
  stageLabels,
  type CreateTrackedPullRequestInput,
  type PullRequestActor,
  type PullRequestStage,
  type TrackedPullRequest,
  type TrackedPullRequestFilter,
  type TrackedPullRequestStatus,
  type UpdateTrackedPullRequestInput,
} from './types.js';
import { log } from '../log.js';

/**
 * Pull requests suivies : création (depuis GitHub, depuis une URL, ou en ouvrant la PR sur GitHub), mise à jour
 * (statut, note, tâche), synchronisation avec GitHub (statut, brouillon, checks, revue, conflits, et adoption
 * des PR ouvertes sur la branche d'une tâche), PR « en préparation » (branche qui porte des modifications sans PR
 * ouverte), PR d'autres dépôts GitHub que celui du projet, notifications et textes pour les agents.
 */

export const SYSTEM: PullRequestActor = { type: 'system' };

const MAX_NOTE = 2000;
const MAX_TITLE = 500;
/**
 * Une synchronisation (GitHub et travail local des branches) par projet au plus toutes les 20 s : sous la période de
 * sondage des pages (30 s), pour qu'un relevé sur deux ne soit pas sauté ; la liste GitHub est alors relue sans cache
 * (une fusion faite hors de Skipper apparaît au relevé suivant).
 */
const SYNC_INTERVAL_MS = 20_000;
/** PR suivies absentes des 100 dernières du dépôt (ou d'un autre dépôt) : interrogées une à une, au plus ce nombre par synchronisation. */
const MAX_INDIVIDUAL_FETCHES = 10;

/**
 * Synchronisation de fond : sans elle, une PR fusionnée sur GitHub ne l'était dans Skipper qu'une fois la page des PR
 * du projet ouverte (le tableau de bord, la sidebar et les fiches de tâche ne font que lire la base ; constat du 31/10
 * sur les #80 et #84, encore « à fusionner » le lendemain de leur fusion).
 */
const BACKGROUND_SYNC_MS = 60_000;

const lastSync = new Map<string, number>();
let backgroundTimer: NodeJS.Timeout | null = null;
let backgroundRunning = false;

/**
 * Numéro d'une PR depuis son URL, avec le dépôt : GitHub (`https://github.com/owner/repo/pull/123`) ou la forge Forgejo
 * de Skipper (`<FORGEJO_URL>/owner/repo/pulls/123`).
 */
export function parsePullRequestUrl(url: string): { owner: string; name: string; number: number } | null {
  const t = url.trim();
  const m = t.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (m) return { owner: m[1], name: m[2], number: Number(m[3]) };
  const base = config.forgejo.url;
  if (base && t.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    const f = t.slice(base.length).match(/^\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:[/?#].*)?$/);
    if (f) return { owner: f[1], name: f[2], number: Number(f[3]) };
  }
  return null;
}

/** Numéro d'une référence libre : « 42 », « #42 » ou l'URL de la PR. */
export function parsePullRequestRef(ref: string): number | null {
  const t = ref.trim();
  if (/^#?\d+$/.test(t)) return Number(t.replace('#', ''));
  return parsePullRequestUrl(t)?.number ?? null;
}

/** Dépôt du projet dont on suit les PR : le dépôt Forgejo d'un projet hébergé, sinon son dépôt GitHub ; null sinon. */
export function projectRepoRef(project: Pick<Project, 'gitUrl' | 'gitHosted' | 'slug'>): GithubRepoRef | null {
  if (project.gitHosted) return hostedRepo(project.slug);
  return parseGithubRepo(project.gitUrl);
}

/** « owner/name » du dépôt d'un projet (GitHub, ou Forgejo pour un projet hébergé), vide sans dépôt suivi. */
export function projectRepoName(project: Pick<Project, 'gitUrl' | 'gitHosted' | 'slug'>): string {
  const repo = projectRepoRef(project);
  return repo ? repoFullName(repo) : '';
}

/** Dépôt d'une PR suivie quand il diffère de celui du projet (à passer aux lectures GitHub), null sinon. */
export function foreignRepoOf(pr: Pick<TrackedPullRequest, 'repo'>, projectRepo: string): GithubRepoRef | null {
  if (!pr.repo || sameRepo(pr.repo, projectRepo)) return null;
  return parseRepoFullName(pr.repo);
}

const statusOf = (state: PullRequest['state']): TrackedPullRequestStatus => (state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open');

/** Champs d'une PR suivie recopiés depuis la PR GitHub. */
function fromGithub(pr: PullRequest): Omit<CreateTrackedPullRequestInput, 'taskId' | 'note'> & { number: number } {
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    status: statusOf(pr.state),
    isDraft: pr.isDraft,
    checksState: pr.checksState,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    openedAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
  };
}

function validateNote(note: string | null | undefined, label = 'La note'): string | undefined {
  if (note == null) return undefined;
  const t = note.trim();
  if (t.length > MAX_NOTE) throw new AppError(`${label} dépasse ${MAX_NOTE} caractères`);
  return t;
}

export { describePullRequest, describeSnapshot } from './types.js';

export const trackedPullRequestService = {
  list: (filter?: TrackedPullRequestFilter) => pullRequestRepository.list(filter),
  forTask: (taskId: string) => pullRequestRepository.list({ taskId, limit: 100 }),
  countPending: (projectIds: string[]) => pullRequestRepository.countPending(projectIds),
  projectRepo: projectRepoName,

  async get(id: string): Promise<TrackedPullRequest> {
    const pr = await pullRequestRepository.findById(id);
    if (!pr) throw new NotFoundError('Pull request suivie introuvable');
    return pr;
  },

  /**
   * PR suivie désignée par son identifiant, par son numéro GitHub (« 42 », « #42 » : dans le dépôt du projet de
   * préférence) ou par son URL (qui dit le dépôt) dans le projet.
   */
  async resolve(projectId: string, ref: string): Promise<TrackedPullRequest> {
    const t = ref.trim();
    const url = parsePullRequestUrl(t);
    const number = url?.number ?? parsePullRequestRef(t);
    let pr: TrackedPullRequest | null;
    if (url) pr = await pullRequestRepository.findByNumber(projectId, url.number, `${url.owner}/${url.name}`);
    else if (number != null) pr = await pullRequestRepository.findByNumber(projectId, number, undefined, projectRepoName(await projectService.get(projectId)));
    else pr = await pullRequestRepository.findById(t);
    if (!pr || pr.projectId !== projectId) throw new NotFoundError(number != null ? `Aucune pull request suivie n'a le numéro #${number}${url ? ` dans ${url.owner}/${url.name}` : ''} dans ce projet` : 'Pull request suivie introuvable dans ce projet');
    return pr;
  },

  /**
   * Enregistre (ou met à jour, si elle est déjà suivie) une PR GitHub connue. Une PR « en préparation » sur la même
   * branche du dépôt du projet devient cette PR (identifiant, note et tâche conservés). Sans `taskId`, la tâche
   * traitée sur la branche de la PR est reliée. Un agent qui ouvre ou déclare une PR prévient les membres du projet.
   */
  async recordGithub(projectId: string, pr: PullRequest, actor: PullRequestActor, extra: { taskId?: string | null; note?: string | null } = {}): Promise<TrackedPullRequest> {
    const project = await projectService.get(projectId).catch(() => null);
    const projectRepo = project ? projectRepoName(project) : '';
    const existing = await pullRequestRepository.findByNumber(projectId, pr.number, pr.repo);
    const pending = !existing && sameRepo(pr.repo, projectRepo) ? (await pullRequestRepository.list({ projectId, headBranch: pr.headRefName, status: ['pending'], limit: 1 }))[0] ?? null : null;
    const taskId = extra.taskId !== undefined ? extra.taskId : existing?.taskId ?? pending?.taskId ?? (await taskService.forBranch(projectId, pr.headRefName))?.id ?? null;
    const note = validateNote(extra.note);
    const fields = fromGithub(pr);
    if (existing) {
      const updated = await pullRequestRepository.update(existing.id, { ...fields, taskId, syncedAt: new Date(), note });
      return updated ?? existing;
    }
    let created: TrackedPullRequest;
    if (pending) {
      // La PR en préparation devient la PR ouverte : même objet, numéro et URL en plus, travail local oublié.
      created = (await pullRequestRepository.update(pending.id, { ...fields, taskId, note, syncedAt: new Date(), localCommits: null, localChanges: null })) ?? pending;
    } else {
      created = await pullRequestRepository.create(projectId, { ...fields, taskId, note }, actor);
    }
    if (created.taskId) await this.linkTaskBranch(created.taskId, created.headBranch);
    if (actor.type === 'agent') {
      void notificationService.notify({
        type: 'pull_request.opened',
        title: 'Pull request ouverte par un agent',
        message: `${created.repo && !sameRepo(created.repo, projectRepo) ? `${created.repo}` : ''}#${created.number} ${created.title}${project ? ` · ${project.name}` : ''}`,
        link: `/projects/${projectId}/pull-requests`,
        projectId,
        sessionId: actor.sessionId ?? null,
        payload: { pullRequestId: created.id, number: created.number, repo: created.repo, taskId: created.taskId },
      });
    }
    return created;
  },

  /** La tâche reliée hérite de la branche de sa PR si elle n'en avait pas (PR ouverte hors de Skipper). */
  async linkTaskBranch(taskId: string, branch: string): Promise<void> {
    const task = await taskService.get(taskId).catch(() => null);
    if (task && !task.branch) await taskService.update(taskId, { branch }).catch(() => undefined);
  },

  /**
   * Suit une PR déjà ouverte, désignée par son URL (dépôt du projet ou tout autre dépôt GitHub) ou son numéro (dépôt
   * du projet). Ses détails sont lus sur GitHub avec le compte de `userId` ; quand GitHub n'est pas joignable (pas de
   * compte connecté), `fallback` (titre, branche) suffit.
   */
  async register(
    projectId: string,
    ref: { url?: string | null; number?: number | null },
    opts: { taskId?: string | null; note?: string | null; userId?: string | null; fallback?: { title?: string | null; headBranch?: string | null } },
    actor: PullRequestActor,
  ): Promise<TrackedPullRequest> {
    const project = await projectService.get(projectId);
    const projectRepo = projectRepoRef(project);
    let number = ref.number ?? null;
    let url: string | null = null;
    /** Dépôt de la PR quand ce n'est pas celui du projet. */
    let foreign: GithubRepoRef | null = null;
    if (ref.url?.trim()) {
      const parsed = parsePullRequestUrl(ref.url);
      if (!parsed) throw new AppError(`URL de pull request attendue (https://github.com/<owner>/<repo>/pull/<n>, ou celle de la forge du projet) : ${ref.url}`);
      if (!projectRepo || parsed.owner.toLowerCase() !== projectRepo.owner.toLowerCase() || parsed.name.toLowerCase() !== projectRepo.name.toLowerCase()) foreign = { owner: parsed.owner, name: parsed.name };
      if (foreign && config.forgejo.url && ref.url.trim().toLowerCase().startsWith(config.forgejo.url.toLowerCase())) throw new AppError("Seules les PR Forgejo du dépôt de ce projet peuvent être suivies ici");
      number = parsed.number;
      url = ref.url.trim();
    }
    if (number == null || !Number.isInteger(number) || number <= 0) throw new AppError('Indique le numéro ou l’URL de la pull request');
    if (opts.taskId) {
      const task = await taskService.get(opts.taskId);
      if (task.projectId !== projectId) throw new AppError('La tâche n’appartient pas à ce projet');
    }
    const repo = foreign ?? projectRepo;
    const github = repo ? await pullRequestService.get(projectId, opts.userId, number, foreign).catch(() => null) : null;
    if (github) return this.recordGithub(projectId, github, actor, { taskId: opts.taskId, note: opts.note });

    // GitHub injoignable : on enregistre ce que l'on sait.
    const repoName = repo ? repoFullName(repo) : '';
    const existing = await pullRequestRepository.findByNumber(projectId, number, repoName);
    if (existing) {
      const updated = await pullRequestRepository.update(existing.id, { taskId: opts.taskId !== undefined ? opts.taskId : undefined, note: validateNote(opts.note), title: opts.fallback?.title?.trim() || undefined });
      return updated ?? existing;
    }
    const title = opts.fallback?.title?.trim();
    const headBranch = opts.fallback?.headBranch?.trim();
    if (!title || !headBranch) throw new AppError(repo ? `GitHub n'a pas répondu pour la PR ${repoName}#${number} : donne aussi son titre et sa branche` : "Ce projet n'est pas relié à un dépôt GitHub : donne l'URL, le titre et la branche de la pull request");
    if (title.length > MAX_TITLE) throw new AppError(`Le titre dépasse ${MAX_TITLE} caractères`);
    const taskId = opts.taskId ?? (foreign ? null : (await taskService.forBranch(projectId, headBranch))?.id ?? null);
    const created = await pullRequestRepository.create(
      projectId,
      { repo: repoName, number, url: url ?? (repoName ? (project.gitHosted && !foreign ? `${config.forgejo.url}/${repoName}/pulls/${number}` : `https://github.com/${repoName}/pull/${number}`) : ''), title, headBranch, baseBranch: foreign ? '' : project.gitBranch ?? '', taskId, note: validateNote(opts.note) },
      actor,
    );
    if (created.taskId) await this.linkTaskBranch(created.taskId, headBranch);
    return created;
  },

  /**
   * Ouvre la PR sur GitHub depuis la branche courante du dossier de travail (poussée au besoin), puis la suit.
   * `input.path` : sous-dossier contenant un autre clone, pour ouvrir la PR sur ce dépôt-là.
   */
  async open(ref: WorkspaceRef, userId: string | null | undefined, input: { title: string; body?: string | null; base?: string | null; draft?: boolean | null; path?: string | null }, opts: { taskId?: string | null; note?: string | null }, actor: PullRequestActor): Promise<TrackedPullRequest> {
    if (opts.taskId) {
      const task = await taskService.get(opts.taskId);
      if (task.projectId !== ref.projectId) throw new AppError('La tâche n’appartient pas à ce projet');
    }
    const pr = await pullRequestService.create(ref, userId, input);
    return this.recordGithub(ref.projectId, pr, actor, { taskId: opts.taskId, note: opts.note });
  },

  /**
   * Statut, note, tâche reliée. Une PR marquée fusionnée ou fermée garde son instantané GitHub. Une PR en préparation
   * ne change pas de statut ici : elle le reçoit en étant ouverte sur GitHub (open, pr_open) ou déclarée.
   */
  async update(id: string, input: { status?: TrackedPullRequestStatus | null; note?: string | null; taskId?: string | null; isDraft?: boolean | null }): Promise<TrackedPullRequest> {
    const before = await this.get(id);
    if (input.status != null && !SETTABLE_PR_STATUSES.includes(input.status)) throw new AppError(`Statut invalide : ${input.status}`);
    if (input.status != null && before.status === 'pending') throw new AppError("Cette pull request n'est pas encore ouverte sur GitHub : ouvre-la (pr_open, ou « Créer la pull request ») ou déclare-la (pr_register) plutôt que de changer son statut");
    if (input.taskId) {
      const task = await taskService.get(input.taskId);
      if (task.projectId !== before.projectId) throw new AppError('La tâche n’appartient pas à ce projet');
    }
    const patch: UpdateTrackedPullRequestInput = {
      status: input.status ?? undefined,
      note: validateNote(input.note),
      taskId: input.taskId,
      isDraft: input.isDraft ?? undefined,
    };
    const after = await pullRequestRepository.update(id, patch);
    if (!after) throw new NotFoundError('Pull request suivie introuvable');
    if (input.taskId && after.taskId) await this.linkTaskBranch(after.taskId, after.headBranch);
    return after;
  },

  /** Fusion faite depuis Skipper (panneau git) : la PR suivie passe à « fusionnée » (créée au besoin). */
  async markMerged(projectId: string, pr: PullRequest, sha: string | null, actor: PullRequestActor): Promise<TrackedPullRequest> {
    const tracked = await this.recordGithub(projectId, { ...pr, state: 'MERGED', mergedAt: pr.mergedAt ?? new Date() }, actor);
    return (await pullRequestRepository.update(tracked.id, { status: 'merged', mergeSha: sha, mergedAt: tracked.mergedAt ?? new Date() })) ?? tracked;
  },

  async delete(id: string): Promise<boolean> {
    await this.get(id);
    return pullRequestRepository.delete(id);
  },

  /**
   * Rafraîchit les PR suivies d'un projet : travail local des work sessions (PR en préparation créées, mises à jour
   * ou retirées), puis GitHub (avec le compte de `userId`) : statut, brouillon, titre, checks, revue, conflits ; une
   * PR fusionnée hors de Skipper est notifiée. Les PR ouvertes du dépôt sur la branche d'une tâche ou d'une work
   * session sont adoptées. Au plus une fois toutes les 20 s par projet, sauf `force`. Sans GitHub (dépôt ailleurs,
   * compte absent, panne), la partie GitHub est passée et la liste est rendue telle quelle.
   */
  async sync(projectId: string, userId: string | null | undefined, opts: { force?: boolean } = {}): Promise<TrackedPullRequest[]> {
    const current = () => pullRequestRepository.list({ projectId, limit: 1000 });
    const last = lastSync.get(projectId) ?? 0;
    if (!opts.force && Date.now() - last < SYNC_INTERVAL_MS) return current();
    const project = await projectService.get(projectId).catch(() => null);
    if (!project?.gitUrl) return current();
    lastSync.set(projectId, Date.now());
    // GitHub d'abord (une PR fusionnée ailleurs l'est avant d'examiner sa branche), puis le travail local des branches.
    const projectRepo = projectRepoRef(project);
    if (projectRepo) await this.syncGithub(projectId, userId, projectRepo).catch((err) => log.error('[pull-requests] synchronisation GitHub', err));
    await this.refreshPending(project).catch((err) => log.error('[pull-requests] travail local des branches', err));
    return current();
  },

  /**
   * Synchronise tous les projets qui ont quelque chose à suivre (PR ouverte ou en préparation, work session active),
   * un par un, avec le compte GitHub d'un de leurs membres (`syncTargets`). Le délai de 20 s par projet s'applique :
   * un projet dont la page est ouverte n'est pas relu deux fois. Une erreur sur un projet n'arrête pas les autres.
   */
  async syncAll(): Promise<void> {
    if (backgroundRunning) return;
    backgroundRunning = true;
    try {
      for (const { projectId, userId } of await pullRequestRepository.syncTargets()) {
        await this.sync(projectId, userId).catch((err) => log.error('[pull-requests] synchronisation de fond', projectId, err));
      }
    } finally {
      backgroundRunning = false;
    }
  },

  startBackgroundSync(): void {
    if (backgroundTimer) return;
    backgroundTimer = setInterval(() => void this.syncAll().catch((err) => log.error('[pull-requests] synchronisation de fond', err)), BACKGROUND_SYNC_MS);
    backgroundTimer.unref();
  },

  stopBackgroundSync(): void {
    if (backgroundTimer) clearInterval(backgroundTimer);
    backgroundTimer = null;
  },

  /** Partie GitHub de la synchronisation : rafraîchissement des PR suivies et adoption. Sans réponse de GitHub, ne fait rien. */
  async syncGithub(projectId: string, userId: string | null | undefined, projectRepo: GithubRepoRef): Promise<void> {
    const projectRepoName = repoFullName(projectRepo);
    let github: PullRequest[];
    try {
      github = await pullRequestService.list(projectId, userId, 'ALL', 100, { fresh: true });
    } catch {
      return;
    }
    const byNumber = new Map(github.map((p) => [p.number, p]));
    const tracked = await pullRequestRepository.list({ projectId, limit: 1000 });
    let individual = 0;
    for (const t of tracked) {
      if (t.number == null) continue;
      const foreign = foreignRepoOf(t, projectRepoName);
      let g = foreign ? null : byNumber.get(t.number) ?? null;
      if (!g && t.status === 'open' && individual < MAX_INDIVIDUAL_FETCHES) {
        individual++;
        g = await pullRequestService.get(projectId, userId, t.number, foreign).catch(() => null);
      }
      if (g) await this.applyGithub(t, g);
    }
    // Adoption : PR ouvertes du dépôt dont la branche est celle d'une tâche ou d'une work session du projet.
    const known = new Set(tracked.filter((t) => t.number != null && !foreignRepoOf(t, projectRepoName)).map((t) => t.number));
    for (const g of github) {
      if (g.state !== 'OPEN' || g.isCrossRepository || known.has(g.number)) continue;
      const task = await taskService.forBranch(projectId, g.headRefName);
      const ws = task ? null : await worksessionRepository.findByBranch(projectId, g.headRefName);
      if (task || ws) await this.recordGithub(projectId, g, SYSTEM, { taskId: task?.id ?? ws?.taskId ?? null });
    }
  },

  /**
   * PR « en préparation » d'un projet git : une par work session active dont la branche porte des modifications
   * (commits en avance sur la base, ou fichiers non commités) sans PR ouverte dans le dépôt du projet. Créée avec la
   * tâche de la work session (sinon celle de la branche) et un titre dérivé ; mise à jour (travail local) ; retirée
   * quand la branche n'a plus rien à proposer, que la PR est ouverte, ou que la work session disparaît. Après une
   * fusion, seuls les commits postérieurs à la fusion comptent (un squash laisse les anciens commits « en avance »).
   */
  async refreshPending(project: Project): Promise<void> {
    const worksessions = await worksessionRepository.listByProject(project.id);
    const tracked = await pullRequestRepository.list({ projectId: project.id, limit: 1000 });
    const projectRepo = projectRepoName(project);
    const pendings = tracked.filter((t) => t.status === 'pending');
    const seen = new Set<string>();
    for (const ws of worksessions) {
      const onBranch = tracked.filter((t) => t.status !== 'pending' && sameRepo(t.repo, projectRepo) && t.headBranch === ws.branch);
      const pending = pendings.find((p) => p.worksessionId === ws.id) ?? null;
      if (pending) seen.add(pending.id);
      const drop = async () => {
        if (pending) await pullRequestRepository.delete(pending.id);
      };
      if (onBranch.some((t) => t.status === 'open')) {
        await drop();
        continue;
      }
      const lastMerged = onBranch.map((t) => t.mergedAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const work = await localBranchWork(project, ws, { since: lastMerged }).catch(() => null);
      if (!work || (work.commits === 0 && work.changes === 0)) {
        await drop();
        continue;
      }
      if (pending) {
        // Tâche apparue depuis la création (prise par la session après ses premières modifications) : on la rattache.
        if (!pending.taskId) {
          const task = ws.taskId ? await taskService.get(ws.taskId).catch(() => null) : await taskService.forBranch(project.id, work.branch);
          if (task) await pullRequestRepository.update(pending.id, { taskId: task.id });
        }
        if (pending.localCommits !== work.commits || pending.localChanges !== work.changes || pending.headBranch !== work.branch) {
          await pullRequestRepository.update(pending.id, { localCommits: work.commits, localChanges: work.changes, headBranch: work.branch, baseBranch: work.baseBranch, syncedAt: new Date() });
        }
        continue;
      }
      const task = ws.taskId ? await taskService.get(ws.taskId).catch(() => null) : await taskService.forBranch(project.id, work.branch);
      const created = await pullRequestRepository.create(
        project.id,
        { repo: projectRepo, number: null, url: '', title: buildDraftText(work.branch, [], task?.title).title, headBranch: work.branch, baseBranch: work.baseBranch, status: 'pending', taskId: task?.id ?? null, worksessionId: ws.id, localCommits: work.commits, localChanges: work.changes },
        SYSTEM,
      );
      seen.add(created.id);
      if (created.taskId) await this.linkTaskBranch(created.taskId, work.branch);
    }
    // PR en préparation dont la work session a disparu ou a été archivée.
    for (const p of pendings) if (!seen.has(p.id)) await pullRequestRepository.delete(p.id);
  },

  /** Recopie l'état GitHub sur une PR suivie ; une fusion ou une fermeture constatée est notifiée. */
  async applyGithub(tracked: TrackedPullRequest, g: PullRequest): Promise<TrackedPullRequest> {
    const status = statusOf(g.state);
    const updated = await pullRequestRepository.update(tracked.id, {
      status,
      isDraft: g.isDraft,
      title: g.title,
      baseBranch: g.baseRefName,
      checksState: g.checksState,
      reviewDecision: g.reviewDecision,
      mergeable: g.mergeable,
      syncedAt: new Date(),
      mergedAt: g.mergedAt,
      closedAt: g.closedAt,
    });
    if (updated && tracked.status === 'open' && status !== 'open') {
      const project = await projectService.get(tracked.projectId).catch(() => null);
      const ref = `${project && !sameRepo(updated.repo, projectRepoName(project)) ? updated.repo : ''}#${updated.number}`;
      void notificationService.notify({
        type: status === 'merged' ? 'pull_request.merged' : 'pull_request.closed',
        title: status === 'merged' ? 'Pull request fusionnée' : 'Pull request fermée sans fusion',
        message: `${ref} ${updated.title}${project ? ` · ${project.name}` : ''}`,
        link: `/projects/${tracked.projectId}/pull-requests`,
        projectId: tracked.projectId,
        payload: { pullRequestId: updated.id, number: updated.number, repo: updated.repo, taskId: updated.taskId },
      });
    }
    return updated ?? tracked;
  },

  /** Paragraphe du prompt système : les outils de suivi des PR du serveur `tasks`. */
  promptSummary(): string {
    return "Les pull requests se suivent au niveau de la tâche avec les outils `tasks` : dès qu'une branche porte des modifications, Skipper y voit une PR « en préparation » (pr_list stage pending) ; `pr_open` pousse la branche courante et ouvre la PR sur GitHub (ou dans la forge Forgejo de Skipper pour un dépôt hébergé) avec le compte de la personne qui pilote la session (soumis à son autorisation ; paramètre `path` pour un autre dépôt cloné dans un sous-dossier), `pr_register` déclare une PR déjà ouverte (URL, du dépôt du projet ou d'un autre dépôt GitHub, ou numéro), `pr_update` tient à jour son statut (open, merged, closed), sa note et sa tâche, `pr_list` les liste par étape (en préparation, brouillon, à fusionner, fusionnée, annulée). Quand tu ouvres une PR par un autre moyen, déclare-la avec `pr_register` pour qu'elle apparaisse dans le suivi. Le statut suit GitHub tout seul (synchronisation).";
  },

  stages: PR_STAGES,
  stageLabel: (stage: PullRequestStage) => stageLabels[stage],
};
