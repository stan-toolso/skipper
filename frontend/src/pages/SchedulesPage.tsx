import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Form } from 'react-bootstrap';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import ScheduleModal from '../components/ScheduleModal';
import { RunDots, RunHistory, RunStatus } from '../components/ScheduleRuns';
import '../components/schedules.css';
import { PROJECTS, RUN_SESSION_SCHEDULE_NOW, SESSION_SCHEDULES, SET_SESSION_SCHEDULE_ENABLED, type Project, type ScheduleListItem } from '../graphql/operations';
import { browserTimeZone, describeCron } from '../lib/cron';
import { timeAgo } from '../lib/humanize';
import { isRunProblem, timeUntil } from '../lib/schedules';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

type Filter = 'all' | 'active' | 'paused' | 'attention';

const FILTERS: { key: Filter; label: string; title: string }[] = [
  { key: 'all', label: 'Toutes', title: 'Toutes les planifications' },
  { key: 'active', label: 'Actives', title: 'Planifications en marche' },
  { key: 'paused', label: 'En pause', title: 'Planifications désactivées' },
  { key: 'attention', label: 'À surveiller', title: 'Dernière exécution bloquée, en erreur ou hors délai' },
];

const nextLabel = (iso: string) => `${new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${timeUntil(iso)})`;

/** Une planification : nom, fréquence en clair, prochaine échéance, dernières exécutions, actions directes. */
function ScheduleCard({ item, showProject, onEdit }: { item: ScheduleListItem; showProject: boolean; onEdit: () => void }) {
  const { showError } = useDialogs();
  const [open, setOpen] = useState(false);
  const [runNow, { loading: launching }] = useMutation(RUN_SESSION_SCHEDULE_NOW, { refetchQueries: ['SessionSchedules'] });
  const [toggle, { loading: toggling }] = useMutation(SET_SESSION_SCHEDULE_ENABLED, { refetchQueries: ['SessionSchedules'] });
  const canWrite = item.project.myRole === 'ADMIN' || item.project.myRole === 'MEMBER';
  const last = item.runs[0] ?? null;
  const problem = Boolean(last && isRunProblem(last.status));
  const working = item.session.status === 'RUNNING' && item.session.activity === 'BUSY';
  const running = last?.status === 'RUNNING' || working;
  const tz = item.timezone !== browserTimeZone() ? ` (${item.timezone})` : '';
  const sessionNamed = item.customName && item.customName !== item.session.name;
  return (
    <div className={`sch-card${item.enabled ? ' on' : ' paused'}${problem ? ' problem' : ''}`}>
      <div className="sch-card-head">
        <div className="sch-card-main">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <Link to={`/sessions/${item.sessionId}`} className="sch-card-title" title="Ouvrir la session de cette planification (transcript de toutes ses exécutions)">
              <i className="bi bi-alarm me-1 text-secondary" />
              {item.name}
            </Link>
            {!item.enabled && (
              <Badge bg="secondary" className="fw-normal">
                en pause
              </Badge>
            )}
            {item.session.pendingRequestCount > 0 && (
              <Link to={`/sessions/${item.sessionId}`} className="badge bg-warning text-dark text-decoration-none fw-normal" title="L'agent attend une réponse">
                {item.session.pendingRequestCount} demande{item.session.pendingRequestCount > 1 ? 's' : ''}
              </Link>
            )}
          </div>
          <div className="sch-card-meta">
            <span title={`cron ${item.cron} · fuseau ${item.timezone}`}>
              <i className="bi bi-arrow-repeat me-1" />
              {describeCron(item.cron)}
              {tz}
            </span>
            {item.enabled && item.nextRunAt && (
              <span>
                <i className="bi bi-clock me-1" />
                prochaine : {nextLabel(item.nextRunAt)}
              </span>
            )}
            {showProject && (
              <Link to={`/projects/${item.project.id}/schedules`} className="text-reset">
                <i className="bi bi-folder2 me-1" />
                {item.project.name}
              </Link>
            )}
            {sessionNamed && (
              <span title="Session qui exécute cette planification">
                <i className="bi bi-chat-dots me-1" />
                {item.session.name}
              </span>
            )}
            {item.session.owner && <span title="Les exécutions utilisent les comptes et le budget de cette personne">{item.session.owner.name}</span>}
          </div>
          <div className="sch-card-prompt" title={item.prompt}>
            {item.prompt}
          </div>
        </div>
        <div className="sch-card-side">
          <div className="sch-card-actions">
            {canWrite && (
              <>
                <Button size="sm" variant="outline-primary" disabled={launching || running} title={running ? "L'agent travaille déjà" : "Exécute la planification maintenant, sans attendre l'échéance"} onClick={() => void runNow({ variables: { id: item.sessionId } }).catch(showError)}>
                  <i className="bi bi-play-fill me-1" />
                  Exécuter
                </Button>
                <Button size="sm" variant="outline-secondary" disabled={toggling} title={item.enabled ? 'Mettre en pause : plus aucune échéance jusqu’à la reprise' : 'Reprendre : la prochaine échéance est recalculée depuis maintenant'} onClick={() => void toggle({ variables: { id: item.sessionId, enabled: !item.enabled } }).catch(showError)}>
                  <i className={`bi ${item.enabled ? 'bi-pause-fill' : 'bi-play-circle'} me-1`} />
                  {item.enabled ? 'Pause' : 'Reprendre'}
                </Button>
                <Button size="sm" variant="outline-secondary" title="Modifier la planification" onClick={onEdit}>
                  <i className="bi bi-pencil" />
                </Button>
              </>
            )}
          </div>
          <div className="sch-card-last">
            <RunDots runs={item.runs} />
            <div className="mt-1">
              {running ? (
                <span className="sch-status running">
                  <span className="spinner-border spinner-border-sm" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> en cours
                </span>
              ) : last ? (
                <>
                  <RunStatus run={last} /> {timeAgo(last.startedAt)}
                </>
              ) : (
                'jamais exécutée'
              )}
              {item.runs.length > 0 && (
                <button type="button" className="sch-link ms-2" onClick={() => setOpen(!open)}>
                  {open ? 'Masquer' : 'Historique'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {problem && last?.message && !open && (
        <div className="small mt-2">
          <i className="bi bi-exclamation-triangle me-1" style={{ color: 'var(--cc-yellow)' }} />
          {last.message}
        </div>
      )}
      {open && (
        <div className="sch-card-details">
          <RunHistory runs={item.runs} />
        </div>
      )}
    </div>
  );
}

/** Planifications de sessions : de tous les projets accessibles, ou d'un projet (route /projects/:id/schedules). */
export default function SchedulesPage() {
  const { id: routeProjectId } = useParams();
  const [filterProject, setFilterProject] = useState('');
  const projectId = routeProjectId ?? (filterProject || null);
  const { data, loading, error } = usePollingQuery<{ sessionSchedules: ScheduleListItem[] }>(SESSION_SCHEDULES, { variables: { projectId, runs: 20 }, pollInterval: 15_000 });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS, { variables: { includePersonal: true } });
  const [searchParams, setSearchParams] = useSearchParams();
  // « ?new=1 » (menu du projet dans la sidebar) : ouvre tout de suite la création, puis s'efface de l'adresse.
  const [creating, setCreating] = useState(searchParams.has('new'));
  useEffect(() => {
    if (searchParams.has('new')) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);
  const [editing, setEditing] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const project = routeProjectId ? projectsData?.projects.find((p) => p.id === routeProjectId) : null;
  useTabTitle(project ? `Planifications · ${project.isPersonal ? 'Mon espace' : project.name}` : 'Planifications');
  const writable = (projectsData?.projects ?? []).filter((p) => p.myRole !== 'VIEWER' && (!routeProjectId || p.id === routeProjectId));

  const all = data?.sessionSchedules ?? [];
  const counts = useMemo(
    () => ({
      all: all.length,
      active: all.filter((s) => s.enabled).length,
      paused: all.filter((s) => !s.enabled).length,
      attention: all.filter((s) => s.runs[0] && isRunProblem(s.runs[0].status)).length,
    }),
    [all],
  );
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((s) => {
      if (filter === 'active' && !s.enabled) return false;
      if (filter === 'paused' && s.enabled) return false;
      if (filter === 'attention' && !(s.runs[0] && isRunProblem(s.runs[0].status))) return false;
      return !q || [s.name, s.prompt, s.session.name, s.project.name].some((v) => v.toLowerCase().includes(q));
    });
  }, [all, filter, search]);
  const soonest = all.filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  const editingItem = editing ? all.find((s) => s.sessionId === editing) : null;

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  return (
    <>
      {project && <ProjectHeader project={project} active="schedules" />}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        {!project && <h1 className="h3 mb-0">Planifications</h1>}
        <div className="d-flex gap-2 align-items-center flex-wrap ms-auto">
          <ButtonGroup size="sm" className="sch-filters">
            {FILTERS.map((f) => (
              <Button key={f.key} variant={filter === f.key ? 'secondary' : 'outline-secondary'} title={f.title} onClick={() => setFilter(f.key)}>
                {f.label}
                {counts[f.key] > 0 && <span className="ms-1 opacity-75">{counts[f.key]}</span>}
              </Button>
            ))}
          </ButtonGroup>
          {!routeProjectId && (
            <Form.Select size="sm" value={filterProject} onChange={(e) => setFilterProject(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Tous les projets</option>
              {(projectsData?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.isPersonal ? 'Mon espace' : p.name}
                </option>
              ))}
            </Form.Select>
          )}
          <Form.Control size="sm" placeholder="Filtrer…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 160 }} />
          {writable.length > 0 && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <i className="bi bi-plus-lg me-1" /> Nouvelle planification
            </Button>
          )}
        </div>
      </div>
      <p className="text-secondary small">
        Une planification envoie une instruction à sa session à heures fixes. {counts.active} active{counts.active > 1 ? 's' : ''}
        {soonest?.nextRunAt ? (
          <>
            {' '}
            · prochaine : <strong>{soonest.name}</strong> {timeUntil(soonest.nextRunAt)}
          </>
        ) : null}
        {counts.attention > 0 && (
          <>
            {' '}
            ·{' '}
            <button type="button" className="sch-link" onClick={() => setFilter('attention')}>
              {counts.attention} à surveiller
            </button>
          </>
        )}
        .
      </p>
      {shown.length === 0 ? (
        <div className="text-secondary fst-italic">
          {all.length === 0 ? 'Aucune planification. Créez-en une ici, ou depuis une session avec le bouton « Planifier ».' : 'Aucune planification ne correspond.'}
        </div>
      ) : (
        <div className="sch-list">
          {shown.map((s) => (
            <ScheduleCard key={s.sessionId} item={s} showProject={!routeProjectId} onEdit={() => setEditing(s.sessionId)} />
          ))}
        </div>
      )}
      {creating && <ScheduleModal projects={writable.map((p) => ({ id: p.id, name: p.isPersonal ? 'Mon espace' : p.name, defaultPermissionMode: p.defaultPermissionMode }))} onClose={() => setCreating(false)} />}
      {editingItem && <ScheduleModal session={editingItem.session} onClose={() => setEditing(null)} />}
    </>
  );
}
