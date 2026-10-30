import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Col, Row, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import { PullRequestChip } from '../components/PullRequests';
import { RegisterPullRequestModal, TrackedPullRequestActions, TrackedPullRequestIndicators, PullRequestStageBadge } from '../components/TrackedPullRequests';
import { prRef, PULL_REQUESTS, type TrackedPullRequest } from '../graphql/pullRequests';
import StatusBadge from '../components/StatusBadge';
import TaskActions from '../components/TaskActions';
import { isOverdue, Linkified, TaskPriorityBadge, TaskStatusBadge, TaskTags } from '../components/TaskBadges';
import TaskThread from '../components/TaskThread';
import type { LaunchTarget } from '../components/TaskLaunchModal';
import TaskModal from '../components/TaskModal';
import { TASK_LAUNCH_TARGETS, type SessionActivity, type SessionStatus, type Task } from '../graphql/operations';
import { TASK_PAGE } from '../graphql/tasks';
import { formatCost, timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';

interface TaskSession {
  id: string;
  name: string;
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  pendingRequestCount: number;
  archivedAt: string | null;
  costUsd: number;
  startedAt: string | null;
  endedAt: string | null;
  owner: { id: string; name: string } | null;
  worksession: { id: string; branch: string } | null;
}

type TaskWithSessions = Task & { sessions: TaskSession[] };

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Une personne d'une tâche : nom (ou e-mail) et lien mailto. */
function Person({ p }: { p: Task['assignee'] }) {
  if (!p) return <span className="text-secondary">—</span>;
  return (
    <>
      {p.name ?? p.email}
      {p.email && (
        <>
          {' '}
          <a href={`mailto:${p.email}`} className="text-secondary" title={p.email}>
            <i className="bi bi-envelope" />
          </a>
        </>
      )}
    </>
  );
}

/**
 * Page d'une tâche dans son propre onglet, à la manière d'un canal de discussion : à gauche la conversation (la
 * description ouvre le fil, puis les messages avec leurs réponses, réactions et mentions, et la saisie en bas), puis
 * les sessions passées par la tâche ; à droite ce qui la décrit (personnes, dates, étiquettes, champs) et son code.
 */
export default function TaskPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = usePollingQuery<{ task: TaskWithSessions | null }>(TASK_PAGE, { variables: { id }, pollInterval: 5000 });
  const { data: targetsData } = useQuery<{ projects: LaunchTarget[] }>(TASK_LAUNCH_TARGETS);
  const [editing, setEditing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const task = data?.task;
  // PR suivies de la tâche, avec tout leur détail (auteur, dates) : les actions en ont besoin.
  const { data: prData } = usePollingQuery<{ pullRequests: TrackedPullRequest[] }>(PULL_REQUESTS, { variables: { taskId: id, limit: 50 }, pollInterval: 15_000 });
  const trackedPrs = prData?.pullRequests ?? [];
  useTabTitle(task?.title ?? null);
  const current = task?.sessions.find((s) => s.id === task.session?.id);
  useGitTarget(task && task.session?.worksession ? { projectId: task.project.id, worksessionId: task.session.worksession.id, label: `${task.project.name} · ${task.session.worksession.branch}` } : null);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!task) return <Alert variant="warning">Tâche introuvable (supprimée, ou dans un projet auquel vous n'avez pas accès).</Alert>;
  const target = targetsData?.projects.find((p) => p.id === task.project.id);
  const overdue = isOverdue(task);
  const canWrite = target ? target.myRole !== 'VIEWER' : false;
  // Le fil s'écrit sauf pour un lecteur ; tant que le rôle n'est pas connu, la saisie est montrée (le serveur tranche).
  const canPost = !target || target.myRole !== 'VIEWER';
  const openedBy = task.createdBySession?.name ?? task.reporter?.name ?? task.reporter?.email ?? (task.createdByType === 'agent' ? 'Un agent' : 'Quelqu’un');

  return (
    <>
      <Link to={`/projects/${task.project.id}/tasks`} className="small">
        ← Tâches · {task.project.name}
      </Link>
      <div className="d-flex align-items-start justify-content-between gap-3 flex-wrap">
        <div>
          <h1 className="h3 mb-1">
            {task.title} <TaskStatusBadge status={task.status} statusTag={task.statusTag} /> <TaskPriorityBadge priority={task.priority} />
          </h1>
          <div className="small text-secondary">
            <Link to={`/projects/${task.project.id}`}>{task.project.name}</Link>
            {task.tags.length > 0 && (
              <>
                {' · '}
                <TaskTags tags={task.tags} />
              </>
            )}
            {' · '}
            {task.commentCount} message{task.commentCount > 1 ? 's' : ''}
            {task.dueDate && <span className={overdue ? ' text-danger' : ''}>{overdue ? ' · en retard depuis le ' : ' · pour le '}{new Date(task.dueDate).toLocaleDateString()}</span>}
            {task.completedAt && ` · terminée le ${fmt(task.completedAt)}`}
          </div>
        </div>
        <TaskActions task={task} target={target} onEdit={() => setEditing(true)} onDeleted={() => navigate(`/projects/${task.project.id}/tasks`)} />
      </div>

      <Row className="g-3 mt-1">
        <Col lg={8}>
          <Card className="task-conversation">
            <Card.Header className="d-flex align-items-center justify-content-between">
              <span>
                <i className="bi bi-chat-left-text me-2 text-secondary" />
                Conversation
              </span>
              <span className="small text-secondary">Les sessions reliées à la tâche reçoivent chaque message</span>
            </Card.Header>
            <Card.Body>
              <TaskThread
                taskId={task.id}
                canWrite={canPost}
                opening={{
                  authorName: openedBy,
                  byAgent: task.createdByType === 'agent',
                  sessionId: task.createdBySession?.id ?? null,
                  createdAt: task.createdAt,
                  body: task.description ? <Linkified text={task.description} /> : <span className="text-secondary fst-italic">Pas de description.</span>,
                  attachments: task.attachments,
                }}
              />
            </Card.Body>
          </Card>
          <Card className="mt-3">
            <Card.Header>Sessions ({task.sessions.length})</Card.Header>
            <Card.Body className="small p-0">
              {task.sessions.length === 0 ? (
                <div className="p-3 text-secondary fst-italic">Aucune session n'a encore travaillé sur cette tâche. « Confier à un agent » en lance une.</div>
              ) : (
                <Table size="sm" hover responsive className="mb-0">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>État</th>
                      <th className="d-none d-md-table-cell">Branche</th>
                      <th className="d-none d-md-table-cell">Par</th>
                      <th className="d-none d-md-table-cell">Démarrée</th>
                      <th className="text-end">Coût</th>
                    </tr>
                  </thead>
                  <tbody>
                    {task.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link to={`/sessions/${s.id}`}>{s.name}</Link>
                          {s.id === task.session?.id && <Badge bg="primary" className="ms-2">en charge</Badge>}
                          {s.id === task.createdBySession?.id && <Badge bg="secondary" className="ms-2">l'a créée</Badge>}
                          {s.archivedAt && <Badge bg="secondary" className="ms-2">archivée</Badge>}
                          <span className="text-secondary ms-2">{s.provider}</span>
                        </td>
                        <td>
                          <StatusBadge status={s.status} />
                          {s.pendingRequestCount > 0 && <Badge bg="warning" text="dark" className="ms-1">{s.pendingRequestCount}</Badge>}
                        </td>
                        <td className="d-none d-md-table-cell font-monospace">{s.worksession ? <Link to={`/sessions/${s.id}/files`} title="Fichiers de la session">{s.worksession.branch}</Link> : <span className="text-secondary">dossier principal</span>}</td>
                        <td className="d-none d-md-table-cell">{s.owner?.name ?? <span className="text-secondary">—</span>}</td>
                        <td className="d-none d-md-table-cell" title={s.startedAt ? fmt(s.startedAt) : ''}>
                          {s.startedAt ? timeAgo(s.startedAt) : '—'}
                          {s.endedAt && <span className="text-secondary"> · fin {timeAgo(s.endedAt)}</span>}
                        </td>
                        <td className="text-end">{formatCost(s.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card.Body>
          </Card>
        </Col>
        <Col lg={4}>
          <Card className="task-page-about">
            <Card.Header>À propos</Card.Header>
            <Card.Body className="small">
              <dl className="row mb-0">
                <dt className="col-4">Responsable</dt>
                <dd className="col-8">
                  <Person p={task.assignee} />
                </dd>
                <dt className="col-4">Rapporteur</dt>
                <dd className="col-8">
                  <Person p={task.reporter} />
                </dd>
                <dt className="col-4">Créée</dt>
                <dd className="col-8">
                  {fmt(task.createdAt)}
                  {task.createdBySession ? (
                    <>
                      {' par '}
                      <Link to={`/sessions/${task.createdBySession.id}`}>{task.createdBySession.name}</Link>
                    </>
                  ) : task.createdByType === 'agent' ? (
                    ' par un agent'
                  ) : (
                    " depuis l'interface"
                  )}
                </dd>
                {task.dueDate && (
                  <>
                    <dt className="col-4">Échéance</dt>
                    <dd className={`col-8${overdue ? ' text-danger' : ''}`}>{new Date(task.dueDate).toLocaleDateString()}{overdue && ' (en retard)'}</dd>
                  </>
                )}
                {task.completedAt && (
                  <>
                    <dt className="col-4">Terminée</dt>
                    <dd className="col-8">{fmt(task.completedAt)}</dd>
                  </>
                )}
                {task.tags.length > 0 && (
                  <>
                    <dt className="col-4">Étiquettes</dt>
                    <dd className="col-8">
                      <TaskTags tags={task.tags} />
                    </dd>
                  </>
                )}
                {task.customFields.map((f) => (
                  <div key={f.key} className="row mx-0 px-0">
                    <dt className="col-4 text-truncate" title={f.key}>
                      {f.key}
                    </dt>
                    <dd className="col-8 mb-1" style={{ overflowWrap: 'anywhere' }}>
                      {f.value ? <Linkified text={f.value} /> : '—'}
                    </dd>
                  </div>
                ))}
              </dl>
              {canWrite && (
                <Button size="sm" variant="link" className="p-0 mt-2 small" onClick={() => setEditing(true)}>
                  <i className="bi bi-pencil me-1" />
                  Modifier la tâche
                </Button>
              )}
            </Card.Body>
          </Card>
          {(task.branch || task.pullRequest || task.worksession || current?.worksession || trackedPrs.length > 0 || canWrite) && (
            <Card className="mt-3">
              <Card.Header className="d-flex align-items-center justify-content-between">
                <span>Code</span>
                {canWrite && (
                  <Button size="sm" variant="link" className="p-0 small" title="Suivre une pull request déjà ouverte pour cette tâche" onClick={() => setRegistering(true)}>
                    <i className="bi bi-git me-1" />
                    Suivre une PR
                  </Button>
                )}
              </Card.Header>
              <Card.Body className="small">
                {(() => {
                  const branch = task.worksession?.branch ?? current?.worksession?.branch ?? task.branch;
                  const alive = Boolean(task.worksession && !task.worksession.archivedAt);
                  return branch ? (
                    <div className="font-monospace" title="Branche de la tâche : ses sessions y travaillent toutes">
                      <i className="bi bi-git me-1" />
                      {current && current.worksession && alive ? <Link to={`/sessions/${current.id}/files`} title="Fichiers de la session en charge">{branch}</Link> : branch}
                      {!task.worksession && <span className="text-secondary"> (dossier de travail supprimé)</span>}
                    </div>
                  ) : null;
                })()}
                {trackedPrs.length > 0 ? (
                  <div className="mt-2 d-flex flex-column gap-2">
                    {trackedPrs.map((pr) => (
                      <div key={pr.id} className="tracked-pr-item border rounded p-2">
                        <div className="d-flex align-items-center gap-2 flex-wrap">
                          {pr.number != null ? (
                            <a href={pr.url} target="_blank" rel="noreferrer" className="text-reset text-decoration-none fw-semibold" title="Ouvrir sur GitHub">
                              <span className="text-secondary">{prRef(pr)}</span> {pr.title}
                            </a>
                          ) : (
                            <span className="fw-semibold" title="Pas encore ouverte sur GitHub">
                              <i className="bi bi-code-slash text-secondary me-1" />
                              {pr.title}
                            </span>
                          )}
                          <PullRequestStageBadge stage={pr.stage} />
                          <TrackedPullRequestIndicators pr={pr} />
                        </div>
                        <div className="text-secondary mt-1">
                          <span className="font-monospace">{pr.headBranch}</span>
                          {pr.createdBySession && (
                            <>
                              {' · par '}
                              <Link to={`/sessions/${pr.createdBySession.id}`}>{pr.createdBySession.name}</Link>
                            </>
                          )}
                          {pr.createdBy && ` · par ${pr.createdBy.name}`}
                          {pr.status === 'PENDING' ? ` · en préparation depuis ${timeAgo(pr.openedAt)}` : ` · ouverte ${timeAgo(pr.openedAt)}`}
                          {pr.mergedAt && ` · fusionnée ${timeAgo(pr.mergedAt)}`}
                          {pr.deployedAt && ` · déployée ${timeAgo(pr.deployedAt)}${pr.deployNote ? ` (${pr.deployNote})` : ''}`}
                        </div>
                        {pr.note && (
                          <div className="text-secondary" title="Note de suivi">
                            <i className="bi bi-sticky me-1" />
                            {pr.note}
                          </div>
                        )}
                        <div className="mt-2">
                          <TrackedPullRequestActions pr={pr} canWrite={canWrite} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : task.pullRequest ? (
                  <div className="mt-1">
                    <PullRequestChip projectId={task.project.id} pr={task.pullRequest} /> {task.pullRequest.title}
                    <span className="text-secondary"> (non suivie)</span>
                  </div>
                ) : (
                  <div className="text-secondary fst-italic mt-1">Aucune pull request suivie.</div>
                )}
              </Card.Body>
            </Card>
          )}
        </Col>
      </Row>
      {editing && <TaskModal task={task} projectId={task.project.id} onClose={() => setEditing(false)} />}
      {registering && <RegisterPullRequestModal projectId={task.project.id} taskId={task.id} onClose={() => setRegistering(false)} />}
    </>
  );
}
