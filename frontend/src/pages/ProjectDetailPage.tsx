import { useMutation, useQuery } from '@apollo/client';
import { Alert, Button, Card, Col, Form, Row, Spinner, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import StatusBadge from '../components/StatusBadge';
import { useState } from 'react';
import { CREATE_WORKTREE, DELETE_PROJECT, DELETE_WORKTREE, PREPARE_PROJECT_WORKSPACE, PROJECT, PROJECTS, PROJECT_WORKTREES, type Project, type Session, type Worktree } from '../graphql/operations';

/** Worktrees git du projet : liste, création (branche existante ou nouvelle), suppression. */
function WorktreesCard({ projectId }: { projectId: string }) {
  const { data } = useQuery<{ project: { gitUrl: string | null; git: { branch: string; commit: string } | null; worktrees: Worktree[] } | null }>(PROJECT_WORKTREES, { variables: { id: projectId }, pollInterval: 5000 });
  const [createWorktree, { loading: creating, error: createError }] = useMutation(CREATE_WORKTREE, { refetchQueries: ['ProjectWorktrees', 'Sidebar'] });
  const [deleteWorktree, { error: deleteError }] = useMutation(DELETE_WORKTREE, { refetchQueries: ['ProjectWorktrees', 'Sidebar'] });
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const project = data?.project;
  if (!project?.gitUrl) return null;
  const error = createError ?? deleteError;
  return (
    <Card className="mt-3">
      <Card.Header>Branches de travail (worktrees)</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Le dossier principal suit la branche <code>{project.git?.branch ?? 'par défaut'}</code>. Un worktree extrait une autre branche dans son propre dossier : les agents y travaillent sans gêner le
          dossier principal.
        </p>
        <Table size="sm" className="mb-3">
          <tbody>
            {project.worktrees.length === 0 && (
              <tr>
                <td className="text-secondary">Aucun worktree.</td>
              </tr>
            )}
            {project.worktrees.map((w) => (
              <tr key={w.id}>
                <td>
                  <i className="bi bi-diagram-2 me-1" />
                  <strong>{w.branch}</strong>
                  {w.git && <span className="text-secondary"> · {w.git.commit}</span>}
                  {!w.exists && <span className="text-danger"> · dossier absent</span>}
                  <div className="text-secondary">
                    <code>{w.path}</code>
                  </div>
                </td>
                <td className="text-end text-nowrap">
                  <Button as={Link as any} to={`/sessions/new?projectId=${projectId}&worktreeId=${w.id}`} size="sm" variant="outline-primary" className="me-1">
                    Session
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => {
                      const deleteBranch = window.confirm(`Supprimer le worktree « ${w.branch} » ?\n\nOK : supprimer le dossier et la branche locale.\nAnnuler : ne rien faire.`);
                      if (deleteBranch) deleteWorktree({ variables: { id: w.id, deleteBranch: window.confirm('Supprimer aussi la branche locale ? (Annuler = garder la branche)') } });
                    }}
                  >
                    Supprimer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Form
          className="d-flex gap-2 align-items-end flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!branch.trim()) return;
            createWorktree({ variables: { projectId, branch: branch.trim(), baseRef: baseRef.trim() || null } }).then(() => {
              setBranch('');
              setBaseRef('');
            });
          }}
        >
          <Form.Group>
            <Form.Label className="mb-1">Branche</Form.Label>
            <Form.Control size="sm" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="ex. feature/contact (créée si absente)" style={{ width: 260 }} />
          </Form.Group>
          <Form.Group>
            <Form.Label className="mb-1">À partir de</Form.Label>
            <Form.Control size="sm" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder="HEAD par défaut" style={{ width: 160 }} />
          </Form.Group>
          <Button type="submit" size="sm" disabled={creating || !branch.trim()}>
            {creating ? 'Création…' : 'Créer le worktree'}
          </Button>
        </Form>
        {error && (
          <Alert variant="danger" className="mt-2 mb-0">
            {error.message}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}

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
          <Button as={Link as any} to={`/projects/${project.id}/tasks`} size="sm" variant="outline-primary">
            Tâches
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
            <Card.Header>Dossier de travail</Card.Header>
            <Card.Body className="small">
              <dl className="row mb-0">
                <dt className="col-4">Identifiant</dt>
                <dd className="col-8">
                  <code>{project.slug}</code>
                </dd>
                <dt className="col-4">Emplacement</dt>
                <dd className="col-8 text-break">
                  <code>{project.workspacePath}</code>
                </dd>
                <dt className="col-4">État</dt>
                <dd className="col-8">
                  {project.workspaceExists && project.gitUrl && !project.git ? (
                    <>
                      <span className="text-warning">dépôt non récupéré</span>{' '}
                      <Button size="sm" variant="outline-primary" className="ms-2" disabled={preparing} onClick={() => prepareWorkspace({ variables: { id } })}>
                        {preparing ? 'Récupération…' : 'Récupérer le dépôt'}
                      </Button>
                      <div className="text-secondary mt-1">Le dossier existe mais ne contient pas le dépôt. S'il est vide, la récupération le clone.</div>
                    </>
                  ) : project.workspaceExists ? (
                    <span className="text-success">prêt</span>
                  ) : (
                    <>
                      <span className="text-warning">absent</span>{' '}
                      <Button size="sm" variant="outline-primary" className="ms-2" disabled={preparing} onClick={() => prepareWorkspace({ variables: { id } })}>
                        {preparing ? 'Création…' : 'Créer le dossier'}
                      </Button>
                    </>
                  )}
                </dd>
                <dt className="col-4">Dépôt git</dt>
                <dd className="col-8 text-break">{project.gitUrl ?? 'aucun'}</dd>
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
            <Card.Header>Instructions permanentes pour les agents</Card.Header>
            <Card.Body>
              <div className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto' }}>
                {project.systemPrompt || <span className="text-secondary">Aucune instruction permanente. Ajoutez-en via « Modifier » : conventions, contexte métier, ce qu'il ne faut pas faire…</span>}
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <WorktreesCard projectId={project.id} />

      <h2 className="h5 mt-4">Sessions</h2>
      <Table hover responsive size="sm" className="align-middle">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Type</th>
            <th>Statut</th>
            <th>Branche</th>
            <th>Créée</th>
          </tr>
        </thead>
        <tbody>
          {project.sessions.length === 0 && (
            <tr>
              <td colSpan={5} className="text-secondary">
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
              <td className="text-secondary small">{s.worktree ? s.worktree.branch : '—'}</td>
              <td className="text-secondary small">{new Date(s.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
