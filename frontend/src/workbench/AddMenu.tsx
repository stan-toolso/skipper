import { useMutation } from '@apollo/client';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { useSessionLauncher } from '../components/SessionLauncher';
import { CREATE_TERMINAL, STOP_SESSION } from '../graphql/operations';
import { useRenameSession } from './RenameSession';
import { useDeletions } from './useDeletions';
import type { SessionStatus } from '../graphql/operations';

/** Session dont le menu est ouvert, avec l'identifiant technique de son dossier (pour y ouvrir un terminal). */
export interface AddMenuSession {
  id: string;
  name: string;
  status: SessionStatus;
  worksessionId: string | null;
  /** Projet git : une branche à supprimer éventuellement avec la session. */
  branch: string | null;
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
 * Menu « ⋮ » d'un projet (nouvelle session, workflow, pages du projet, modification et suppression pour les
 * administrateurs) ou d'une session (ouvrir, ses fichiers, un terminal dans son dossier, arrêter, renommer,
 * archiver, supprimer). Le « + » de la sous-barre ouvre le même menu pour le dossier affiché.
 */
export default function AddMenu({ projectId, project, session, onClose }: { projectId: string; project?: AddMenuProject | null; session?: AddMenuSession | null; onClose: () => void }) {
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
  const [stopSession] = useMutation(STOP_SESSION, { refetchQueries: ['Sidebar'], onError: (err) => void showError(err) });
  const { openNewSession } = useSessionLauncher();
  const { openRenameSession } = useRenameSession();
  const { archiveSession, deleteSession, deleteProject } = useDeletions();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  if (session) {
    return (
      <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
        <Link to={`/sessions/${session.id}`} className="wb-pop-item" onClick={onClose}>
          <i className="bi bi-box-arrow-in-right wb-icon" /> Ouvrir
        </Link>
        <Link to={`/sessions/${session.id}/files`} className="wb-pop-item" onClick={onClose}>
          <i className="bi bi-folder2-open wb-icon" /> Fichiers
        </Link>
        {session.worksessionId && (
          <button type="button" className="wb-pop-item" disabled={loading} onClick={() => createTerminal({ variables: { projectId, worksessionId: session.worksessionId } })}>
            <i className="bi bi-terminal wb-icon" /> {loading ? 'Ouverture…' : 'Nouveau terminal'}
          </button>
        )}
        <div className="wb-pop-sep" />
        {session.status === 'RUNNING' && (
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              void stopSession({ variables: { id: session.id } });
            }}
          >
            <i className="bi bi-stop-circle wb-icon" /> Arrêter
          </button>
        )}
        <button
          type="button"
          className="wb-pop-item"
          onClick={() => {
            onClose();
            openRenameSession(session);
          }}
        >
          <i className="bi bi-pencil wb-icon" /> Renommer
        </button>
        <button
          type="button"
          className="wb-pop-item"
          onClick={() => {
            onClose();
            void archiveSession(session);
          }}
        >
          <i className="bi bi-archive wb-icon" /> Archiver
        </button>
        <button
          type="button"
          className="wb-pop-item danger"
          onClick={() => {
            onClose();
            void deleteSession(session);
          }}
        >
          <i className="bi bi-trash wb-icon" /> Supprimer
        </button>
      </div>
    );
  }
  return (
    <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
      <Link to={`/projects/${projectId}/files`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-folder2-open wb-icon" /> Fichiers
      </Link>
      <div className="wb-pop-sep" />
      <button
        type="button"
        className="wb-pop-item"
        onClick={() => {
          onClose();
          openNewSession({ projectId });
        }}
      >
        <i className="bi bi-chat-dots wb-icon" /> Nouvelle session
      </button>
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
      <Link to={`/projects/${projectId}/workflows`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-diagram-3 wb-icon" /> Workflows
      </Link>
      <Link to={`/projects/${projectId}/history`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-clock-history wb-icon" /> Historique
      </Link>
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
    </div>
  );
}
