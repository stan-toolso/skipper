import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { DELETE_TASK, MOVE_TASK, PROJECTS, UPDATE_TASK, type Project, type Task, type TaskStatus, type TaskStatusDefinition } from '../graphql/operations';
import { PROJECT_TASK_STATUSES } from '../graphql/tasks';
import { useDialogs } from './Dialogs';
import PopMenu, { type MenuItem } from './PopMenu';
import { useTaskLauncher, type LaunchTarget } from './TaskLaunchModal';

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

/**
 * Boutons d'une tâche (carte du kanban, page de la tâche) : confier à un agent (à faire ou en cours), changer de statut,
 * modifier, déplacer, supprimer. En mode `compact` (ligne de la vue liste, une seule ligne) : le bouton « Confier » et
 * un menu « ⋯ » avec le reste.
 */
export default function TaskActions({ task, target, onEdit, onDeleted, compact = false }: { task: Task; target: LaunchTarget | undefined; onEdit: () => void; onDeleted?: () => void; compact?: boolean }) {
  const { confirm, showError } = useDialogs();
  const [updateTask] = useMutation(UPDATE_TASK, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [deleteTask] = useMutation(DELETE_TASK, { refetchQueries: REFETCH, onCompleted: onDeleted, onError: (e) => void showError(e) });
  const { launchTask } = useTaskLauncher();
  const [moving, setMoving] = useState(false);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const move = (status: TaskStatus) => updateTask({ variables: { id: task.id, input: { status } } });
  const moveTo = (state: string) => updateTask({ variables: { id: task.id, input: { state } } });
  // Statuts du projet (menu compact) : chargés une fois par projet (cache Apollo).
  const { data: statusesData } = useQuery<{ project: { id: string; taskStatuses: TaskStatusDefinition[] } | null }>(PROJECT_TASK_STATUSES, { variables: { id: task.project.id }, skip: !compact });
  const open = task.status === 'TODO' || task.status === 'IN_PROGRESS';
  // Une session déjà en charge : la modale propose de reprendre sa conversation plutôt que d'en lancer une nouvelle.
  const resume = Boolean(task.session);
  // Une tâche bloquée par des dépendances non terminées ne se confie pas à un agent (le serveur le refuse aussi).
  const blocked = task.blockedBy.length > 0;
  const launchTitle = blocked
    ? `Bloquée par ${task.blockedBy.map((t) => `« ${t.title} »`).join(', ')} : elle pourra être confiée à un agent quand ses dépendances seront terminées${task.autoStartWhenUnblocked ? ' (elle sera alors lancée automatiquement)' : ''}`
    : resume
      ? 'Reprendre la conversation de la session de la tâche avec un nouveau message (ou lancer une nouvelle session)'
      : "Choisir la consigne, l'agent et l'endroit où il travaille, puis lancer une session";
  const remove = async () => {
    if (await confirm({ title: 'Supprimer la tâche', message: `Supprimer la tâche « ${task.title} » ?`, confirmLabel: 'Supprimer', danger: true })) deleteTask({ variables: { id: task.id } });
  };
  const modals = moving && <TaskMoveModal task={task} onClose={() => setMoving(false)} />;

  if (compact) {
    const items: MenuItem[] = [];
    const statuses = statusesData?.project?.taskStatuses;
    if (statuses?.length) {
      // Un statut du projet par entrée (sauf l'actuel), dans l'ordre du projet.
      const icons: Record<TaskStatus, string> = { TODO: 'bi-circle', IN_PROGRESS: 'bi-play', DONE: 'bi-check2', CANCELLED: 'bi-x-circle' };
      for (const st of statuses) if (st.key !== task.state) items.push({ label: `Passer à « ${st.label} »`, icon: st.attention ? 'bi-person-exclamation' : icons[st.category], onClick: () => void moveTo(st.key) });
    } else {
      if (task.status === 'TODO') items.push({ label: 'Passer en cours', icon: 'bi-play', onClick: () => void move('IN_PROGRESS') });
      if (task.status === 'IN_PROGRESS') {
        items.push({ label: 'Terminée', icon: 'bi-check2', onClick: () => void move('DONE') });
        items.push({ label: 'Remettre à faire', icon: 'bi-arrow-counterclockwise', onClick: () => void move('TODO') });
      }
      if (task.status === 'DONE' || task.status === 'CANCELLED') items.push({ label: 'Rouvrir', icon: 'bi-arrow-counterclockwise', onClick: () => void move('TODO') });
      if (open) items.push({ label: 'Annuler la tâche', icon: 'bi-x-circle', onClick: () => void move('CANCELLED') });
    }
    items.push({ label: 'Modifier', icon: 'bi-pencil', onClick: onEdit, separatorBefore: true });
    items.push({ label: 'Déplacer dans un autre projet', icon: 'bi-arrow-left-right', onClick: () => setMoving(true) });
    items.push({ label: 'Supprimer', icon: 'bi-trash', danger: true, onClick: () => void remove(), separatorBefore: true });
    return (
      <div className="task-actions-compact">
        {open ? (
          <span title={launchTitle}>
            <Button size="sm" variant="primary" className="text-nowrap" disabled={blocked} onClick={() => launchTask(task, target)}>
              <i className={`bi ${blocked ? 'bi-lock' : 'bi-play-fill'}`} /> {resume ? 'Reprendre' : 'Confier'}
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="outline-secondary" className="text-nowrap" onClick={() => move('TODO')}>
            Rouvrir
          </Button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-link text-secondary p-0 px-1"
          title="Autres actions"
          aria-label="Autres actions"
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAt)}
          onClick={(e) => {
            e.stopPropagation();
            if (menuAt) return setMenuAt(null);
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ top: r.bottom + 2, right: Math.max(4, window.innerWidth - r.right) });
          }}
        >
          <i className="bi bi-three-dots" />
        </button>
        {menuAt && <PopMenu items={items} at={menuAt} onClose={() => setMenuAt(null)} />}
        {modals}
      </div>
    );
  }

  return (
    <div className="d-flex flex-wrap gap-1 align-items-center">
      {open && (
        <span title={launchTitle}>
          <Button size="sm" variant="primary" disabled={blocked} onClick={() => launchTask(task, target)}>
            <i className={`bi ${blocked ? 'bi-lock' : 'bi-play-fill'}`} /> {resume ? 'Reprendre' : 'Confier à un agent'}
          </Button>
        </span>
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
      <Button size="sm" variant="link" className="text-secondary p-0 px-1" title="Supprimer" onClick={() => void remove()}>
        <i className="bi bi-trash" />
      </Button>
      {modals}
    </div>
  );
}
