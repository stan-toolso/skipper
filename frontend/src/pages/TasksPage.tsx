import { useQuery } from '@apollo/client';
import PageLoading from '../components/PageLoading';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Card, Col, Form, Row } from 'react-bootstrap';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { PROJECT, PROJECTS, TASKS, TASK_LAUNCH_TARGETS, type Project, type Task, type TaskPerson, type TaskPriority, type TaskStatus } from '../graphql/operations';
import { TASK_PEOPLE, TASK_TAGS } from '../graphql/tasks';
import { taskPriorityLabels } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import ProjectHeader from '../components/ProjectHeader';
import { useGitTarget } from '../workbench/GitTargetContext';
import { PullRequestChip } from '../components/PullRequests';
import { TrackedPullRequestChip } from '../components/TrackedPullRequests';
import TaskActions from '../components/TaskActions';
import TaskDashboard from '../components/TaskDashboard';
import TaskGrid from '../components/TaskGrid';
import type { TaskColumnKey, TaskFilters } from '../lib/taskTable';
import { isOverdue, PersonChip, TaskPriorityBadge, TaskStatusBadge, TaskTags } from '../components/TaskBadges';
import TaskModal from '../components/TaskModal';
import type { LaunchTarget } from '../components/TaskLaunchModal';

const columns: { status: TaskStatus; label: string; hint: string }[] = [
  { status: 'TODO', label: 'À faire', hint: 'Prêtes à être confiées à un agent' },
  { status: 'IN_PROGRESS', label: 'En cours', hint: 'Un agent ou vous y travaillez' },
  { status: 'DONE', label: 'Terminées', hint: 'Faites et vérifiées' },
];
const priorities: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const VIEW_KEY = 'skipper.tasks.view';
type View = 'board' | 'table' | 'dashboard';

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function TaskCard({ task, showProject, onEdit, target, onTag }: { task: Task; showProject: boolean; onEdit: () => void; target?: LaunchTarget; onTag: (tag: string) => void }) {
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
        {(task.statusTag || task.tags.length > 0) && (
          <div className="mt-1 d-flex flex-wrap gap-1 align-items-center">
            {task.statusTag && <TaskStatusBadge status={task.status} statusTag={task.statusTag} />}
            <TaskTags tags={task.tags} onSelect={onTag} />
          </div>
        )}
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
          {(task.worksession?.branch ?? task.branch) && (
            <span className="font-monospace" title="Branche de la tâche : ses sessions y travaillent toutes">
              <i className="bi bi-git me-1" />
              {task.worksession?.branch ?? task.branch}
            </span>
          )}
          {task.pullRequests?.length ? task.pullRequests.slice(0, 2).map((pr) => <TrackedPullRequestChip key={pr.id} projectId={task.project.id} pr={pr} />) : task.pullRequest && <PullRequestChip projectId={task.project.id} pr={task.pullRequest} />}
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

/**
 * Tâches : d'un projet (/projects/:id/tasks) ou de tous les projets (/tasks), en liste (TaskGrid : colonnes réglables,
 * filtres par colonne côté client) ou en kanban (filtres de la barre d'outils, côté serveur).
 */
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
  const [tag, setTag] = useState('');
  // Vue liste : filtres par colonne, appliqués côté client sur les tâches chargées (le projet, lui, filtre la requête).
  const [filters, setFilters] = useState<TaskFilters>({});
  const [view, setView] = useState<View>(() => {
    try {
      // Le tableau (liste) est la vue par défaut ; le kanban et le pilotage restent au choix.
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'board' || v === 'dashboard' ? v : 'table';
    } catch {
      return 'table';
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
  const tagQ = useDebounced(tag, 300);

  const { data: projectData } = useQuery<{ project: Project | null }>(PROJECT, { variables: { id: routeProjectId }, skip: !routeProjectId });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS, { variables: { all: Boolean(user?.isSuperAdmin) } });
  const { data: targetsData } = usePollingQuery<{ projects: LaunchTarget[] }>(TASK_LAUNCH_TARGETS, { pollInterval: 10_000 });
  const { data: peopleData } = useQuery<{ taskPeople: TaskPerson[] }>(TASK_PEOPLE, { variables: { projectId: projectId || null } });
  const { data: tagsData } = useQuery<{ taskTags: string[] }>(TASK_TAGS, { variables: { projectId: projectId || null } });
  const targets = useMemo(() => new Map((targetsData?.projects ?? []).map((p) => [p.id, p])), [targetsData]);
  const table = view === 'table';
  const dashboard = view === 'dashboard';
  const withCancelled = showCancelled || (table && filters.status === 'CANCELLED');
  // Le pilotage a besoin de tout (terminées et annulées comprises, « mes tâches » aussi) pour mesurer débit et délais.
  const statuses: TaskStatus[] = dashboard || withCancelled ? ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] : mine ? ['TODO', 'IN_PROGRESS'] : ['TODO', 'IN_PROGRESS', 'DONE'];
  const { data, loading, error } = usePollingQuery<{ tasks: Task[] }>(TASKS, {
    variables: table
      ? { projectId: projectId || null, status: statuses, priority: null, assignee: null, reporter: null, tag: null, mine, limit: null }
      : { projectId: projectId || null, status: statuses, priority: priority || null, assignee: mine ? null : assigneeQ || null, reporter: reporterQ || null, tag: tagQ.trim() || null, mine, limit: dashboard ? 1000 : null },
    pollInterval: 3000,
  });

  const project = projectData?.project;
  useTabTitle(routeProjectId ? (project ? `Tâches · ${project.name}` : null) : 'Tâches');
  useGitTarget(routeProjectId && project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);
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
    } else if (!showCancelled || mine || assignee || reporter || priority || tag || Object.values(filters).some(Boolean)) {
      setShowCancelled(true);
      setMine(false);
      setTag('');
      setFilters({});
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
  const writableProjects = (projectsData?.projects ?? []).filter((p) => p.myRole !== 'VIEWER');
  const newTaskProjectId = projectId || writableProjects[0]?.id || '';
  const showProject = !routeProjectId;
  const people = peopleData?.taskPeople ?? [];
  const setFilter = (key: TaskColumnKey, value: string) => {
    if (key === 'project') setProjectId(value);
    else setFilters((f) => ({ ...f, [key]: value }));
  };
  const clearFilters = () => {
    setFilters({});
    if (!routeProjectId) setProjectId('');
  };
  const onTag = (t: string) => (table ? setFilters((f) => ({ ...f, tags: t })) : setTag(t));

  return (
    <>
      {routeProjectId && project && <ProjectHeader project={project} active="tasks" />}
      <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
        {!(routeProjectId && project) && <h1 className="h3 mb-0">Tâches</h1>}
        <div className="d-flex gap-2 align-items-center flex-wrap ms-auto">
          {!routeProjectId && !table && (
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
          {!table && (
            <>
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
              <Form.Control size="sm" placeholder="Étiquette" list="task-tags" value={tag} onChange={(e) => setTag(e.target.value)} style={{ width: 130 }} title="Tâches portant cette étiquette" />
              <datalist id="task-tags">
                {(tagsData?.taskTags ?? []).map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <datalist id="task-people">
                {people.flatMap((p) => [p.name, p.email]).filter((v): v is string => Boolean(v)).map((v) => <option key={v} value={v} />)}
              </datalist>
            </>
          )}
          <Button size="sm" variant={mine ? 'primary' : 'outline-primary'} disabled={!user} title="Tâches dont je suis responsable et qui ne sont pas terminées" onClick={() => setMine((v) => !v)}>
            <i className="bi bi-person-check me-1" /> Mes tâches ouvertes
          </Button>
          {!dashboard && <Form.Check type="switch" id="showCancelled" label="Voir les annulées" className="small" checked={showCancelled} disabled={mine} onChange={(e) => setShowCancelled(e.target.checked)} />}
          <ButtonGroup size="sm">
            <Button variant={view === 'table' ? 'secondary' : 'outline-secondary'} title="Liste" onClick={() => setViewPersist('table')}>
              <i className="bi bi-list-ul" />
            </Button>
            <Button variant={view === 'board' ? 'secondary' : 'outline-secondary'} title="Kanban" onClick={() => setViewPersist('board')}>
              <i className="bi bi-kanban" />
            </Button>
            <Button variant={dashboard ? 'secondary' : 'outline-secondary'} title="Pilotage : indicateurs, avancement, prévision" onClick={() => setViewPersist('dashboard')}>
              <i className="bi bi-speedometer2" />
            </Button>
          </ButtonGroup>
          <Button size="sm" disabled={!newTaskProjectId} onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg" /> Nouvelle tâche
          </Button>
        </div>
      </div>
      <p className="text-secondary small">
        {dashboard
          ? 'Vue de pilotage : où en est le projet, à quel rythme il avance et quand le reste à faire devrait être terminé. Les filtres de la barre s’appliquent à tous les indicateurs.'
          : 'Les agents voient ces tâches, peuvent en créer, les commenter et les mettre à jour. « Confier à un agent » lance une session avec la tâche comme consigne.'}
      </p>

      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <PageLoading />}

      {dashboard && data ? (
        <TaskDashboard tasks={tasks} showProject={showProject && !projectId} onEdit={setEditing} onTag={onTag} targets={targets} />
      ) : table ? (
        <TaskGrid
          tasks={tasks}
          showProject={showProject}
          projects={projectsData?.projects ?? []}
          filters={{ ...filters, project: routeProjectId ? '' : projectId }}
          onFilterChange={setFilter}
          onClearFilters={clearFilters}
          onEdit={setEditing}
          onTag={onTag}
          targets={targets}
        />
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
                  <TaskCard key={t.id} task={t} showProject={showProject && !projectId} onEdit={() => setEditing(t)} target={targets.get(t.project.id)} onTag={onTag} />
                ))}
                {list.length === 0 && <div className="text-secondary small fst-italic">Rien ici.</div>}
              </Col>
            );
          })}
        </Row>
      )}

      {editing && <TaskModal task={editing === 'new' ? null : editing} projectId={editing === 'new' ? newTaskProjectId : editing.project.id} projects={routeProjectId ? undefined : writableProjects} onClose={() => setEditing(null)} />}
    </>
  );
}
