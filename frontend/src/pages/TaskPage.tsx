import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Card, Col, Row, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import { PullRequestChip } from '../components/PullRequests';
import StatusBadge from '../components/StatusBadge';
import TaskActions from '../components/TaskActions';
import { formatPerson, isOverdue, Linkified, TaskPriorityBadge, TaskStatusBadge } from '../components/TaskBadges';
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
  worktree: { id: string; label: string } | null;
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
  const task = data?.task;
  useTabTitle(task?.title ?? null);
  const current = task?.sessions.find((s) => s.id === task.session?.id);
  useGitTarget(task && task.session?.worktree ? { projectId: task.project.id, worktreeId: task.session.worktree.id, label: task.session.worktree.label } : null);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!task) return <Alert variant="warning">Tâche introuvable (supprimée, ou dans un projet auquel vous n'avez pas accès).</Alert>;
  const target = targetsData?.projects.find((p) => p.id === task.project.id);
  const overdue = isOverdue(task);

  return (
    <>
      <Link to={`/projects/${task.project.id}/tasks`} className="small">
        ← Tâches · {task.project.name}
      </Link>
      <div className="d-flex align-items-start justify-content-between gap-3 flex-wrap">
        <div>
          <h1 className="h3 mb-1">
            {task.title} <TaskStatusBadge status={task.status} /> <TaskPriorityBadge priority={task.priority} />
          </h1>
          <div className="small text-secondary">
            <Link to={`/projects/${task.project.id}`}>{task.project.name}</Link>
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
                <Table size="sm" hover className="mb-0">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>État</th>
                      <th>Worktree</th>
                      <th>Par</th>
                      <th>Démarrée</th>
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
                        <td>{s.worktree ? <Link to={`/worktrees/${s.worktree.id}/files`}>{s.worktree.label}</Link> : <span className="text-secondary">dossier principal</span>}</td>
                        <td>{s.owner?.name ?? <span className="text-secondary">—</span>}</td>
                        <td title={s.startedAt ? fmt(s.startedAt) : ''}>
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
          {(task.branch || task.pullRequest || current?.worktree) && (
            <Card className="mt-3">
              <Card.Header>Code</Card.Header>
              <Card.Body className="small">
                {current?.worktree ? (
                  <div>
                    <i className="bi bi-diagram-2 me-1" />
                    <Link to={`/worktrees/${current.worktree.id}/files`}>{current.worktree.label}</Link>
                  </div>
                ) : (
                  task.branch && (
                    <div className="font-monospace">
                      <i className="bi bi-diagram-2 me-1" />
                      {task.branch} <span className="text-secondary">(worktree supprimé)</span>
                    </div>
                  )
                )}
                {task.pullRequest && (
                  <div className="mt-1">
                    <PullRequestChip projectId={task.project.id} pr={task.pullRequest} /> {task.pullRequest.title}
                  </div>
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
    </>
  );
}
