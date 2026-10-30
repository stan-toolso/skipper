import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Col, Row, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import { PullRequestChip } from '../components/PullRequests';
import { RegisterPullRequestModal, TrackedPullRequestActions, TrackedPullRequestIndicators, PullRequestStageBadge } from '../components/TrackedPullRequests';
import { PULL_REQUESTS, type TrackedPullRequest } from '../graphql/pullRequests';
import StatusBadge from '../components/StatusBadge';
import TaskAttachments from '../components/TaskAttachments';
import TaskActions from '../components/TaskActions';
import { formatPerson, isOverdue, Linkified, TaskPriorityBadge, TaskStatusBadge, TaskTags } from '../components/TaskBadges';
import TaskComments from '../components/TaskComments';
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

/** Page d'une tâche dans son propre onglet : description, commentaires, sessions passées par la tâche, personnes, code, champs. */
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
            {' · créée le '}
            {fmt(task.createdAt)}
            {task.createdByType === 'agent' ? ' par un agent' : " depuis l'interface"}
            {task.createdBySession && (
              <>
                {' ('}
                <Link to={`/sessions/${task.createdBySession.id}`}>{task.createdBySession.name}</Link>)
              </>
            )}
            {task.dueDate && <span className={overdue ? ' text-danger' : ''}>{overdue ? ' · en retard depuis le ' : ' · pour le '}{new Date(task.dueDate).toLocaleDateString()}</span>}
            {task.completedAt && ` · terminée le ${fmt(task.completedAt)}`}
          </div>
        </div>
        <TaskActions task={task} target={target} onEdit={() => setEditing(true)} onDeleted={() => navigate(`/projects/${task.project.id}/tasks`)} />
      </div>

      <Row className="g-3 mt-1">
        <Col lg={8}>
          <Card>
            <Card.Header>Description</Card.Header>
            <Card.Body className="small" style={{ whiteSpace: 'pre-wrap' }}>
              {task.description ? <Linkified text={task.description} /> : <span className="text-secondary fst-italic">Pas de description.</span>}
              <TaskAttachments taskId={task.id} attachments={task.attachments} />
            </Card.Body>
          </Card>
          <Card className="mt-3">
            <Card.Header>Commentaires ({task.commentCount})</Card.Header>
            <Card.Body className="small">
              <TaskComments taskId={task.id} />
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
          <Card>
            <Card.Header>Personnes</Card.Header>
            <Card.Body className="small">
              <dl className="row mb-0">
                <dt className="col-4">Responsable</dt>
                <dd className="col-8">{task.assignee ? <>{task.assignee.name ?? task.assignee.email}{task.assignee.email && <> <a href={`mailto:${task.assignee.email}`} className="text-secondary"><i className="bi bi-envelope" /></a></>}</> : <span className="text-secondary">—</span>}</dd>
                <dt className="col-4">Rapporteur</dt>
                <dd className="col-8 mb-0">{task.reporter ? <>{task.reporter.name ?? task.reporter.email}{task.reporter.email && <> <a href={`mailto:${task.reporter.email}`} className="text-secondary"><i className="bi bi-envelope" /></a></>}</> : <span className="text-secondary">—</span>}</dd>
              </dl>
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
                          <a href={pr.url} target="_blank" rel="noreferrer" className="text-reset text-decoration-none fw-semibold" title="Ouvrir sur GitHub">
                            <span className="text-secondary">#{pr.number}</span> {pr.title}
                          </a>
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
                          {` · ouverte ${timeAgo(pr.openedAt)}`}
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
          <Card className="mt-3">
            <Card.Header>Champs personnalisés</Card.Header>
            <Card.Body className="small">
              {task.customFields.length === 0 ? (
                <span className="text-secondary fst-italic">Aucun. Ajoutez-en avec le bouton de modification.</span>
              ) : (
                <dl className="row mb-0">
                  {task.customFields.map((f) => (
                    <div key={f.key} className="row mx-0 px-0">
                      <dt className="col-5 text-truncate" title={f.key}>
                        {f.key}
                      </dt>
                      <dd className="col-7 mb-1" style={{ overflowWrap: 'anywhere' }}>
                        {f.value ? <Linkified text={f.value} /> : '—'}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card.Body>
          </Card>
          <div className="small text-secondary mt-2">{formatPerson(task.assignee) && ''}</div>
        </Col>
      </Row>
      {editing && <TaskModal task={task} projectId={task.project.id} onClose={() => setEditing(false)} />}
      {registering && <RegisterPullRequestModal projectId={task.project.id} taskId={task.id} onClose={() => setRegistering(false)} />}
    </>
  );
}
