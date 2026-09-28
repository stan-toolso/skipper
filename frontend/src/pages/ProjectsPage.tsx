import { useQuery } from '@apollo/client';
import { Alert, Button, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { PROJECTS, type Project } from '../graphql/operations';

export default function ProjectsPage() {
  const { data, loading, error } = useQuery<{ projects: Project[] }>(PROJECTS, { pollInterval: 10000 });

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
              <th>Slug</th>
              <th>Dépôt git</th>
              <th>Workspace</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.projects.length === 0 && (
              <tr>
                <td colSpan={5} className="text-secondary">
                  Aucun projet. Créez-en un pour lancer des sessions.
                </td>
              </tr>
            )}
            {data.projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  {p.description && <div className="small text-secondary">{p.description}</div>}
                </td>
                <td>
                  <code>{p.slug}</code>
                </td>
                <td className="small">
                  {p.gitUrl ?? <span className="text-secondary">—</span>}
                  {p.git && (
                    <div className="text-secondary">
                      {p.git.branch} @ {p.git.commit}
                    </div>
                  )}
                </td>
                <td className="small">
                  {p.workspaceExists ? <span className="text-success">prêt</span> : <span className="text-warning">absent</span>}
                </td>
                <td className="text-end">
                  <Button as={Link as any} to={`/sessions/new?projectId=${p.id}`} size="sm" variant="outline-primary">
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
