import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal, Table } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import {
  canResolveConflicts,
  DELETE_PULL_REQUEST,
  localWorkText,
  prRef,
  REGISTER_PULL_REQUEST,
  RESOLVE_PULL_REQUEST_CONFLICTS,
  STAGE_LABELS,
  TRACKED_PR_REFETCH,
  UPDATE_PULL_REQUEST,
  type PullRequestStage,
  type TrackedPullRequest,
  type TrackedPullRequestSummary,
} from '../graphql/pullRequests';
import { timeAgo } from '../lib/humanize';
import { useDialogs } from './Dialogs';
import PopMenu, { type MenuItem } from './PopMenu';
import { CreatePullRequestModal, PullRequestIndicators, PullRequestModal, type PullRequestRelated } from './PullRequests';

/**
 * Pull requests suivies : pastille d'étape, puce compacte (cartes et grilles de tâches), tableau avec actions
 * (détail et fusion via la fenêtre GitHub, déploiement, statut, note, tâche, arrêt du suivi) et fenêtre « Suivre
 * une pull request ». Une PR « en préparation » (branche avec des modifications, pas encore ouverte) propose de la
 * créer (fenêtre de création du panneau git). La PR GitHub en direct (checks, revues, fusion) reste `PullRequestModal`,
 * qui reçoit le dépôt quand la PR n'est pas dans celui du projet.
 */

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export function PullRequestStageBadge({ stage, className = '' }: { stage: PullRequestStage; className?: string }) {
  const s = STAGE_LABELS[stage];
  return (
    <span className={`pr-stage ${s.cls} ${className}`} title={s.hint}>
      <i className={`bi ${s.icon} me-1`} />
      {s.label}
    </span>
  );
}

/** Indicateurs GitHub (checks, conflits, revue) d'une PR suivie, à partir de son instantané ; travail local d'une PR en préparation. */
export function TrackedPullRequestIndicators({ pr }: { pr: TrackedPullRequestSummary }) {
  if (pr.status === 'PENDING') {
    const work = localWorkText(pr);
    return work ? <span className="small text-secondary">{work}</span> : null;
  }
  if (pr.status !== 'OPEN') return null;
  return <PullRequestIndicators pr={{ number: pr.number ?? 0, title: pr.title, url: pr.url, state: 'OPEN', isDraft: pr.isDraft, mergeable: pr.mergeable ?? 'UNKNOWN', reviewDecision: pr.reviewDecision, checksState: pr.checksState, headRefName: '', baseRefName: '' }} showState={false} />;
}

/** Fenêtre à ouvrir pour une PR suivie : son détail GitHub, ou sa création quand elle est en préparation. */
type Window = { kind: 'github'; number: number; repo: string | null } | { kind: 'create'; worksessionId: string };

/** La fenêtre qui convient à une PR suivie : création pour une PR en préparation (dossier de travail connu), détail GitHub sinon. */
export function windowFor(pr: TrackedPullRequestSummary): Window | null {
  if (pr.number == null) return pr.worksession ? { kind: 'create', worksessionId: pr.worksession.id } : null;
  return { kind: 'github', number: pr.number, repo: pr.foreignRepo ? pr.repo : null };
}

/**
 * Rend la fenêtre demandée (détail GitHub ou création) ; après une création, enchaîne sur le détail de la PR ouverte.
 * `full` (la PR suivie complète, quand on l'a) ajoute à la fenêtre GitHub les liens reliés et « Résoudre les conflits ».
 */
export function PullRequestWindow({ projectId, window, full, onClose }: { projectId: string; window: Window; full?: TrackedPullRequest; onClose: () => void }) {
  const [created, setCreated] = useState<number | null>(null);
  const resolver = useConflictResolver(full ?? null);
  const related = full ? relatedOf(full) : undefined;
  if (window.kind === 'github') return <PullRequestModal projectId={projectId} number={window.number} repo={window.repo} onClose={onClose} onResolveConflicts={resolver} related={related} />;
  if (created != null) return <PullRequestModal projectId={projectId} number={created} onClose={onClose} related={related} />;
  return <CreatePullRequestModal projectId={projectId} worksessionId={window.worksessionId} onClose={onClose} onCreated={(pr) => setCreated(pr.number)} />;
}

/** Puce compacte d'une PR suivie (grille, carte, fiche de tâche) : référence, étape, indicateurs ; ouvre la fenêtre qui convient. */
export function TrackedPullRequestChip({ projectId, pr, showTitle = false }: { projectId: string; pr: TrackedPullRequestSummary; showTitle?: boolean }) {
  const [open, setOpen] = useState(false);
  const target = windowFor(pr);
  return (
    <>
      <button
        type="button"
        className="btn btn-link btn-sm p-0 text-decoration-none small d-inline-flex align-items-center gap-1 text-reset"
        title={pr.number == null ? `En préparation sur ${pr.headBranch} : ${pr.title}${target ? ' (créer la pull request)' : ''}` : `Pull request ${prRef(pr)} : ${pr.title} (${STAGE_LABELS[pr.stage].label})`}
        disabled={!target}
        onClick={() => setOpen(true)}
      >
        <span className="text-secondary">{pr.number == null ? <i className="bi bi-code-slash" /> : prRef(pr)}</span>
        <PullRequestStageBadge stage={pr.stage} />
        <TrackedPullRequestIndicators pr={pr} />
        {showTitle && <span className="text-truncate">{pr.title}</span>}
      </button>
      {open && target && <PullRequestWindow projectId={projectId} window={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Actions d'une PR suivie (menu « ⋮ ») : les mutations avec leurs confirmations et saisies. */
export function useTrackedPullRequestActions() {
  const { confirm, prompt, showError } = useDialogs();
  const navigate = useNavigate();
  const [update] = useMutation(UPDATE_PULL_REQUEST, { refetchQueries: TRACKED_PR_REFETCH });
  const [remove] = useMutation(DELETE_PULL_REQUEST, { refetchQueries: TRACKED_PR_REFETCH });
  const [resolveConflicts] = useMutation<{ resolvePullRequestConflicts: { id: string; name: string } }>(RESOLVE_PULL_REQUEST_CONFLICTS, { refetchQueries: TRACKED_PR_REFETCH });
  const run = (p: Promise<unknown>) => p.catch((err) => void showError(err));

  return {
    /** Demande à la session rattachée de résoudre les conflits avec la base (la session est relancée si elle était terminée). */
    resolveConflicts: async (pr: TrackedPullRequest) => {
      if (!pr.session) return;
      const answer = await confirm({
        title: `Résoudre les conflits de #${pr.number}`,
        message: `Demander à la session « ${pr.session.name} » de résoudre les conflits de « ${pr.title} » avec ${pr.baseBranch || 'la base'} ? L'instruction lui est envoyée ; si elle est terminée, elle est relancée.`,
        confirmLabel: 'Envoyer la demande',
        checkbox: { label: 'Ouvrir la session', defaultChecked: true },
      });
      if (!answer) return;
      await run(
        resolveConflicts({ variables: { id: pr.id } }).then((res) => {
          const session = res.data?.resolvePullRequestConflicts;
          if (answer.checked && session) navigate(`/sessions/${session.id}`);
        }),
      );
    },
    markDeployed: async (pr: TrackedPullRequest) => {
      const note = await prompt({ title: `Marquer ${prRef(pr)} comme déployée`, message: 'Où et comment a-t-elle été mise en production ? (facultatif)', placeholder: 'ex. skipper-1, 30/10 18:40', required: false });
      if (note === null) return;
      await run(update({ variables: { id: pr.id, input: { deployed: true, deployNote: note } } }));
    },
    undeploy: (pr: TrackedPullRequest) => run(update({ variables: { id: pr.id, input: { deployed: false } } })),
    setStatus: async (pr: TrackedPullRequest, status: 'OPEN' | 'MERGED' | 'CLOSED') => {
      const labels = { OPEN: 'rouvrir', MERGED: 'marquer comme fusionnée', CLOSED: 'marquer comme annulée (fermée sans fusion)' };
      if (!(await confirm({ title: `Pull request ${prRef(pr)}`, message: `Voulez-vous ${labels[status]} le suivi de « ${pr.title} » ? La PR sur GitHub n'est pas modifiée.`, confirmLabel: 'Oui' }))) return;
      await run(update({ variables: { id: pr.id, input: { status } } }));
    },
    editNote: async (pr: TrackedPullRequest) => {
      const note = await prompt({ title: `Note de suivi de ${prRef(pr)}`, defaultValue: pr.note, placeholder: 'ex. attend la CI, revue demandée à…', required: false });
      if (note === null) return;
      await run(update({ variables: { id: pr.id, input: { note } } }));
    },
    detachTask: (pr: TrackedPullRequest) => run(update({ variables: { id: pr.id, input: { taskId: null } } })),
    untrack: async (pr: TrackedPullRequest) => {
      if (!(await confirm({ title: 'Ne plus suivre', message: `Retirer « ${prRef(pr)} ${pr.title} » du suivi ? La PR GitHub n'est pas touchée ; on peut la suivre de nouveau plus tard.`, confirmLabel: 'Ne plus suivre', danger: true }))) return;
      await run(remove({ variables: { id: pr.id } }));
    },
  };
}

function ActionsMenu({ pr, onOpen }: { pr: TrackedPullRequest; onOpen: () => void }) {
  const actions = useTrackedPullRequestActions();
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const pending = pr.status === 'PENDING';
  const items: MenuItem[] = [];
  if (pending) {
    if (pr.worksession) items.push({ label: 'Créer la pull request', icon: 'bi-git', onClick: onOpen });
    if (pr.session) items.push({ label: `Session : ${pr.session.name}`, icon: 'bi-terminal', to: `/sessions/${pr.session.id}` });
    items.push({ label: 'Modifier la note', icon: 'bi-pencil', onClick: () => void actions.editNote(pr) });
    if (pr.task) items.push({ label: 'Détacher de la tâche', icon: 'bi-link-45deg', onClick: () => void actions.detachTask(pr) });
  } else {
    items.push({ label: 'Détail et fusion', icon: 'bi-git', onClick: onOpen });
    items.push({ label: 'Ouvrir sur GitHub', icon: 'bi-box-arrow-up-right', onClick: () => window.open(pr.url, '_blank', 'noopener') });
    items.push({ label: 'Modifier la note', icon: 'bi-pencil', onClick: () => void actions.editNote(pr) });
    if (pr.status === 'MERGED' && !pr.deployedAt) items.push({ label: 'Marquer comme déployée', icon: 'bi-box-arrow-up', onClick: () => void actions.markDeployed(pr) });
    if (pr.deployedAt) items.push({ label: 'Annuler le déploiement', icon: 'bi-arrow-counterclockwise', onClick: () => void actions.undeploy(pr) });
    if (pr.status === 'OPEN') {
      items.push({ label: 'Marquer comme fusionnée', icon: 'bi-check2-circle', onClick: () => void actions.setStatus(pr, 'MERGED') });
      items.push({ label: 'Marquer comme annulée', icon: 'bi-x-circle', onClick: () => void actions.setStatus(pr, 'CLOSED') });
    } else {
      items.push({ label: 'Rouvrir le suivi', icon: 'bi-arrow-repeat', onClick: () => void actions.setStatus(pr, 'OPEN') });
    }
    if (pr.task) items.push({ label: 'Détacher de la tâche', icon: 'bi-link-45deg', onClick: () => void actions.detachTask(pr) });
    items.push({ label: 'Ne plus suivre', icon: 'bi-trash', danger: true, onClick: () => void actions.untrack(pr) });
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary py-0 px-1"
        title="Actions"
        aria-label={`Actions sur la pull request ${prRef(pr)}`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 2, right: window.innerWidth - r.right });
        }}
      >
        <i className="bi bi-three-dots" />
      </button>
      {at && <PopMenu items={items} onClose={() => setAt(null)} at={at} />}
    </>
  );
}

/** Bouton « Résoudre les conflits » : visible quand GitHub signale des conflits et qu'une session est rattachée à la PR. */
export function ResolveConflictsButton({ pr, className = '' }: { pr: TrackedPullRequest; className?: string }) {
  const actions = useTrackedPullRequestActions();
  if (!canResolveConflicts(pr) || !pr.session) return null;
  return (
    <Button size="sm" variant="outline-danger" className={`py-0 ${className}`} title={`Demander à la session « ${pr.session.name} » de résoudre les conflits avec ${pr.baseBranch}`} onClick={() => void actions.resolveConflicts(pr)}>
      <i className="bi bi-robot me-1" />
      Résoudre les conflits
    </Button>
  );
}

/** Tâche et sessions reliées à une PR suivie, pour les liens de la fenêtre GitHub (session rattachée, puis celle qui l'a ouverte). */
const relatedOf = (pr: TrackedPullRequest): PullRequestRelated => ({
  tasks: pr.task ? [pr.task] : [],
  sessions: [pr.session, pr.createdBySession].filter((x): x is { id: string; name: string } => x != null),
});

/** Ce que la fenêtre GitHub d'une PR suivie sait faire de plus : demander la résolution des conflits à la session rattachée. */
function useConflictResolver(pr: TrackedPullRequest | null) {
  const actions = useTrackedPullRequestActions();
  return pr && canResolveConflicts(pr) && pr.session ? { sessionName: pr.session.name, run: () => void actions.resolveConflicts(pr) } : undefined;
}

/**
 * Barre d'actions d'une PR suivie (fiche de tâche) : détail et fusion (fenêtre GitHub) ou création (PR en
 * préparation), résolution des conflits, déploiement, puis le menu des autres actions. Sans droit d'écriture, seul
 * le détail reste.
 */
export function TrackedPullRequestActions({ pr, canWrite }: { pr: TrackedPullRequest; canWrite: boolean }) {
  const actions = useTrackedPullRequestActions();
  const [open, setOpen] = useState(false);
  const target = windowFor(pr);
  const pending = pr.status === 'PENDING';
  if (pending && !canWrite) return null;
  return (
    <div className="d-flex align-items-center gap-2 flex-wrap">
      {target && (
        <Button size="sm" variant={pending ? 'primary' : 'outline-secondary'} className="py-0" onClick={() => setOpen(true)}>
          <i className="bi bi-git me-1" />
          {pending ? 'Créer la pull request' : pr.status === 'OPEN' && canWrite ? 'Détail et fusion' : 'Détail'}
        </Button>
      )}
      {canWrite && <ResolveConflictsButton pr={pr} />}
      {canWrite && pr.status === 'MERGED' && !pr.deployedAt && (
        <Button size="sm" variant="outline-success" className="py-0" onClick={() => void actions.markDeployed(pr)}>
          <i className="bi bi-box-arrow-up me-1" />
          Marquer comme déployée
        </Button>
      )}
      {canWrite && <ActionsMenu pr={pr} onOpen={() => setOpen(true)} />}
      {open && target && <PullRequestWindow projectId={pr.project.id} window={target} full={canWrite ? pr : undefined} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Qui a ouvert ou déployé : personne, session d'agent (lien) ou synchronisation. */
function By({ type, user, session, pending = false }: { type: string | null; user: { id: string; name: string } | null; session: { id: string; name: string } | null; pending?: boolean }) {
  if (session) return <Link to={`/sessions/${session.id}`} title="Session d'agent">{session.name}</Link>;
  if (user) return <>{user.name}</>;
  if (type === 'system') return <span className="text-secondary">{pending ? 'branche' : 'GitHub'}</span>;
  return <span className="text-secondary">—</span>;
}

/**
 * Tableau des PR suivies. `showProject` (vue multi-projets), `showTask` (hors fiche de tâche). Chaque ligne ouvre la
 * fenêtre GitHub (checks, revues, fusion avec nettoyage), ou la création pour une PR en préparation ; le menu porte
 * les actions de suivi. Sur mobile (règles `.pr-table` de workbench.css), chaque ligne devient une carte : titre,
 * puis étape, date et menu sur une ligne.
 */
export function TrackedPullRequestTable({ prs, showProject = false, showTask = true, compact = false }: { prs: TrackedPullRequest[]; showProject?: boolean; showTask?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState<{ pr: TrackedPullRequest; window: Window } | null>(null);
  if (prs.length === 0) return null;
  const openFor = (pr: TrackedPullRequest) => {
    const window = windowFor(pr);
    if (window) setOpen({ pr, window });
  };
  return (
    <>
      <Table size="sm" hover responsive className={`mb-0 pr-table${compact ? ' pr-table-compact' : ''}`}>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Étape</th>
            {showProject && <th className="d-none d-lg-table-cell">Projet</th>}
            {showTask && <th className="d-none d-md-table-cell">Tâche</th>}
            {!compact && <th className="d-none d-lg-table-cell">Branche</th>}
            {!compact && <th className="d-none d-lg-table-cell">Par</th>}
            <th>Quand</th>
            <th className="text-end"> </th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => {
            const pending = pr.status === 'PENDING';
            const when = pending
              ? { label: 'depuis', at: pr.openedAt }
              : pr.stage === 'DEPLOYED' && pr.deployedAt
                ? { label: 'déployée', at: pr.deployedAt }
                : pr.mergedAt
                  ? { label: 'fusionnée', at: pr.mergedAt }
                  : pr.closedAt
                    ? { label: 'fermée', at: pr.closedAt }
                    : { label: 'ouverte', at: pr.openedAt };
            const clickable = Boolean(windowFor(pr));
            return (
              <tr key={pr.id} className={clickable ? 'pr-row' : undefined} onClick={() => openFor(pr)} role={clickable ? 'button' : undefined}>
                <td className="pr-cell-title">
                  {pr.number != null && <span className="text-secondary me-1">{prRef(pr)}</span>}
                  {pending && <i className="bi bi-code-slash text-secondary me-1" title="Pas encore ouverte sur GitHub" />}
                  <span className="fw-semibold">{pr.title}</span>
                  {!pending && <TrackedPullRequestIndicators pr={pr} />}
                  {pr.note && (
                    <div className="small text-secondary text-truncate" title={pr.note}>
                      <i className="bi bi-sticky me-1" />
                      {pr.note}
                    </div>
                  )}
                  {showTask && pr.task && (
                    <div className="small text-truncate d-md-none">
                      <i className="bi bi-check2-square me-1 text-secondary" />
                      <Link to={`/tasks/${pr.task.id}`} title={pr.task.title} onClick={(e) => e.stopPropagation()}>
                        {pr.task.title}
                      </Link>
                    </div>
                  )}
                </td>
                <td className="pr-cell-stage">
                  <PullRequestStageBadge stage={pr.stage} />
                  {pending && <div className="small text-secondary text-truncate">{localWorkText(pr) || 'modifications sur la branche'}</div>}
                  {pr.deployNote && pr.stage === 'DEPLOYED' && (
                    <div className="small text-secondary text-truncate" title={pr.deployNote}>
                      {pr.deployNote}
                    </div>
                  )}
                </td>
                {showProject && (
                  <td className="d-none d-lg-table-cell">
                    <Link to={`/projects/${pr.project.id}/pull-requests`} onClick={(e) => e.stopPropagation()}>
                      {pr.project.name}
                    </Link>
                  </td>
                )}
                {showTask && (
                  <td className="d-none d-md-table-cell">
                    {pr.task ? (
                      <Link to={`/tasks/${pr.task.id}`} className="text-truncate d-inline-block" style={{ maxWidth: 220 }} title={pr.task.title} onClick={(e) => e.stopPropagation()}>
                        {pr.task.title}
                      </Link>
                    ) : (
                      <span className="text-secondary">—</span>
                    )}
                  </td>
                )}
                {!compact && (
                  <td className="d-none d-lg-table-cell font-monospace small">
                    {pr.headBranch}
                    {pr.baseBranch && <span className="text-secondary"> → {pr.baseBranch}</span>}
                  </td>
                )}
                {!compact && (
                  <td className="d-none d-lg-table-cell small" onClick={(e) => e.stopPropagation()}>
                    <By type={pr.createdByType} user={pr.createdBy} session={pr.createdBySession} pending={pending} />
                  </td>
                )}
                <td className="pr-cell-when small text-secondary" title={fmt(when.at)}>
                  {when.label} {timeAgo(when.at)}
                  {pr.stage === 'DEPLOYED' && (pr.deployedBy || pr.deployedBySession) && (
                    <>
                      {' par '}
                      <By type={pr.deployedByType} user={pr.deployedBy} session={pr.deployedBySession} />
                    </>
                  )}
                </td>
                <td className="pr-cell-actions text-end text-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ActionsMenu pr={pr} onOpen={() => openFor(pr)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {open && <PullRequestWindow projectId={open.pr.project.id} window={open.window} full={open.pr} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Suivre une PR GitHub déjà ouverte : URL (dépôt du projet ou autre dépôt) ou numéro, tâche reliée (facultative), note. */
export function RegisterPullRequestModal({ projectId, taskId = null, onClose }: { projectId: string; taskId?: string | null; onClose: () => void }) {
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [register, { loading, error }] = useMutation(REGISTER_PULL_REQUEST, { refetchQueries: TRACKED_PR_REFETCH, onCompleted: onClose });
  const submit = () => {
    const t = ref.trim();
    if (!t) return;
    const number = /^#?\d+$/.test(t) ? Number(t.replace('#', '')) : null;
    void register({ variables: { projectId, url: number == null ? t : null, number, taskId, note: note.trim() || null } }).catch(() => undefined);
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h6">Suivre une pull request</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">Une pull request déjà ouverte sur GitHub (par un agent, en ligne de commande ou par quelqu'un d'autre), dans le dépôt du projet ou dans un autre dépôt. Ses détails sont lus avec votre compte GitHub.</p>
          <Form.Group className="mb-2">
            <Form.Label className="small mb-1">URL ou numéro</Form.Label>
            <Form.Control value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://github.com/owner/repo/pull/42 ou 42" required autoFocus />
            <Form.Text className="text-secondary">Un numéro seul désigne une PR du dépôt du projet ; l'URL permet n'importe quel dépôt GitHub.</Form.Text>
          </Form.Group>
          <Form.Group>
            <Form.Label className="small mb-1">Note de suivi (facultative)</Form.Label>
            <Form.Control value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex. attend la CI, à relire par…" />
          </Form.Group>
          {!taskId && <div className="small text-secondary mt-2">Sans tâche désignée, la PR est reliée à la tâche traitée sur sa branche, s'il y en a une.</div>}
          {error && <Alert variant="danger" className="mt-2 mb-0 py-1 small">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !ref.trim()}>
            {loading ? 'Lecture…' : 'Suivre'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
