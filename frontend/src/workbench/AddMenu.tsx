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

/**
 * Menu « ⋮ » d'un projet ou d'un dossier de travail (et « + » de la sous-barre) : fichiers, nouvelle session,
 * nouveau terminal, nouveau worktree, pages du projet ; pour un worktree : renommer, archiver, supprimer.
 */
export default function AddMenu({ projectId, worktree, canWorktree, onClose }: { projectId: string; worktree?: AddMenuWorktree | null; canWorktree: boolean; onClose: () => void }) {
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
  const { deleteWorktree, archiveWorktree } = useDeletions();
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
      {canWorktree && !worktreeId && (
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
          <Link to={`/projects/${projectId}/history`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-clock-history wb-icon" /> Historique
          </Link>
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
