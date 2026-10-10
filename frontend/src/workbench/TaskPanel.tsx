import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PullRequestChip } from '../components/PullRequests';
import { isOverdue, Linkified, TaskPriorityBadge, TaskStatusBadge } from '../components/TaskBadges';
import TaskComments from '../components/TaskComments';
import TaskModal from '../components/TaskModal';
import type { Task } from '../graphql/operations';
import { TASK_DETAIL } from '../graphql/tasks';
import { usePollingQuery } from '../lib/usePollingQuery';

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Onglet « Tâche » du panneau de droite, à côté d'une session en charge d'une tâche. */
export default function TaskPanel({ taskId }: { taskId: string }) {
  const { data } = usePollingQuery<{ task: Task | null }>(TASK_DETAIL, { variables: { id: taskId }, pollInterval: 10_000 });
  const [editing, setEditing] = useState(false);
  const task = data?.task;
  if (!task) return <div className="git-empty p-2">Chargement de la tâche…</div>;
  const overdue = isOverdue(task);
  return (
    <div className="task-panel">
      <div className="task-panel-head">
        <Link to={`/tasks/${task.id}`} className="task-panel-title">
          {task.title}
        </Link>
        <button type="button" className="git-icon-btn" title="Modifier la tâche" onClick={() => setEditing(true)}>
          <i className="bi bi-pencil" />
        </button>
      </div>
      <div className="d-flex gap-2 align-items-center px-2 pb-2">
        <TaskStatusBadge status={task.status} />
        <TaskPriorityBadge priority={task.priority} />
        {task.dueDate && <span className={`small ${overdue ? 'text-danger' : 'text-secondary'}`}>{overdue ? 'En retard : ' : 'Pour le '}{new Date(task.dueDate).toLocaleDateString()}</span>}
      </div>
      <div className="git-subhead">Description</div>
      <div className="task-panel-text">{task.description ? <Linkified text={task.description} /> : <span className="text-secondary fst-italic">Pas de description.</span>}</div>
      <div className="git-subhead">Personnes</div>
      <div className="task-panel-text">
        <div>
          Responsable : {task.assignee ? task.assignee.name ?? task.assignee.email : <span className="text-secondary">—</span>}
        </div>
        <div>
          Rapporteur : {task.reporter ? task.reporter.name ?? task.reporter.email : <span className="text-secondary">—</span>}
        </div>
      </div>
      {task.customFields.length > 0 && (
        <>
          <div className="git-subhead">Champs</div>
          <dl className="task-panel-fields">
            {task.customFields.map((f) => (
              <div key={f.key}>
                <dt title={f.key}>{f.key}</dt>
                <dd>{f.value ? <Linkified text={f.value} /> : '—'}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {(task.branch || task.pullRequest) && (
        <>
          <div className="git-subhead">Code</div>
          <div className="task-panel-text">
            {task.branch && <div className="font-monospace">{task.branch}</div>}
            {task.pullRequest && (
              <div>
                <PullRequestChip projectId={task.project.id} pr={task.pullRequest} />
              </div>
            )}
          </div>
        </>
      )}
      <div className="git-subhead">Commentaires ({task.commentCount})</div>
      <div className="task-panel-text">
        <TaskComments taskId={task.id} />
      </div>
      <div className="git-subhead">Infos</div>
      <div className="task-panel-text text-secondary">
        Créée le {fmt(task.createdAt)} {task.createdBySession ? <>par la session <Link to={`/sessions/${task.createdBySession.id}`}>{task.createdBySession.name}</Link></> : task.createdByType === 'agent' ? 'par un agent' : "depuis l'interface"}
        {task.completedAt && <div>Terminée le {fmt(task.completedAt)}</div>}
        <div className="mt-1">
          <Link to={`/tasks/${task.id}`}>Ouvrir la tâche</Link> · <Link to={`/projects/${task.project.id}/tasks`}>Tableau des tâches</Link>
        </div>
      </div>
      {editing && <TaskModal task={task} projectId={task.project.id} onClose={() => setEditing(false)} />}
    </div>
  );
}
