import { useMutation } from '@apollo/client';
import { Link, useNavigate } from 'react-router-dom';
import { REQUEST_CODE_REVIEW } from '../graphql/pullRequests';
import { useDialogs } from './Dialogs';
import Markdown from './Markdown';

/** Ce que l'interface montre d'une session de relecture (`Session.review`). */
export interface SessionReviewInfo {
  branch: string | null;
  baseBranch: string;
  commits: number;
  reportedAt: string | null;
  report: string | null;
  error: string | null;
  githubCommentUrl: string | null;
  githubError: string | null;
  task: { id: string; title: string } | null;
  pullRequest: { id: string; number: number | null; url: string } | null;
}

/** Ce qu'on fait relire : un dossier de travail (sa branche) ou une PR suivie ; `label` pour la confirmation. */
export interface CodeReviewTarget {
  projectId: string;
  worksessionId?: string | null;
  pullRequestId?: string | null;
  label: string;
}

/**
 * « Faire relire par un agent » : confirmation, puis lancement d'une session Claude en lecture seule dans le dossier de
 * la branche ; son rapport sera publié dans le fil de la tâche et, pour une PR ouverte, sur GitHub.
 */
export function useRequestCodeReview(): (target: CodeReviewTarget) => Promise<void> {
  const { confirm, showError } = useDialogs();
  const navigate = useNavigate();
  const [request] = useMutation<{ requestCodeReview: { id: string; name: string } }>(REQUEST_CODE_REVIEW);
  return async (target) => {
    const answer = await confirm({
      title: 'Faire relire par un agent',
      message: `Lancer une relecture de ${target.label} ? Un agent Claude en lecture seule relit le diff par rapport à la base (bugs, sécurité, simplifications) sans modifier aucun fichier ; son rapport est publié dans le fil de la tâche liée et, s'il y a une pull request ouverte, en commentaire GitHub.`,
      confirmLabel: 'Lancer la relecture',
      checkbox: { label: 'Ouvrir la session de relecture', defaultChecked: false },
    });
    if (!answer) return;
    try {
      const res = await request({ variables: { projectId: target.projectId, worksessionId: target.worksessionId ?? null, pullRequestId: target.pullRequestId ?? null } });
      const session = res.data?.requestCodeReview;
      if (answer.checked && session) navigate(`/sessions/${session.id}`);
    } catch (err) {
      await showError(err);
    }
  };
}

/** Rapport d'une session de relecture (onglet « Session » du panneau de droite) : en cours, publié ou en échec. */
export function SessionReviewReport({ review }: { review: SessionReviewInfo }) {
  const scope = `${review.branch ?? 'HEAD'} vs ${review.baseBranch} · ${review.commits} commit(s)`;
  return (
    <div className="session-review">
      <div className="git-subhead">Relecture</div>
      <div className="session-review-scope" title={scope}>
        <i className="bi bi-git me-1" />
        {scope}
      </div>
      {!review.reportedAt && <div className="session-review-note">Relecture en cours : le rapport sera publié à la fin du tour de l'agent.</div>}
      {review.error && <div className="session-review-note cc-red">{review.error}</div>}
      <div className="session-review-links">
        {review.task && (
          <Link to={`/tasks/${review.task.id}`} title={review.task.title}>
            <i className="bi bi-check2-square me-1" />
            Tâche
          </Link>
        )}
        {review.githubCommentUrl && (
          <a href={review.githubCommentUrl} target="_blank" rel="noopener noreferrer">
            <i className="bi bi-github me-1" />
            Commentaire sur la PR{review.pullRequest?.number ? ` #${review.pullRequest.number}` : ''}
          </a>
        )}
      </div>
      {review.githubError && <div className="session-review-note cc-yellow">Commentaire GitHub non posté : {review.githubError}</div>}
      {review.report && <Markdown text={review.report} className="session-review-report" />}
    </div>
  );
}
