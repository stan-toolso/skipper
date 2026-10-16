import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { DELETE_TASK, MOVE_TASK, PROJECTS, UPDATE_TASK, type Project, type Task, type TaskStatus } from '../graphql/operations';
import { useDialogs } from './Dialogs';
import TaskLaunchModal, { type LaunchTarget } from './TaskLaunchModal';

const REFETCH = ['Tasks', 'TaskPage', 'TaskDetail', 'Sidebar'];

/** Choix du projet où déplacer une tâche (elle est détachée de sa session et de sa branche). */
function TaskMoveModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const { showError } = useDialogs();
  const { data } = useQuery<{ projects: Project[] }>(PROJECTS);
  const [moveTask, { loading }] = useMutation(MOVE_TASK, { refetchQueries: REFETCH });
  const [projectId, setProjectId] = useState('');
  const choices = (data?.projects ?? []).filter((p) => p.id !== task.project.id);
  const submit = async () => {
    try {
      await moveTask({ variables: { id: task.id, projectId } });
      onClose();
    } catch (err) {
      void showError(err);
    }
  };
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h6">Déplacer la tâche dans un autre projet</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="small text-secondary">
          « {task.title} » quitte {task.project.name} avec ses commentaires et son historique. Sa session et sa branche restent dans {task.project.name}.
        </p>
        <Form.Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Projet de destination">
          <option value="">Choisir un projet…</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Form.Select>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" size="sm" onClick={onClose}>
          Annuler
        </Button>
        <Button size="sm" disabled={!projectId || loading} onClick={() => void submit()}>
          Déplacer
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Boutons d'une tâche (carte du tableau, page de la tâche) : confier à un agent (à faire ou en cours), changer de statut, modifier, déplacer, supprimer. */
export default function TaskActions({ task, target, onEdit, onDeleted }: { task: Task; target: LaunchTarget | undefined; onEdit: () => void; onDeleted?: () => void }) {
  const { confirm, showError } = useDialogs();
  const [updateTask] = useMutation(UPDATE_TASK, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [deleteTask] = useMutation(DELETE_TASK, { refetchQueries: REFETCH, onCompleted: onDeleted, onError: (e) => void showError(e) });
  const [launching, setLaunching] = useState(false);
  const [moving, setMoving] = useState(false);
  const move = (status: TaskStatus) => updateTask({ variables: { id: task.id, input: { status } } });
  const open = task.status === 'TODO' || task.status === 'IN_PROGRESS';
  return (
    <div className="d-flex flex-wrap gap-1 align-items-center">
      {open && (
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
      <Button size="sm" variant="link" className="text-secondary p-0 px-1" title="Déplacer dans un autre projet" onClick={() => setMoving(true)}>
        <i className="bi bi-arrow-left-right" />
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
      {moving && <TaskMoveModal task={task} onClose={() => setMoving(false)} />}
      {launching && <TaskLaunchModal task={task} target={target} onClose={() => setLaunching(false)} />}
    </div>
  );
}
