import { useMutation } from '@apollo/client';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { useSessionLauncher } from '../components/SessionLauncher';
import { CREATE_TERMINAL } from '../graphql/operations';
import { useRenameWorksession } from './RenameWorksession';
import { useDeletions } from './useDeletions';

export interface AddMenuWorksession {
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
 * créer (work session au niveau du projet ; session et terminal dans une work session ; agent, workflow), les pages du projet, puis la gestion :
 * renommer, archiver, supprimer une work session ; modifier, supprimer un projet (administrateurs).
 */
export default function AddMenu({ projectId, project, worksession, canWorksession, onClose }: { projectId: string; project?: AddMenuProject | null; worksession?: AddMenuWorksession | null; canWorksession: boolean; onClose: () => void }) {
  const worksessionId = worksession?.id ?? null;
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
  const { openNewSession, openNewWorksession } = useSessionLauncher();
  const { openRenameWorksession } = useRenameWorksession();
  const { deleteWorksession, archiveWorksession, deleteProject } = useDeletions();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  return (
    <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
      <Link to={worksessionId ? `/worksessions/${worksessionId}/files` : `/projects/${projectId}/files`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-folder2-open wb-icon" /> Fichiers
      </Link>
      <div className="wb-pop-sep" />
      {worksessionId ? (
        <>
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              openNewSession({ projectId, worksessionId });
            }}
          >
            <i className="bi bi-chat-dots wb-icon" /> Nouvelle session ici
          </button>
          <button type="button" className="wb-pop-item" disabled={loading} onClick={() => createTerminal({ variables: { projectId, worksessionId } })}>
            <i className="bi bi-terminal wb-icon" /> {loading ? 'Ouverture…' : 'Nouveau terminal ici'}
          </button>
        </>
      ) : (
        canWorksession && (
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              openNewWorksession({ projectId });
            }}
          >
            <i className="bi bi-layers wb-icon" /> Nouvelle work session
          </button>
        )
      )}
      {!worksessionId && (
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
      {worksession && (
        <>
          <div className="wb-pop-sep" />
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              openRenameWorksession(worksession);
            }}
          >
            <i className="bi bi-pencil wb-icon" /> Renommer la work session
          </button>
          <button
            type="button"
            className="wb-pop-item"
            onClick={() => {
              onClose();
              void archiveWorksession(worksession);
            }}
          >
            <i className="bi bi-archive wb-icon" /> Archiver la work session
          </button>
          <button
            type="button"
            className="wb-pop-item danger"
            onClick={() => {
              onClose();
              void deleteWorksession(worksession);
            }}
          >
            <i className="bi bi-trash wb-icon" /> Supprimer la work session
          </button>
        </>
      )}
    </div>
  );
}
