import { useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Form } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AgentEditor from '../components/automation/AgentEditor';
import { RunStatusBadge } from '../components/automation/RunBadges';
import PageLoading from '../components/PageLoading';
import { AGENTS, type Agent } from '../graphql/automation';
import { PROJECTS, PROVIDERS, type Project, type Provider } from '../graphql/operations';
import { fmtDateTime, providerLabel } from '../lib/automation';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import '../components/automation/automation.css';

/** Liste des agents : de tous les projets accessibles, ou d'un projet (route /projects/:id/agents). */
export default function AgentsPage() {
  const { id: routeProjectId } = useParams();
  const navigate = useNavigate();
  const [filterProject, setFilterProject] = useState('');
  const projectId = routeProjectId ?? (filterProject || null);
  const { data, loading, error } = usePollingQuery<{ agents: Agent[] }>(AGENTS, { variables: { projectId }, pollInterval: 10_000 });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const project = routeProjectId ? projectsData?.projects.find((p) => p.id === routeProjectId) : null;
  useTabTitle(project ? `Agents · ${project.name}` : 'Agents');

  const agents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.agents ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
  }, [data, search]);
  const canCreate = (projectsData?.projects ?? []).some((p) => p.myRole !== 'VIEWER' && (!routeProjectId || p.id === routeProjectId));

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
        <h1 className="h3 mb-0">Agents</h1>
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
          {canCreate && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <i className="bi bi-plus-lg me-1" /> Nouvel agent
            </Button>
          )}
        </div>
      </div>
      <p className="text-secondary small">
        Un agent est une configuration réutilisable : un modèle appelé directement ou une session dédiée, un rôle, une instruction à variables. Il s'exécute à la main, par planification ou depuis un{' '}
        <Link to="/workflows">workflow</Link>.
      </p>
      {agents.length === 0 ? (
        <div className="text-secondary fst-italic">Aucun agent{search ? ' ne correspond' : ''}.</div>
      ) : (
        <div className="auto-grid">
          {agents.map((a) => (
            <div key={a.id} className="auto-card">
              <div className="d-flex justify-content-between align-items-start gap-2">
                <Link to={`/agents/${a.id}`} className="auto-card-title">
                  <i className="bi bi-robot me-1 text-secondary" />
                  {a.name}
                </Link>
                <Badge bg="secondary" className="fw-normal">
                  {providerLabel(a.provider, providersData?.providers)}
                </Badge>
              </div>
              {a.description && <div className="small text-secondary">{a.description}</div>}
              <div className="auto-card-meta mt-auto">
                {!routeProjectId && (
                  <Link to={`/projects/${a.project.id}/agents`} className="text-reset">
                    <i className="bi bi-folder2 me-1" />
                    {a.project.name}
                  </Link>
                )}
                {a.schedule && (
                  <span title={`cron ${a.schedule.cron} (${a.schedule.timezone})`}>
                    <i className={`bi bi-alarm me-1 ${a.schedule.enabled ? '' : 'text-secondary'}`} />
                    {a.schedule.enabled ? (a.schedule.nextRunAt ? `prochaine ${fmtDateTime(a.schedule.nextRunAt)}` : 'planifié') : 'planification en pause'}
                  </span>
                )}
                {a.lastRun ? (
                  <span>
                    <RunStatusBadge status={a.lastRun.status} /> <span className="ms-1">{timeAgo(a.lastRun.createdAt)}</span>
                  </span>
                ) : (
                  <span>jamais exécuté</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <AgentEditor projectId={routeProjectId ?? null} onClose={() => setCreating(false)} onSaved={(agent) => navigate(`/agents/${agent.id}`)} />}
    </>
  );
}
