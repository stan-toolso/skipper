import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Button } from 'react-bootstrap';
import { DELETE_TASK, UPDATE_TASK, type Task, type TaskStatus } from '../graphql/operations';
import { useDialogs } from './Dialogs';
import TaskLaunchModal, { type LaunchTarget } from './TaskLaunchModal';

const REFETCH = ['Tasks', 'TaskPage', 'TaskDetail', 'Sidebar'];

/** Boutons d'une tâche (carte du tableau, page de la tâche) : confier à un agent, changer de statut, modifier, supprimer. */
export default function TaskActions({ task, target, onEdit, onDeleted }: { task: Task; target: LaunchTarget | undefined; onEdit: () => void; onDeleted?: () => void }) {
  const { confirm, showError } = useDialogs();
  const [updateTask] = useMutation(UPDATE_TASK, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [deleteTask] = useMutation(DELETE_TASK, { refetchQueries: REFETCH, onCompleted: onDeleted, onError: (e) => void showError(e) });
  const [launching, setLaunching] = useState(false);
  const move = (status: TaskStatus) => updateTask({ variables: { id: task.id, input: { status } } });
  const open = task.status === 'TODO' || task.status === 'IN_PROGRESS';
  return (
    <div className="d-flex flex-wrap gap-1 align-items-center">
      {task.status === 'TODO' && (
        <Button size="sm" variant="primary" onClick={() => setLaunching(true)} title="Choisir la consigne, l'agent et l'endroit où il travaille, puis lancer une session">
          <i className="bi bi-play-fill" /> Confier à un agent
        </Button>
      )}
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
      {(task.status === 'DONE' || task.status === 'CANCELLED') && (
        <Button size="sm" variant="outline-secondary" onClick={() => move('TODO')}>
          Rouvrir
        </Button>
      )}
      {open && (
        <Button size="sm" variant="link" className="text-secondary p-0 px-1" onClick={() => move('CANCELLED')}>
          Annuler
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
      {launching && <TaskLaunchModal task={task} target={target} onClose={() => setLaunching(false)} />}
    </div>
  );
}
