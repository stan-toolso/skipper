import { Alert, Badge } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { TASK_THREAD_OPENING } from '../graphql/conversations';
import { taskStatusLabels } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { Linkified } from './TaskBadges';
import TaskSummary from './TaskSummary';
import TaskThread from './TaskThread';

interface Data {
  task: {
    id: string;
    title: string;
    status: string;
    summary: string | null;
    description: string;
    createdAt: string;
    createdByType: string;
    createdBySession: { id: string; name: string; owner: { id: string; name: string } | null } | null;
    reporter: { name: string | null; email: string | null } | null;
    attachments: { id: string; name: string; mediaType: string; size: number }[];
  } | null;
}

/**
 * Le fil d'une tâche ouvert dans l'onglet Conversations (fils de tâches suivis) : le même fil que sur la page de la
 * tâche (conversation de la tâche, mutations de la tâche), avec son message d'ouverture et un lien vers la tâche.
 */
export default function ConversationTaskThread({ taskId, canWrite }: { taskId: string; canWrite: boolean }) {
  const { data, error } = usePollingQuery<Data>(TASK_THREAD_OPENING, { variables: { id: taskId }, pollInterval: 30_000 });
  if (error && !data) return <Alert variant="danger" className="m-2">Erreur : {error.message}</Alert>;
  const task = data?.task;
  if (data && !task) return <div className="text-secondary p-3">Tâche introuvable.</div>;
  if (!task) return null;
  const openedBy = task.createdBySession?.owner?.name ?? task.createdBySession?.name ?? task.reporter?.name ?? task.reporter?.email ?? (task.createdByType === 'agent' ? 'Un agent' : 'Quelqu’un');
  return (
    <>
      <div className="ch-head">
        <div className="ch-head-title">
          <i className="bi bi-check2-square ch-hash me-1" />
          <Link to={`/tasks/${task.id}`}>{task.title}</Link>
          <Badge bg="secondary" className="ms-2 fw-normal">
            {taskStatusLabels[task.status] ?? task.status}
          </Badge>
        </div>
        <div className="ch-head-topic">Fil de la tâche : les sessions reliées à la tâche reçoivent chaque message.</div>
      </div>
      <div className="ch-body ch-scroll">
        <TaskSummary summary={task.summary} className="m-2" />
        <TaskThread
          key={task.id}
          taskId={task.id}
          canWrite={canWrite}
          opening={{
            authorName: openedBy,
            byAgent: task.createdByType === 'agent' && !task.createdBySession?.owner,
            session: task.createdBySession ? { id: task.createdBySession.id, name: task.createdBySession.name } : null,
            createdAt: task.createdAt,
            body: task.description ? <Linkified text={task.description} /> : <span className="text-secondary fst-italic">Pas de description.</span>,
            attachments: task.attachments,
          }}
        />
      </div>
    </>
  );
}
