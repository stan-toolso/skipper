import { useMutation } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Form, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import RequestCard from '../components/RequestCard';
import { TrackedPullRequestChip } from '../components/TrackedPullRequests';
import { prSession } from '../components/DashboardRows';
import { prRef } from '../graphql/pullRequests';
import { useDialogs } from '../components/Dialogs';
import { INBOX, RESUME_SESSION, UPDATE_TASK, type Inbox, type Task } from '../graphql/operations';
import { waitingText } from '../components/TaskBadges';
import { useTaskLauncher } from '../components/TaskLaunchModal';
import { buildInboxItems, filterInboxItems, inboxProjects, type InboxItem, type InboxKind, type SessionReason } from '../lib/inbox';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import './dashboard.css';
import { projectWindowId } from '../lib/projectWindow';

const KIND_LABELS: Record<InboxKind, string> = { request: 'Demandes', session: 'Sessions', task: 'Tâches sans agent', pullRequest: 'Pull requests' };

const REASONS: Record<SessionReason, { icon: string; text: string }> = {
  failed: { icon: 'bi-x-octagon bad', text: 'en erreur' },
  interrupted: { icon: 'bi-pause-circle warn', text: 'interrompue en plein travail par un redémarrage' },
};

/**
 * « À traiter » : tout ce qui attend une action humaine, tous projets confondus — demandes des agents
 * (réponse sur place), sessions en erreur ou interrompues, tâches en cours dont l'agent s'est arrêté sans les terminer
 * (reprendre, relancer ou remettre à faire), pull requests à fusionner. Une session qui attend simplement des
 * instructions n'y figure pas : elle ne demande rien. Triée par urgence puis ancienneté, filtrable par projet et par nature. Le compteur global
 * vit dans la sidebar (query InboxCounts).
 */
export default function InboxPage() {
  useTabTitle('À traiter');
  const { data, loading, error, refetch } = usePollingQuery<{ inbox: Inbox }>(INBOX, { variables: { projectId: projectWindowId }, pollInterval: 5000, fetchPolicy: 'cache-and-network' });
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<InboxKind | ''>('');
  const inbox = data?.inbox;
  const all = useMemo(() => (inbox ? buildInboxItems(inbox) : []), [inbox]);
  const projects = useMemo(() => inboxProjects(all), [all]);
  const items = useMemo(() => filterInboxItems(all, { projectId, kind }), [all, projectId, kind]);
  // Un projet qui n'a plus rien à traiter disparaît du filtre : on retombe sur « tous ».
  const effectiveProject = projects.some((p) => p.id === projectId) ? projectId : '';

  return (
    <>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <h1 className="h3 mb-0">
          À traiter {inbox && inbox.counts.total > 0 && <Badge bg="warning" text="dark" pill>{inbox.counts.total}</Badge>}
        </h1>
        <Button size="sm" variant="outline-secondary" onClick={() => refetch()} title="Rafraîchir" aria-label="Rafraîchir">
          <i className="bi bi-arrow-clockwise" />
        </Button>
      </div>

      <div className="d-flex flex-wrap gap-2 mb-3 inbox-filters">
        <Form.Select size="sm" value={effectiveProject} onChange={(e) => setProjectId(e.target.value)} aria-label="Filtrer par projet">
          <option value="">Tous les projets</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.count})</option>
          ))}
        </Form.Select>
        <Form.Select size="sm" value={kind} onChange={(e) => setKind(e.target.value as InboxKind | '')} aria-label="Filtrer par nature">
          <option value="">Tout</option>
          {(Object.keys(KIND_LABELS) as InboxKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABELS[k]}{inbox ? ` (${countOf(inbox, k)})` : ''}</option>
          ))}
        </Form.Select>
      </div>

      {error && <Alert variant={inbox ? 'warning' : 'danger'} className="py-2 small">{inbox ? 'Dernier rafraîchissement en échec : ' : ''}{error.message}</Alert>}
      {loading && !inbox && <Spinner animation="border" size="sm" />}
      {inbox && items.length === 0 && (
        <p className="text-secondary">{all.length === 0 ? 'Rien à traiter : les agents n’ont besoin de rien pour l’instant.' : 'Rien à traiter pour ce filtre.'}</p>
      )}
      {items.map((item) => (
        <InboxRow key={item.key} item={item} />
      ))}
      {inbox && (kind === '' || kind === 'task') && <WaitingTasks tasks={(inbox.waitingTasks ?? []).filter((t) => !effectiveProject || t.project.id === effectiveProject)} />}
    </>
  );
}

/**
 * Tâches en attente : en cours, sans agent au travail, mais l'agent a dit ce qu'il attendait (réveil daté, étiquette
 * d'état, compte rendu). Rien à faire avant le réveil : listées à part, repliées, hors du compteur. Au réveil, l'agent
 * qui la tenait est reconvoqué (ou elle revient en « Tâches sans agent » pour une personne).
 */
function WaitingTasks({ tasks }: { tasks: Task[] }) {
  const [open, setOpen] = useState(false);
  if (!tasks.length) return null;
  return (
    <div className="inbox-waiting mt-4">
      <button type="button" className="btn btn-link p-0 text-secondary text-decoration-none" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className={`bi bi-chevron-${open ? 'down' : 'right'} me-1`} />
        En attente ({tasks.length}) <span className="small">· pas à traiter : l’agent attend quelque chose, il sera réveillé</span>
      </button>
      {open &&
        tasks.map((task) => (
          <div key={task.id} className="inbox-item">
            <i className="bi bi-hourglass-split icon text-secondary" />
            <div className="main">
              <Link to={task.session ? `/sessions/${task.session.id}` : `/tasks/${task.id}`} className="title" title={task.session ? `Ouvrir la session « ${task.session.name} »` : undefined}>{task.title}</Link>
              <div className="meta">
                {task.project.name} · {waitingText(task)}
                {task.session && <> · <Link to={`/tasks/${task.id}`}>tâche</Link> · {task.session.name}</>}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

const countOf = (inbox: Inbox, kind: InboxKind) =>
  kind === 'request' ? inbox.requests.length : kind === 'session' ? inbox.sessions.length : kind === 'task' ? (inbox.tasks ?? []).length : inbox.pullRequests.length;

function InboxRow({ item }: { item: InboxItem }) {
  if (item.kind === 'request') return <RequestCard request={item.request} showSession />;
  if (item.kind === 'session') return <SessionItem item={item} />;
  if (item.kind === 'task') return <StalledTaskItem item={item} />;
  return <PullRequestItem item={item} />;
}

function SessionItem({ item }: { item: Extract<InboxItem, { kind: 'session' }> }) {
  const { session, reason } = item;
  const { showError } = useDialogs();
  const [resume, { loading: resuming }] = useMutation(RESUME_SESSION, { refetchQueries: ['Inbox', 'InboxCounts'], onError: (err) => void showError(err) });
  const r = REASONS[reason];
  return (
    <div className="inbox-item">
      <i className={`bi ${r.icon} icon`} />
      <div className="main">
        <Link to={`/sessions/${session.id}`} className="title">{session.name}</Link>
        <div className="meta">
          {session.project.name} · {reason === 'failed' && session.error ? session.error.slice(0, 120) : r.text} · {timeAgo(item.at)}
        </div>
      </div>
      <div className="side">
        {reason === 'interrupted' && (
          <Button size="sm" variant="outline-primary" disabled={resuming} onClick={() => void resume({ variables: { id: session.id } })}>
            <i className="bi bi-play-fill" /> {resuming ? 'Reprise…' : 'Reprendre'}
          </Button>
        )}
        <Button as={Link as any} to={`/sessions/${session.id}`} size="sm" variant="outline-secondary">Ouvrir</Button>
      </div>
    </div>
  );
}

/**
 * Tâche « agent arrêté » : « Reprendre » ouvre la modale de la tâche, qui propose de renvoyer un message à sa session
 * (elle repart avec son historique) ou d'en lancer une nouvelle dans le même dossier ; « Remettre à faire » la rend au tableau.
 */
function StalledTaskItem({ item }: { item: Extract<InboxItem, { kind: 'task' }> }) {
  const { task } = item;
  const { showError } = useDialogs();
  const { launchTask } = useTaskLauncher();
  const [updateTask, { loading }] = useMutation(UPDATE_TASK, { refetchQueries: ['Inbox', 'InboxCounts', 'Tasks', 'Sidebar'], onError: (err) => void showError(err) });
  return (
    <div className="inbox-item">
      <i className="bi bi-person-x bad icon" />
      <div className="main">
        <Link to={task.session ? `/sessions/${task.session.id}` : `/tasks/${task.id}`} className="title" title={task.session ? `Ouvrir la session « ${task.session.name} »` : undefined}>{task.title}</Link>
        <div className="meta">
          {task.project.name} · {task.wakeAt && new Date(task.wakeAt) <= new Date() ? `réveil passé (${timeAgo(task.wakeAt)})${task.wakeNote ? ` : ${task.wakeNote.slice(0, 160)}` : ''}` : 'en cours, mais l’agent s’est arrêté sans la terminer'}
          {task.session ? <> · <Link to={`/tasks/${task.id}`}>tâche</Link> · {task.session.name}</> : null}
          {' · '}{timeAgo(item.at)}
        </div>
      </div>
      <div className="side">
        <Button size="sm" variant="outline-primary" onClick={() => launchTask(task, undefined)} title="Renvoyer un message à sa session (elle repart avec son historique) ou relancer une nouvelle session dans le même dossier">
          <i className="bi bi-play-fill" /> Reprendre
        </Button>
        <Button size="sm" variant="outline-secondary" disabled={loading} onClick={() => void updateTask({ variables: { id: task.id, input: { status: 'TODO' } } })}>
          <i className="bi bi-arrow-counterclockwise" /> Remettre à faire
        </Button>
      </div>
    </div>
  );
}

function PullRequestItem({ item }: { item: Extract<InboxItem, { kind: 'pullRequest' }> }) {
  const { pr } = item;
  const session = prSession(pr);
  return (
    <div className="inbox-item">
      <i className="bi bi-git icon" />
      <div className="main">
        {session ? (
          <Link to={`/sessions/${session.id}`} className="title" title={`Ouvrir la session « ${session.name} »`}>{pr.title}</Link>
        ) : (
          <a href={pr.url} target="_blank" rel="noreferrer" className="title" title="Ouvrir sur la forge">{pr.title}</a>
        )}
        <div className="meta">
          {pr.project.name}
          {session && <> · <a href={pr.url} target="_blank" rel="noreferrer" title="Ouvrir sur la forge">{prRef(pr)}</a> · {session.name}</>}
          {pr.task && <> · <Link to={`/tasks/${pr.task.id}`}>{pr.task.title}</Link></>}
          {' · '}{timeAgo(pr.openedAt)}
        </div>
      </div>
      <div className="side">
        {/* La puce ouvre la fenêtre de la PR : relecture, checks et fusion. */}
        <TrackedPullRequestChip projectId={pr.project.id} pr={pr} />
      </div>
    </div>
  );
}
