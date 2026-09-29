import { useQuery } from '@apollo/client';
import { Alert, Button, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { PROJECTS, type Project } from '../graphql/operations';
import { useSessionLauncher } from '../components/SessionLauncher';

export default function ProjectsPage() {
  const { data, loading, error } = useQuery<{ projects: Project[] }>(PROJECTS, { pollInterval: 10000 });
  const { openNewSession } = useSessionLauncher();

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h1 className="h3 mb-0">Projets</h1>
        <Button as={Link as any} to="/projects/new" size="sm">
          Nouveau projet
        </Button>
      </div>

      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <Spinner animation="border" size="sm" />}

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
