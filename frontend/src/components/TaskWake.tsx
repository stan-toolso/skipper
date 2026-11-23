import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Button, Form } from 'react-bootstrap';
import { UPDATE_TASK, type Task } from '../graphql/operations';
import { useDialogs } from './Dialogs';
import { TaskWakeDate } from './TaskBadges';

const REFETCH = ['Tasks', 'TaskPage', 'TaskDetail', 'Sidebar', 'Inbox', 'InboxCounts'];

/** ISO → valeur d'un champ datetime-local (heure locale, à la minute). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Demain 9 h, heure locale : proposition par défaut d'une nouvelle vérification. */
function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

/**
 * Vérification programmée d'une tâche en cours (date de réveil `wakeAt` et ce qu'il faudra vérifier `wakeNote`) : vue et
 * réglage depuis la fiche. Jusqu'à la date, la tâche est « en attente » (même « à valider ») ; à la date, l'agent qui la
 * tenait est reconvoqué, ou la tâche revient dans « À traiter ».
 */
export default function TaskWakeField({ task, canWrite }: { task: Pick<Task, 'id' | 'status' | 'wakeAt' | 'wakeNote'>; canWrite: boolean }) {
  const { showError } = useDialogs();
  const [updateTask, { loading }] = useMutation(UPDATE_TASK, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [editing, setEditing] = useState(false);
  const [at, setAt] = useState('');
  const [note, setNote] = useState('');
  if (task.status !== 'IN_PROGRESS' && !task.wakeAt) return null;

  const open = () => {
    setAt(task.wakeAt && new Date(task.wakeAt).getTime() > Date.now() ? toLocalInput(task.wakeAt) : tomorrowMorning());
    setNote(task.wakeNote ?? '');
    setEditing(true);
  };
  const save = async () => {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return;
    const r = await updateTask({ variables: { id: task.id, input: { wakeAt: d.toISOString(), wakeNote: note.trim() || null } } });
    if (r.data) setEditing(false);
  };
  const remove = async () => {
    const r = await updateTask({ variables: { id: task.id, input: { wakeAt: null, wakeNote: null } } });
    if (r.data) setEditing(false);
  };

  if (editing) {
    return (
      <div className="d-flex flex-column gap-2">
        <Form.Control size="sm" type="datetime-local" value={at} min={toLocalInput(new Date().toISOString())} onChange={(e) => setAt(e.target.value)} aria-label="Date de vérification" />
        <Form.Control size="sm" as="textarea" rows={2} value={note} maxLength={1000} placeholder="Ce qu'il faudra vérifier (facultatif)" onChange={(e) => setNote(e.target.value)} aria-label="Ce qu'il faudra vérifier" />
        <div className="d-flex gap-2 flex-wrap">
          <Button size="sm" onClick={() => void save()} disabled={loading || !at}>
            Enregistrer
          </Button>
          {task.wakeAt && (
            <Button size="sm" variant="outline-danger" onClick={() => void remove()} disabled={loading}>
              Retirer
            </Button>
          )}
          <Button size="sm" variant="link" onClick={() => setEditing(false)} disabled={loading}>
            Annuler
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div>
      {task.wakeAt ? (
        <>
          <TaskWakeDate task={task} />
          {new Date(task.wakeAt).getTime() <= Date.now() && <span className="text-danger"> (passée)</span>}
          {task.wakeNote && <div className="text-secondary mt-1">{task.wakeNote}</div>}
        </>
      ) : (
        <span className="text-secondary">Aucune</span>
      )}
      {canWrite && task.status === 'IN_PROGRESS' && (
        <Button size="sm" variant="link" className="p-0 ms-2 align-baseline" onClick={open}>
          {task.wakeAt ? 'Modifier' : 'Programmer'}
        </Button>
      )}
    </div>
  );
}
