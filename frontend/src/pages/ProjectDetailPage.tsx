import { useMutation, useQuery } from '@apollo/client';
import { Alert, Button, Card, Col, Row, Spinner, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import StatusBadge from '../components/StatusBadge';
import { DELETE_PROJECT, PREPARE_PROJECT_WORKSPACE, PROJECT, PROJECTS, type Project, type Session } from '../graphql/operations';

type ProjectWithSessions = Project & { sessions: Session[] };

export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<{ project: ProjectWithSessions | null }>(PROJECT, { variables: { id }, pollInterval: 3000 });
  useTabTitle(data?.project?.name);
  const [prepareWorkspace, { loading: preparing, error: prepareError }] = useMutation(PREPARE_PROJECT_WORKSPACE);
  const [deleteProject, { error: deleteError }] = useMutation(DELETE_PROJECT, {
    refetchQueries: [{ query: PROJECTS }],
    onCompleted: () => navigate('/projects'),
  });

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const project = data?.project;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const actionError = prepareError ?? deleteError;

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div>
          <Link to="/projects" className="small">
            ← Projets
          </Link>
          <h1 className="h3 mb-0">{project.name}</h1>
          {project.description && <div className="text-secondary">{project.description}</div>}
        </div>
        <div className="d-flex gap-2">
          <Button as={Link as any} to={`/sessions/new?projectId=${project.id}`} size="sm">
            Nouvelle session
          </Button>
          <Button as={Link as any} to={`/projects/${project.id}/context`} size="sm" variant="outline-primary">
            Contexte
          </Button>
          <Button as={Link as any} to={`/projects/${project.id}/edit`} size="sm" variant="outline-secondary">
            Modifier
          </Button>
          <Button
            size="sm"
            variant="outline-danger"
            onClick={() => {
              if (window.confirm(`Supprimer le projet « ${project.name} » et ses sessions ? Le dossier sur disque sera conservé.`)) {
                deleteProject({ variables: { id } });
              }
            }}
          >
            Supprimer
          </Button>
        </div>
      </div>

      {actionError && <Alert variant="danger">{actionError.message}</Alert>}

      <Row className="g-3 mb-4">
        <Col md={5}>
          <Card className="h-100">
            <Card.Header>Workspace</Card.Header>
            <Card.Body className="small">
              <dl className="row mb-0">
                <dt className="col-4">Slug</dt>
                <dd className="col-8">
                  <code>{project.slug}</code>
                </dd>
                <dt className="col-4">Dossier</dt>
                <dd className="col-8 text-break">
                  <code>{project.workspacePath}</code>
                </dd>
                <dt className="col-4">État</dt>
                <dd className="col-8">
                  {project.workspaceExists ? (
                    <span className="text-success">prêt</span>
                  ) : (
                    <>
                      <span className="text-warning">absent</span>{' '}
                      <Button size="sm" variant="outline-primary" className="ms-2" disabled={preparing} onClick={() => prepareWorkspace({ variables: { id } })}>
                        {preparing ? 'Préparation…' : 'Préparer'}
                      </Button>
                    </>
                  )}
                </dd>
                <dt className="col-4">Dépôt git</dt>
                <dd className="col-8 text-break">{project.gitUrl ?? '—'}</dd>
                <dt className="col-4">Branche</dt>
                <dd className="col-8">
                  {project.git ? (
                    <>
                      {project.git.branch} <span className="text-secondary">@ {project.git.commit}</span>
                    </>
                  ) : (
                    project.gitBranch ?? '—'
                  )}
                </dd>
              </dl>
            </Card.Body>
          </Card>
        </Col>
        <Col md={7}>
          <Card className="h-100">
            <Card.Header>Prompt système</Card.Header>
            <Card.Body>
              <pre className="mb-0 small" style={{ whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto' }}>
                {project.systemPrompt || <span className="text-secondary">Aucun prompt système.</span>}
              </pre>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <h2 className="h5">Sessions</h2>
      <Table hover responsive size="sm" className="align-middle">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Type</th>
            <th>Statut</th>
            <th>Créée</th>
          </tr>
        </thead>
        <tbody>
          {project.sessions.length === 0 && (
            <tr>
              <td colSpan={4} className="text-secondary">
                Aucune session pour ce projet.
              </td>
            </tr>
          )}
          {project.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to={`/sessions/${s.id}`}>{s.name}</Link>
              </td>
              <td>
                <code>{s.provider}</code>
              </td>
              <td>
                <StatusBadge status={s.status} pendingRequests={s.pendingRequestCount} />
              </td>
              <td className="text-secondary small">{new Date(s.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
