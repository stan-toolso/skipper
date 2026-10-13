import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CLOSE_TERMINAL, REQUESTS, SIDEBAR, SIDEBAR_WORKTREE_PULL_REQUESTS, STOP_SESSION, type HumanRequest } from '../graphql/operations';
import { usePollingQuery } from '../lib/usePollingQuery';
import { sessionStateHint } from '../lib/humanize';
import Logo from '../components/Logo';
import InstallButton from '../components/InstallButton';
import { useDialogs } from '../components/Dialogs';
import { useSearchPalette } from '../components/SearchPalette';
import { useShortcutsHelp } from '../components/ShortcutsHelp';
import { displayComboText } from '../lib/shortcuts';
import AddMenu from './AddMenu';
import { useDeletions } from './useDeletions';
import { useTabs } from './TabsContext';
import { ContextDot, SubagentsCount, initialsOf, sessionDotClass } from './WorkspaceTabs';
import { mineFirst, openItemsOf, participates, sessionGroups, subagentsSummary, workspaceState, type SessionNode, type SidebarProject, type SidebarSession, type SidebarTerminal, type Workspace } from './workspaces';

const EXPANDED_KEY = 'skipper.workbench.expanded';
const FILTER_KEY = 'skipper.workbench.sessionFilter';
const MAX_CHIPS = 6;
/** Décalage (px) d'une session lancée par un agent sous sa session parente. */
const CHILD_INDENT = 14;

/** Session annotée de son dossier (toutes celles d'un projet forment le « pool » où l'on cherche les sous-agents d'une parente). */
type PoolSession = SidebarSession & { wsKey: string; wsName: string; wsWorktreeId: string | null };

interface PullRequestRef {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
}

/** « sous-agent de « Nom » » ou « sous-agent (lancé par un agent) » pour une session lancée par l'agent d'une autre session (sessions.create). */
const byAgentTitle = (n: Pick<SessionNode<unknown>, 'byAgent' | 'parentName'>) => (n.byAgent ? ` · sous-agent${n.parentName ? ` de « ${n.parentName} »` : ' (lancé par un agent)'}` : '');

/** Pictogramme d'un sous-agent (session lancée par un agent), devant son nom. */
const RobotIcon = () => <i className="bi bi-robot wb-robot" aria-label="Sous-agent" />;

/**
 * Ligne « N sous-agents » sous une session parente : repliée par défaut (un clic la déplie), dépliée d'office quand la
 * page courante est l'un des sous-agents ou que l'un d'eux attend une réponse.
 */
function SubagentsRow({ children, indent, expanded, onToggle }: { children: SidebarSession[]; indent: number; expanded: boolean; onToggle: () => void }) {
  const sum = subagentsSummary(children);
  return (
    <button type="button" className={`wb-row wb-session-row wb-row-btn wb-subagents${expanded ? ' open' : ''}`} style={{ paddingLeft: indent }} title={`${sum.label} lancé${children.length > 1 ? 's' : ''} par l'agent de cette session · cliquer pour ${expanded ? 'replier' : 'déplier'}`} onClick={onToggle}>
      <span className="wb-tree">└</span>
      <span className={`wb-dot ${sum.state === 'ask' ? 'ask' : sum.state === 'busy' ? 'busy' : sum.state === 'idle' ? 'idle' : 'done'}`} />
      <i className="bi bi-robot wb-robot" />
      <span className="wb-row-label">{sum.label}</span>
      {sum.pending > 0 ? <span className="wb-badge">{sum.pending}</span> : sum.hint && <span className="wb-state">{sum.hint}</span>}
      <i className={`bi bi-chevron-${expanded ? 'down' : 'right'} wb-subagents-chevron`} />
    </button>
  );
}

function statusTitle(s: SidebarSession): string {
  if (s.status === 'RUNNING') return s.activity === 'BUSY' ? "L'agent travaille" : "L'agent attend vos instructions";
  if (s.status === 'QUEUED') return "En file d'attente : démarrera dès qu'une place se libère";
  if (s.status === 'FAILED') return 'Terminée avec une erreur';
  if (s.status === 'COMPLETED') return 'Terminée';
  if (s.status === 'STOPPED') return 'Arrêtée';
  if (s.status === 'INTERRUPTED') return 'Interrompue par un redémarrage';
  return 'Pas encore démarrée';
}

/** Icône d'un worktree, colorée par l'état de la pull request de sa branche. */
function worktreeIcon(ws: Workspace, pr: PullRequestRef | null | undefined): { cls: string; title: string } {
  if (!ws.exists) return { cls: 'wt-missing', title: 'Worktree absent du disque' };
  const base = `Worktree · branche ${ws.branch}`;
  if (!pr) return { cls: '', title: base };
  const state = pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase();
  return { cls: `wt-pr-${state}`, title: `${base} · pull request #${pr.number} ${state === 'draft' ? 'brouillon' : state === 'open' ? 'ouverte' : state === 'merged' ? 'fusionnée' : 'fermée'}` };
}

interface MenuItem {
  label: string;
  icon: string;
  to?: string;
  onClick?: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

/** Menu contextuel d'une ligne (clic sur ⋯ ou clic droit). */
function PopMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [onClose]);
  return (
    <div className="wb-pop" onClick={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <div key={it.label}>
          {it.separatorBefore && <div className="wb-pop-sep" />}
          {it.to ? (
            <Link to={it.to} className={`wb-pop-item${it.danger ? ' danger' : ''}`} onClick={onClose}>
              <i className={`bi ${it.icon} wb-icon`} /> {it.label}
            </Link>
          ) : (
            <button
              type="button"
              className={`wb-pop-item${it.danger ? ' danger' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                onClose();
                it.onClick?.();
              }}
            >
              <i className={`bi ${it.icon} wb-icon`} /> {it.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function RowWithMenu({ to, active, indent, title, items, children }: { to: string; active: boolean; indent: number; title: string; items: MenuItem[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
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
        {open && <PopMenu items={items} onClose={() => setOpen(false)} />}
      </span>
    </Link>
  );
}

/**
 * Ligne d'une session. Ses sous-agents (`children`, sessions lancées par son agent) sont repliés derrière une ligne
 * « N sous-agents » ; dépliés, ils apparaissent indentés (`depth`), reliés par └ et marqués d'un robot.
 */
function SessionRow({ s, worktreeId, indent, depth = 0, byAgent = false, parentName = null, children = [], wsKey = null, elsewhere = null }: { s: SidebarSession; worktreeId: string | null; indent: number; depth?: number; byAgent?: boolean; parentName?: string | null; children?: SessionNode<PoolSession>[]; /** Clé du dossier de la carte : un sous-agent d'un autre dossier est étiqueté. */ wsKey?: string | null; /** Nom du dossier du sous-agent quand ce n'est pas celui de la carte. */ elsewhere?: string | null }) {
  const location = useLocation();
  const [open, setOpen] = useState<boolean | null>(null); // null : automatique (page courante ou demande en attente chez un sous-agent)
  const childActive = children.some((c) => location.pathname.startsWith(`/sessions/${c.session.id}`));
  const expanded = open ?? (childActive || children.some((c) => c.session.pendingRequestCount > 0));
  const { user } = useAuth();
  const { showError } = useDialogs();
  const { archiveSession } = useDeletions();
  const [stopSession] = useMutation(STOP_SESSION, { refetchQueries: ['Sidebar'] });
  const hint = sessionStateHint(s.status, s.activity, s.pendingRequestCount);
  const mine = participates(s, user?.id ?? null);
  const items: MenuItem[] = [
    { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/sessions/${s.id}` },
    ...(s.status === 'RUNNING' ? [{ label: 'Arrêter', icon: 'bi-stop-circle', onClick: () => void stopSession({ variables: { id: s.id } }).catch(showError) }] : []),
    { label: 'Archiver', icon: 'bi-archive', separatorBefore: true, onClick: () => void archiveSession({ id: s.id, name: s.name, worktreeId }) },
  ];
  const browserPath = `/sessions/${s.id}/browser`;
  const left = indent + depth * CHILD_INDENT;
  return (
    <>
      <RowWithMenu to={`/sessions/${s.id}`} active={location.pathname === `/sessions/${s.id}`} indent={left} title={`${statusTitle(s)}${byAgentTitle({ byAgent, parentName })}${elsewhere ? ` · dans le dossier ${elsewhere}` : ''}`} items={items}>
        {depth > 0 && <span className="wb-tree">└</span>}
        <span className={`wb-dot ${sessionDotClass(s)}`} />
        {byAgent && depth === 0 && <RobotIcon />}
        <span className="wb-row-label">{s.name}</span>
        {elsewhere && !s.name.toLowerCase().startsWith(elsewhere.toLowerCase()) && (
          <span className="wb-tag" title={`Travaille dans le dossier ${elsewhere}`}>
            <i className="bi bi-diagram-2" /> {elsewhere}
          </span>
        )}
        {s.context.overThreshold && <ContextDot context={s.context} />}
        {s.owner && !mine && (
          <span className="wb-owner" title={`Session de ${s.owner.name}`}>
            {initialsOf(s.owner.name)}
          </span>
        )}
        {s.pendingRequestCount > 0 ? <span className="wb-badge">{s.pendingRequestCount}</span> : hint && depth === 0 && <span className="wb-state">{hint}</span>}
      </RowWithMenu>
      {s.browserActive && (
        <Link to={browserPath} className={`wb-row wb-session-row wb-browser-row${location.pathname === browserPath ? ' active' : ''}`} style={{ paddingLeft: left + 16 }} title="Voir en direct la page ouverte par l'agent">
          <i className="bi bi-globe2 wb-browser-icon" />
          <span className="wb-row-label">Navigateur</span>
        </Link>
      )}
      {children.length > 0 && <SubagentsRow children={children.map((c) => c.session)} indent={left + CHILD_INDENT} expanded={expanded} onToggle={() => setOpen(!expanded)} />}
      {expanded && children.map((c) => <SessionRow key={c.session.id} s={c.session} worktreeId={c.session.wsWorktreeId} indent={indent} depth={c.depth} byAgent parentName={c.parentName} elsewhere={c.session.wsKey !== wsKey ? c.session.wsName : null} />)}
    </>
  );
}

function TerminalRow({ t, worktreeId, indent }: { t: SidebarTerminal; worktreeId: string | null; indent: number }) {
  const location = useLocation();
  const { showError } = useDialogs();
  const { deleteTerminal } = useDeletions();
  const [closeTerminal] = useMutation(CLOSE_TERMINAL, { refetchQueries: ['Sidebar'] });
  const items: MenuItem[] = [
    { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/terminals/${t.id}` },
    ...(t.status === 'RUNNING' ? [{ label: 'Fermer le shell', icon: 'bi-x-circle', onClick: () => void closeTerminal({ variables: { id: t.id } }).catch(showError) }] : []),
    { label: 'Supprimer', icon: 'bi-trash', danger: true, separatorBefore: true, onClick: () => void deleteTerminal({ id: t.id, name: t.name, worktreeId }) },
  ];
  return (
    <RowWithMenu to={`/terminals/${t.id}`} active={location.pathname === `/terminals/${t.id}`} indent={indent} title={t.status === 'RUNNING' ? 'Terminal ouvert' : 'Terminal fermé'} items={items}>
      <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} />
      <span className="wb-row-label">{t.name}</span>
    </RowWithMenu>
  );
}

/**
 * Carte d'un dossier de travail (checkout principal ou worktree) : état, nom, puces de ce qui y est ouvert,
 * et lignes détaillées quand on la déplie.
 */
function WorkspaceCard({ ws, pr, expanded, onToggle, tabUrl, filterMine, canWorktree }: { ws: Workspace; pr: PullRequestRef | null | undefined; expanded: boolean; onToggle: () => void; tabUrl: string | null; filterMine: boolean; canWorktree: boolean }) {
  const location = useLocation();
  const { user } = useAuth();
  const { activeKey, workspaces } = useTabs();
  const [menu, setMenu] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const userId = user?.id ?? null;
  const current = location.pathname;
  const isCurrent = (path: string) => current === path || current === `${path}/browser`;
  // Toutes les sessions du projet, annotées de leur dossier : les sous-agents lancés dans un autre worktree se rangent sous leur parente.
  const pool = useMemo(() => workspaces.ofProject(ws.projectId).flatMap((w) => w.sessions.map((s): PoolSession => ({ ...s, wsKey: w.key, wsName: w.name, wsWorktreeId: w.worktreeId }))), [workspaces, ws.projectId]);
  const visibleSessions = useMemo(() => {
    const all = mineFirst(pool.filter((s) => s.wsKey === ws.key), userId);
    if (!filterMine || showOthers) return all;
    // La session affichée reste listée même si elle est à quelqu'un d'autre.
    return all.filter((s) => participates(s, userId) || isCurrent(`/sessions/${s.id}`));
  }, [pool, ws.key, userId, filterMine, showOthers, current]);
  // Les sous-agents (sessions lancées par un agent) sont regroupés derrière leur session parente, même lancés dans un autre worktree ; un sous-agent dont la parente est ailleurs reste au premier niveau ici, avec son robot.
  const groups = useMemo(() => sessionGroups(visibleSessions, pool), [visibleSessions, pool]);
  const hiddenOthers = ws.sessions.length - visibleSessions.length;
  const state = workspaceState(ws.sessions);
  const pending = ws.sessions.reduce((n, s) => n + s.pendingRequestCount, 0);
  const icon = worktreeIcon(ws, pr);
  const chips = [
    // Une puce par session de premier niveau, avec le compte de ses sous-agents ; un sous-agent n'a sa propre puce que s'il est la page courante ou attend une réponse.
    ...groups.flatMap(({ root, children }) =>
      [root, ...children.filter((c) => c.session.wsKey === ws.key && (isCurrent(`/sessions/${c.session.id}`) || c.session.pendingRequestCount > 0))].map(({ session: s, ...n }) => ({
        key: `s:${s.id}`,
        to: `/sessions/${s.id}`,
        active: isCurrent(`/sessions/${s.id}`),
        label: s.name,
        title: `${s.name} · ${statusTitle(s)}${byAgentTitle(n)}${s.owner ? ` · ${s.owner.name}` : ''}`,
        node: (
          <>
            <span className={`wb-dot ${sessionDotClass(s)}`} />
            {n.byAgent && <RobotIcon />}
          </>
        ),
        extra: n.depth === 0 && children.length ? <SubagentsCount children={children.map((c) => c.session)} /> : null,
        owner: s.owner && !participates(s, userId) ? s.owner : null,
      })),
    ),
    ...ws.terminals.map((t) => ({ key: `t:${t.id}`, to: `/terminals/${t.id}`, active: current === `/terminals/${t.id}`, label: t.name, title: `${t.name} · ${t.status === 'RUNNING' ? 'ouvert' : 'fermé'}`, node: <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} />, extra: null, owner: null })),
  ];
  const activeIndex = chips.findIndex((c) => c.active);
  const shown = showAll || activeIndex >= MAX_CHIPS ? chips : chips.slice(0, MAX_CHIPS);
  // Clic sur la tête : la première session du worktree, sinon la page où l'onglet du dossier en était, sinon les fichiers.
  const headTo = !ws.primary && groups.length ? `/sessions/${groups[0].root.session.id}` : tabUrl ?? ws.key;
  const name = ws.task && !ws.worktree?.customLabel ? ws.task.title : ws.name;
  const title = ws.primary ? `Dossier principal · ${ws.name}` : `${ws.task ? `Tâche : ${ws.task.title} · ${ws.task.status.toLowerCase()} · ` : ''}${icon.title}`;
  return (
    <div className={`wb-ws${activeKey === ws.key ? ' active' : ''}`}>
      <div
        className="wb-ws-head"
        title={title}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu(true);
        }}
      >
        <Link to={headTo} className="wb-ws-link">
          <span className={`wb-ws-state ${state ?? 'none'}`} />
          {!ws.primary && <i className={`bi ${ws.task ? 'bi-check2-square' : 'bi-diagram-2'} wb-icon ${icon.cls}`} />}
          <span className="wb-ws-name">{name}</span>
          {ws.primary && ws.projectName && <span className="wb-tag">principal</span>}
          {!ws.exists && <span className="wb-tag missing">absent</span>}
          {pending > 0 && <span className="wb-badge">{pending}</span>}
        </Link>
        <span className={`wb-row-actions${menu ? ' open' : ''}`}>
          <button
            type="button"
            className="wb-plus"
            title={ws.primary ? 'Ouvrir quelque chose dans le dossier principal' : 'Ouvrir quelque chose ici, ou gérer le worktree'}
            onClick={(e) => {
              e.stopPropagation();
              setMenu((v) => !v);
            }}
          >
            <i className="bi bi-three-dots" />
          </button>
          {menu && <AddMenu projectId={ws.projectId} worktree={ws.worktree} canWorktree={canWorktree && ws.primary} onClose={() => setMenu(false)} />}
        </span>
      </div>
      <div className="wb-ws-items">
        {ws.task && (
          <Link to={`/tasks/${ws.task.id}`} className={`wb-ws-task task-status task-status-${ws.task.status.toLowerCase()}`} title={`Tâche : ${ws.task.title}`}>
            {ws.task.status === 'IN_PROGRESS' ? 'en cours' : ws.task.status === 'DONE' ? 'terminée' : ws.task.status === 'CANCELLED' ? 'annulée' : 'à faire'}
          </Link>
        )}
        {shown.map((c) => (
          <Link key={c.key} to={c.to} className={`wb-chip${c.active ? ' active' : ''}`} title={c.title}>
            {c.node}
            <span className="wb-chip-label">{c.label}</span>
            {c.extra}
            {c.owner && <span className="wb-owner">{initialsOf(c.owner.name)}</span>}
          </Link>
        ))}
        {!showAll && chips.length > shown.length && (
          <button type="button" className="wb-chip wb-chip-more" title="Tout afficher" onClick={() => setShowAll(true)}>
            +{chips.length - shown.length}
          </button>
        )}
        {hiddenOthers > 0 && (
          <button type="button" className="wb-chip wb-chip-more" title={`Afficher les ${hiddenOthers} session(s) d'autres personnes`} onClick={() => setShowOthers(true)}>
            <i className="bi bi-people" /> {hiddenOthers}
          </button>
        )}
        {chips.length === 0 && hiddenOthers === 0 && <span className="wb-ws-empty">rien d'ouvert</span>}
        <button type="button" className="wb-chevron wb-ws-chevron" title={expanded ? 'Replier' : 'Détailler'} onClick={onToggle}>
          <i className={`bi bi-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
        </button>
      </div>
      {expanded && (
        <div className="wb-ws-rows">
          {groups.map(({ root, children }) => (
            <SessionRow key={root.session.id} s={root.session} worktreeId={ws.worktreeId} indent={30} byAgent={root.byAgent} parentName={root.parentName} children={children} wsKey={ws.key} />
          ))}
          {ws.terminals.map((t) => (
            <TerminalRow key={t.id} t={t} worktreeId={ws.worktreeId} indent={30} />
          ))}
          {hiddenOthers > 0 && (
            <button type="button" className="wb-row wb-empty wb-row-btn" style={{ paddingLeft: 30 }} onClick={() => setShowOthers(true)}>
              + {hiddenOthers} session(s) d'autres personnes
            </button>
          )}
          {visibleSessions.length === 0 && ws.terminals.length === 0 && hiddenOthers === 0 && (
            <div className="wb-row wb-empty" style={{ paddingLeft: 30 }}>
              rien d'ouvert dans ce dossier
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Utilisateur connecté (avatar, nom) et déconnexion, en bas de la sidebar. */
function UserBlock() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="wb-user" title={user.email}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="wb-avatar" referrerPolicy="no-referrer" /> : <span className="wb-avatar wb-avatar-initials">{initialsOf(user.name)}</span>}
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

function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Sidebar : recherche, menus principaux, puis les projets avec leurs dossiers de travail. */
export default function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const location = useLocation();
  const { user } = useAuth();
  const { tabs, workspaces, activeKey } = useTabs();
  const { openSearch } = useSearchPalette();
  const { openHelp } = useShortcutsHelp();
  const open = useMemo(() => (user?.isSuperAdmin ? openItemsOf([...tabs.map((t) => t.url), location.pathname]) : null), [user?.isSuperAdmin, tabs, location.pathname]);
  const { data } = usePollingQuery<{ projects: SidebarProject[] }>(SIDEBAR, { variables: { open }, pollInterval: 3000, fetchPolicy: 'cache-and-network' });
  const { data: prData } = usePollingQuery<{ projects: { id: string; worktrees: { id: string; pullRequest: PullRequestRef | null }[] }[] }>(SIDEBAR_WORKTREE_PULL_REQUESTS, { variables: { open }, pollInterval: 60_000 });
  const { data: pendingData } = usePollingQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 3000 });
  const pending = pendingData?.requests.length ?? 0;
  const prByWorktree = useMemo(() => new Map((prData?.projects ?? []).flatMap((p) => p.worktrees.map((w) => [w.id, w.pullRequest] as const))), [prData]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadExpanded);
  const [filter, setFilter] = useState<'mine' | 'all'>(() => {
    try {
      return localStorage.getItem(FILTER_KEY) === 'all' ? 'all' : 'mine';
    } catch {
      return 'mine';
    }
  });
  const setFilterPersist = (f: 'mine' | 'all') => {
    setFilter(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };
  const toggle = (id: string, defaultOpen: boolean) =>
    setExpanded((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? defaultOpen) };
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  const activeProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? (activeKey ? workspaces.get(activeKey)?.projectId : undefined);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const userId = user?.id ?? null;

  // Révélation : le projet qui contient la page affichée est déplié s'il avait été replié à la main.
  useEffect(() => {
    if (!activeProjectId || expanded[activeProjectId] !== false) return;
    setExpanded((prev) => ({ ...prev, [activeProjectId]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, activeProjectId]);

  // Défilement vers la ligne courante, une fois par chemin, quand elle est hors de vue.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || scrolledFor.current === location.pathname) return;
    scrolledFor.current = location.pathname;
    const root = explorerRef.current;
    const target = root?.querySelector<HTMLElement>('.wb-chip.active, .wb-session-row.active, .wb-ws.active, .wb-row.active');
    if (!root || !target) return;
    const r = root.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (t.top < r.top || t.bottom > r.bottom) root.scrollTop += t.top - r.top - r.height / 2 + t.height / 2;
  }, [data, location.pathname]);

  const projectDefaultOpen = (p: SidebarProject) => {
    if (p.id === activeProjectId) return true;
    return p.sessions.some((s) => participates(s, userId) && (s.status === 'RUNNING' || s.status === 'QUEUED' || s.pendingRequestCount > 0));
  };

  return (
    <aside className="wb-sidebar">
      <div className="wb-brand">
        <Link to="/" title="Tableau de bord">
          <Logo size={18} />
          Skipper
        </Link>
        <span className="wb-brand-actions">
          <button type="button" className="wb-plus" title="Raccourcis clavier (?)" onClick={openHelp}>
            <i className="bi bi-keyboard" />
          </button>
          {onCollapse && (
            <button type="button" className="wb-plus d-none d-md-inline" title="Replier la barre latérale" onClick={onCollapse}>
              <i className="bi bi-chevron-double-left" />
            </button>
          )}
        </span>
      </div>

      <button type="button" className="wb-search-btn" onClick={() => openSearch()}>
        <i className="bi bi-search" /> Rechercher…
        <kbd>{displayComboText('mod+k')}</kbd>
      </button>

      <nav className="wb-menu">
        <NavLink to="/" end className="wb-menu-item" title="Tableau de bord">
          <i className="bi bi-speedometer2 wb-icon" /> <span>Tableau de bord</span>
        </NavLink>
        <NavLink to="/projects" end className="wb-menu-item" title="Projets">
          <i className="bi bi-folder2 wb-icon" /> <span>Projets</span>
        </NavLink>
        <NavLink to="/sessions" end className="wb-menu-item" title="Sessions">
          <i className="bi bi-chat-dots wb-icon" /> <span>Sessions</span>
        </NavLink>
        <NavLink to="/tasks" end className="wb-menu-item" title="Tâches">
          <i className="bi bi-check2-square wb-icon" /> <span>Tâches</span>
        </NavLink>
        <NavLink to="/shared" end className="wb-menu-item" title="Pages partagées">
          <i className="bi bi-file-earmark-richtext wb-icon" /> <span>Pages</span>
        </NavLink>
        <NavLink to="/vault" end className="wb-menu-item" title="Coffre">
          <i className="bi bi-shield-lock wb-icon" /> <span>Coffre</span>
        </NavLink>
        <NavLink to="/agents" end className="wb-menu-item" title="Agents : configurations réutilisables, planifiables">
          <i className="bi bi-robot wb-icon" /> <span>Agents</span>
        </NavLink>
        <NavLink to="/workflows" end className="wb-menu-item" title="Workflows : enchaînements d'agents, de sessions et de tâches">
          <i className="bi bi-diagram-3 wb-icon" /> <span>Workflows</span>
        </NavLink>
        <NavLink to="/requests" className="wb-menu-item" title="Demandes">
          <i className="bi bi-bell wb-icon" /> <span>Demandes</span>
          {pending > 0 && (
            <span className="wb-badge" title="Un agent attend votre réponse">
              {pending}
            </span>
          )}
        </NavLink>
      </nav>

      <div className="wb-section-title">
        <span>Projets</span>
        <button
          type="button"
          className="wb-section-action wb-filter"
          title={filter === 'mine' ? 'Mes sessions seulement : cliquer pour voir celles de tout le monde' : 'Sessions de tout le monde : cliquer pour ne voir que les miennes'}
          onClick={() => setFilterPersist(filter === 'mine' ? 'all' : 'mine')}
        >
          <i className={`bi ${filter === 'mine' ? 'bi-person' : 'bi-people'}`} /> {filter === 'mine' ? 'Les miennes' : 'Tout le monde'}
        </button>
        <Link to="/projects/new" className="wb-section-action" title="Nouveau projet">
          <i className="bi bi-plus-lg" />
        </Link>
      </div>

      <div className="wb-explorer" ref={explorerRef}>
        {!data && (
          <div className="wb-row wb-empty">
            <Spinner animation="border" size="sm" className="me-2" /> chargement des projets…
          </div>
        )}
        {(data?.projects ?? []).map((p) => {
          const open = expanded[p.id] ?? projectDefaultOpen(p);
          const list = workspaces.ofProject(p.id);
          const collapsedPending = !open ? p.sessions.filter((s) => participates(s, userId)).reduce((n, s) => n + s.pendingRequestCount, 0) : 0;
          return (
            <div key={p.id} className="wb-project">
              <div className={`wb-row wb-project-row${p.id === activeProjectId ? ' active' : ''}`}>
                <button type="button" className="wb-chevron" onClick={() => toggle(p.id, projectDefaultOpen(p))} title={open ? 'Replier' : 'Déplier'}>
                  <i className={`bi bi-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
                </button>
                <Link to={`/projects/${p.id}`} className="wb-row-label" title="Ouvrir le projet">
                  <i className="bi bi-folder2 wb-icon" /> {p.name}
                </Link>
                {!p.isMember && <i className="bi bi-shield-lock wb-icon" title="Vous n'êtes pas membre de ce projet : il apparaît parce qu'un de vos onglets y est ouvert (super administrateur)" />}
                {collapsedPending > 0 && <span className="wb-badge">{collapsedPending}</span>}
                <span className={`wb-row-actions${menuFor === p.id ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="wb-plus"
                    title="Actions du projet : nouvelle session, terminal, worktree, agent, workflow ; pages ; modification, suppression"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === p.id ? null : p.id);
                    }}
                  >
                    <i className="bi bi-three-dots" />
                  </button>
                  {menuFor === p.id && (
                    <AddMenu
                      projectId={p.id}
                      project={{ id: p.id, name: p.name, canManage: p.myRole === 'ADMIN', paths: [...p.sessions.map((s) => `/sessions/${s.id}`), ...p.terminals.map((t) => `/terminals/${t.id}`), ...p.worktrees.map((w) => `/worktrees/${w.id}`)] }}
                      canWorktree={Boolean(p.gitUrl)}
                      onClose={() => setMenuFor(null)}
                    />
                  )}
                </span>
              </div>
              {open &&
                list.map((ws) => (
                  <WorkspaceCard
                    key={ws.key}
                    ws={ws}
                    pr={ws.worktreeId ? prByWorktree.get(ws.worktreeId) : null}
                    expanded={expanded[ws.key] ?? false}
                    onToggle={() => toggle(ws.key, false)}
                    tabUrl={tabs.find((t) => t.key === ws.key)?.url ?? null}
                    filterMine={filter === 'mine'}
                    canWorktree={Boolean(p.gitUrl)}
                  />
                ))}
            </div>
          );
        })}
        {data && data.projects.length === 0 && (
          <div className="wb-row wb-empty">
            Aucun projet. <Link to="/projects">Créer le premier</Link>
          </div>
        )}
      </div>
      <nav className="wb-menu wb-menu-bottom">
        <InstallButton />
        {user?.isAdmin && (
          <NavLink to="/users" className="wb-menu-item" title="Utilisateurs">
            <i className="bi bi-people wb-icon" /> <span>Utilisateurs</span>
          </NavLink>
        )}
        <NavLink to="/settings" className="wb-menu-item" title="Paramètres">
          <i className="bi bi-gear wb-icon" /> <span>Paramètres</span>
        </NavLink>
        <UserBlock />
      </nav>
    </aside>
  );
}
