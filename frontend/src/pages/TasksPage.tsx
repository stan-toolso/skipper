import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Card, Col, Dropdown, Form, Modal, Row, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CREATE_TASK, DELETE_TASK, PROJECT, PROJECTS, START_TASK_SESSION, TASK_LAUNCH_TARGETS, TASKS, UPDATE_TASK, type Project, type Task, type TaskPriority, type TaskStatus } from '../graphql/operations';
import { taskPriorityLabels, taskStatusLabels } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useDialogs } from '../components/Dialogs';
import { canAutoFocus } from '../lib/device';
import { PullRequestChip } from '../components/PullRequests';


const columns: { status: TaskStatus; label: string; hint: string }[] = [
  { status: 'TODO', label: 'À faire', hint: 'Prêtes à être confiées à un agent' },
  { status: 'IN_PROGRESS', label: 'En cours', hint: 'Un agent ou vous y travaillez' },
  { status: 'DONE', label: 'Terminées', hint: 'Faites et vérifiées' },
];
const priorities: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

interface TaskForm {
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
}

/** Fenêtre de création / édition d'une tâche. */
function TaskModal({ task, projectId, onClose }: { task: Task | null; projectId: string; onClose: () => void }) {
  const [form, setForm] = useState<TaskForm>({ title: task?.title ?? '', description: task?.description ?? '', priority: task?.priority ?? 'MEDIUM', status: task?.status ?? 'TODO', dueDate: task?.dueDate ?? '' });
  const [createTask, { loading: creating, error: createError }] = useMutation(CREATE_TASK, { refetchQueries: ['Tasks'], onCompleted: onClose });
  const [updateTask, { loading: updating, error: updateError }] = useMutation(UPDATE_TASK, { refetchQueries: ['Tasks'], onCompleted: onClose });
  const error = createError ?? updateError;
  const set = (k: keyof TaskForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = { title: form.title, description: form.description, priority: form.priority, status: form.status, dueDate: form.dueDate || null };
    if (task) updateTask({ variables: { id: task.id, input } });
    else createTask({ variables: { input: { ...input, projectId } } });
  };

  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">{task ? 'Modifier la tâche' : 'Nouvelle tâche'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Titre</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={form.title} onChange={set('title')} required placeholder="Ex. Ajouter la page de contact" />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Description</Form.Label>
            <Form.Control as="textarea" rows={5} value={form.description} onChange={set('description')} placeholder="Ce qu'il faut faire, comment savoir que c'est réussi, les pistes utiles…" />
          </Form.Group>
          <Row className="g-2">
            <Col sm={4}>
              <Form.Label>Priorité</Form.Label>
              <Form.Select value={form.priority} onChange={set('priority')}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {taskPriorityLabels[p].label}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col sm={4}>
              <Form.Label>Statut</Form.Label>
              <Form.Select value={form.status} onChange={set('status')}>
                {(Object.keys(taskStatusLabels) as TaskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {taskStatusLabels[s]}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col sm={4}>
              <Form.Label>Échéance</Form.Label>
              <Form.Control type="date" value={form.dueDate} onChange={set('dueDate')} />
            </Col>
          </Row>
          {error && (
            <Alert variant="danger" className="mt-3 mb-0">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={creating || updating || !form.title.trim()}>
            {task ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Projet relié à git et ses worktrees : détermine où une tâche peut être confiée. */
interface LaunchTarget {
  id: string;
  gitUrl: string | null;
  worktrees: { id: string; branch: string; exists: boolean }[];
}

function TaskCard({ task, showProject, onEdit, target }: { task: Task; showProject: boolean; onEdit: () => void; target?: LaunchTarget }) {
  const navigate = useNavigate();
  const [updateTask] = useMutation(UPDATE_TASK, { refetchQueries: ['Tasks'] });
  const { confirm } = useDialogs();
  const [deleteTask] = useMutation(DELETE_TASK, { refetchQueries: ['Tasks'] });
  const [startTaskSession, { loading: starting, error: startError }] = useMutation<{ startTaskSession: { id: string } }>(START_TASK_SESSION, {
    refetchQueries: ['Tasks', 'Sidebar'],
    onCompleted: (res) => navigate(`/sessions/${res.startTaskSession.id}`),
  });
  const move = (status: TaskStatus) => updateTask({ variables: { id: task.id, input: { status } } });
  const pr = taskPriorityLabels[task.priority];
  const overdue = task.dueDate && task.status !== 'DONE' && task.status !== 'CANCELLED' && task.dueDate < new Date().toISOString().slice(0, 10);

  return (
    <Card className="mb-2 task-card">
      <Card.Body className="p-2 px-3">
        <div className="d-flex justify-content-between align-items-start gap-2">
          <div className="fw-semibold" style={{ cursor: 'pointer' }} onClick={onEdit} title="Modifier">
            {task.title}
          </div>
          <Badge bg={pr.bg} text={pr.bg === 'warning' ? 'dark' : undefined} title="Priorité">
            {pr.label}
          </Badge>
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
              {task.session.worktree.branch}
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
          {task.dueDate && <span className={overdue ? 'text-danger' : ''}>{overdue ? 'En retard : ' : 'Pour le '}{new Date(task.dueDate).toLocaleDateString()}</span>}
          <span title={task.createdBySession ? `Créée par la session ${task.createdBySession.name}` : 'Créée depuis l\'interface'}>
            {task.createdByType === 'agent' ? <i className="bi bi-robot" /> : <i className="bi bi-person" />}
          </span>
        </div>
        <div className="d-flex flex-wrap gap-1 mt-2">
          {task.status === 'TODO' &&
            (target?.gitUrl ? (
              // Projet git : par défaut dans un worktree dédié (branche task/<slug>) ; le menu permet le dossier principal ou un worktree existant.
              <Dropdown as={ButtonGroup} size="sm">
                <Button variant="primary" disabled={starting} onClick={() => startTaskSession({ variables: { id: task.id, dedicatedWorktree: true } })} title="Lance un agent dans un worktree créé pour cette tâche">
                  <i className="bi bi-play-fill" /> {starting ? 'Lancement…' : 'Confier à un agent'}
                </Button>
                <Dropdown.Toggle split variant="primary" disabled={starting} title="Choisir où l'agent travaille" />
                <Dropdown.Menu>
                  <Dropdown.Header>Où l'agent travaille</Dropdown.Header>
                  <Dropdown.Item onClick={() => startTaskSession({ variables: { id: task.id, dedicatedWorktree: true } })}>
                    <i className="bi bi-diagram-2 me-2" />
                    Nouveau worktree dédié <span className="text-secondary small">(recommandé)</span>
                  </Dropdown.Item>
                  <Dropdown.Item onClick={() => startTaskSession({ variables: { id: task.id, dedicatedWorktree: false } })}>
                    <i className="bi bi-folder2 me-2" />
                    Dossier principal du projet
                  </Dropdown.Item>
                  {target.worktrees.filter((w) => w.exists).length > 0 && <Dropdown.Divider />}
                  {target.worktrees
                    .filter((w) => w.exists)
                    .map((w) => (
                      <Dropdown.Item key={w.id} onClick={() => startTaskSession({ variables: { id: task.id, worktreeId: w.id } })}>
                        <i className="bi bi-diagram-2 me-2" />
                        {w.branch}
                      </Dropdown.Item>
                    ))}
                </Dropdown.Menu>
              </Dropdown>
            ) : (
              <Button size="sm" variant="primary" disabled={starting} onClick={() => startTaskSession({ variables: { id: task.id, dedicatedWorktree: false } })} title="Lance une session d'agent avec cette tâche">
                <i className="bi bi-play-fill" /> {starting ? 'Lancement…' : 'Confier à un agent'}
              </Button>
            ))}
          {task.status === 'TODO' && (
            <Button size="sm" variant="outline-secondary" onClick={() => move('IN_PROGRESS')}>
              En cours
            </Button>
          )}
          {task.status === 'IN_PROGRESS' && (
            <>
              <Button size="sm" variant="outline-success" onClick={() => move('DONE')}>
                <i className="bi bi-check2" /> Terminée
              </Button>
              <Button size="sm" variant="outline-secondary" onClick={() => move('TODO')}>
                Remettre à faire
              </Button>
            </>
          )}
          {task.status === 'DONE' && (
            <Button size="sm" variant="outline-secondary" onClick={() => move('TODO')}>
              Rouvrir
            </Button>
          )}
          <Button size="sm" variant="link" className="text-secondary ms-auto p-0 px-1" title="Modifier" onClick={onEdit}>
            <i className="bi bi-pencil" />
          </Button>
          <Button
            size="sm"
            variant="link"
            className="text-secondary p-0 px-1"
            title="Supprimer"
            onClick={async () => {
              if (await confirm({ title: 'Supprimer la tâche', message: `Supprimer la tâche « ${task.title} » ?`, confirmLabel: 'Supprimer', danger: true })) deleteTask({ variables: { id: task.id } });
            }}
          >
            <i className="bi bi-trash" />
          </Button>
        </div>
        {startError && (
          <Alert variant="danger" className="mt-2 mb-0 py-1 small">
            {startError.message}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}

/** Tableau des tâches : d'un projet (/projects/:id/tasks) ou de tous les projets (/tasks). */
export default function TasksPage() {
  const { id: routeProjectId } = useParams();
  const [projectId, setProjectId] = useState(routeProjectId ?? '');
  useEffect(() => setProjectId(routeProjectId ?? ''), [routeProjectId]);
  const [showCancelled, setShowCancelled] = useState(false);
  const [editing, setEditing] = useState<Task | null | 'new'>(null);

  const { data: projectData } = useQuery<{ project: Project | null }>(PROJECT, { variables: { id: routeProjectId }, skip: !routeProjectId });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const { data: targetsData } = useQuery<{ projects: LaunchTarget[] }>(TASK_LAUNCH_TARGETS, { pollInterval: 10_000 });
  const targets = useMemo(() => new Map((targetsData?.projects ?? []).map((p) => [p.id, p])), [targetsData]);
  const statuses: TaskStatus[] = showCancelled ? ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] : ['TODO', 'IN_PROGRESS', 'DONE'];
  const { data, loading, error } = useQuery<{ tasks: Task[] }>(TASKS, { variables: { projectId: projectId || null, status: statuses }, pollInterval: 3000 });

  const project = projectData?.project;
  useTabTitle(routeProjectId ? (project ? `Tâches · ${project.name}` : null) : 'Tâches');
  useGitTarget(routeProjectId && project?.gitUrl ? { projectId: project.id, worktreeId: null, label: project.name } : null);
  const tasks = data?.tasks ?? [];
  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const t of tasks) m.set(t.status, [...(m.get(t.status) ?? []), t]);
    return m;
  }, [tasks]);
  const cols = showCancelled ? [...columns, { status: 'CANCELLED' as TaskStatus, label: 'Annulées', hint: '' }] : columns;
  const newTaskProjectId = projectId || projectsData?.projects[0]?.id || '';

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
        <div className="d-flex gap-2 align-items-center">
          {!routeProjectId && (
            <Form.Select size="sm" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Tous les projets</option>
              {(projectsData?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Form.Select>
          )}
          <Form.Check type="switch" id="showCancelled" label="Voir les annulées" className="small" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
          <Button size="sm" disabled={!newTaskProjectId} onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg" /> Nouvelle tâche
          </Button>
        </div>
      </div>
      <p className="text-secondary small">
        Les agents voient ces tâches, peuvent en créer et les mettre à jour. « Confier à un agent » lance une session avec la tâche comme consigne.
      </p>

      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <Spinner animation="border" size="sm" />}

      <Row className="g-3">
        {cols.map((col) => {
          const list = byStatus.get(col.status) ?? [];
          return (
            <Col key={col.status} md={12 / cols.length}>
              <div className="d-flex justify-content-between align-items-baseline mb-2">
                <span className="fw-semibold">
                  {col.label} <span className="text-secondary fw-normal">({list.length})</span>
                </span>
              </div>
              {col.hint && <div className="small text-secondary mb-2">{col.hint}</div>}
              {list.map((t) => (
                <TaskCard key={t.id} task={t} showProject={!routeProjectId && !projectId} onEdit={() => setEditing(t)} target={targets.get(t.project.id)} />
              ))}
              {list.length === 0 && <div className="text-secondary small fst-italic">Rien ici.</div>}
            </Col>
          );
        })}
      </Row>

      {editing && <TaskModal task={editing === 'new' ? null : editing} projectId={editing === 'new' ? newTaskProjectId : editing.project.id} onClose={() => setEditing(null)} />}
    </>
  );
}
