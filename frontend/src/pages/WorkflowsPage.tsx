import { useMutation, useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Form, Modal } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RunStatusBadge } from '../components/automation/RunBadges';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import { CREATE_WORKFLOW, UPDATE_WORKFLOW, WORKFLOWS, type Workflow } from '../graphql/automation';
import { PROJECTS, type Project } from '../graphql/operations';
import { fmtDateTime } from '../lib/automation';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { emptyDefinition } from '../lib/workflowGraph';
import { useTabTitle } from '../workbench/TabsContext';
import '../components/automation/automation.css';

function CreateWorkflowModal({ projects, projectId: fixed, onClose, onCreated }: { projects: Project[]; projectId: string | null; onClose: () => void; onCreated: (w: Workflow) => void }) {
  const [projectId, setProjectId] = useState(fixed ?? projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [create, { loading, error }] = useMutation<{ createWorkflow: Workflow }>(CREATE_WORKFLOW, { refetchQueries: ['Workflows'] });
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await create({ variables: { input: { projectId, name: name.trim(), description: description.trim(), definition: emptyDefinition(), enabled: true } } }).catch(() => null);
          if (res?.data) onCreated(res.data.createWorkflow);
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Nouveau workflow</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {!fixed && (
            <Form.Group className="mb-3">
              <Form.Label>Projet</Form.Label>
              <Form.Select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
          <Form.Group className="mb-3">
            <Form.Label>Nom</Form.Label>
            <Form.Control value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Revue puis correction" />
          </Form.Group>
          <Form.Group>
            <Form.Label>Description</Form.Label>
            <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optionnel" />
          </Form.Group>
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !name.trim() || !projectId}>
            Créer et ouvrir l'éditeur
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Liste des workflows : de tous les projets accessibles, ou d'un projet (route /projects/:id/workflows). */
export default function WorkflowsPage() {
  const { id: routeProjectId } = useParams();
  const navigate = useNavigate();
  const { showError } = useDialogs();
  const [filterProject, setFilterProject] = useState('');
  const projectId = routeProjectId ?? (filterProject || null);
  const { data, loading, error } = usePollingQuery<{ workflows: Workflow[] }>(WORKFLOWS, { variables: { projectId }, pollInterval: 10_000 });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const [toggle] = useMutation(UPDATE_WORKFLOW);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const project = routeProjectId ? projectsData?.projects.find((p) => p.id === routeProjectId) : null;
  useTabTitle(project ? `Workflows · ${project.name}` : 'Workflows');
  const writable = (projectsData?.projects ?? []).filter((p) => p.myRole !== 'VIEWER' && (!routeProjectId || p.id === routeProjectId));
  const workflows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.workflows ?? []).filter((w) => !q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q));
  }, [data, search]);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  return (
    <>
      {project && (
        <Link to={`/projects/${project.id}`} className="small">
          ← {project.name}
        </Link>
      )}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <h1 className="h3 mb-0">Workflows</h1>
        <div className="d-flex gap-2 align-items-center">
          {!routeProjectId && (
            <Form.Select size="sm" value={filterProject} onChange={(e) => setFilterProject(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Tous les projets</option>
              {(projectsData?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Form.Select>
          )}
          <Form.Control size="sm" placeholder="Filtrer…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 180 }} />
          {writable.length > 0 && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <i className="bi bi-plus-lg me-1" /> Nouveau workflow
            </Button>
          )}
        </div>
      </div>
      <p className="text-secondary small">
        Un workflow enchaîne des <Link to="/agents">agents</Link>, des sessions et des tâches selon un graphe à branches, lancé à la main, par planification ou quand une tâche est créée.
      </p>
      {workflows.length === 0 ? (
        <div className="text-secondary fst-italic">Aucun workflow{search ? ' ne correspond' : ''}.</div>
      ) : (
        <div className="auto-grid">
          {workflows.map((w) => {
            const errors = w.issues.filter((i) => i.severity === 'error').length;
            const warnings = w.issues.length - errors;
            return (
              <div key={w.id} className="auto-card">
                <div className="d-flex justify-content-between align-items-start gap-2">
                  <Link to={`/workflows/${w.id}`} className="auto-card-title">
                    <i className="bi bi-diagram-3 me-1 text-secondary" />
                    {w.name}
                  </Link>
                  <Form.Check type="switch" id={`wf-enabled-${w.id}`} title={w.enabled ? 'Actif : planification et déclencheurs en marche' : 'En pause : planification et déclencheurs ignorés'} checked={w.enabled} onChange={(e) => void toggle({ variables: { id: w.id, input: { enabled: e.target.checked } } }).catch(showError)} />
                </div>
                {w.description && <div className="small text-secondary">{w.description}</div>}
                <div className="auto-card-meta mt-auto">
                  {!routeProjectId && (
                    <Link to={`/projects/${w.project.id}/workflows`} className="text-reset">
                      <i className="bi bi-folder2 me-1" />
                      {w.project.name}
                    </Link>
                  )}
                  <span>{w.definition.nodes.length} nœud{w.definition.nodes.length > 1 ? 's' : ''}</span>
                  {errors > 0 && <Badge bg="danger">{errors} erreur{errors > 1 ? 's' : ''}</Badge>}
                  {warnings > 0 && <Badge bg="warning" text="dark">{warnings} avert.</Badge>}
                  {w.definition.nodes.some((n) => n.type === 'trigger' && n.event === 'task.created') && (
                    <span title="Déclenché par les tâches créées">
                      <i className="bi bi-lightning-charge me-1" />
                      tâches
                    </span>
                  )}
                  {w.schedule && (
                    <span title={`cron ${w.schedule.cron} (${w.schedule.timezone})`}>
                      <i className="bi bi-alarm me-1" />
                      {w.schedule.enabled && w.enabled ? (w.schedule.nextRunAt ? `prochaine ${fmtDateTime(w.schedule.nextRunAt)}` : 'planifié') : 'planification en pause'}
                    </span>
                  )}
                  {w.lastRun ? (
                    <span>
                      <RunStatusBadge status={w.lastRun.status} /> <span className="ms-1">{timeAgo(w.lastRun.createdAt)}</span>
                    </span>
                  ) : (
                    <span>jamais exécuté</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {creating && <CreateWorkflowModal projects={writable} projectId={routeProjectId ?? null} onClose={() => setCreating(false)} onCreated={(w) => navigate(`/workflows/${w.id}`)} />}
    </>
  );
}
