import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Form, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import PageLoading from '../components/PageLoading';
import { useSessionLauncher } from '../components/SessionLauncher';
import { PROJECTS, type Project } from '../graphql/operations';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

export default function ProjectsPage() {
  const { user } = useAuth();
  useTabTitle('Projets');
  // Un super administrateur voit tous les projets ; il peut se limiter à ceux dont il est membre.
  const [all, setAll] = useState(true);
  const superAdmin = Boolean(user?.isSuperAdmin);
  const { data, loading, error } = usePollingQuery<{ projects: Project[] }>(PROJECTS, { variables: { all: superAdmin ? all : null }, pollInterval: 10_000 });
  const { openNewSession } = useSessionLauncher();

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <h1 className="h3 mb-0">Projets</h1>
        <div className="d-flex align-items-center gap-3">
          {superAdmin && <Form.Check type="switch" id="projects-all" label="Tous les projets" checked={all} onChange={(e) => setAll(e.target.checked)} title="Super administrateur : afficher aussi les projets dont vous n'êtes pas membre" />}
          <Button as={Link as any} to="/projects/new" size="sm">
            Nouveau projet
          </Button>
        </div>
      </div>

      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <PageLoading />}

      {data && (
        <Table hover responsive size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Dépôt git</th>
              <th>Dossier de travail</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.projects.length === 0 && (
              <tr>
                <td colSpan={4} className="text-secondary">
                  Aucun projet pour l'instant. Un projet regroupe un dossier de travail, des instructions permanentes et les sessions des agents.
                </td>
              </tr>
            )}
            {data.projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  {!p.isMember && (
                    <Badge bg="secondary" className="ms-2" title="Vous n'êtes pas membre : accès de super administrateur">
                      non membre
                    </Badge>
                  )}
                  {p.description && <div className="small text-secondary">{p.description}</div>}
                </td>
                <td className="small">
                  {p.gitUrl ?? <span className="text-secondary">aucun</span>}
                  {p.git && (
                    <div className="text-secondary">
                      branche {p.git.branch} · {p.git.commit}
                    </div>
                  )}
                </td>
                <td className="small">
                  {p.workspaceExists ? (
                    <span className="text-success">
                      <i className="bi bi-check-circle me-1" />
                      prêt
                    </span>
                  ) : (
                    <span className="text-warning">
                      <i className="bi bi-exclamation-circle me-1" />à préparer
                    </span>
                  )}
                </td>
                <td className="text-end">
                  <Button size="sm" variant="outline-primary" onClick={() => openNewSession({ projectId: p.id })}>
                    Nouvelle session
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
