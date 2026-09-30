import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  CLOSE_TERMINAL,
  CREATE_TERMINAL,
  DELETE_SESSION,
  DELETE_TERMINAL,
  DELETE_WORKTREE,
  REQUESTS,
  SIDEBAR,
  STOP_SESSION,
  type HumanRequest,
  type Session,
  type SessionActivity,
  type SessionStatus,
  type Terminal,
} from '../graphql/operations';
import { useTabs } from './TabsContext';
import { sessionStateHint } from '../lib/humanize';
import Logo from '../components/Logo';
import InstallButton from '../components/InstallButton';
import { useSessionLauncher } from '../components/SessionLauncher';
import { useDialogs } from '../components/Dialogs';

type SidebarSession = Pick<Session, 'id' | 'name' | 'status' | 'activity' | 'pendingRequestCount'> & { worktree?: { id: string } | null };
type SidebarTerminal = Pick<Terminal, 'id' | 'name' | 'status'> & { worktree?: { id: string } | null };
interface SidebarWorktree {
  id: string;
  name: string;
  branch: string;
  exists: boolean;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
}
interface SidebarProject {
  id: string;
  name: string;
  slug: string;
  gitUrl: string | null;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
  worktrees: SidebarWorktree[];
}

function statusDot(status: SessionStatus, activity: SessionActivity | null): { cls: string; title: string } {
  if (status === 'RUNNING') return activity === 'BUSY' ? { cls: 'busy', title: "L'agent travaille" } : { cls: 'idle', title: "L'agent attend vos instructions" };
  if (status === 'FAILED') return { cls: 'failed', title: 'Terminée avec une erreur' };
  if (status === 'COMPLETED') return { cls: 'done', title: 'Terminée' };
  if (status === 'STOPPED' || status === 'INTERRUPTED') return { cls: 'stopped', title: status === 'STOPPED' ? 'Arrêtée' : 'Interrompue par un redémarrage' };
  return { cls: 'pending', title: 'Pas encore démarrée' };
}

/** Menu « + » d'un projet ou d'un worktree : session d'agent, terminal, et pour un projet git : worktree. */
function AddMenu({ projectId, worktreeId, canWorktree, onClose }: { projectId: string; worktreeId?: string; canWorktree: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [createTerminal, { loading }] = useMutation<{ createTerminal: { id: string } }>(CREATE_TERMINAL, {
    refetchQueries: ['Sidebar'],
    onCompleted: (res) => {
      onClose();
      navigate(`/terminals/${res.createTerminal.id}`);
    },
  });
  const { openNewSession, openNewWorktree } = useSessionLauncher();
  const { confirm, showError } = useDialogs();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  const [deleteWorktree] = useMutation(DELETE_WORKTREE, { refetchQueries: ['Sidebar', 'ProjectWorktrees'] });
  return (
    <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
      <Link to={worktreeId ? `/worktrees/${worktreeId}/files` : `/projects/${projectId}/files`} className="wb-pop-item" onClick={onClose}>
        <i className="bi bi-folder2-open wb-icon" /> Fichiers
      </Link>
      <button
        type="button"
        className="wb-pop-item"
        onClick={() => {
          onClose();
          openNewSession({ projectId, worktreeId: worktreeId ?? null });
        }}
      >
        <i className="bi bi-chat-dots wb-icon" /> Nouvelle session d'agent
      </button>
      <button type="button" className="wb-pop-item" disabled={loading} onClick={() => createTerminal({ variables: { projectId, worktreeId: worktreeId ?? null } })}>
        <i className="bi bi-terminal wb-icon" /> {loading ? 'Ouverture…' : 'Nouveau terminal'}
      </button>
      {canWorktree && !worktreeId && (
        <button
          type="button"
          className="wb-pop-item"
          onClick={() => {
            onClose();
            openNewWorktree({ projectId });
          }}
        >
          <i className="bi bi-diagram-2 wb-icon" /> Nouveau worktree
        </button>
      )}
      {worktreeId && (
        <>
          <div className="wb-pop-sep" />
          <button
            type="button"
            className="wb-pop-item danger"
            onClick={async () => {
              const res = await confirm({
                title: 'Supprimer le worktree',
                message: 'Supprimer ce worktree ? Ses sessions (arrêtées), ses terminaux et son dossier seront supprimés ; les fichiers non validés seront perdus.',
                confirmLabel: 'Supprimer',
                danger: true,
                checkbox: { label: 'Supprimer aussi la branche locale' },
              });
              if (!res) return;
              onClose();
              deleteWorktree({ variables: { id: worktreeId, deleteBranch: res.checked } }).catch(showError);
            }}
          >
            <i className="bi bi-trash wb-icon" /> Supprimer le worktree
          </button>
        </>
      )}
      {!worktreeId && (
        <>
          <Link to={`/projects/${projectId}/tasks`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-check2-square wb-icon" /> Tâches du projet
          </Link>
          <Link to={`/projects/${projectId}/connections`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-hdd-network wb-icon" /> Connexions du projet
          </Link>
          <Link to={`/projects/${projectId}/context`} className="wb-pop-item" onClick={onClose}>
            <i className="bi bi-journal-text wb-icon" /> Contexte du projet
          </Link>
        </>
      )}
    </div>
  );
}

interface MenuItem {
  label: string;
  icon: string;
  to?: string;
  onClick?: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

/**
 * Ligne de l'explorateur (session, terminal) avec menu « ⋯ » au survol et au clic droit.
 * Le menu propose notamment la suppression.
 */
function RowWithMenu({ to, active, indent, title, items, children }: { to: string; active: boolean; indent: number; title: string; items: MenuItem[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [open]);
  return (
    <Link
      to={to}
      className={`wb-row wb-session-row${active ? ' active' : ''}`}
      style={{ paddingLeft: indent }}
      title={title}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }}
    >
      {children}
      <span className={`wb-row-actions${open ? ' open' : ''}`}>
        <button
          type="button"
          className="wb-plus"
          title="Actions"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <i className="bi bi-three-dots" />
        </button>
        {open && (
          <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
            {items.map((it) => (
              <div key={it.label}>
                {it.separatorBefore && <div className="wb-pop-sep" />}
                {it.to ? (
                  <Link to={it.to} className={`wb-pop-item${it.danger ? ' danger' : ''}`} onClick={() => setOpen(false)}>
                    <i className={`bi ${it.icon} wb-icon`} /> {it.label}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={`wb-pop-item${it.danger ? ' danger' : ''}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setOpen(false);
                      it.onClick?.();
                    }}
                  >
                    <i className={`bi ${it.icon} wb-icon`} /> {it.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </span>
    </Link>
  );
}

function SessionRow({ s, active, indent }: { s: SidebarSession; active: boolean; indent: number }) {
  const navigate = useNavigate();
  const { closeTab } = useTabs();
  const { confirm, showError } = useDialogs();
  const [stopSession] = useMutation(STOP_SESSION, { refetchQueries: ['Sidebar'] });
  const [deleteSession] = useMutation(DELETE_SESSION, { refetchQueries: ['Sidebar', 'Sessions'] });
  const dot = statusDot(s.status, s.activity);
  const hint = sessionStateHint(s.status, s.activity, s.pendingRequestCount);
  const items: MenuItem[] = [
    { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/sessions/${s.id}` },
    ...(s.status === 'RUNNING' ? [{ label: 'Arrêter', icon: 'bi-stop-circle', onClick: () => void stopSession({ variables: { id: s.id } }).catch(showError) }] : []),
    {
      label: 'Supprimer',
      icon: 'bi-trash',
      danger: true,
      separatorBefore: true,
      onClick: async () => {
        if (!(await confirm({ title: 'Supprimer la session', message: `Supprimer la session « ${s.name} » et son historique ?`, confirmLabel: 'Supprimer', danger: true }))) return;
        deleteSession({ variables: { id: s.id } })
          .then(() => {
            closeTab(`/sessions/${s.id}`);
            if (active) navigate('/sessions');
          })
          .catch(showError);
      },
    },
  ];
  return (
    <RowWithMenu to={`/sessions/${s.id}`} active={active} indent={indent} title={dot.title} items={items}>
      <span className={`wb-dot ${dot.cls}`} />
      <span className="wb-row-label">{s.name}</span>
      {s.pendingRequestCount > 0 ? <span className="wb-badge">{s.pendingRequestCount}</span> : hint && <span className="wb-state">{hint}</span>}
    </RowWithMenu>
  );
}

function TerminalRow({ t, active, indent }: { t: SidebarTerminal; active: boolean; indent: number }) {
  const navigate = useNavigate();
  const { closeTab } = useTabs();
  const { confirm, showError } = useDialogs();
  const [closeTerminal] = useMutation(CLOSE_TERMINAL, { refetchQueries: ['Sidebar'] });
  const [deleteTerminal] = useMutation(DELETE_TERMINAL, { refetchQueries: ['Sidebar'] });
  const items: MenuItem[] = [
    { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/terminals/${t.id}` },
    ...(t.status === 'RUNNING' ? [{ label: 'Fermer le shell', icon: 'bi-x-circle', onClick: () => void closeTerminal({ variables: { id: t.id } }).catch(showError) }] : []),
    {
      label: 'Supprimer',
      icon: 'bi-trash',
      danger: true,
      separatorBefore: true,
      onClick: async () => {
        if (!(await confirm({ title: 'Supprimer le terminal', message: `Supprimer le terminal « ${t.name} » ?`, confirmLabel: 'Supprimer', danger: true }))) return;
        deleteTerminal({ variables: { id: t.id } })
          .then(() => {
            closeTab(`/terminals/${t.id}`);
            if (active) navigate('/');
          })
          .catch(showError);
      },
    },
  ];
  return (
    <RowWithMenu to={`/terminals/${t.id}`} active={active} indent={indent} title={t.status === 'RUNNING' ? 'Terminal ouvert' : 'Terminal fermé'} items={items}>
      <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} />
      <span className="wb-row-label">{t.name}</span>
    </RowWithMenu>
  );
}

function SessionRows({ sessions, terminals, activeSessionId, activeTerminalId, indent }: { sessions: SidebarSession[]; terminals: SidebarTerminal[]; activeSessionId?: string; activeTerminalId?: string; indent: number }) {
  return (
    <>
      {sessions.map((s) => (
        <SessionRow key={s.id} s={s} active={s.id === activeSessionId} indent={indent} />
      ))}
      {terminals.map((t) => (
        <TerminalRow key={t.id} t={t} active={t.id === activeTerminalId} indent={indent} />
      ))}
    </>
  );
}

/** Utilisateur connecté (avatar, nom) et déconnexion, en bas de la sidebar. */
function UserBlock() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="wb-user" title={user.email}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="wb-avatar" referrerPolicy="no-referrer" /> : <span className="wb-avatar wb-avatar-initials">{initials}</span>}
      <span className="wb-user-name">
        {user.name}
        <span className="wb-user-email">{user.email}</span>
      </span>
      <button type="button" className="wb-plus" title="Se déconnecter" onClick={() => void logout()}>
        <i className="bi bi-box-arrow-right" />
      </button>
    </div>
  );
}

/** Sidebar : menus principaux, puis les projets avec leurs sessions, terminaux et worktrees. */
export default function Sidebar() {
  const location = useLocation();
  const { user } = useAuth();
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
        <Link to="/" title="Tableau de bord">
          <Logo size={18} />
          Skipper
        </Link>
      </div>

      <nav className="wb-menu">
        <NavLink to="/" end className="wb-menu-item">
          <i className="bi bi-speedometer2 wb-icon" /> Tableau de bord
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
          const empty = p.sessions.length === 0 && p.terminals.length === 0 && p.worktrees.length === 0;
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
                    title="Nouvelle session, terminal ou worktree"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === p.id ? null : p.id);
                    }}
                  >
                    <i className="bi bi-plus-lg" />
                  </button>
                  {menuFor === p.id && <AddMenu projectId={p.id} canWorktree={Boolean(p.gitUrl)} onClose={() => setMenuFor(null)} />}
                </span>
              </div>
              {open && (
                <SessionRows
                  sessions={p.sessions.filter((s) => !s.worktree)}
                  terminals={p.terminals.filter((t) => !t.worktree)}
                  activeSessionId={activeSessionId}
                  activeTerminalId={activeTerminalId}
                  indent={30}
                />
              )}
              {open &&
                p.worktrees.map((w) => {
                  const wOpen = !collapsed[w.id];
                  return (
                    <div key={w.id}>
                      <div
                        className="wb-row wb-worktree-row"
                        title={w.exists ? `Worktree · branche ${w.branch}` : 'Worktree absent du disque'}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setMenuFor(w.id);
                        }}
                      >
                        <button type="button" className="wb-chevron" onClick={() => toggle(w.id)}>
                          <i className={`bi bi-chevron-${wOpen ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
                        </button>
                        <span className="wb-row-label">
                          <i className={`bi bi-diagram-2 wb-icon${w.exists ? '' : ' text-danger'}`} /> {w.branch}
                        </span>
                        <span className={`wb-row-actions${menuFor === w.id ? ' open' : ''}`}>
                          <button
                            type="button"
                            className="wb-plus"
                            title="Actions du worktree"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuFor(menuFor === w.id ? null : w.id);
                            }}
                          >
                            <i className="bi bi-three-dots" />
                          </button>
                          {menuFor === w.id && <AddMenu projectId={p.id} worktreeId={w.id} canWorktree={false} onClose={() => setMenuFor(null)} />}
                        </span>
                      </div>
                      {wOpen && <SessionRows sessions={w.sessions} terminals={w.terminals} activeSessionId={activeSessionId} activeTerminalId={activeTerminalId} indent={48} />}
                      {wOpen && w.sessions.length === 0 && w.terminals.length === 0 && (
                        <div className="wb-row wb-empty" style={{ paddingLeft: 48 }}>
                          rien dans ce worktree
                        </div>
                      )}
                    </div>
                  );
                })}
              {open && empty && <div className="wb-row wb-empty" style={{ paddingLeft: 30 }}>aucune session pour l'instant</div>}
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
      <nav className="wb-menu wb-menu-bottom">
        <InstallButton />
        {user?.isAdmin && (
          <NavLink to="/settings" className="wb-menu-item">
            <i className="bi bi-gear wb-icon" /> Paramètres
          </NavLink>
        )}
        <UserBlock />
      </nav>
    </aside>
  );
}
