import type { ReactNode } from 'react';
import { Button, Nav } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useSessionLauncher } from './SessionLauncher';

export type ProjectTab = 'overview' | 'tasks' | 'context' | 'vault' | 'agents' | 'workflows' | 'history';

const TABS: { key: ProjectTab; label: string; path: string; icon: string; title?: string }[] = [
  { key: 'overview', label: 'Aperçu', path: '', icon: 'bi-folder2-open' },
  { key: 'tasks', label: 'Tâches', path: '/tasks', icon: 'bi-check2-square' },
  { key: 'context', label: 'Contexte', path: '/context', icon: 'bi-journal-text', title: 'Bibliothèque d’instructions consultée par les agents' },
  { key: 'vault', label: 'Coffre', path: '/vault', icon: 'bi-shield-lock', title: 'Serveurs, bases, API, sites et comptes utilisables par les agents' },
  { key: 'agents', label: 'Agents', path: '/agents', icon: 'bi-robot', title: 'Agents : configurations réutilisables et planifiables' },
  { key: 'workflows', label: 'Workflows', path: '/workflows', icon: 'bi-diagram-3', title: 'Workflows : enchaînements d’agents, de sessions et de tâches' },
  { key: 'history', label: 'Historique', path: '/history', icon: 'bi-clock-history', title: 'Sessions et work sessions archivées' },
];

export interface ProjectHeaderProject {
  id: string;
  name: string;
  description?: string | null;
  myRole?: 'ADMIN' | 'MEMBER' | 'VIEWER';
}

/**
 * En-tête commun des pages d'un projet : retour à la liste, nom, description, actions (nouvelle session, modifier,
 * actions propres à la page), puis la barre d'onglets qui mène aux pages du projet (aperçu, tâches, contexte, coffre…).
 * Les onglets sont des liens : chaque page garde sa route et son onglet du workbench.
 */
export default function ProjectHeader({ project, active, actions }: { project: ProjectHeaderProject; active: ProjectTab; actions?: ReactNode }) {
  const { openNewSession } = useSessionLauncher();
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  return (
    <>
      <div className="d-flex align-items-start justify-content-between flex-wrap gap-2 mb-2">
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <Link to="/projects" className="small">
            ← Projets
          </Link>
          <h1 className="h3 mb-0">{project.name}</h1>
          {project.description && <div className="text-secondary">{project.description}</div>}
        </div>
        <div className="d-flex gap-2 flex-wrap align-items-center">
          {canWrite && (
            <Button size="sm" onClick={() => openNewSession({ projectId: project.id })}>
              <i className="bi bi-plus-lg me-1" /> Nouvelle session
            </Button>
          )}
          {project.myRole === 'ADMIN' && (
            <Button as={Link as any} to={`/projects/${project.id}/edit`} size="sm" variant="outline-secondary">
              Modifier
            </Button>
          )}
          {actions}
        </div>
      </div>
      <Nav variant="tabs" className="project-tabs mb-3" activeKey={active}>
        {TABS.map((t) => (
          <Nav.Item key={t.key}>
            <Nav.Link as={Link as any} to={`/projects/${project.id}${t.path}`} eventKey={t.key} title={t.title}>
              <i className={`bi ${t.icon} me-1`} />
              {t.label}
            </Nav.Link>
          </Nav.Item>
        ))}
      </Nav>
    </>
  );
}
