import { useMutation, useQuery } from '@apollo/client';
import PopMenu, { type MenuItem } from '../components/PopMenu';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CLOSE_TERMINAL, REQUESTS, SIDEBAR, SIDEBAR_PULL_REQUESTS, STOP_SESSION, type HumanRequest } from '../graphql/operations';
import { usePollingQuery } from '../lib/usePollingQuery';
import { sessionStateHint } from '../lib/humanize';
import Logo from '../components/Logo';
import { useInstallApp } from '../components/InstallButton';
import { useDialogs } from '../components/Dialogs';
import { useSearchPalette } from '../components/SearchPalette';
import { useShortcutsHelp } from '../components/ShortcutsHelp';
import { displayComboText } from '../lib/shortcuts';
import AddMenu from './AddMenu';
import { useDeletions } from './useDeletions';
import { useTabs } from './TabsContext';
import { ContextDot, SubagentsCount, initialsOf, sessionDotClass } from './WorkspaceTabs';
import { attachedElsewhere, mineFirst, openItemsOf, participates, sessionGroups, subagentsSummary, workspaceState, type SessionNode, type SidebarProject, type SidebarSession, type SidebarTerminal, type Workspace } from './workspaces';

const EXPANDED_KEY = 'skipper.workbench.expanded';
const FILTER_KEY = 'skipper.workbench.sessionFilter';
const MAX_CHIPS = 6;
/** Décalage (px) d'une session lancée par un agent sous sa session parente. */
const CHILD_INDENT = 14;

/** Session annotée de son dossier (toutes celles d'un projet forment le « pool » où l'on cherche les sous-agents d'une parente). */
type PoolSession = SidebarSession & { wsKey: string; wsName: string; wsBranch: string | null; wsWorksessionId: string | null; /** Rangée dans le dossier principal parce que son dossier a été supprimé. */ wsDeleted: boolean };

/** Note d'un dossier dont les seules sessions sont des sous-agents rangés sous leur parente, ailleurs : « 4 sous-agents de « Session » ». */
function ElsewhereNote({ subs, poolById, row }: { subs: PoolSession[]; poolById: Map<string, PoolSession>; row?: boolean }) {
  const parents = [...new Set(subs.map((s) => s.parentSession?.id).filter((id): id is string => Boolean(id)))];
  return (
    <span className={row ? 'wb-row wb-empty' : 'wb-ws-empty'} style={row ? { paddingLeft: 30 } : undefined} title="Ces sessions sont listées sous la session qui les a lancées">
      <i className="bi bi-robot" /> {subs.length} sous-agent{subs.length > 1 ? 's' : ''} de{' '}
      {parents.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <Link to={`/sessions/${id}`} className="wb-empty-link">« {poolById.get(id)?.name ?? 'session'} »</Link>
        </span>
      ))}
    </span>
  );
}

/** Nombre de chats montrés sous « Chats » dans la sidebar ; au-delà, un lien vers la liste. */
const MAX_CHATS = 6;

/** Ligne d'un chat (conversation légère de l'espace personnel) : état, nom, menu (arrêter, supprimer). */
function ChatRow({ chat, indent }: { chat: SidebarSession; indent: number }) {
  const location = useLocation();
  const { showError } = useDialogs();
  const { deleteSession } = useDeletions();
  const [stopSession] = useMutation(STOP_SESSION, { refetchQueries: ['Sidebar', 'Chats'] });
  const hint = sessionStateHint(chat.status, chat.activity, chat.pendingRequestCount);
  const items: MenuItem[] = [
    { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/chats/${chat.id}` },
    ...(chat.status === 'RUNNING' ? [{ label: 'Arrêter', icon: 'bi-stop-circle', onClick: () => void stopSession({ variables: { id: chat.id } }).catch(showError) }] : []),
    { label: 'Supprimer', icon: 'bi-trash', danger: true, separatorBefore: true, onClick: () => void deleteSession({ id: chat.id, name: chat.name }) },
  ];
  return (
    <RowWithMenu to={`/chats/${chat.id}`} active={location.pathname === `/chats/${chat.id}`} indent={indent} title={`${chat.name} · ${statusTitle(chat)}`} items={items}>
      <span className={`wb-dot ${sessionDotClass(chat)}`} />
      <span className="wb-row-label">{chat.name}</span>
      {chat.pendingRequestCount > 0 ? <span className="wb-badge">{chat.pendingRequestCount}</span> : hint && <span className="wb-state">{hint}</span>}
    </RowWithMenu>
  );
}

/**
 * Bloc « Chats » de l'espace personnel : une ligne d'en-tête qui ouvre la liste des chats (et se replie), puis les
 * derniers chats avec leur état ; au-delà de MAX_CHATS, un lien vers la liste complète.
 */
function ChatsBlock({ chats, expanded, onToggle }: { chats: SidebarSession[]; expanded: boolean; onToggle: () => void }) {
  const location = useLocation();
  const current = location.pathname.match(/^\/chats\/([^/]+)$/)?.[1] ?? null;
  const pending = chats.reduce((n, c) => n + c.pendingRequestCount, 0);
  // Le chat affiché reste listé même s'il n'est pas parmi les plus récents.
  const shown = chats.slice(0, MAX_CHATS);
  if (current && !shown.some((c) => c.id === current)) {
    const extra = chats.find((c) => c.id === current);
    if (extra) shown.push(extra);
  }
  const hidden = chats.length - shown.length;
  return (
    <div className="wb-chats">
      <div className={`wb-row wb-session-row wb-chats-head${location.pathname === '/chats' ? ' active' : ''}`} style={{ paddingLeft: 18 }}>
        <button type="button" className="wb-chevron" onClick={onToggle} title={expanded ? 'Replier les chats' : 'Déplier les chats'}>
          <i className={`bi bi-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
        </button>
        <Link to="/chats" className="wb-row-label" title="Chats : conversations légères, sans dossier de travail, avec accès à tous vos projets">
          <i className="bi bi-chat-left-text wb-icon" /> Chats
        </Link>
        {!expanded && pending > 0 && <span className="wb-badge">{pending}</span>}
        <Link to="/chats" className="wb-plus wb-chats-new" title="Nouveau chat" aria-label="Nouveau chat">
          <i className="bi bi-plus-lg" />
        </Link>
      </div>
      {expanded && (
        <div className="wb-chats-rows">
          {shown.map((c) => (
            <ChatRow key={c.id} chat={c} indent={30} />
          ))}
          {hidden > 0 && (
            <Link to="/chats" className="wb-row wb-empty wb-empty-link" style={{ paddingLeft: 30 }}>
              + {hidden} autre{hidden > 1 ? 's' : ''} chat{hidden > 1 ? 's' : ''}
            </Link>
          )}
          {chats.length === 0 && (
            <Link to="/chats" className="wb-row wb-empty wb-empty-link" style={{ paddingLeft: 30 }}>
              aucun chat : en ouvrir un
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** Menus principaux, affichés en une ligne d'icônes (le libellé sert d'infobulle). */
const MAIN_MENU: { to: string; label: string; icon: string; title?: string }[] = [
  { to: '/', label: 'Tableau de bord', icon: 'bi-speedometer2' },
  { to: '/projects', label: 'Projets', icon: 'bi-folder2' },
  { to: '/sessions', label: 'Sessions', icon: 'bi-chat-dots' },
  { to: '/chats', label: 'Chats', icon: 'bi-chat-left-text', title: 'Chats : conversations légères de votre espace personnel, avec accès à tous vos projets' },
  { to: '/tasks', label: 'Tâches', icon: 'bi-check2-square' },
  { to: '/shared', label: 'Pages', icon: 'bi-file-earmark-richtext', title: 'Pages partagées' },
  { to: '/vault', label: 'Coffre', icon: 'bi-shield-lock' },
  { to: '/workflows', label: 'Workflows', icon: 'bi-diagram-3', title: "Workflows : enchaînements d'appels de modèle, de sessions et de tâches" },
  { to: '/requests', label: 'Demandes', icon: 'bi-bell' },
];

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

/** Icône du dossier d'une session, colorée par l'état de la pull request de sa branche. */
function branchIcon(ws: Workspace, pr: PullRequestRef | null | undefined): { cls: string; title: string } {
  if (!ws.exists) return { cls: 'wt-missing', title: 'Dossier de travail absent du disque (recréé à la prochaine utilisation)' };
  const base = `Branche ${ws.branch}`;
  if (!pr) return { cls: '', title: base };
  const state = pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase();
  return { cls: `wt-pr-${state}`, title: `${base} · pull request #${pr.number} ${state === 'draft' ? 'brouillon' : state === 'open' ? 'ouverte' : state === 'merged' ? 'fusionnée' : 'fermée'}` };
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
function SessionRow({ s, indent, depth = 0, byAgent = false, parentName = null, children = [], wsKey = null, elsewhere = null }: { s: SidebarSession; indent: number; depth?: number; byAgent?: boolean; parentName?: string | null; children?: SessionNode<PoolSession>[]; /** Clé du dossier de la carte : un sous-agent d'un autre dossier est étiqueté. */ wsKey?: string | null; /** Nom du dossier du sous-agent quand ce n'est pas celui de la carte. */ elsewhere?: string | null }) {
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
    { label: 'Archiver', icon: 'bi-archive', separatorBefore: true, onClick: () => void archiveSession({ id: s.id, name: s.name }) },
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
            <i className="bi bi-layers" /> {elsewhere}
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
      {expanded && children.map((c) => <SessionRow key={c.session.id} s={c.session} indent={indent} depth={c.depth} byAgent parentName={c.parentName} elsewhere={c.session.wsKey !== wsKey ? (c.session.wsDeleted ? 'dossier supprimé' : c.session.wsBranch ?? c.session.wsName) : null} />)}
    </>
  );
}

function TerminalRow({ t, indent }: { t: SidebarTerminal; indent: number }) {
  const location = useLocation();
  const { showError } = useDialogs();
  const { deleteTerminal } = useDeletions();
  const [closeTerminal] = useMutation(CLOSE_TERMINAL, { refetchQueries: ['Sidebar'] });
  const items: MenuItem[] = [
    { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/terminals/${t.id}` },
    ...(t.status === 'RUNNING' ? [{ label: 'Fermer le shell', icon: 'bi-x-circle', onClick: () => void closeTerminal({ variables: { id: t.id } }).catch(showError) }] : []),
    { label: 'Supprimer', icon: 'bi-trash', danger: true, separatorBefore: true, onClick: () => void deleteTerminal({ id: t.id, name: t.name }) },
  ];
  return (
    <RowWithMenu to={`/terminals/${t.id}`} active={location.pathname === `/terminals/${t.id}`} indent={indent} title={t.status === 'RUNNING' ? 'Terminal ouvert' : 'Terminal fermé'} items={items}>
      <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} />
      <span className="wb-row-label">{t.name}</span>
    </RowWithMenu>
  );
}

/**
 * Carte d'une session : son état, son nom, sa tâche, les puces de ce qui est ouvert dans son dossier (navigateur,
 * sous-agents qui réclament l'attention, terminaux) et, dépliée, le détail (sous-agents, terminaux). Le dossier de
 * travail (work session) reste invisible : seule sa branche apparaît, dans l'infobulle et la couleur de l'icône (PR).
 * La carte du checkout principal (`primary`) ne subsiste que pour les sessions et terminaux d'avant les work
 * sessions : elle liste ses sessions comme avant.
 */
function WorkspaceCard({ ws, pr, expanded, onToggle, tabUrl, filterMine, showOthers, onShowOthers }: { ws: Workspace; pr: PullRequestRef | null | undefined; expanded: boolean; onToggle: () => void; tabUrl: string | null; filterMine: boolean; showOthers: boolean; onShowOthers: () => void }) {
  const location = useLocation();
  const { user } = useAuth();
  const { activeKey, workspaces } = useTabs();
  const [menu, setMenu] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [subsOpen, setSubsOpen] = useState<boolean | null>(null); // null : automatique (page courante ou demande en attente chez un sous-agent)
  const userId = user?.id ?? null;
  const current = location.pathname;
  const isCurrent = (path: string) => current === path || current === `${path}/browser`;
  // Toutes les sessions du projet, annotées de leur dossier : les sous-agents (qui ont chacun leur dossier) se rangent sous leur parente.
  const pool = useMemo(() => workspaces.ofProject(ws.projectId).flatMap((w) => w.sessions.map((s): PoolSession => ({ ...s, wsKey: w.key, wsName: w.name, wsBranch: w.primary ? null : w.branch, wsWorksessionId: w.worksessionId, wsDeleted: Boolean(w.primary && s.worksession) }))), [workspaces, ws.projectId]);
  const poolById = useMemo(() => new Map(pool.map((s) => [s.id, s])), [pool]);
  // Les sous-agents dont la parente est dans un autre dossier ne sont pas listés ici (`elsewhereSubs`, juste une note
  // sur la carte du checkout principal). Un sous-agent dont la parente a disparu du projet reste au premier niveau, avec son robot.
  const { local, elsewhereSubs } = useMemo(() => {
    const mine = pool.filter((s) => s.wsKey === ws.key);
    const here = new Set(mine.map((s) => s.id));
    return { local: mine.filter((s) => !attachedElsewhere(s, here, poolById)), elsewhereSubs: mine.filter((s) => attachedElsewhere(s, here, poolById)) };
  }, [pool, poolById, ws.key]);
  const visibleSessions = useMemo(() => {
    const all = mineFirst(local, userId);
    if (!filterMine || showOthers) return all;
    // La session affichée reste listée même si elle est à quelqu'un d'autre.
    return all.filter((s) => participates(s, userId) || isCurrent(`/sessions/${s.id}`));
  }, [local, userId, filterMine, showOthers, current]);
  const groups = useMemo(() => sessionGroups(visibleSessions, pool), [visibleSessions, pool]);
  const hiddenOthers = local.length - visibleSessions.length;
  const session = ws.session;
  const self = groups.find((g) => g.root.session.id === session?.id) ?? null;
  const children = self?.children ?? [];
  const childActive = children.some((c) => current.startsWith(`/sessions/${c.session.id}`));
  const subsExpanded = subsOpen ?? (childActive || children.some((c) => c.session.pendingRequestCount > 0));
  const state = workspaceState([...ws.sessions, ...children.map((c) => c.session)]);
  const pending = [...ws.sessions, ...children.map((c) => c.session)].reduce((n, s) => n + s.pendingRequestCount, 0);
  const icon = branchIcon(ws, pr);
  const hint = session ? sessionStateHint(session.status, session.activity, session.pendingRequestCount) : null;
  const mine = session ? participates(session, userId) : true;
  const chips = ws.primary
    ? [
        // Checkout principal : une puce par session de premier niveau, avec le compte de ses sous-agents ; un sous-agent n'a sa propre puce que s'il est la page courante ou attend une réponse.
        ...groups.flatMap(({ root, children }) =>
          [root, ...children.filter((c) => isCurrent(`/sessions/${c.session.id}`) || c.session.pendingRequestCount > 0)].map(({ session: s, ...n }) => ({
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
      ]
    : [
        // Session : son navigateur s'il est ouvert, puis ses sous-agents qui sont la page courante ou attendent une réponse.
        ...(session?.browserActive ? [{ key: 'browser', to: `/sessions/${session.id}/browser`, active: current === `/sessions/${session.id}/browser`, label: 'Navigateur', title: "Voir en direct la page ouverte par l'agent", node: <i className="bi bi-globe2 wb-browser-icon" />, extra: null, owner: null }] : []),
        ...children
          .filter((c) => isCurrent(`/sessions/${c.session.id}`) || c.session.pendingRequestCount > 0)
          .map(({ session: s, ...n }) => ({
            key: `s:${s.id}`,
            to: `/sessions/${s.id}`,
            active: isCurrent(`/sessions/${s.id}`),
            label: s.name,
            title: `${s.name} · ${statusTitle(s)}${byAgentTitle(n)}${s.owner ? ` · ${s.owner.name}` : ''}`,
            node: (
              <>
                <span className={`wb-dot ${sessionDotClass(s)}`} />
                <RobotIcon />
              </>
            ),
            extra: null,
            owner: s.owner && !participates(s, userId) ? s.owner : null,
          })),
      ];
  chips.push(...ws.terminals.map((t) => ({ key: `t:${t.id}`, to: `/terminals/${t.id}`, active: current === `/terminals/${t.id}`, label: t.name, title: `${t.name} · ${t.status === 'RUNNING' ? 'ouvert' : 'fermé'}`, node: <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} />, extra: null, owner: null })));
  const activeIndex = chips.findIndex((c) => c.active);
  const shown = showAll || activeIndex >= MAX_CHIPS ? chips : chips.slice(0, MAX_CHIPS);
  // Clic sur la tête : la session ; checkout principal : la page où l'onglet du dossier en était, sinon les fichiers.
  const headTo = session ? `/sessions/${session.id}` : tabUrl ?? ws.key;
  const title = ws.primary
    ? `Dossier principal · ${ws.name} · sessions d'avant les work sessions`
    : `${session ? `${statusTitle(session)}${session.owner ? ` · ${session.owner.name}` : ''} · ` : ''}${ws.task ? `Tâche : ${ws.task.title} · ${ws.task.status.toLowerCase()}${ws.task.statusTag ? ` · ${ws.task.statusTag}` : ''} · ` : ''}${icon.title}`;
  const hasRows = ws.primary ? visibleSessions.length > 0 || ws.terminals.length > 0 || hiddenOthers > 0 || elsewhereSubs.length > 0 : children.length > 0 || ws.terminals.length > 0 || Boolean(session?.browserActive);
  return (
    <div className={`wb-ws${activeKey === ws.key ? ' active' : ''}${session && isCurrent(`/sessions/${session.id}`) ? ' current' : ''}`}>
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
          {session ? <span className={`wb-dot ${sessionDotClass(session)}`} /> : <span className={`wb-ws-state ${state ?? 'none'}`} />}
          {!ws.primary && <i className={`bi ${ws.task ? 'bi-check2-square' : 'bi-git'} wb-icon ${icon.cls}`} />}
          <span className="wb-ws-name">{ws.name}</span>
          {ws.primary && ws.projectName && <span className="wb-tag" title="Sessions et terminaux d'avant les work sessions, dans le checkout principal">principal</span>}
          {!ws.exists && <span className="wb-tag missing">absent</span>}
          {session?.context.overThreshold && <ContextDot context={session.context} />}
          {session?.owner && !mine && (
            <span className="wb-owner" title={`Session de ${session.owner.name}`}>
              {initialsOf(session.owner.name)}
            </span>
          )}
          {pending > 0 ? <span className="wb-badge">{pending}</span> : hint && <span className="wb-state">{hint}</span>}
        </Link>
        <span className={`wb-row-actions${menu ? ' open' : ''}`}>
          <button
            type="button"
            className="wb-plus"
            title={ws.primary ? 'Ouvrir quelque chose dans le dossier principal' : 'Actions de la session : fichiers, terminal, renommer, archiver, supprimer'}
            onClick={(e) => {
              e.stopPropagation();
              setMenu((v) => !v);
            }}
          >
            <i className="bi bi-three-dots" />
          </button>
          {menu && <AddMenu projectId={ws.projectId} session={session ? { id: session.id, name: session.name, status: session.status, worksessionId: ws.worksessionId, branch: ws.worksessionId ? ws.branch : null } : null} onClose={() => setMenu(false)} />}
        </span>
      </div>
      {(chips.length > 0 || ws.task || ws.primary || hasRows || children.length > 0) && (
        <div className="wb-ws-items">
          {ws.task && (
            <Link to={`/tasks/${ws.task.id}`} className={`wb-ws-task task-status task-status-${ws.task.status.toLowerCase()}`} title={`Tâche : ${ws.task.title}`}>
              {ws.task.status === 'IN_PROGRESS' ? 'en cours' : ws.task.status === 'DONE' ? 'terminée' : ws.task.status === 'CANCELLED' ? 'annulée' : 'à faire'}
              {ws.task.statusTag && <span className="task-status-tag">{ws.task.statusTag}</span>}
            </Link>
          )}
          {!ws.primary && children.length > 0 && !expanded && (
            <button type="button" className="wb-chip" title={`${subagentsSummary(children.map((c) => c.session)).label} lancé(s) par l'agent de cette session · cliquer pour détailler`} onClick={onToggle}>
              <SubagentsCount children={children.map((c) => c.session)} />
            </button>
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
          {ws.primary && hiddenOthers > 0 && (
            <button type="button" className="wb-chip wb-chip-more" title={`Afficher les ${hiddenOthers} session(s) d'autres personnes`} onClick={onShowOthers}>
              <i className="bi bi-people" /> {hiddenOthers}
            </button>
          )}
          {ws.primary && chips.length === 0 && hiddenOthers === 0 && (elsewhereSubs.length ? <ElsewhereNote subs={elsewhereSubs} poolById={poolById} /> : <span className="wb-ws-empty">rien d'ouvert</span>)}
          {hasRows && (
            <button type="button" className="wb-chevron wb-ws-chevron" title={expanded ? 'Replier' : 'Détailler'} onClick={onToggle}>
              <i className={`bi bi-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
            </button>
          )}
        </div>
      )}
      {expanded && hasRows && (
        <div className="wb-ws-rows">
          {ws.primary ? (
            <>
              {groups.map(({ root, children }) => (
                <SessionRow key={root.session.id} s={root.session} indent={30} byAgent={root.byAgent} parentName={root.parentName} children={children} wsKey={ws.key} />
              ))}
              {hiddenOthers > 0 && (
                <button type="button" className="wb-row wb-empty wb-row-btn" style={{ paddingLeft: 30 }} onClick={onShowOthers}>
                  + {hiddenOthers} session(s) d'autres personnes
                </button>
              )}
              {elsewhereSubs.length > 0 && <ElsewhereNote subs={elsewhereSubs} poolById={poolById} row />}
            </>
          ) : (
            session && (
              <>
                {session.browserActive && (
                  <Link to={`/sessions/${session.id}/browser`} className={`wb-row wb-session-row wb-browser-row${current === `/sessions/${session.id}/browser` ? ' active' : ''}`} style={{ paddingLeft: 30 }} title="Voir en direct la page ouverte par l'agent">
                    <i className="bi bi-globe2 wb-browser-icon" />
                    <span className="wb-row-label">Navigateur</span>
                  </Link>
                )}
                {children.length > 0 && <SubagentsRow children={children.map((c) => c.session)} indent={30} expanded={subsExpanded} onToggle={() => setSubsOpen(!subsExpanded)} />}
                {subsExpanded && children.map((c) => <SessionRow key={c.session.id} s={c.session} indent={30} depth={c.depth} byAgent parentName={c.parentName} elsewhere={null} />)}
              </>
            )
          )}
          {ws.terminals.map((t) => (
            <TerminalRow key={t.id} t={t} indent={30} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Utilisateur connecté (avatar, nom, e-mail) en bas de la sidebar : un clic ouvre le menu du compte
 * (installer l'application, utilisateurs, paramètres, déconnexion).
 */
function UserBlock() {
  const { user, logout } = useAuth();
  const { available: installable, install } = useInstallApp();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const items: MenuItem[] = [
    ...(installable ? [{ label: "Installer l'application", icon: 'bi-phone', onClick: install }] : []),
    ...(user.isAdmin ? [{ label: 'Utilisateurs', icon: 'bi-people', to: '/users' }] : []),
    { label: 'Paramètres', icon: 'bi-gear', to: '/settings' },
    { label: 'Se déconnecter', icon: 'bi-box-arrow-right', separatorBefore: true, onClick: () => void logout() },
  ];
  return (
    <div className={`wb-user-wrap${open ? ' open' : ''}`}>
      <button
        type="button"
        className="wb-user"
        title="Menu du compte"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="wb-avatar" referrerPolicy="no-referrer" /> : <span className="wb-avatar wb-avatar-initials">{initialsOf(user.name)}</span>}
        <span className="wb-user-name">
          <span className="wb-user-label">{user.name}</span>
          <span className="wb-user-email">{user.email}</span>
        </span>
        <i className={`bi bi-chevron-${open ? 'down' : 'up'} wb-user-chevron`} />
      </button>
      {open && <PopMenu items={items} onClose={() => setOpen(false)} up />}
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
  const { data } = usePollingQuery<{ projects: SidebarProject[]; chats: SidebarSession[] }>(SIDEBAR, { variables: { open }, pollInterval: 3000, fetchPolicy: 'cache-and-network' });
  const chats = data?.chats ?? [];
  const { data: prData } = usePollingQuery<{ projects: { id: string; worksessions: { id: string; pullRequest: PullRequestRef | null }[] }[] }>(SIDEBAR_PULL_REQUESTS, { variables: { open }, pollInterval: 60_000 });
  const { data: pendingData } = usePollingQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 3000 });
  const pending = pendingData?.requests.length ?? 0;
  const prByWorksession = useMemo(() => new Map((prData?.projects ?? []).flatMap((p) => p.worksessions.map((w) => [w.id, w.pullRequest] as const))), [prData]);
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
  // Projets où l'on a demandé à voir les sessions des autres malgré le filtre « les miennes ».
  const [othersShown, setOthersShown] = useState<Set<string>>(new Set());
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
    // L'espace personnel s'ouvre quand un chat est en cours ou attend une réponse, ou qu'un chat est affiché.
    if (p.isPersonal && (location.pathname.startsWith('/chats') || chats.some((c) => c.status === 'RUNNING' || c.pendingRequestCount > 0))) return true;
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

      <nav className="wb-menu wb-menu-icons" aria-label="Navigation principale">
        {MAIN_MENU.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.to !== '/requests'} className="wb-menu-item" title={m.title ?? m.label} aria-label={m.label}>
            <i className={`bi ${m.icon} wb-icon`} />
            {m.to === '/requests' && pending > 0 && (
              <span className="wb-badge" title="Un agent attend votre réponse">
                {pending}
              </span>
            )}
          </NavLink>
        ))}
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
        {[...(data?.projects ?? [])]
          .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal))
          .map((p) => {
          const open = expanded[p.id] ?? projectDefaultOpen(p);
          const list = workspaces.ofProject(p.id);
          const collapsedPending = !open ? p.sessions.filter((s) => participates(s, userId)).reduce((n, s) => n + s.pendingRequestCount, 0) : 0;
          return (
            <div key={p.id} className={`wb-project${p.isPersonal ? ' wb-personal' : ''}`}>
              <div className={`wb-row wb-project-row${p.id === activeProjectId ? ' active' : ''}`}>
                <button type="button" className="wb-chevron" onClick={() => toggle(p.id, projectDefaultOpen(p))} title={open ? 'Replier' : 'Déplier'}>
                  <i className={`bi bi-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
                </button>
                <Link to={`/projects/${p.id}`} className="wb-row-label" title={p.isPersonal ? 'Mon espace personnel : mes sessions, chats et tâches, avec accès à tous mes projets' : 'Ouvrir le projet'}>
                  <i className={`bi ${p.isPersonal ? 'bi-person-circle' : 'bi-folder2'} wb-icon`} /> {p.isPersonal ? 'Mon espace' : p.name}
                </Link>
                {!p.isMember && <i className="bi bi-shield-lock wb-icon" title="Vous n'êtes pas membre de ce projet : il apparaît parce qu'un de vos onglets y est ouvert (super administrateur)" />}
                {collapsedPending > 0 && <span className="wb-badge">{collapsedPending}</span>}
                <span className={`wb-row-actions${menuFor === p.id ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="wb-plus"
                    title="Actions du projet : nouvelle session, workflow ; pages ; modification, suppression"
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
                      project={{ id: p.id, name: p.name, canManage: p.myRole === 'ADMIN', paths: [...p.sessions.map((s) => `/sessions/${s.id}`), ...p.terminals.map((t) => `/terminals/${t.id}`)] }}
                      onClose={() => setMenuFor(null)}
                    />
                  )}
                </span>
              </div>
              {open && p.isPersonal && <ChatsBlock chats={chats} expanded={expanded[`chats:${p.id}`] ?? true} onToggle={() => toggle(`chats:${p.id}`, true)} />}
              {open && (() => {
                const showOthers = othersShown.has(p.id);
                const poolById = new Map(p.sessions.map((s) => [s.id, s]));
                // Une carte par session de premier niveau (un sous-agent est rangé sous sa parente) ; avec le filtre
                // « les miennes », les sessions des autres sont comptées, sauf celle affichée. Le dossier principal
                // n'accueille plus rien : sa carte ne reste que pour les sessions et terminaux d'avant les work sessions.
                const cards = list.filter((ws) => {
                  if (ws.primary) return ws.sessions.length > 0 || ws.terminals.length > 0;
                  // Un sous-agent dont la parente (ou une aïeule) est dans le projet n'a pas sa carte : il est listé sous elle.
                  return !attachedElsewhere(ws.session!, new Set([ws.session!.id]), poolById);
                });
                const visible = cards.filter((ws) => ws.primary || !(filter === 'mine' && !showOthers) || participates(ws.session!, userId) || location.pathname.startsWith(`/sessions/${ws.session!.id}`));
                const hiddenOthers = cards.length - visible.length;
                return (
                  <>
                    {visible.map((ws) => (
                      <WorkspaceCard
                        key={ws.key}
                        ws={ws}
                        pr={ws.worksessionId ? prByWorksession.get(ws.worksessionId) : null}
                        expanded={expanded[ws.key] ?? false}
                        onToggle={() => toggle(ws.key, false)}
                        tabUrl={tabs.find((t) => t.key === ws.key)?.url ?? null}
                        filterMine={filter === 'mine'}
                        showOthers={showOthers}
                        onShowOthers={() => setOthersShown((prev) => new Set([...prev, p.id]))}
                      />
                    ))}
                    {hiddenOthers > 0 && (
                      <button type="button" className="wb-row wb-empty wb-row-btn" style={{ paddingLeft: 18 }} title="Afficher les sessions d'autres personnes" onClick={() => setOthersShown((prev) => new Set([...prev, p.id]))}>
                        <i className="bi bi-people me-1" /> + {hiddenOthers} session{hiddenOthers > 1 ? 's' : ''} d'autres personnes
                      </button>
                    )}
                    {cards.length === 0 && (
                      <div className="wb-row wb-empty" style={{ paddingLeft: 18 }}>
                        aucune session
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          );
        })}
        {data && data.projects.length === 0 && (
          <div className="wb-row wb-empty">
            Aucun projet. <Link to="/projects">Créer le premier</Link>
          </div>
        )}
      </div>
      <div className="wb-menu wb-menu-bottom">
        <UserBlock />
      </div>
    </aside>
  );
}
