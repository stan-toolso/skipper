import { AppError, NotFoundError } from '../errors.js';
import type { WorkspaceRef } from '../files/service.js';
import { parseGithubRepo, pullRequestService, type PullRequest } from '../git/pullRequests.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { taskService } from '../tasks/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { pullRequestRepository } from './repository.js';
import {
  describePullRequest,
  PR_STAGES,
  stageLabels,
  TRACKED_PR_STATUSES,
  type CreateTrackedPullRequestInput,
  type PullRequestActor,
  type PullRequestStage,
  type TrackedPullRequest,
  type TrackedPullRequestFilter,
  type TrackedPullRequestStatus,
  type UpdateTrackedPullRequestInput,
} from './types.js';

/**
 * Pull requests suivies : création (depuis GitHub, depuis une URL, ou en ouvrant la PR sur GitHub), mise à jour
 * (statut, note, déploiement), synchronisation avec GitHub (statut, brouillon, checks, revue, conflits, et adoption
 * des PR ouvertes sur la branche d'une tâche), notifications et textes pour les agents.
 */

export const SYSTEM: PullRequestActor = { type: 'system' };

const MAX_NOTE = 2000;
const MAX_TITLE = 500;
/** Une synchronisation GitHub par projet au plus toutes les 30 s (les pages sondent). */
const SYNC_INTERVAL_MS = 30_000;
/** PR suivies absentes des 100 dernières du dépôt : interrogées une à une, au plus ce nombre par synchronisation. */
const MAX_INDIVIDUAL_FETCHES = 10;

const lastSync = new Map<string, number>();

/** Numéro d'une PR depuis son URL GitHub (`https://github.com/owner/repo/pull/123`), avec le dépôt. */
export function parsePullRequestUrl(url: string): { owner: string; name: string; number: number } | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

/** Numéro d'une référence libre : « 42 », « #42 » ou l'URL de la PR. */
export function parsePullRequestRef(ref: string): number | null {
  const t = ref.trim();
  if (/^#?\d+$/.test(t)) return Number(t.replace('#', ''));
  return parsePullRequestUrl(t)?.number ?? null;
}

const statusOf = (state: PullRequest['state']): TrackedPullRequestStatus => (state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open');

/** Champs d'une PR suivie recopiés depuis la PR GitHub. */
function fromGithub(pr: PullRequest): Omit<CreateTrackedPullRequestInput, 'taskId' | 'note'> {
  return {
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

  async get(id: string): Promise<TrackedPullRequest> {
    const pr = await pullRequestRepository.findById(id);
    if (!pr) throw new NotFoundError('Pull request suivie introuvable');
    return pr;
  },

  /** PR suivie désignée par son identifiant, ou par son numéro GitHub (« 42 », « #42 », URL) dans le projet. */
  async resolve(projectId: string, ref: string): Promise<TrackedPullRequest> {
    const number = parsePullRequestRef(ref);
    const pr = number != null ? await pullRequestRepository.findByNumber(projectId, number) : await pullRequestRepository.findById(ref.trim());
    if (!pr || pr.projectId !== projectId) throw new NotFoundError(number != null ? `Aucune pull request suivie n'a le numéro #${number} dans ce projet` : 'Pull request suivie introuvable dans ce projet');
    return pr;
  },

  /**
   * Enregistre (ou met à jour, si elle est déjà suivie) une PR GitHub connue. Sans `taskId`, la tâche traitée sur
   * la branche de la PR est reliée. Un agent qui ouvre ou déclare une PR prévient les membres du projet.
   */
  async recordGithub(projectId: string, pr: PullRequest, actor: PullRequestActor, extra: { taskId?: string | null; note?: string | null } = {}): Promise<TrackedPullRequest> {
    const existing = await pullRequestRepository.findByNumber(projectId, pr.number);
    const taskId = extra.taskId !== undefined ? extra.taskId : existing?.taskId ?? (await taskService.forBranch(projectId, pr.headRefName))?.id ?? null;
    const note = validateNote(extra.note);
    const fields = fromGithub(pr);
    if (existing) {
      const updated = await pullRequestRepository.update(existing.id, { ...fields, taskId, syncedAt: new Date(), note });
      return updated ?? existing;
    }
    const created = await pullRequestRepository.create(projectId, { ...fields, taskId, note }, actor);
    if (!created.taskId && taskId === null) {
      // Rien à relier : la PR reste au niveau du projet.
    }
    if (created.taskId) await this.linkTaskBranch(created.taskId, created.headBranch);
    if (actor.type === 'agent') {
      const project = await projectService.get(projectId).catch(() => null);
      void notificationService.notify({
        type: 'pull_request.opened',
        title: 'Pull request ouverte par un agent',
        message: `#${created.number} ${created.title}${project ? ` · ${project.name}` : ''}`,
        link: `/projects/${projectId}/pull-requests`,
        projectId,
        sessionId: actor.sessionId ?? null,
        payload: { pullRequestId: created.id, number: created.number, taskId: created.taskId },
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
   * Suit une PR déjà ouverte, désignée par son URL ou son numéro. Ses détails sont lus sur GitHub avec le compte de
   * `userId` ; quand GitHub n'est pas joignable (pas de compte connecté), `fallback` (titre, branche) suffit.
   */
  async register(
    projectId: string,
    ref: { url?: string | null; number?: number | null },
    opts: { taskId?: string | null; note?: string | null; userId?: string | null; fallback?: { title?: string | null; headBranch?: string | null } },
    actor: PullRequestActor,
  ): Promise<TrackedPullRequest> {
    const project = await projectService.get(projectId);
    const repo = parseGithubRepo(project.gitUrl);
    let number = ref.number ?? null;
    let url: string | null = null;
    if (ref.url?.trim()) {
      const parsed = parsePullRequestUrl(ref.url);
      if (!parsed) throw new AppError(`URL de pull request GitHub attendue (https://github.com/<owner>/<repo>/pull/<n>) : ${ref.url}`);
      if (repo && (parsed.owner.toLowerCase() !== repo.owner.toLowerCase() || parsed.name.toLowerCase() !== repo.name.toLowerCase())) {
        throw new AppError(`Cette pull request appartient à ${parsed.owner}/${parsed.name}, pas au dépôt du projet (${repo.owner}/${repo.name})`);
      }
      number = parsed.number;
      url = ref.url.trim();
    }
    if (number == null || !Number.isInteger(number) || number <= 0) throw new AppError('Indique le numéro ou l’URL de la pull request');
    if (opts.taskId) {
      const task = await taskService.get(opts.taskId);
      if (task.projectId !== projectId) throw new AppError('La tâche n’appartient pas à ce projet');
    }
    const github = repo ? await pullRequestService.get(projectId, opts.userId, number).catch(() => null) : null;
    if (github) return this.recordGithub(projectId, github, actor, { taskId: opts.taskId, note: opts.note });

    // GitHub injoignable : on enregistre ce que l'on sait.
    const existing = await pullRequestRepository.findByNumber(projectId, number);
    if (existing) {
      const updated = await pullRequestRepository.update(existing.id, { taskId: opts.taskId !== undefined ? opts.taskId : undefined, note: validateNote(opts.note), title: opts.fallback?.title?.trim() || undefined });
      return updated ?? existing;
    }
    const title = opts.fallback?.title?.trim();
    const headBranch = opts.fallback?.headBranch?.trim();
    if (!title || !headBranch) throw new AppError(repo ? `GitHub n'a pas répondu pour la PR #${number} : donne aussi son titre et sa branche` : "Ce projet n'est pas relié à un dépôt GitHub : donne l'URL, le titre et la branche de la pull request");
    if (title.length > MAX_TITLE) throw new AppError(`Le titre dépasse ${MAX_TITLE} caractères`);
    const taskId = opts.taskId ?? (await taskService.forBranch(projectId, headBranch))?.id ?? null;
    const created = await pullRequestRepository.create(
      projectId,
      { number, url: url ?? (repo ? `https://github.com/${repo.owner}/${repo.name}/pull/${number}` : ''), title, headBranch, baseBranch: project.gitBranch ?? '', taskId, note: validateNote(opts.note) },
      actor,
    );
    if (created.taskId) await this.linkTaskBranch(created.taskId, headBranch);
    return created;
  },

  /** Ouvre la PR sur GitHub depuis la branche courante du dossier de travail (poussée au besoin), puis la suit. */
  async open(ref: WorkspaceRef, userId: string | null | undefined, input: { title: string; body?: string | null; base?: string | null; draft?: boolean | null }, opts: { taskId?: string | null; note?: string | null }, actor: PullRequestActor): Promise<TrackedPullRequest> {
    if (opts.taskId) {
      const task = await taskService.get(opts.taskId);
      if (task.projectId !== ref.projectId) throw new AppError('La tâche n’appartient pas à ce projet');
    }
    const pr = await pullRequestService.create(ref, userId, input);
    return this.recordGithub(ref.projectId, pr, actor, { taskId: opts.taskId, note: opts.note });
  },

  /** Statut, note, tâche reliée, déploiement. Une PR marquée fusionnée ou fermée garde son instantané GitHub. */
  async update(id: string, input: { status?: TrackedPullRequestStatus | null; note?: string | null; taskId?: string | null; deployed?: boolean | null; deployNote?: string | null; isDraft?: boolean | null }, actor: PullRequestActor): Promise<TrackedPullRequest> {
    const before = await this.get(id);
    if (input.status != null && !TRACKED_PR_STATUSES.includes(input.status)) throw new AppError(`Statut invalide : ${input.status}`);
    if (input.taskId) {
      const task = await taskService.get(input.taskId);
      if (task.projectId !== before.projectId) throw new AppError('La tâche n’appartient pas à ce projet');
    }
    const status = input.status ?? before.status;
    if (input.deployed && status !== 'merged') throw new AppError('Seule une pull request fusionnée peut être marquée déployée');
    const patch: UpdateTrackedPullRequestInput = {
      status: input.status ?? undefined,
      note: validateNote(input.note),
      taskId: input.taskId,
      isDraft: input.isDraft ?? undefined,
      deployed: input.deployed ?? undefined,
      deployedBy: input.deployed ? actor : undefined,
      deployNote: validateNote(input.deployNote, 'La note de déploiement'),
    };
    // Repasser « ouverte » annule le déploiement.
    if (input.status === 'open' && before.deployedAt) patch.deployed = false;
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
   * Rafraîchit les PR suivies d'un projet depuis GitHub (avec le compte de `userId`) : statut, brouillon, titre,
   * checks, revue, conflits ; une PR fusionnée hors de Skipper est notifiée. Les PR ouvertes du dépôt sur la
   * branche d'une tâche ou d'une work session sont adoptées. Au plus une fois toutes les 30 s par projet, sauf
   * `force`. Sans GitHub (projet sans dépôt GitHub, compte absent, panne), renvoie la liste telle quelle.
   */
  async sync(projectId: string, userId: string | null | undefined, opts: { force?: boolean } = {}): Promise<TrackedPullRequest[]> {
    const current = () => pullRequestRepository.list({ projectId, limit: 1000 });
    const last = lastSync.get(projectId) ?? 0;
    if (!opts.force && Date.now() - last < SYNC_INTERVAL_MS) return current();
    if (!(await pullRequestService.isGithubProject(projectId).catch(() => false))) return current();
    lastSync.set(projectId, Date.now());
    let github: PullRequest[];
    try {
      github = await pullRequestService.list(projectId, userId, 'ALL', 100);
    } catch {
      return current();
    }
    const byNumber = new Map(github.map((p) => [p.number, p]));
    const tracked = await current();
    let individual = 0;
    for (const t of tracked) {
      let g = byNumber.get(t.number) ?? null;
      if (!g && t.status === 'open' && individual < MAX_INDIVIDUAL_FETCHES) {
        individual++;
        g = await pullRequestService.get(projectId, userId, t.number).catch(() => null);
      }
      if (g) await this.applyGithub(t, g);
    }
    // Adoption : PR ouvertes du dépôt dont la branche est celle d'une tâche ou d'une work session du projet.
    const known = new Set(tracked.map((t) => t.number));
    for (const g of github) {
      if (g.state !== 'OPEN' || g.isCrossRepository || known.has(g.number)) continue;
      const task = await taskService.forBranch(projectId, g.headRefName);
      const ws = task ? null : await worksessionRepository.findByBranch(projectId, g.headRefName);
      if (task || ws) await this.recordGithub(projectId, g, SYSTEM, { taskId: task?.id ?? ws?.taskId ?? null });
    }
    return current();
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
      void notificationService.notify({
        type: status === 'merged' ? 'pull_request.merged' : 'pull_request.closed',
        title: status === 'merged' ? 'Pull request fusionnée' : 'Pull request fermée sans fusion',
        message: `#${updated.number} ${updated.title}${project ? ` · ${project.name}` : ''}${status === 'merged' ? ' · à déployer' : ''}`,
        link: `/projects/${tracked.projectId}/pull-requests`,
        projectId: tracked.projectId,
        payload: { pullRequestId: updated.id, number: updated.number, taskId: updated.taskId },
      });
    }
    return updated ?? tracked;
  },

  /** Paragraphe du prompt système : les outils de suivi des PR du serveur `tasks`. */
  promptSummary(): string {
    return "Les pull requests se suivent au niveau de la tâche avec les outils `tasks` : `pr_open` pousse la branche courante et ouvre la PR sur GitHub avec le compte de la personne qui pilote la session (soumis à son autorisation), `pr_register` déclare une PR déjà ouverte (URL ou numéro), `pr_update` tient à jour son statut (open, merged, closed), sa note et son déploiement (deployed), `pr_list` les liste par étape (brouillon, à fusionner, à déployer, déployée, annulée). Quand tu ouvres une PR par un autre moyen, déclare-la avec `pr_register` pour qu'elle apparaisse dans le suivi ; quand tu mets une PR fusionnée en production, marque-la déployée.";
  },

  stages: PR_STAGES,
  stageLabel: (stage: PullRequestStage) => stageLabels[stage],
};
