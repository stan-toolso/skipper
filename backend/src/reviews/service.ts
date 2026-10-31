import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { pullRequestService } from '../git/pullRequests.js';
import { gitService } from '../git/service.js';
import { projectService } from '../projects/service.js';
import { pubSub } from '../pubsub.js';
import { foreignRepoOf, projectRepoName, trackedPullRequestService } from '../pullRequests/service.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { resultError } from '../sessions/providers/claudeResult.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { AttachmentInput, Session } from '../sessions/types.js';
import { taskRepository } from '../tasks/repository.js';
import { taskService } from '../tasks/service.js';
import { log } from '../log.js';
import type { Task } from '../tasks/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { worksessionService } from '../worksessions/service.js';
import type { Worksession } from '../worksessions/types.js';
import { reviewOf, type SessionReview } from './types.js';

/**
 * Revue de code par un agent (« Faire relire par un agent », panneau git et PR suivies) : lance une session Claude en
 * lecture seule dans le dossier de travail de la branche, avec le diff par rapport à la base et une grille de relecture,
 * puis publie son rapport (fil de la tâche, commentaire GitHub de la PR) dès son premier tour terminé.
 */

/** Diff inclus dans la consigne jusqu'à cette taille ; au-delà, il est joint en fichier que l'agent lit par morceaux. */
export const INLINE_DIFF_CHARS = 60_000;
/** Taille maximale du diff joint (sous la limite des fichiers joints). */
const MAX_DIFF_BYTES = 9 * 1024 * 1024;
/** Commentaires de tâche et de PR : sous les limites de Skipper (20 000) et de GitHub (65 536). */
const MAX_REPORT_CHARS = 18_000;

export interface ReviewTarget {
  projectId: string;
  /** Dossier de travail (branche) à relire. */
  worksessionId?: string | null;
  /** PR suivie à relire (dépôt du projet) : son dossier de travail, ou un nouveau sur sa branche. */
  pullRequestId?: string | null;
}

/** La consigne de l'agent relecteur : contexte, grille de relecture, format du rapport, puis le diff (ou son fichier). */
export function reviewPrompt(input: { review: SessionReview; task: Pick<Task, 'title' | 'description'> | null; pr: Pick<TrackedPullRequest, 'title' | 'url' | 'number'> | null; stat: string; patch: string | null }): string {
  const { review, task, pr } = input;
  const branch = review.branch ? `\`${review.branch}\`` : 'courante';
  const lines = [
    `Relis les modifications de la branche ${branch} par rapport à \`${review.baseBranch}\` (point de divergence ${review.mergeBase.slice(0, 7)}, ${review.commits} commit(s), travail non validé compris). Le dossier de travail est la branche telle qu'elle est : lis les fichiers autour des modifications (appelants, types, tests) pour juger, sans t'en tenir au diff.`,
    pr ? `Pull request : #${pr.number} « ${pr.title} » (${pr.url}).` : '',
    task ? `Tâche réalisée par cette branche : « ${task.title} »${task.description.trim() ? `\n\n${task.description.trim().slice(0, 4000)}` : ''}` : '',
    [
      'Grille de relecture, par ordre d\'importance :',
      '1. **Bugs et régressions** : logique, cas limites, erreurs non gérées, concurrence, données (migrations, requêtes), comportement existant cassé.',
      '2. **Sécurité** : contrôle des droits, injection (SQL, commandes, HTML), secrets exposés, entrées non validées, chemins de fichiers.',
      '3. **Simplifications** : code mort ou dupliqué, abstraction inutile, ce qui existe déjà ailleurs dans le projet, écarts aux conventions (bibliothèque de contexte, README).',
      '4. **Tests** manquants pour ce qui est risqué.',
    ].join('\n'),
    [
      'Format du rapport (ta réponse finale, publiée telle quelle en Markdown) :',
      '- première ligne : le verdict, « ✅ Rien de bloquant », « ⚠️ À corriger avant fusion » ou « ❌ Problèmes bloquants », suivi d\'une phrase de synthèse ;',
      '- puis les constats classés par gravité (bloquant, à corriger, suggestion), chacun avec `fichier:ligne`, le problème, un scénario concret quand c\'est un bug, et la correction proposée ;',
      '- sois concis et factuel : pas de préambule, pas de récit de ta démarche, pas de rubrique vide, et n\'invente pas de problème pour remplir le rapport.',
    ].join('\n'),
    `Fichiers modifiés :\n\`\`\`\n${input.stat.trim() || '(aucun fichier suivi modifié)'}\n\`\`\``,
    input.patch !== null ? `Diff :\n\`\`\`diff\n${input.patch}\n\`\`\`` : 'Le diff complet est dans le fichier joint ci-dessous : lis-le en entier (par morceaux avec offset et limit s\'il est long) avant de conclure.',
  ];
  return lines.filter(Boolean).join('\n\n');
}

/** PR suivie ouverte (ou brouillon) du dépôt du projet sur cette branche. */
async function openPullRequestOf(projectId: string, repo: string, branch: string): Promise<TrackedPullRequest | null> {
  const prs = await trackedPullRequestService.list({ projectId, headBranch: branch, status: ['open'], limit: 5 });
  return prs.find((p) => !foreignRepoOf(p, repo)) ?? null;
}

/** Une revue est déjà en cours dans ce dossier de travail. */
async function runningReview(worksessionId: string): Promise<Session | null> {
  const sessions = await sessionRepository.list({ worksessionId, archived: 'exclude', limit: 50 });
  return sessions.find((s) => reviewOf(s) && !reviewOf(s)?.reportedAt && (s.status === 'running' || s.status === 'queued' || s.status === 'pending')) ?? null;
}

export const reviewService = {
  /**
   * Lance la revue : la session (provider Claude, lecture seule) s'exécute dans le dossier de travail de la branche,
   * à côté de la session qui y travaille. Renvoie la session de relecture.
   */
  async request(target: ReviewTarget, userId: string): Promise<Session> {
    const project = await projectService.get(target.projectId);
    if (!project.gitUrl) throw new AppError("La revue de code demande un projet relié à un dépôt git");
    const repo = projectRepoName(project);
    let pr: TrackedPullRequest | null = null;
    let ws: Worksession | null = null;
    let createdWorksession = false;
    if (target.pullRequestId) {
      pr = await trackedPullRequestService.get(target.pullRequestId);
      if (pr.projectId !== project.id) throw new NotFoundError('Pull request introuvable');
      if (foreignRepoOf(pr, repo)) throw new AppError(`La PR ${pr.repo}#${pr.number} est dans un autre dépôt : la revue ne relit que les branches du dépôt du projet`);
      if (pr.status === 'merged' || pr.status === 'closed') throw new AppError(`La pull request #${pr.number} n'est plus ouverte`);
      const found = pr.worksessionId ? await worksessionRepository.findById(pr.worksessionId) : await worksessionRepository.findByBranch(project.id, pr.headBranch);
      if (found && !found.archivedAt) ws = found;
      else {
        // Pas de dossier de travail actif sur la branche (PR ouverte par quelqu'un d'autre) : un nouveau, qui l'extrait.
        ws = await worksessionService.create(project.id, { branch: pr.headBranch }, userId);
        createdWorksession = true;
      }
    } else if (target.worksessionId) {
      ws = await worksessionService.assertUsable(project, target.worksessionId);
      pr = await openPullRequestOf(project.id, repo, ws.branch);
    } else throw new AppError('Indiquez la branche (dossier de travail) ou la pull request à relire');

    try {
      const already = await runningReview(ws.id);
      if (already) throw new AppError(`Une relecture de la branche ${ws.branch} est déjà en cours (« ${already.name} »)`);
      const ref = { projectId: project.id, worksessionId: ws.id };
      // Base à jour : la relecture compare à la branche distante telle qu'elle est maintenant (échec ignoré : hors ligne).
      await gitService.fetch(ref, userId).catch(() => undefined);
      const diff = await gitService.branchPatch(ref, pr?.baseBranch);
      if (!diff) throw new AppError('Aucune branche de base à comparer (ni la branche du projet, ni origin/HEAD, main ou master)');
      if (!diff.patch.trim()) throw new AppError(`Rien à relire : la branche ${ws.branch} n'a aucune modification par rapport à ${diff.baseBranch}`);

      const taskId = pr?.taskId ?? ws.taskId ?? (await taskRepository.findForBranches([{ projectId: project.id, branch: ws.branch }])).get(`${project.id}\u0000${ws.branch}`)?.id ?? null;
      const task = taskId ? await taskRepository.findById(taskId) : null;
      const review: SessionReview = {
        branch: diff.branch,
        baseBranch: diff.baseBranch,
        mergeBase: diff.mergeBase,
        commits: diff.commits,
        pullRequestId: pr?.id ?? null,
        prNumber: pr?.number ?? null,
        prUrl: pr?.url || null,
        taskId: task?.id ?? null,
        requestedBy: userId,
      };
      const inline = diff.patch.length <= INLINE_DIFF_CHARS;
      const attachments: AttachmentInput[] = inline
        ? []
        : [{ name: `${(diff.branch ?? 'branche').replace(/[^\w.-]+/g, '-')}.diff`, mediaType: 'text/x-diff', data: Buffer.from(diff.patch).subarray(0, MAX_DIFF_BYTES).toString('base64') }];
      return await sessionService.create({
        projectId: project.id,
        worksessionId: ws.id,
        ownerId: userId,
        name: pr?.number ? `Relecture PR #${pr.number}` : `Relecture ${ws.branch}`,
        provider: 'claude',
        prompt: reviewPrompt({ review, task, pr, stat: diff.stat, patch: inline ? diff.patch : null }),
        attachments,
        config: { permissionMode: 'dontAsk', review },
      });
    } catch (err) {
      if (createdWorksession) await worksessionService.delete(ws.id).catch(() => undefined);
      throw err;
    }
  },

  /**
   * Publie le rapport d'une session de relecture dont le premier tour est fini (ou qui s'est arrêtée) : fil de la tâche,
   * commentaire GitHub de la PR encore ouverte, rapport rangé dans la session ; puis la session est terminée.
   * Une seule fois : `reportedAt` est posé avant toute publication.
   */
  async report(sessionId: string): Promise<void> {
    const session = await sessionRepository.findById(sessionId);
    const review = session && reviewOf(session);
    if (!session || !review || review.reportedAt) return;
    const finished = session.status === 'completed' || session.status === 'failed' || session.status === 'stopped';
    if (!finished && !(session.status === 'running' && session.activity === 'idle')) return;
    const result = await sessionRepository.findLastEvent(session.id, ['claude.result']);
    const text = typeof result?.payload.result === 'string' ? result.payload.result.trim() : '';
    const error = (result ? resultError(result.payload) : null) ?? (text ? null : session.error ?? 'Aucun rapport rendu par l\'agent');
    // Arrêtée par quelqu'un avant d'avoir conclu : rien à publier.
    if (session.status === 'stopped' && !text) {
      await save(session, { ...review, reportedAt: new Date().toISOString(), error: 'Relecture arrêtée avant son rapport' });
      return;
    }
    let current = await save(session, { ...review, reportedAt: new Date().toISOString(), report: error ? null : text, error });
    const link = `${config.appUrl}/sessions/${session.id}`;
    const scope = `${review.branch ? `branche \`${review.branch}\`` : 'branche courante'} comparée à \`${review.baseBranch}\`, ${review.commits} commit(s)`;
    const body = error
      ? `**Relecture par un agent** (${scope}) : elle n'a pas abouti (${error}). [Session de relecture](${link})`
      : `**Relecture par un agent** (${scope}) · [session](${link})\n\n${truncate(text)}`;
    const patch: Partial<SessionReview> = {};
    if (review.taskId) {
      try {
        patch.taskCommentId = (await taskService.addComment(review.taskId, body, { type: 'agent', sessionId: session.id, name: session.name })).id;
      } catch (err) {
        log.warn('[reviews] commentaire de tâche', err);
      }
    }
    if (!error && review.pullRequestId && review.prNumber) {
      try {
        const pr = await trackedPullRequestService.get(review.pullRequestId);
        if (pr.status !== 'open') throw new AppError(`la PR #${pr.number} n'est plus ouverte`);
        patch.githubCommentUrl = await pullRequestService.comment(session.projectId, review.requestedBy, review.prNumber, `${body}\n\n<sub>Relecture automatique lancée depuis Skipper.</sub>`);
      } catch (err) {
        patch.githubError = (err as Error).message;
      }
    }
    if (Object.keys(patch).length) current = await save(current, { ...reviewOf(current)!, ...patch });
    // Le rapport est rendu : la session est terminée pour libérer sa place (un message la relance pour en discuter).
    if (sessionService.isRunning(session.id)) await sessionService.end(session.id).catch((err) => log.warn('[reviews] fin de la session de relecture', err));
  },

  /** Guette la fin du premier tour des sessions de relecture (événements `sessionUpdated`). Renvoie l'arrêt. */
  startWatcher(): () => void {
    const updates = pubSub.subscribe('sessionUpdated');
    const inFlight = new Set<string>();
    void (async () => {
      for await (const s of updates) {
        const review = reviewOf(s);
        if (!review || review.reportedAt || inFlight.has(s.id)) continue;
        if (!(s.status === 'running' && s.activity === 'idle') && s.status !== 'completed' && s.status !== 'failed' && s.status !== 'stopped') continue;
        inFlight.add(s.id);
        void this.report(s.id)
          .catch((err) => log.error('[reviews] publication du rapport', err))
          .finally(() => inFlight.delete(s.id));
      }
    })();
    return () => void updates.return?.();
  },
};

function truncate(text: string): string {
  return text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n\n… (rapport tronqué : la suite est dans la session)` : text;
}

/** Range la revue dans la configuration de la session et diffuse la session à jour. */
async function save(session: Session, review: SessionReview): Promise<Session> {
  const updated = (await sessionRepository.update(session.id, { config: { ...session.config, review } })) ?? session;
  pubSub.publish('sessionUpdated', updated);
  return updated;
}
