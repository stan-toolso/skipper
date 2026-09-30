import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Form, Modal, Spinner } from 'react-bootstrap';
import {
  CREATE_PULL_REQUEST,
  GITHUB_PULL_REQUEST,
  GITHUB_PULL_REQUEST_DRAFT,
  MERGE_PULL_REQUEST,
  type PullRequest,
  type PullRequestDraft,
  type PullRequestMergeMethod,
  type PullRequestSummary,
} from '../graphql/operations';
import Markdown from './Markdown';

/** Requêtes à rafraîchir après une création ou une fusion (panneau git, tâches, sidebar). */
const PR_REFETCH = ['GithubPullRequests', 'Tasks', 'Sidebar', 'GitStatus', 'GitBranches', 'GitLog'];

const stateLabels: Record<string, { label: string; bg: string; icon: string }> = {
  OPEN: { label: 'ouverte', bg: 'success', icon: 'bi-git' },
  MERGED: { label: 'fusionnée', bg: 'primary', icon: 'bi-check2-circle' },
  CLOSED: { label: 'fermée', bg: 'secondary', icon: 'bi-x-circle' },
};

const checkIcons: Record<string, { icon: string; cls: string; label: string }> = {
  SUCCESS: { icon: 'bi-check-circle-fill', cls: 'text-success', label: 'checks réussis' },
  FAILURE: { icon: 'bi-x-circle-fill', cls: 'text-danger', label: 'checks en échec' },
  ERROR: { icon: 'bi-x-circle-fill', cls: 'text-danger', label: 'checks en erreur' },
  PENDING: { icon: 'bi-circle-half', cls: 'text-warning', label: 'checks en cours' },
  EXPECTED: { icon: 'bi-circle-half', cls: 'text-warning', label: 'checks attendus' },
  NEUTRAL: { icon: 'bi-dash-circle', cls: 'text-secondary', label: 'neutre' },
  SKIPPED: { icon: 'bi-skip-forward-circle', cls: 'text-secondary', label: 'ignoré' },
};

const reviewLabels: Record<string, { label: string; cls: string; icon: string }> = {
  APPROVED: { label: 'approuvée', cls: 'text-success', icon: 'bi-hand-thumbs-up' },
  CHANGES_REQUESTED: { label: 'modifications demandées', cls: 'text-danger', icon: 'bi-pencil-square' },
  REVIEW_REQUIRED: { label: 'revue requise', cls: 'text-warning', icon: 'bi-eye' },
  COMMENTED: { label: 'commentée', cls: 'text-secondary', icon: 'bi-chat' },
  DISMISSED: { label: 'écartée', cls: 'text-secondary', icon: 'bi-slash-circle' },
  PENDING: { label: 'en cours', cls: 'text-secondary', icon: 'bi-hourglass' },
};

const mergeStateHints: Record<string, string> = {
  BEHIND: 'la branche est en retard sur la base',
  BLOCKED: 'fusion bloquée par les règles de la branche (revues ou checks requis)',
  DIRTY: 'conflits avec la base',
  UNSTABLE: 'des checks non obligatoires échouent',
  DRAFT: 'brouillon',
};

/** Pastilles compactes : état, checks, conflits, revue. */
export function PullRequestIndicators({ pr, showState = true }: { pr: PullRequestSummary; showState?: boolean }) {
  const st = stateLabels[pr.state] ?? stateLabels.OPEN;
  const checks = pr.checksState ? checkIcons[pr.checksState] : null;
  const review = pr.reviewDecision ? reviewLabels[pr.reviewDecision] : null;
  return (
    <span className="d-inline-flex align-items-center gap-1">
      {showState && (
        <Badge bg={pr.isDraft && pr.state === 'OPEN' ? 'secondary' : st.bg} className="fw-normal">
          {pr.isDraft && pr.state === 'OPEN' ? 'brouillon' : st.label}
        </Badge>
      )}
      {pr.state === 'OPEN' && checks && <i className={`bi ${checks.icon} ${checks.cls}`} title={checks.label} />}
      {pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && <i className="bi bi-exclamation-triangle-fill text-danger" title="Conflits avec la base" />}
      {pr.state === 'OPEN' && review && <i className={`bi ${review.icon} ${review.cls}`} title={`Revue : ${review.label}`} />}
    </span>
  );
}

/** Lien compact vers une PR (carte de tâche) : ouvre la fenêtre de détail. */
export function PullRequestChip({ projectId, pr }: { projectId: string; pr: PullRequestSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-link btn-sm p-0 text-decoration-none small d-inline-flex align-items-center gap-1" title={`Pull request : ${pr.title}`} onClick={() => setOpen(true)}>
        <i className={`bi ${(stateLabels[pr.state] ?? stateLabels.OPEN).icon}`} />#{pr.number}
        <PullRequestIndicators pr={pr} />
      </button>
      {open && <PullRequestModal projectId={projectId} number={pr.number} onClose={() => setOpen(false)} />}
    </>
  );
}

function DetailsLine({ pr }: { pr: PullRequest }) {
  return (
    <div className="small text-secondary d-flex flex-wrap gap-2 align-items-center">
      <span className="font-monospace">
        {pr.headRefName} <i className="bi bi-arrow-right" /> {pr.baseRefName}
      </span>
      {pr.author && <span>par {pr.author}</span>}
      <span>
        {pr.commitCount} commit{pr.commitCount > 1 ? 's' : ''} · {pr.changedFiles} fichier{pr.changedFiles > 1 ? 's' : ''}{' '}
        <span className="text-success">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
      </span>
    </div>
  );
}

/**
 * Détail d'une PR : checks, revues, possibilité de fusion ; fusion (merge, squash, rebase) avec
 * nettoyage du worktree, des branches et des tâches liées.
 */
export function PullRequestModal({ projectId, number, onClose, onMerged }: { projectId: string; number: number; onClose: () => void; onMerged?: (deletedWorktreeIds: string[]) => void }) {
  const q = useQuery<{ githubPullRequest: PullRequest }>(GITHUB_PULL_REQUEST, { variables: { projectId, number }, fetchPolicy: 'cache-and-network', pollInterval: 15000 });
  const pr = q.data?.githubPullRequest;
  const [method, setMethod] = useState<PullRequestMergeMethod>('SQUASH');
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(true);
  const [deleteWorktree, setDeleteWorktree] = useState(true);
  const [stopSessions, setStopSessions] = useState(true);
  const [completeTasks, setCompleteTasks] = useState(true);
  const [merge, { loading: merging, data: mergeData, error: mergeError }] = useMutation<{ mergePullRequest: { sha: string | null; warnings: string[]; deletedWorktreeIds: string[]; completedTaskIds: string[]; pullRequest: PullRequest } }>(MERGE_PULL_REQUEST, {
    refetchQueries: PR_REFETCH,
    onCompleted: (res) => onMerged?.(res.mergePullRequest.deletedWorktreeIds),
  });
  const result = mergeData?.mergePullRequest;
  const runningSessions = pr?.worktree?.sessions.filter((s) => s.status === 'RUNNING') ?? [];
  const openTasks = pr?.tasks.filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS') ?? [];
  const hint = pr ? mergeStateHints[pr.mergeStateStatus] : undefined;

  return (
    <Modal show onHide={onClose} size="lg" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h6">
          {pr ? (
            <>
              <span className="text-secondary">#{pr.number}</span> {pr.title}
            </>
          ) : (
            `Pull request #${number}`
          )}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {q.loading && !pr && (
          <div>
            <Spinner size="sm" /> Chargement…
          </div>
        )}
        {q.error && <Alert variant="danger">{q.error.message}</Alert>}
        {pr && (
          <>
            <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
              <PullRequestIndicators pr={pr} />
              <a href={pr.url} target="_blank" rel="noreferrer" className="small ms-auto">
                Ouvrir sur GitHub <i className="bi bi-box-arrow-up-right" />
              </a>
            </div>
            <DetailsLine pr={pr} />
            {pr.body.trim() && (
              <div className="border rounded p-2 mt-2 small" style={{ maxHeight: 220, overflowY: 'auto' }}>
                <Markdown text={pr.body} />
              </div>
            )}

            <div className="mt-3">
              <div className="fw-semibold small mb-1">Checks</div>
              {pr.checks.length === 0 && <div className="small text-secondary">Aucun check sur le dernier commit.</div>}
              {pr.checks.map((c, i) => {
                const ic = checkIcons[c.state] ?? checkIcons.NEUTRAL;
                return (
                  <div key={`${c.name}-${i}`} className="small d-flex gap-2 align-items-center">
                    <i className={`bi ${ic.icon} ${ic.cls}`} title={ic.label} />
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.name}
                      </a>
                    ) : (
                      <span>{c.name}</span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-3">
              <div className="fw-semibold small mb-1">Revues</div>
              {pr.reviews.length === 0 && <div className="small text-secondary">{pr.reviewDecision === 'REVIEW_REQUIRED' ? 'Revue requise, aucune pour le moment.' : 'Aucune revue.'}</div>}
              {pr.reviews.map((r) => {
                const rl = reviewLabels[r.state] ?? { label: r.state.toLowerCase(), cls: 'text-secondary', icon: 'bi-chat' };
                return (
                  <div key={r.author} className="small d-flex gap-2 align-items-center">
                    <i className={`bi ${rl.icon} ${rl.cls}`} />
                    {r.author} <span className="text-secondary">· {rl.label}</span>
                  </div>
                );
              })}
            </div>

            {pr.state === 'OPEN' && !result && (
              <div className="mt-3 border-top pt-3">
                <div className="fw-semibold small mb-2">Fusionner</div>
                {pr.isDraft && <Alert variant="secondary" className="py-1 small">Brouillon : marquez-la prête pour la revue sur GitHub avant de la fusionner.</Alert>}
                {pr.mergeable === 'CONFLICTING' && <Alert variant="danger" className="py-1 small">Conflits avec {pr.baseRefName} : à résoudre dans la branche avant la fusion.</Alert>}
                {pr.mergeable === 'UNKNOWN' && <div className="small text-secondary mb-2">GitHub calcule encore si la fusion est possible…</div>}
                {hint && pr.mergeable !== 'CONFLICTING' && !pr.isDraft && <div className="small text-warning mb-2">Attention : {hint}.</div>}
                <Form.Group className="mb-2 d-flex gap-3 flex-wrap small">
                  {(
                    [
                      ['SQUASH', 'Squash (un seul commit)'],
                      ['MERGE', 'Commit de fusion'],
                      ['REBASE', 'Rebase'],
                    ] as const
                  ).map(([value, label]) => (
                    <Form.Check key={value} type="radio" id={`merge-${value}`} name="merge-method" label={label} checked={method === value} onChange={() => setMethod(value)} />
                  ))}
                </Form.Group>
                <div className="small">
                  <Form.Check id="pr-del-remote" label={`Supprimer la branche ${pr.headRefName} sur GitHub`} checked={deleteRemoteBranch} disabled={pr.isCrossRepository} onChange={(e) => setDeleteRemoteBranch(e.target.checked)} />
                  <Form.Check
                    id="pr-del-wt"
                    label={pr.worktree ? `Supprimer le worktree ${pr.worktree.name} et la branche locale` : 'Supprimer la branche locale'}
                    checked={deleteWorktree}
                    disabled={pr.isCrossRepository}
                    onChange={(e) => setDeleteWorktree(e.target.checked)}
                  />
                  {deleteWorktree && runningSessions.length > 0 && (
                    <Form.Check
                      className="ms-4"
                      id="pr-stop-sessions"
                      label={`Arrêter ${runningSessions.length > 1 ? `les ${runningSessions.length} sessions encore ouvertes` : `la session encore ouverte (${runningSessions[0].name})`} dans ce worktree (historique conservé)`}
                      checked={stopSessions}
                      onChange={(e) => setStopSessions(e.target.checked)}
                    />
                  )}
                  {openTasks.length > 0 && (
                    <Form.Check
                      id="pr-complete-tasks"
                      label={`Marquer comme terminée : ${openTasks.map((t) => `« ${t.title} »`).join(', ')}`}
                      checked={completeTasks}
                      onChange={(e) => setCompleteTasks(e.target.checked)}
                    />
                  )}
                </div>
              </div>
            )}
            {mergeError && <Alert variant="danger" className="mt-2 mb-0 py-1 small">{mergeError.message}</Alert>}
            {result && (
              <Alert variant={result.warnings.length ? 'warning' : 'success'} className="mt-3 mb-0 small">
                <div>
                  <i className="bi bi-check2-circle me-1" />
                  Pull request fusionnée{result.sha ? ` (${result.sha.slice(0, 7)})` : ''}.
                  {result.deletedWorktreeIds.length > 0 && ' Worktree supprimé.'}
                  {result.completedTaskIds.length > 0 && ` ${result.completedTaskIds.length > 1 ? 'Tâches terminées' : 'Tâche terminée'}.`}
                </div>
                {result.warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </Alert>
            )}
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onClose}>
          Fermer
        </Button>
        {pr?.state === 'OPEN' && !result && (
          <Button
            variant="success"
            disabled={merging || pr.isDraft || pr.mergeable === 'CONFLICTING'}
            onClick={() =>
              merge({ variables: { projectId, number, method, cleanup: { deleteRemoteBranch, deleteWorktree, stopSessions: deleteWorktree && stopSessions, completeTasks: completeTasks && openTasks.length > 0 } } }).catch(() => undefined)
            }
          >
            {merging ? 'Fusion…' : 'Fusionner'}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

/** Création d'une PR pour la branche courante d'un workspace : titre et description pré-remplis. */
export function CreatePullRequestModal({ projectId, worktreeId, onClose, onCreated }: { projectId: string; worktreeId: string | null; onClose: () => void; onCreated?: (pr: PullRequest) => void }) {
  const q = useQuery<{ githubPullRequestDraft: PullRequestDraft }>(GITHUB_PULL_REQUEST_DRAFT, { variables: { projectId, worktreeId }, fetchPolicy: 'network-only' });
  const d = q.data?.githubPullRequestDraft;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  useEffect(() => {
    if (!d) return;
    setTitle(d.title);
    setBody(d.body);
    setBase(d.base);
  }, [d]);
  const [create, { loading, error }] = useMutation<{ createPullRequest: PullRequest }>(CREATE_PULL_REQUEST, {
    refetchQueries: PR_REFETCH,
    onCompleted: (res) => onCreated?.(res.createPullRequest),
  });

  return (
    <Modal show onHide={onClose} size="lg" centered>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create({ variables: { projectId, worktreeId, title: title.trim(), body, base: base.trim() || null, draft } }).catch(() => undefined);
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h6">Nouvelle pull request{d ? <span className="font-monospace text-secondary"> · {d.branch}</span> : null}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {q.loading && (
            <div>
              <Spinner size="sm" /> Préparation…
            </div>
          )}
          {q.error && <Alert variant="danger">{q.error.message}</Alert>}
          {d?.existing && (
            <Alert variant="info" className="py-2 small">
              Une pull request est déjà ouverte pour cette branche :{' '}
              <a href={d.existing.url} target="_blank" rel="noreferrer">
                #{d.existing.number} {d.existing.title}
              </a>
            </Alert>
          )}
          {d && !d.existing && (
            <>
              <Form.Group className="mb-2">
                <Form.Label className="small mb-1">Titre</Form.Label>
                <Form.Control value={title} onChange={(e) => setTitle(e.target.value)} required />
              </Form.Group>
              <Form.Group className="mb-2">
                <Form.Label className="small mb-1">Description (Markdown)</Form.Label>
                <Form.Control as="textarea" rows={8} value={body} onChange={(e) => setBody(e.target.value)} className="font-monospace small" />
              </Form.Group>
              <div className="d-flex gap-3 align-items-end flex-wrap">
                <Form.Group>
                  <Form.Label className="small mb-1">Base</Form.Label>
                  <Form.Control size="sm" value={base} onChange={(e) => setBase(e.target.value)} className="font-monospace" style={{ width: 200 }} />
                </Form.Group>
                <Form.Check id="pr-draft" label="Brouillon" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              </div>
              <div className="small text-secondary mt-2">
                {d.commits.length} commit{d.commits.length > 1 ? 's' : ''} par rapport à {d.base}
                {d.needsPush ? ' · la branche sera poussée sur GitHub' : ' · les commits non poussés le seront'}.
              </div>
              {d.commits.length === 0 && <Alert variant="warning" className="py-1 small mt-2 mb-0">Aucun commit par rapport à {d.base} : validez et poussez d'abord des modifications.</Alert>}
            </>
          )}
          {error && <Alert variant="danger" className="mt-2 mb-0 py-1 small">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          {d && !d.existing && (
            <Button type="submit" disabled={loading || !title.trim() || d.commits.length === 0}>
              {loading ? 'Création…' : 'Créer la pull request'}
            </Button>
          )}
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
