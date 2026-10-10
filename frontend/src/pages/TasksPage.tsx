import { useQuery } from '@apollo/client';
import PageLoading from '../components/PageLoading';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { PROJECT, PROJECTS, TASKS, TASK_LAUNCH_TARGETS, type Project, type Task, type TaskPerson, type TaskPriority, type TaskStatus } from '../graphql/operations';
import { TASK_PEOPLE } from '../graphql/tasks';
import { taskPriorityLabels } from '../lib/humanize';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { useGitTarget } from '../workbench/GitTargetContext';
import { PullRequestChip } from '../components/PullRequests';
import TaskActions from '../components/TaskActions';
import { formatPerson, isOverdue, PersonChip, TaskPriorityBadge, TaskStatusBadge } from '../components/TaskBadges';
import TaskModal from '../components/TaskModal';
import type { LaunchTarget } from '../components/TaskLaunchModal';

const columns: { status: TaskStatus; label: string; hint: string }[] = [
  { status: 'TODO', label: 'À faire', hint: 'Prêtes à être confiées à un agent' },
  { status: 'IN_PROGRESS', label: 'En cours', hint: 'Un agent ou vous y travaillez' },
  { status: 'DONE', label: 'Terminées', hint: 'Faites et vérifiées' },
];
const priorities: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const VIEW_KEY = 'skipper.tasks.view';
type View = 'board' | 'table';
type SortKey = 'title' | 'project' | 'status' | 'priority' | 'assignee' | 'reporter' | 'dueDate' | 'comments' | 'createdAt' | 'updatedAt';

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function TaskCard({ task, showProject, onEdit, target }: { task: Task; showProject: boolean; onEdit: () => void; target?: LaunchTarget }) {
  const overdue = isOverdue(task);
  return (
    <Card className="mb-2 task-card">
      <Card.Body className="p-2 px-3">
        <div className="d-flex justify-content-between align-items-start gap-2">
          <Link to={`/tasks/${task.id}`} className="fw-semibold text-reset text-decoration-none" title="Ouvrir la tâche (sessions, détails) dans un onglet">
            {task.title}
          </Link>
          <TaskPriorityBadge priority={task.priority} />
        </div>
        {task.description && (
          <div className="small text-secondary mt-1" style={{ whiteSpace: 'pre-wrap', maxHeight: 72, overflow: 'hidden' }}>
            {task.description}
          </div>
        )}
        <div className="small text-secondary mt-2 d-flex flex-wrap gap-2 align-items-center">
          {showProject && (
            <Link to={`/projects/${task.project.id}/tasks`}>
              <i className="bi bi-folder2 me-1" />
              {task.project.name}
            </Link>
          )}
          {task.session && (
            <Link to={`/sessions/${task.session.id}`} title="Session qui s'en occupe">
              <i className="bi bi-chat-dots me-1" />
              {task.session.name}
              {task.session.status === 'RUNNING' && (task.session.activity === 'BUSY' ? ' · travaille' : ' · attend')}
            </Link>
          )}
          {task.session?.worktree ? (
            <Link to={`/worktrees/${task.session.worktree.id}/files`} title="Worktree dédié à cette tâche">
              <i className="bi bi-diagram-2 me-1" />
              {task.session.worktree.label}
            </Link>
          ) : (
            task.branch && (
              <span className="font-monospace" title="Branche de la tâche (worktree supprimé)">
                <i className="bi bi-diagram-2 me-1" />
                {task.branch}
              </span>
            )
          )}
          {task.pullRequest && <PullRequestChip projectId={task.project.id} pr={task.pullRequest} />}
          <PersonChip person={task.assignee} />
          {task.commentCount > 0 && (
            <Link to={`/tasks/${task.id}`} className="text-reset" title="Commentaires">
              <i className="bi bi-chat-left-text me-1" />
              {task.commentCount}
            </Link>
          )}
          {task.dueDate && <span className={overdue ? 'text-danger' : ''}>{overdue ? 'En retard : ' : 'Pour le '}{new Date(task.dueDate).toLocaleDateString()}</span>}
          <span title={task.createdBySession ? `Créée par la session ${task.createdBySession.name}` : "Créée depuis l'interface"}>
            {task.createdByType === 'agent' ? <i className="bi bi-robot" /> : <i className="bi bi-person" />}
          </span>
        </div>
        <div className="mt-2">
          <TaskActions task={task} target={target} onEdit={onEdit} />
        </div>
      </Card.Body>
    </Card>
  );
}

function sortValue(t: Task, key: SortKey): string | number {
  switch (key) {
    case 'title':
      return t.title.toLowerCase();
    case 'project':
      return t.project.name.toLowerCase();
    case 'status':
      return ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'].indexOf(t.status);
    case 'priority':
      return priorities.indexOf(t.priority);
    case 'assignee':
      return formatPerson(t.assignee).toLowerCase() || '￿';
    case 'reporter':
      return formatPerson(t.reporter).toLowerCase() || '￿';
    case 'dueDate':
      return t.dueDate ?? '9999';
    case 'comments':
      return -t.commentCount;
    case 'createdAt':
      return -new Date(t.createdAt).getTime();
    case 'updatedAt':
      return -new Date(t.updatedAt).getTime();
  }
}

function TaskTable({ tasks, showProject, onEdit, targets }: { tasks: Task[]; showProject: boolean; onEdit: (t: Task) => void; targets: Map<string, LaunchTarget> }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'asc' });
  const sorted = useMemo(() => {
    const list = [...tasks];
    list.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [tasks, sort]);
  const header = (key: SortKey, label: string, cls = '') => (
    <th className={cls} role="button" aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))}>
      {label}
      {sort.key === key && <i className={`bi bi-caret-${sort.dir === 'asc' ? 'down' : 'up'}-fill ms-1 small`} />}
    </th>
  );
  return (
    <Table hover size="sm" className="task-table">
      <thead>
        <tr>
          {header('title', 'Titre')}
          {showProject && header('project', 'Projet')}
          {header('status', 'Statut')}
          {header('priority', 'Priorité')}
          {header('assignee', 'Responsable')}
          {header('reporter', 'Rapporteur')}
          {header('dueDate', 'Échéance')}
          {header('comments', 'Comm.', 'text-end')}
          {header('createdAt', 'Créée')}
          {header('updatedAt', 'Mise à jour')}
          <th />
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => (
          <tr key={t.id}>
            <td>
              <Link to={`/tasks/${t.id}`} className="fw-semibold text-reset text-decoration-none">
                {t.title}
              </Link>
              {t.session && (
                <Link to={`/sessions/${t.session.id}`} className="ms-2 text-secondary" title={t.session.name}>
                  <i className="bi bi-chat-dots" />
                </Link>
              )}
              {t.pullRequest && (
                <span className="ms-2">
                  <PullRequestChip projectId={t.project.id} pr={t.pullRequest} />
                </span>
              )}
            </td>
            {showProject && (
              <td>
                <Link to={`/projects/${t.project.id}/tasks`}>{t.project.name}</Link>
              </td>
            )}
            <td>
              <TaskStatusBadge status={t.status} />
            </td>
            <td>
              <TaskPriorityBadge priority={t.priority} />
            </td>
            <td title={formatPerson(t.assignee)}>{t.assignee?.name ?? t.assignee?.email ?? ''}</td>
            <td title={formatPerson(t.reporter)}>{t.reporter?.name ?? t.reporter?.email ?? ''}</td>
            <td className={isOverdue(t) ? 'text-danger' : ''}>{t.dueDate ? new Date(t.dueDate).toLocaleDateString() : ''}</td>
            <td className="text-end">{t.commentCount || ''}</td>
            <td title={new Date(t.createdAt).toLocaleString()}>{timeAgo(t.createdAt)}</td>
            <td title={new Date(t.updatedAt).toLocaleString()}>{timeAgo(t.updatedAt)}</td>
            <td style={{ minWidth: 260 }}>
              <TaskActions task={t} target={targets.get(t.project.id)} onEdit={() => onEdit(t)} />
            </td>
          </tr>
        ))}
        {sorted.length === 0 && (
          <tr>
            <td colSpan={11} className="text-secondary fst-italic">
              Aucune tâche ne correspond.
            </td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}

/** Tâches : d'un projet (/projects/:id/tasks) ou de tous les projets (/tasks), en tableau ou en liste. */
export default function TasksPage() {
  const { id: routeProjectId } = useParams();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projectId, setProjectId] = useState(routeProjectId ?? '');
  useEffect(() => setProjectId(routeProjectId ?? ''), [routeProjectId]);
  const [showCancelled, setShowCancelled] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [assignee, setAssignee] = useState('');
  const [reporter, setReporter] = useState('');
  const [mine, setMine] = useState(false);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'board';
    } catch {
      return 'board';
    }
  });
  const setViewPersist = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const [editing, setEditing] = useState<Task | null | 'new'>(null);
  const assigneeQ = useDebounced(assignee, 300);
  const reporterQ = useDebounced(reporter, 300);

  const { data: projectData } = useQuery<{ project: Project | null }>(PROJECT, { variables: { id: routeProjectId }, skip: !routeProjectId });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS, { variables: { all: Boolean(user?.isSuperAdmin) } });
  const { data: targetsData } = usePollingQuery<{ projects: LaunchTarget[] }>(TASK_LAUNCH_TARGETS, { pollInterval: 10_000 });
  const { data: peopleData } = useQuery<{ taskPeople: TaskPerson[] }>(TASK_PEOPLE, { variables: { projectId: projectId || null } });
  const targets = useMemo(() => new Map((targetsData?.projects ?? []).map((p) => [p.id, p])), [targetsData]);
  const statuses: TaskStatus[] = mine ? ['TODO', 'IN_PROGRESS'] : showCancelled ? ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] : ['TODO', 'IN_PROGRESS', 'DONE'];
  const { data, loading, error } = usePollingQuery<{ tasks: Task[] }>(TASKS, {
    variables: { projectId: projectId || null, status: statuses, priority: priority || null, assignee: mine ? null : assigneeQ || null, reporter: reporterQ || null, mine },
    pollInterval: 3000,
  });

  const project = projectData?.project;
  useTabTitle(routeProjectId ? (project ? `Tâches · ${project.name}` : null) : 'Tâches');
  useGitTarget(routeProjectId && project?.gitUrl ? { projectId: project.id, worktreeId: null, label: project.name } : null);
  const tasks = data?.tasks ?? [];

  // Lien profond ?task=<id> : ouvre la tâche en édition (en levant les filtres qui la cacheraient).
  const deepLink = searchParams.get('task');
  useEffect(() => {
    if (!deepLink || !data) return;
    const found = tasks.find((t) => t.id === deepLink);
    if (found) {
      setEditing(found);
      searchParams.delete('task');
      setSearchParams(searchParams, { replace: true });
    } else if (!showCancelled || mine || assignee || reporter || priority) {
      setShowCancelled(true);
      setMine(false);
      setAssignee('');
      setReporter('');
      setPriority('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink, data]);

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const t of tasks) m.set(t.status, [...(m.get(t.status) ?? []), t]);
    return m;
  }, [tasks]);
  const cols = (mine ? columns.filter((c) => c.status !== 'DONE') : columns).concat(showCancelled && !mine ? [{ status: 'CANCELLED' as TaskStatus, label: 'Annulées', hint: '' }] : []);
  const newTaskProjectId = projectId || projectsData?.projects.find((p) => p.myRole !== 'VIEWER')?.id || '';
  const showProject = !routeProjectId && !projectId;
  const people = peopleData?.taskPeople ?? [];

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
        <div>
          {routeProjectId && project && (
            <Link to={`/projects/${project.id}`} className="small">
              ← {project.name}
            </Link>
          )}
          <h1 className="h3 mb-0">Tâches</h1>
        </div>
        <div className="d-flex gap-2 align-items-center flex-wrap">
          {!routeProjectId && (
            <Form.Select size="sm" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Tous les projets</option>
              {(projectsData?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {!p.isMember ? ' (non membre)' : ''}
                </option>
              ))}
            </Form.Select>
          )}
          <Form.Select size="sm" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority | '')} style={{ width: 'auto' }}>
            <option value="">Toutes priorités</option>
            {priorities.map((p) => (
              <option key={p} value={p}>
                {taskPriorityLabels[p].label}
              </option>
            ))}
          </Form.Select>
          <Form.Control size="sm" placeholder="Responsable" list="task-people" value={assignee} disabled={mine} onChange={(e) => setAssignee(e.target.value)} style={{ width: 150 }} />
          <Form.Control size="sm" placeholder="Rapporteur" list="task-people" value={reporter} onChange={(e) => setReporter(e.target.value)} style={{ width: 150 }} />
          <datalist id="task-people">
            {people.flatMap((p) => [p.name, p.email]).filter((v): v is string => Boolean(v)).map((v) => <option key={v} value={v} />)}
          </datalist>
          <Button size="sm" variant={mine ? 'primary' : 'outline-primary'} disabled={!user} title="Tâches dont je suis responsable et qui ne sont pas terminées" onClick={() => setMine((v) => !v)}>
            <i className="bi bi-person-check me-1" /> Mes tâches ouvertes
          </Button>
          <Form.Check type="switch" id="showCancelled" label="Voir les annulées" className="small" checked={showCancelled} disabled={mine} onChange={(e) => setShowCancelled(e.target.checked)} />
          <ButtonGroup size="sm">
            <Button variant={view === 'board' ? 'secondary' : 'outline-secondary'} title="Tableau" onClick={() => setViewPersist('board')}>
              <i className="bi bi-kanban" />
            </Button>
            <Button variant={view === 'table' ? 'secondary' : 'outline-secondary'} title="Liste" onClick={() => setViewPersist('table')}>
              <i className="bi bi-list-ul" />
            </Button>
          </ButtonGroup>
          <Button size="sm" disabled={!newTaskProjectId} onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg" /> Nouvelle tâche
          </Button>
        </div>
      </div>
      <p className="text-secondary small">
        Les agents voient ces tâches, peuvent en créer, les commenter et les mettre à jour. « Confier à un agent » lance une session avec la tâche comme consigne.
      </p>

      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <PageLoading />}

      {view === 'table' ? (
        <TaskTable tasks={tasks} showProject={showProject} onEdit={setEditing} targets={targets} />
      ) : (
        <Row className="g-3">
          {cols.map((col) => {
            const list = byStatus.get(col.status) ?? [];
            return (
              <Col key={col.status} md={12 / cols.length}>
                <div className="d-flex justify-content-between align-items-baseline mb-2">
                  <span className="fw-semibold">
                    {col.label} <span className="text-secondary fw-normal">({list.length})</span>
                  </span>
                  {col.status === 'TODO' && list.some(isOverdue) && <Badge bg="danger">en retard</Badge>}
                </div>
                {col.hint && <div className="small text-secondary mb-2">{col.hint}</div>}
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} showProject={showProject} onEdit={() => setEditing(t)} target={targets.get(t.project.id)} />
                ))}
                {list.length === 0 && <div className="text-secondary small fst-italic">Rien ici.</div>}
              </Col>
            );
          })}
        </Row>
      )}

      {editing && <TaskModal task={editing === 'new' ? null : editing} projectId={editing === 'new' ? newTaskProjectId : editing.project.id} onClose={() => setEditing(null)} />}
    </>
  );
}
