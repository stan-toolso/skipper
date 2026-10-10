import { useMutation } from '@apollo/client';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { useSessionLauncher } from '../components/SessionLauncher';
import { CREATE_TERMINAL } from '../graphql/operations';
import { useRenameWorktree } from './RenameWorktree';
import { useDeletions } from './useDeletions';

export interface AddMenuWorktree {
  id: string;
  name: string;
  branch: string;
  label: string;
  customLabel: string | null;
}

export interface AddMenuProject {
  id: string;
  name: string;
  /** Administrateur du projet : peut le modifier et le supprimer. */
  canManage: boolean;
  /** Chemins des onglets à fermer si le projet est supprimé. */
  paths: string[];
}

/**
 * Menu « ⋮ » d'un projet ou d'un dossier de travail (et « + » de la sous-barre) : fichiers, tout ce qu'on peut
 * créer (session, terminal, worktree d'un projet git, agent, workflow), les pages du projet, puis la gestion :
 * renommer, archiver, supprimer un worktree ; modifier, supprimer un projet (administrateurs).
 */
export default function AddMenu({ projectId, project, worktree, canWorktree, onClose }: { projectId: string; project?: AddMenuProject | null; worktree?: AddMenuWorktree | null; canWorktree: boolean; onClose: () => void }) {
  const worktreeId = worktree?.id ?? null;
  const navigate = useNavigate();
  const { showError } = useDialogs();
  const [createTerminal, { loading }] = useMutation<{ createTerminal: { id: string } }>(CREATE_TERMINAL, {
    refetchQueries: ['Sidebar'],
    onCompleted: (res) => {
      onClose();
      navigate(`/terminals/${res.createTerminal.id}`);
    },
    onError: (err) => void showError(err),
  });
  const { openNewSession, openNewWorktree } = useSessionLauncher();
  const { openRenameWorktree } = useRenameWorktree();
  const { deleteWorktree, archiveWorktree, deleteProject } = useDeletions();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  return (
    <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
      <Link to={worktreeId ? `/worktrees/${worktreeId}/files` : `/projects/${projectId}/files`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-folder2-open wb-icon" /> Fichiers
      </Link>
      <div className="wb-pop-sep" />
      <button
        type="button"
        className="wb-pop-item"
        onClick={() => {
          onClose();
          openNewSession({ projectId, worktreeId });
        }}
      >
        <i className="bi bi-chat-dots wb-icon" /> Nouvelle session
      </button>
      <button type="button" className="wb-pop-item" disabled={loading} onClick={() => createTerminal({ variables: { projectId, worktreeId } })}>
        <i className="bi bi-terminal wb-icon" /> {loading ? 'Ouverture…' : 'Nouveau terminal'}
      </button>
      {canWorktree && (
        <button
          type="button"
          className="wb-pop-item"
          onClick={() => {
            onClose();
            openNewWorktree({ projectId });
          }}
        >
          <i className="bi bi-diagram-2 wb-icon" /> Nouveau worktree
        </button>
      )}
      {!worktreeId && (
        <>
          <Link to={`/projects/${projectId}/agents?new=1`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-robot wb-icon" /> Nouvel agent
          </Link>
          <Link to={`/projects/${projectId}/workflows?new=1`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-diagram-3 wb-icon" /> Nouveau workflow
          </Link>
          <div className="wb-pop-sep" />
          <Link to={`/projects/${projectId}/tasks`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-check2-square wb-icon" /> Tâches
          </Link>
          <Link to={`/projects/${projectId}/vault`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-shield-lock wb-icon" /> Coffre
          </Link>
          <Link to={`/projects/${projectId}/context`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-journal-text wb-icon" /> Contexte
          </Link>
          <Link to={`/projects/${projectId}/agents`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-robot wb-icon" /> Agents
          </Link>
          <Link to={`/projects/${projectId}/workflows`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-diagram-3 wb-icon" /> Workflows
          </Link>
          <Link to={`/projects/${projectId}/history`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-clock-history wb-icon" /> Historique
          </Link>
        </>
      )}
      {project?.canManage && (
        <>
          <div className="wb-pop-sep" />
          <Link to={`/projects/${projectId}/edit`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-pencil wb-icon" /> Modifier le projet
          </Link>
          <button
            type="button"
            className="wb-pop-item danger"
            onClick={() => {
              onClose();
              void deleteProject(project);
            }}
          >
            <i className="bi bi-trash wb-icon" /> Supprimer le projet
          </button>
        </>
      )}
      {worktree && (
        <>
          <div className="wb-pop-sep" />
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              openRenameWorktree(worktree);
            }}
          >
            <i className="bi bi-pencil wb-icon" /> Renommer le worktree
          </button>
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              void archiveWorktree(worktree);
            }}
          >
            <i className="bi bi-archive wb-icon" /> Archiver le worktree
          </button>
          <button
            type="button"
            className="wb-pop-item danger"
            onClick={() => {
              onClose();
              void deleteWorktree(worktree);
            }}
          >
            <i className="bi bi-trash wb-icon" /> Supprimer le worktree
          </button>
        </>
      )}
    </div>
  );
}
