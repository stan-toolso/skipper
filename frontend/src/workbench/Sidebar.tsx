import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { CREATE_TERMINAL, REQUESTS, SIDEBAR, type HumanRequest, type Session, type SessionActivity, type SessionStatus, type Terminal } from '../graphql/operations';
import { sessionStateHint } from '../lib/humanize';

interface SidebarProject {
  id: string;
  name: string;
  slug: string;
  sessions: Pick<Session, 'id' | 'name' | 'status' | 'activity' | 'pendingRequestCount'>[];
  terminals: Pick<Terminal, 'id' | 'name' | 'status'>[];
}

function statusDot(status: SessionStatus, activity: SessionActivity | null): { cls: string; title: string } {
  if (status === 'RUNNING') return activity === 'BUSY' ? { cls: 'busy', title: "L'agent travaille" } : { cls: 'idle', title: "L'agent attend vos instructions" };
  if (status === 'FAILED') return { cls: 'failed', title: 'Terminée avec une erreur' };
  if (status === 'COMPLETED') return { cls: 'done', title: 'Terminée' };
  if (status === 'STOPPED' || status === 'INTERRUPTED') return { cls: 'stopped', title: status === 'STOPPED' ? 'Arrêtée' : 'Interrompue par un redémarrage' };
  return { cls: 'pending', title: 'Pas encore démarrée' };
}

/** Menu « + » d'un projet : lancer une session d'agent ou ouvrir un terminal. */
function AddMenu({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [createTerminal, { loading }] = useMutation<{ createTerminal: { id: string } }>(CREATE_TERMINAL, {
    refetchQueries: ['Sidebar'],
    onCompleted: (res) => {
      onClose();
      navigate(`/terminals/${res.createTerminal.id}`);
    },
  });
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  return (
    <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
      <Link to={`/sessions/new?projectId=${projectId}`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-chat-dots wb-icon" /> Nouvelle session d'agent
      </Link>
      <button type="button" className="wb-pop-item" disabled={loading} onClick={() => createTerminal({ variables: { projectId } })}>
        <i className="bi bi-terminal wb-icon" /> {loading ? 'Ouverture…' : 'Nouveau terminal'}
      </button>
      <Link to={`/projects/${projectId}/tasks`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-check2-square wb-icon" /> Tâches du projet
      </Link>
      <Link to={`/projects/${projectId}/context`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-journal-text wb-icon" /> Contexte du projet
      </Link>
    </div>
  );
}

/** Sidebar : menus principaux, puis les projets avec leurs sessions et terminaux. */
export default function Sidebar() {
  const location = useLocation();
  const { data } = useQuery<{ projects: SidebarProject[] }>(SIDEBAR, { pollInterval: 3000 });
  const { data: pendingData } = useQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 3000 });
  const pending = pendingData?.requests.length ?? 0;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('skipper.workbench.collapsed') ?? '{}');
    } catch {
      return {};
    }
  });
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem('skipper.workbench.collapsed', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  const activeSessionId = location.pathname.match(/^\/sessions\/([^/]+)$/)?.[1];
  const activeTerminalId = location.pathname.match(/^\/terminals\/([^/]+)$/)?.[1];
  const activeProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const [menuFor, setMenuFor] = useState<string | null>(null);

  return (
    <aside className="wb-sidebar">
      <div className="wb-brand">
        <Link to="/">✻ Skipper</Link>
      </div>

      <nav className="wb-menu">
        <NavLink to="/" end className="wb-menu-item">
          <i className="bi bi-house wb-icon" /> Accueil
        </NavLink>
        <NavLink to="/projects" end className="wb-menu-item">
          <i className="bi bi-folder2 wb-icon" /> Projets
        </NavLink>
        <NavLink to="/sessions" end className="wb-menu-item">
          <i className="bi bi-chat-dots wb-icon" /> Sessions
        </NavLink>
        <NavLink to="/tasks" end className="wb-menu-item">
          <i className="bi bi-check2-square wb-icon" /> Tâches
        </NavLink>
        <NavLink to="/requests" className="wb-menu-item">
          <i className="bi bi-bell wb-icon" /> Demandes
          {pending > 0 && (
            <span className="wb-badge" title="Un agent attend votre réponse">
              {pending}
            </span>
          )}
        </NavLink>
      </nav>

      <div className="wb-section-title">
        <span>Projets</span>
        <Link to="/projects/new" className="wb-section-action" title="Créer un projet">
          <i className="bi bi-plus-lg" />
        </Link>
      </div>

      <div className="wb-explorer">
        {(data?.projects ?? []).map((p) => {
          const open = !collapsed[p.id];
          return (
            <div key={p.id} className="wb-project">
              <div className={`wb-row wb-project-row${p.id === activeProjectId ? ' active' : ''}`}>
                <button type="button" className="wb-chevron" onClick={() => toggle(p.id)} title={open ? 'Replier' : 'Déplier'}>
                  <i className={`bi bi-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
                </button>
                <Link to={`/projects/${p.id}`} className="wb-row-label" title="Ouvrir le projet">
                  <i className="bi bi-folder2 wb-icon" /> {p.name}
                </Link>
                <span className={`wb-row-actions${menuFor === p.id ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="wb-plus"
                    title="Nouvelle session ou terminal"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === p.id ? null : p.id);
                    }}
                  >
                    <i className="bi bi-plus-lg" />
                  </button>
                  {menuFor === p.id && <AddMenu projectId={p.id} onClose={() => setMenuFor(null)} />}
                </span>
              </div>
              {open &&
                p.sessions.map((s) => {
                  const dot = statusDot(s.status, s.activity);
                  const hint = sessionStateHint(s.status, s.activity, s.pendingRequestCount);
                  return (
                    <Link key={s.id} to={`/sessions/${s.id}`} className={`wb-row wb-session-row${s.id === activeSessionId ? ' active' : ''}`} title={dot.title}>
                      <span className={`wb-dot ${dot.cls}`} />
                      <span className="wb-row-label">{s.name}</span>
                      {s.pendingRequestCount > 0 ? <span className="wb-badge">{s.pendingRequestCount}</span> : hint && <span className="wb-state">{hint}</span>}
                    </Link>
                  );
                })}
              {open &&
                p.terminals.map((t) => (
                  <Link key={t.id} to={`/terminals/${t.id}`} className={`wb-row wb-session-row${t.id === activeTerminalId ? ' active' : ''}`} title={t.status === 'RUNNING' ? 'Terminal ouvert' : 'Terminal fermé'}>
                    <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} />
                    <span className="wb-row-label">{t.name}</span>
                  </Link>
                ))}
              {open && p.sessions.length === 0 && p.terminals.length === 0 && <div className="wb-row wb-empty">aucune session pour l'instant</div>}
            </div>
          );
        })}
        {data && data.projects.length === 0 && (
          <div className="wb-row wb-empty">
            Aucun projet. <Link to="/projects/new">Créer le premier</Link>
          </div>
        )}
      </div>
      <div className="wb-hint">
        Un point orange qui clignote : l'agent travaille. Vert : il attend vos instructions. Un badge jaune : il a besoin de vous.
      </div>
    </aside>
  );
}
