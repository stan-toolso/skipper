import AgentAvatar from '../components/AgentAvatar';
import { isOpus, shortModel } from '../lib/models';
import { useMutation, useQuery } from '@apollo/client';
import PopMenu, { type MenuItem } from '../components/PopMenu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CLOSE_TERMINAL, INBOX_COUNTS, RUN_SCHEDULE_NOW, SIDEBAR, SIDEBAR_PULL_REQUESTS, STOP_SESSION } from '../graphql/operations';
import { usePollingQuery } from '../lib/usePollingQuery';
import { formatCost, sessionStateHint, taskChipOf } from '../lib/humanize';
import Logo from '../components/Logo';
import { useInstallApp } from '../components/InstallButton';
import { useDialogs } from '../components/Dialogs';
import { useSearchPalette } from '../components/SearchPalette';
import { useShortcutsHelp } from '../components/ShortcutsHelp';
import { displayComboText } from '../lib/shortcuts';
import { PullRequestWindow, windowFor } from '../components/TrackedPullRequests';
import { localWorkText, type TrackedPullRequestSummary } from '../graphql/pullRequests';
import { FAVORITE_SHARED_PAGES, type FavoriteSharedPage } from '../graphql/misc';
import { useFavoriteToggle } from '../components/pages/FavoriteButton';
import AddMenu from './AddMenu';
import { useDeletions } from './useDeletions';
import { useTabs } from './TabsContext';
import { SubagentsCount, initialsOf, sessionDotClass } from './WorkspaceTabs';
import { attachedElsewhere, cliSubagentDetail, cliSubagentsLabel, isBackgroundCommand, waitingCommandsHint, mineFirst, openItemsOf, ownerGroups, participates, runLabel, scheduleGroups, sessionGroups, subagentsSummary, workspaceState, type CliSubagent, type ScheduleGroup, type SessionNode, type SidebarProject, type SidebarSession, type OwnerGroup, type SidebarTerminal, type Workspace } from './workspaces';
import { leaveProjectWindow, openFullSkipper, projectWindowId } from '../lib/projectWindow';

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
      {chat.pendingRequestCount > 0 ? <span className="wb-badge">{chat.pendingRequestCount}</span> : hint && sessionDotClass(chat) !== 'idle' && <span className={`wb-state ${sessionDotClass(chat)}`}>{hint}</span>}
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
      <div className={`wb-row wb-session-row wb-chats-head${location.pathname === '/chats' ? ' active' : ''}`} style={{ paddingLeft: 8 }}>
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
            <ChatRow key={c.id} chat={c} indent={26} />
          ))}
          {hidden > 0 && (
            <Link to="/chats" className="wb-row wb-empty wb-empty-link" style={{ paddingLeft: 26 }}>
              + {hidden} autre{hidden > 1 ? 's' : ''} chat{hidden > 1 ? 's' : ''}
            </Link>
          )}
          {chats.length === 0 && (
            <Link to="/chats" className="wb-row wb-empty wb-empty-link" style={{ paddingLeft: 26 }}>
              aucun chat : en ouvrir un
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** Projet où la personne n'est qu'invitée : ses conversations, avec les non-lus. */
export interface GuestProject {
  id: string;
  name: string;
  unreadMessages: number;
}

/**
 * Section « Conversations » : les projets où la personne n'est qu'invitée (rôle invité : canaux et artefacts partagés,
 * sans sessions ni tâches), chacun menant à ses canaux. Rien tant qu'il n'y en a pas.
 */
function GuestProjectsSection({ projects, activeProjectId }: { projects: GuestProject[]; activeProjectId: string | null | undefined }) {
  if (!projects.length) return null;
  return (
    <>
      <div className="wb-section-title">
        <span className="wb-section-link" title="Projets où vous êtes invité : vous y suivez les conversations de l’équipe et de ses agents">
          Conversations
        </span>
      </div>
      <div className="wb-guest-projects">
        {projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}/conversations`} className={`wb-row wb-guest-project${p.id === activeProjectId ? ' active' : ''}`} title={`Conversations de ${p.name}`}>
            <i className="bi bi-chat-square-text wb-icon" />
            <span className="wb-row-label">{p.name}</span>
            {p.unreadMessages > 0 && <span className="wb-badge">{p.unreadMessages}</span>}
          </Link>
        ))}
      </div>
    </>
  );
}

/** Icône et libellé d'un type d'artefact (repris de ARTIFACT_KINDS de pages/SharedPagesPage, chargée à la demande : pas importée ici). */
const FAVORITE_KINDS: Record<FavoriteSharedPage['kind'], { icon: string; label: string }> = {
  PAGE: { icon: 'bi-file-earmark-richtext', label: 'Page' },
  DATA: { icon: 'bi-bar-chart-line', label: 'Données' },
  SLIDES: { icon: 'bi-easel', label: 'Diapositives' },
};

/**
 * Section « Favoris » : les artefacts que la personne a mis en favori (étoile de la galerie ou de la page), dans
 * l'ordre d'ajout ; repliable. Rien tant qu'il n'y a pas de favori. Menu de chaque ligne : ouvrir, retirer.
 */
function FavoritesSection({ expanded, onToggle, projectId }: { expanded: boolean; onToggle: () => void; /** Fenêtre dédiée à un projet : seulement ses artefacts. */ projectId: string | null }) {
  const location = useLocation();
  const toggleFavorite = useFavoriteToggle();
  const { data } = usePollingQuery<{ favoriteSharedPages: FavoriteSharedPage[] }>(FAVORITE_SHARED_PAGES, { pollInterval: 60_000 });
  const favorites = (data?.favoriteSharedPages ?? []).filter((f) => !projectId || f.project?.id === projectId);
  if (!favorites.length) return null;
  return (
    <div className="wb-favorites-block">
      <div className="wb-section-title">
        <button type="button" className="wb-section-toggle" onClick={onToggle} title={expanded ? 'Replier les favoris' : 'Déplier les favoris'} aria-expanded={expanded}>
          <i className={`bi bi-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: 9 }} /> Favoris
          {!expanded && <span className="wb-fav-count">{favorites.length}</span>}
        </button>
        <Link to={projectId ? `/projects/${projectId}/artifacts` : '/shared'} className="wb-section-action" title="Tous les artefacts">
          <i className="bi bi-collection" />
        </Link>
      </div>
      {expanded && (
        <div className="wb-favorites">
          {favorites.map((f) => {
            const kind = FAVORITE_KINDS[f.kind] ?? FAVORITE_KINDS.PAGE;
            const items: MenuItem[] = [
              { label: 'Ouvrir', icon: 'bi-box-arrow-in-right', to: `/shared/${f.id}` },
              { label: 'Retirer des favoris', icon: 'bi-star', separatorBefore: true, onClick: () => toggleFavorite({ id: f.id, favorite: true }) },
            ];
            return (
              <RowWithMenu key={f.id} to={`/shared/${f.id}`} active={location.pathname === `/shared/${f.id}` || location.pathname.endsWith(`/pages/${f.id}`)} indent={14} title={`${kind.label} · ${f.title}`} items={items}>
                <i className={`bi ${kind.icon} wb-icon wb-fav-icon wb-fav-${f.kind.toLowerCase()}`} />
                <span className="wb-row-label">{f.title}</span>
                {f.openComments > 0 && (
                  <span className="wb-badge" title={`${f.openComments} commentaire${f.openComments > 1 ? 's' : ''} à traiter`}>
                    {f.openComments}
                  </span>
                )}
              </RowWithMenu>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * L'essentiel en tête de la sidebar : l'accueil, ce qui attend une action, les tâches. Les autres pages (sessions,
 * chats, artefacts, projets, coffre, planifications, workflows…) sont dans le menu du compte (`MORE_PAGES`) et la
 * recherche (⌘K) ; les sessions, chats et projets sont de toute façon listés plus bas.
 */
type MenuEntry = { to: string; label: string; icon: string; title?: string };
const MAIN_MENU: MenuEntry[] = [
  { to: '/', label: 'Accueil', icon: 'bi-house', title: 'Tableau de bord' },
  { to: '/inbox', label: 'À traiter', icon: 'bi-inbox', title: 'À traiter : demandes, sessions en attente et pull requests à fusionner, tous projets' },
  { to: '/tasks', label: 'Tâches', icon: 'bi-check2-square', title: 'Tâches de tous vos projets' },
];
/** Personne qui n'a que des accès d'invité (conversations et artefacts partagés) : ni accueil, ni tâches, ni « à traiter ». */
const RESTRICTED_MENU: MenuEntry[] = [{ to: '/shared', label: 'Artefacts partagés', icon: 'bi-collection', title: 'Pages, tableaux de bord et diapositives partagés avec vous' }];
/** Fenêtre dédiée à un projet : l'essentiel, limité au projet (les pages globales n'y existent pas). */
const projectMenu = (id: string): MenuEntry[] => [
  { to: `/projects/${id}`, label: 'Accueil', icon: 'bi-house', title: 'Tableau de bord du projet' },
  { to: '/inbox', label: 'À traiter', icon: 'bi-inbox', title: 'À traiter : demandes, sessions en attente et pull requests à fusionner du projet' },
  { to: `/projects/${id}/tasks`, label: 'Tâches', icon: 'bi-check2-square', title: 'Tâches du projet' },
  { to: `/projects/${id}/conversations`, label: 'Conversations', icon: 'bi-chat-square-text', title: 'Canaux de conversation du projet' },
];
/** Pages du projet rangées dans le menu du compte d'une fenêtre dédiée au projet. */
const projectMorePages = (id: string): MenuItem[] => [
  { label: 'Historique des sessions', icon: 'bi-clock-history', to: `/projects/${id}/history` },
  { label: 'Artefacts', icon: 'bi-collection', to: `/projects/${id}/artifacts` },
  { label: 'Pull requests', icon: 'bi-git', to: `/projects/${id}/pull-requests` },
  { label: 'Coffre', icon: 'bi-shield-lock', to: `/projects/${id}/vault` },
  { label: 'Planifications', icon: 'bi-alarm', to: `/projects/${id}/schedules` },
  { label: 'Workflows', icon: 'bi-diagram-3', to: `/projects/${id}/workflows` },
];
/** Pages moins fréquentes, rangées dans le menu du compte (bas de la sidebar). */
const MORE_PAGES: MenuItem[] = [
  { label: 'Sessions', icon: 'bi-chat-dots', to: '/sessions' },
  { label: 'Chats', icon: 'bi-chat-left-text', to: '/chats' },
  { label: 'Artefacts', icon: 'bi-collection', to: '/shared' },
  { label: 'Projets', icon: 'bi-folder2', to: '/projects' },
  { label: 'Demandes', icon: 'bi-bell', to: '/requests' },
  { label: 'Coffre', icon: 'bi-shield-lock', to: '/vault' },
  { label: 'Planifications', icon: 'bi-alarm', to: '/schedules' },
  { label: 'Workflows', icon: 'bi-diagram-3', to: '/workflows' },
];

/** PR suivie d'un dossier de travail : en préparation dès que la branche porte des modifications, puis ouverte sur GitHub. */
type PullRequestRef = TrackedPullRequestSummary;

/** « sous-agent de « Nom » » ou « sous-agent (lancé par un agent) » pour une session lancée par l'agent d'une autre session (sessions.create). */
const byAgentTitle = (n: Pick<SessionNode<unknown>, 'byAgent' | 'parentName'>) => (n.byAgent ? ` · sous-agent${n.parentName ? ` de « ${n.parentName} »` : ' (lancé par un agent)'}` : '');

/** Pictogramme d'une session planifiée (barré quand la planification est en pause). */
const ScheduleIcon = ({ schedule }: { schedule: { name: string; enabled: boolean } }) => (
  <i className={`bi ${schedule.enabled ? 'bi-alarm' : 'bi-alarm wb-schedule-paused'} wb-robot`} title={`Planification « ${schedule.name} »${schedule.enabled ? '' : ' (en pause)'}`} aria-label="Planifiée" />
);

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

/**
 * Sous-agents du CLI en cours dans une session (outil Agent, premier plan ou arrière-plan) : une ligne chacun, reliée
 * par └, avec sa description et depuis quand il tourne. Ce ne sont pas des sessions Skipper : un clic ouvre son fil
 * (pages/SubagentPage.tsx, /sessions/<id>/subagents/<toolUseId>), tiré des événements de la session.
 */
function CliSubagentRows({ sessionId, subagents, indent }: { sessionId: string; subagents: readonly CliSubagent[]; indent: number }) {
  const location = useLocation();
  const now = Date.now();
  return (
    <>
      {subagents.map((a) => {
        const d = cliSubagentDetail(a, now);
        const command = isBackgroundCommand(a);
        // Une commande de fond n'a pas de fil à elle : son appel est dans le transcript de la session.
        const to = a.toolUseId && !command ? `/sessions/${sessionId}/subagents/${encodeURIComponent(a.toolUseId)}` : `/sessions/${sessionId}`;
        return (
          <Link key={a.id} to={to} className={`wb-row wb-session-row wb-cli-subagent${location.pathname === to && !command ? ' active' : ''}`} style={{ paddingLeft: indent }} title={command ? d.title : `${d.title} · cliquer pour suivre son fil`}>
            <span className="wb-tree">└</span>
            <span className="wb-dot busy" />
            {command ? <i className="bi bi-terminal wb-robot" aria-label="Commande en arrière-plan" /> : <i className="bi bi-robot wb-robot" aria-label="Sous-agent" />}
            <span className="wb-row-label">{a.description}</span>
            <span className="wb-state busy">{d.short}</span>
          </Link>
        );
      })}
    </>
  );
}

/** Puce « 🤖 N » des sous-agents du CLI au travail, sur la ligne de méta d'une carte repliée. */
const CliSubagentsChip = ({ subagents }: { subagents: readonly CliSubagent[] }) => (
  <span className="wb-chip-sub busy wb-cli-chip">
    <i className={`bi ${subagents.every(isBackgroundCommand) ? 'bi-terminal' : 'bi-robot'}`} />
    {subagents.length}
  </span>
);

function statusTitle(s: SidebarSession): string {
  if (s.status === 'RUNNING') return s.activity === 'BUSY' ? "L'agent travaille" : "L'agent attend vos instructions";
  if (s.status === 'QUEUED') return "En file d'attente : démarrera dès qu'une place se libère";
  if (s.status === 'FAILED') return 'Terminée avec une erreur';
  if (s.status === 'COMPLETED') return 'Terminée';
  if (s.status === 'STOPPED') return 'Arrêtée';
  if (s.status === 'INTERRUPTED') return 'Interrompue (redémarrage du serveur ou de l’environnement du projet) : à reprendre';
  return 'Pas encore démarrée';
}

/** Pastille de la pull request de la branche : visible tant qu'elle attend une action (en préparation, brouillon, à fusionner) ou juste fusionnée. */
const PR_PILL: Record<string, string> = { pending: 'en préparation', open: 'à fusionner', draft: 'brouillon', merged: 'fusionnée' };

const PR_STATE: Record<PullRequestRef['stage'], string> = { PENDING: 'pending', DRAFT: 'draft', TO_MERGE: 'open', MERGED: 'merged', CANCELLED: 'closed' };
const prState = (pr: PullRequestRef) => PR_STATE[pr.stage];
/** « #42 » d'une PR ouverte, travail local (« 3 commits, 2 fichiers non commités ») d'une PR en préparation. */
const prLabel = (pr: PullRequestRef) => (pr.number == null ? localWorkText(pr) || 'modifications locales' : `#${pr.number}`);

/** Icône du dossier d'une session, colorée par l'état de la pull request de sa branche. */
function branchIcon(ws: Workspace, pr: PullRequestRef | null | undefined): { cls: string; title: string } {
  if (!ws.exists) return { cls: 'wt-missing', title: 'Dossier de travail absent du disque (recréé à la prochaine utilisation)' };
  const base = `Branche ${ws.branch}`;
  if (!pr) return { cls: '', title: base };
  const state = prState(pr);
  if (state === 'pending') return { cls: 'wt-pr-pending', title: `${base} · pull request en préparation (${prLabel(pr)}), pas encore ouverte` };
  return { cls: `wt-pr-${state}`, title: `${base} · pull request #${pr.number} ${state === 'draft' ? 'brouillon' : state === 'open' ? 'ouverte' : state === 'merged' ? 'fusionnée' : 'fermée'}` };
}

/**
 * Étape de la PR d'un sous-agent qui travaille dans son propre dossier, sur sa ligne : « #12 », « #12 ✓ »… colorée
 * comme la pastille des cartes. Seulement tant qu'elle attend une action ou vient d'être fusionnée (PR_PILL).
 */
function SubPrTag({ pr }: { pr: PullRequestRef }) {
  const state = prState(pr);
  const pill = PR_PILL[state];
  if (!pill) return null;
  return (
    <span className={`wb-tag wb-sub-pr wt-pr-${state}`} title={`Pull request de sa branche : ${pr.number == null ? prLabel(pr) : `#${pr.number}`} · ${pill}`}>
      <i className="bi bi-git" /> {pr.number == null ? pill : `#${pr.number}`}
    </span>
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
function SessionRow({ s, indent, depth = 0, byAgent = false, parentName = null, children = [], wsKey = null, elsewhere = null, pr = null, prOf }: { s: SidebarSession; indent: number; depth?: number; byAgent?: boolean; parentName?: string | null; children?: SessionNode<PoolSession>[]; /** Clé du dossier de la carte : un sous-agent d'un autre dossier est étiqueté. */ wsKey?: string | null; /** Nom du dossier du sous-agent quand ce n'est pas celui de la carte. */ elsewhere?: string | null; /** PR suivie du dossier propre à cette session (sous-agent dans son dossier à lui). */ pr?: PullRequestRef | null; /** PR suivie d'un dossier, pour les sous-agents dépliés. */ prOf?: (worksessionId: string | null) => PullRequestRef | null }) {
  const location = useLocation();
  const [open, setOpen] = useState<boolean | null>(null); // null : automatique (page courante ou demande en attente chez un sous-agent)
  const childActive = children.some((c) => location.pathname.startsWith(`/sessions/${c.session.id}`));
  const expanded = open ?? (childActive || children.some((c) => c.session.pendingRequestCount > 0));
  const { user } = useAuth();
  const { showError } = useDialogs();
  const { archiveSession } = useDeletions();
  const [stopSession] = useMutation(STOP_SESSION, { refetchQueries: ['Sidebar'] });
  const hint = sessionStateHint(s.status, s.activity, s.pendingRequestCount);
  // Au repos mais en attente de commandes de fond : l'anneau seul ferait croire qu'il n'y a plus rien en cours.
  const waiting = waitingCommandsHint(s);
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
      <RowWithMenu to={`/sessions/${s.id}`} active={location.pathname === `/sessions/${s.id}`} indent={left} title={`${statusTitle(s)}${s.model ? ` · modèle ${s.model}` : ''}${byAgentTitle({ byAgent, parentName })}${elsewhere ? ` · dans le dossier ${elsewhere}` : ''}${s.costUsd ? ` · coût ${formatCost(s.costUsd)}` : ''}`} items={items}>
        {depth > 0 && <span className="wb-tree">└</span>}
        <span className={`wb-dot ${sessionDotClass(s)}`} />
        {byAgent && depth === 0 && <RobotIcon />}
        {s.schedule && <ScheduleIcon schedule={s.schedule} />}
        <span className="wb-row-label">{s.name}</span>
        {s.model && !isOpus(s.model) && (
          <span className="wb-tag wb-model-tag" title={`Modèle : ${s.model}`}>
            {shortModel(s.model)}
          </span>
        )}
        {pr && <SubPrTag pr={pr} />}
        {elsewhere && !s.name.toLowerCase().startsWith(elsewhere.toLowerCase()) && (
          <span className="wb-tag" title={`Travaille dans le dossier ${elsewhere}`}>
            <i className="bi bi-layers" /> {elsewhere}
          </span>
        )}
        {s.agent ? (
          <AgentAvatar agent={s.agent} size={16} className="wb-owner wb-owner-agent" title={`Session de l'agent ${s.agent.name}`} />
        ) : (
          s.owner &&
          !mine && (
            <span className="wb-owner" title={`Session de ${s.owner.name}`}>
              {initialsOf(s.owner.name)}
            </span>
          )
        )}
        {s.pendingRequestCount > 0 ? (
          <span className="wb-badge">{s.pendingRequestCount}</span>
        ) : waiting && depth === 0 ? (
          <span className="wb-state pending">{waiting}</span>
        ) : (
          hint && depth === 0 && sessionDotClass(s) !== 'idle' && <span className={`wb-state ${sessionDotClass(s)}`}>{hint}</span>
        )}
      </RowWithMenu>
      {s.browserActive && (
        <Link to={browserPath} className={`wb-row wb-session-row wb-browser-row${location.pathname === browserPath ? ' active' : ''}`} style={{ paddingLeft: left + 16 }} title="Voir en direct la page ouverte par l'agent">
          <i className="bi bi-globe2 wb-browser-icon" />
          <span className="wb-row-label">Navigateur</span>
        </Link>
      )}
      {(s.subagents?.length ?? 0) > 0 && <CliSubagentRows sessionId={s.id} subagents={s.subagents!} indent={left + CHILD_INDENT} />}
      {children.length > 0 && <SubagentsRow children={children.map((c) => c.session)} indent={left + CHILD_INDENT} expanded={expanded} onToggle={() => setOpen(!expanded)} />}
      {expanded && children.map((c) => <SessionRow key={c.session.id} s={c.session} indent={indent} depth={c.depth} byAgent parentName={c.parentName} elsewhere={c.session.wsKey !== wsKey ? (c.session.wsDeleted ? 'dossier supprimé' : c.session.wsBranch ?? c.session.wsName) : null} pr={c.session.wsKey !== wsKey ? prOf?.(c.session.wsWorksessionId) ?? null : null} prOf={prOf} />)}
    </>
  );
}

/**
 * Ligne repliable des sessions d'une autre personne ou d'un agent dans un projet : pastille (avatar de l'agent ou
 * initiales), nom, nombre de sessions et leur état (réponse attendue, au travail…).
 */
function OwnerGroupRow({ group, expanded, onToggle }: { group: OwnerGroup<Workspace>; expanded: boolean; onToggle: () => void }) {
  const sessions = group.items.map((ws) => ws.session!);
  const sum = subagentsSummary(sessions);
  const who = group.agent ? `l'agent ${group.agent.name}` : group.owner.name;
  const count = `${sessions.length} session${sessions.length > 1 ? 's' : ''}`;
  return (
    <button type="button" className={`wb-row wb-row-btn wb-owner-group${expanded ? ' open' : ''}`} style={{ paddingLeft: 8 }} title={`${count} de ${who} · cliquer pour ${expanded ? 'replier' : 'déplier'}`} onClick={onToggle}>
      {group.agent ? (
        <AgentAvatar agent={group.agent} size={16} className="wb-owner wb-owner-agent" />
      ) : (
        <span className="wb-owner">{initialsOf(group.owner.name)}</span>
      )}
      <span className="wb-row-label">{group.agent?.name ?? group.owner.name}</span>
      {sum.state && <span className={`wb-dot ${sum.state}`} />}
      {sum.pending > 0 ? <span className="wb-badge">{sum.pending}</span> : <span className="wb-state">{sessions.length}</span>}
      <i className={`bi bi-chevron-${expanded ? 'down' : 'right'} wb-subagents-chevron`} />
    </button>
  );
}

/**
 * Ligne d'une planification : les sessions de ses exécutions s'affichent dessous (dépliée par défaut). Un clic replie
 * ou déplie ; le menu lance une exécution tout de suite (« Exécuter maintenant », nouvelle session ouverte) ou ouvre
 * la planification (réglages, historique).
 */
function ScheduleGroupRow({ group, projectId, canRun, expanded, onToggle }: { group: ScheduleGroup<Workspace>; projectId: string; canRun: boolean; expanded: boolean; onToggle: () => void }) {
  const [menu, setMenu] = useState(false);
  const navigate = useNavigate();
  const { showError } = useDialogs();
  const [runNow] = useMutation<{ runScheduleNow: { id: string } | null }>(RUN_SCHEDULE_NOW, { refetchQueries: ['Sidebar', 'SessionSchedules'] });
  const launch = async () => {
    const res = await runNow({ variables: { id: group.schedule.id } }).catch((err: Error) => (showError(err), null));
    const sessionId = res?.data?.runScheduleNow?.id;
    if (sessionId) navigate(`/sessions/${sessionId}`);
  };
  const sessions = group.items.map((ws) => ws.session!);
  const sum = subagentsSummary(sessions);
  const count = `${sessions.length} exécution${sessions.length > 1 ? 's' : ''}`;
  const items: MenuItem[] = [
    ...(canRun ? [{ label: 'Exécuter maintenant', icon: 'bi-play-circle', onClick: () => void launch() }] : []),
    { label: 'Modifier la planification', icon: 'bi-pencil', to: `/projects/${projectId}/schedules?edit=${group.schedule.id}` },
    { label: 'Planifications du projet', icon: 'bi-alarm', to: `/projects/${projectId}/schedules` },
  ];
  return (
    <div
      role="button"
      tabIndex={0}
      className={`wb-row wb-row-btn wb-schedule-group${expanded ? ' open' : ''}`}
      style={{ paddingLeft: 8 }}
      title={`Planification « ${group.schedule.name} »${group.schedule.enabled ? '' : ' (en pause)'} · ${count} dans la sidebar · cliquer pour ${expanded ? 'replier' : 'déplier'}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu(true);
      }}
    >
      <ScheduleIcon schedule={group.schedule} />
      <span className="wb-row-label">{group.schedule.name}</span>
      {sum.state && <span className={`wb-dot ${sum.state}`} />}
      {sum.pending > 0 ? <span className="wb-badge">{sum.pending}</span> : sessions.length > 1 && <span className="wb-state">{sessions.length}</span>}
      <i className={`bi bi-chevron-${expanded ? 'down' : 'right'} wb-subagents-chevron`} />
      <span className={`wb-row-actions${menu ? ' open' : ''}`}>
        <button
          type="button"
          className="wb-plus"
          title="Actions de la planification"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu((v) => !v);
          }}
        >
          <i className="bi bi-three-dots" />
        </button>
        {menu && <PopMenu items={items} onClose={() => setMenu(false)} />}
      </span>
    </div>
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
function WorkspaceCard({ ws, pr, prOf, expanded, onToggle, tabUrl, filterMine, showOthers, onShowOthers, label }: { ws: Workspace; pr: PullRequestRef | null | undefined; /** PR suivie d'un autre dossier du projet (sous-agents dans leur dossier). */ prOf: (worksessionId: string | null) => PullRequestRef | null; expanded: boolean; onToggle: () => void; tabUrl: string | null; filterMine: boolean; showOthers: boolean; onShowOthers: () => void; /** Nom affiché à la place de celui du dossier (session d'exécution sous sa planification : la date seule). */ label?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeKey, workspaces } = useTabs();
  const [menu, setMenu] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
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
  // Sous-agents du CLI de la session du dossier (outil Agent) : puce sur la carte repliée, une ligne chacun dépliée.
  const cli = (!ws.primary && session?.subagents) || [];
  const state = workspaceState([...ws.sessions, ...children.map((c) => c.session)]);
  const taskChip = ws.task ? taskChipOf(ws.task, session ?? null) : null;
  const pending = [...ws.sessions, ...children.map((c) => c.session)].reduce((n, s) => n + s.pendingRequestCount, 0);
  const icon = branchIcon(ws, pr);
  const prWindow = pr ? windowFor(pr) : null;
  // « attend vos instructions » n'est pas écrit : l'anneau du point le dit déjà ; la ligne de méta garde ce qui appelle l'attention.
  // Exception : au repos en attente de commandes de fond, la ligne le dit (l'agent reprendra de lui-même).
  const waiting = session && !session.pendingRequestCount ? waitingCommandsHint(session) : null;
  const hint = waiting ?? (session && sessionDotClass(session) !== 'idle' ? sessionStateHint(session.status, session.activity, session.pendingRequestCount) : null);
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
            title: `${s.name} · ${statusTitle(s)}${byAgentTitle(n)}${s.owner ? ` · ${s.owner.name}` : ''}${s.model ? ` · modèle ${s.model}` : ''}`,
            node: (
              <>
                <span className={`wb-dot ${sessionDotClass(s)}`} />
                {n.byAgent && <RobotIcon />}
                {s.schedule && <ScheduleIcon schedule={s.schedule} />}
              </>
            ),
            extra: n.depth === 0 && children.length ? <SubagentsCount children={children.map((c) => c.session)} /> : null,
            owner: s.owner && !participates(s, userId) ? s.owner : null,
          })),
        ),
      ]
    : [
        // Session : son navigateur s'il est ouvert, puis ses sous-agents qui sont la page courante ou attendent une réponse
        // (carte repliée seulement : dépliée, ils sont listés en lignes dessous, une puce ferait doublon).
        ...(session?.browserActive ? [{ key: 'browser', to: `/sessions/${session.id}/browser`, active: current === `/sessions/${session.id}/browser`, label: 'Navigateur', title: "Voir en direct la page ouverte par l'agent", node: <i className="bi bi-globe2 wb-browser-icon" />, extra: null, owner: null }] : []),
        ...children
          .filter((c) => !expanded && (isCurrent(`/sessions/${c.session.id}`) || c.session.pendingRequestCount > 0))
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
    : `${session ? `${statusTitle(session)}${session.owner ? ` · ${session.owner.name}` : ''}${session.model ? ` · modèle ${session.model}` : ''} · ` : ''}${ws.task ? `Tâche : ${ws.task.title} · ${ws.task.status.toLowerCase()}${ws.task.statusTag ? ` · ${ws.task.statusTag}` : ''} · ` : ''}${icon.title}`;
  // Modèle de la session du dossier : signalé sur la carte quand ce n'est pas Opus (planification ou tâche sur Sonnet…).
  const cheapModel = !ws.primary && session?.model && !isOpus(session.model) ? session.model : null;
  const hasRows = ws.primary ? visibleSessions.length > 0 || ws.terminals.length > 0 || hiddenOthers > 0 || elsewhereSubs.length > 0 : children.length > 0 || cli.length > 0 || ws.terminals.length > 0 || Boolean(session?.browserActive);
  // Ligne de méta (deuxième ligne, jamais plus) : ce qui appelle l'attention, la PR, la tâche, puis ce qui est ouvert
  // dans le dossier. Sans rien de tout cela, la carte tient sur une ligne (le modèle passe alors sur la tête).
  const prPill = pr && PR_PILL[prState(pr)] ? PR_PILL[prState(pr)] : null;
  const subagentsChip = !ws.primary && children.length > 0 && !expanded;
  const cliChip = cli.length > 0 && !expanded;
  const hasMeta = !ws.primary && Boolean(hint || (ws.task && taskChip) || prPill || subagentsChip || cliChip || shown.length > 0);
  // L'étape de la PR s'écrit toujours en toutes lettres (« #87 à fusionner », « #87 brouillon », « en préparation ») :
  // c'est ce qu'on cherche d'un coup d'œil dans la sidebar ; la pastille colorée la détache du reste de la ligne.
  const prText = pr && prPill ? (pr.number == null ? prPill : `${prLabel(pr)} ${prPill}`) : '';
  const modelTag = cheapModel ? (
    <span className="wb-meta-model" title={`Modèle : ${cheapModel}`}>
      {shortModel(cheapModel)}
    </span>
  ) : null;
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
          {ws.primary && <i className="bi bi-folder2 wb-icon" />}
          <span className="wb-ws-name">{label ?? ws.name}</span>
          {ws.primary && ws.projectName && <span className="wb-tag" title="Sessions et terminaux d'avant les work sessions, dans le checkout principal">principal</span>}
          {!ws.exists && <span className="wb-tag missing">absent</span>}
          {modelTag}
          {session?.agent ? (
            <AgentAvatar agent={session.agent} size={16} className="wb-owner wb-owner-agent" title={`Session de l'agent ${session.agent.name}`} />
          ) : (
            session?.owner &&
            !mine && (
              <span className="wb-owner" title={`Session de ${session.owner.name}`}>
                {initialsOf(session.owner.name)}
              </span>
            )
          )}
          {pending > 0 && <span className="wb-badge">{pending}</span>}
        </Link>
        {hasRows && (
          <button type="button" className="wb-chevron wb-ws-chevron" title={expanded ? 'Replier' : 'Détailler'} onClick={onToggle}>
            <i className={`bi bi-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
          </button>
        )}
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
      {hasMeta && (
        // Sur mobile, les étiquettes (PR, tâche, puces) ne captent pas le toucher (CSS) : toute la ligne ouvre la session,
        // pour qu'un doigt un peu bas n'ouvre pas la tâche ou la PR. Sur ordinateur, seul le vide entre elles y mène.
        <div
          className="wb-ws-meta"
          onClick={(e) => {
            if (e.target === e.currentTarget) navigate(headTo);
          }}
        >
          {hint && session && <span className={`wb-meta-state ${waiting ? 'pending' : sessionDotClass(session)}`}>{hint}</span>}
          {cliChip && (
            <button type="button" className="wb-meta-sub wb-meta-cli" title={`${cliSubagentsLabel(cli)} : ${cli.map((a) => `« ${a.description} »`).join(', ')} · cliquer pour détailler`} onClick={onToggle}>
              <CliSubagentsChip subagents={cli} />
            </button>
          )}
          {pr && prPill && (
            <button type="button" className={`wb-meta-pr wt-pr-${prState(pr)}`} title={`${icon.title} · ${prPill} · ${pr.number == null ? 'créer la pull request' : 'voir la pull request'}`} disabled={!prWindow} onClick={() => setPrOpen(true)}>
              <i className="bi bi-git" />
              <span className="wb-meta-text">{prText}</span>
            </button>
          )}
          {ws.task && taskChip && (
            <Link to={`/tasks/${ws.task.id}`} className={`wb-meta-task task-${taskChip.cls}`} title={`Tâche : ${ws.task.title} · ${taskChip.text}${taskChip.tag ? ` · ${taskChip.tag}` : ''}${taskChip.note ? ` · ${taskChip.note}` : ''}`}>
              <i className="bi bi-check2-square" />
              <span className="wb-meta-text">{taskChip.tag || taskChip.text}</span>
            </Link>
          )}
          {subagentsChip && (
            <button type="button" className="wb-meta-sub" title={`${subagentsSummary(children.map((c) => c.session)).label} lancé(s) par l'agent de cette session · cliquer pour détailler`} onClick={onToggle}>
              <SubagentsCount children={children.map((c) => c.session)} />
            </button>
          )}
          {shown.map((c) => (
            <Link key={c.key} to={c.to} className={`wb-meta-chip${c.active ? ' active' : ''}`} title={c.title}>
              {c.node}
              <span className="wb-meta-text">{c.label}</span>
            </Link>
          ))}
        </div>
      )}
      {prOpen && prWindow && <PullRequestWindow projectId={ws.projectId} window={prWindow} onClose={() => setPrOpen(false)} />}
      {ws.primary && (
        <div className="wb-ws-items">
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
            <button type="button" className="wb-chip wb-chip-more" title={`Afficher les ${hiddenOthers} session(s) d'autres personnes`} onClick={onShowOthers}>
              <i className="bi bi-people" /> {hiddenOthers}
            </button>
          )}
          {chips.length === 0 && hiddenOthers === 0 && (elsewhereSubs.length ? <ElsewhereNote subs={elsewhereSubs} poolById={poolById} /> : <span className="wb-ws-empty">rien d'ouvert</span>)}
        </div>
      )}
      {expanded && hasRows && (
        <div className="wb-ws-rows">
          {ws.primary ? (
            <>
              {groups.map(({ root, children }) => (
                <SessionRow key={root.session.id} s={root.session} indent={30} byAgent={root.byAgent} parentName={root.parentName} children={children} wsKey={ws.key} prOf={prOf} />
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
                {cli.length > 0 && <CliSubagentRows sessionId={session.id} subagents={cli} indent={16} />}
                {/* La carte dépliée liste directement les sous-agents : pas de ligne « N sous-agents » intermédiaire, la carte se replie déjà. */}
                {children.map((c) => <SessionRow key={c.session.id} s={c.session} indent={16} depth={c.depth} byAgent parentName={c.parentName} elsewhere={null} pr={c.session.wsKey !== ws.key ? prOf(c.session.wsWorksessionId) : null} prOf={prOf} />)}
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
  const items: MenuItem[] = projectWindowId
    ? [
        { label: 'Ouvrir tout Skipper', icon: 'bi-box-arrow-up-right', onClick: () => openFullSkipper() },
        { label: 'Afficher tout Skipper dans cette fenêtre', icon: 'bi-window', onClick: leaveProjectWindow },
        ...projectMorePages(projectWindowId).map((m, i) => ({ ...m, separatorBefore: i === 0 })),
        { label: 'Paramètres', icon: 'bi-gear', to: '/settings', separatorBefore: true },
        { label: 'Se déconnecter', icon: 'bi-box-arrow-right', separatorBefore: true, onClick: () => void logout() },
      ]
    : [
    ...(user.isGuest ? [] : MORE_PAGES),
    ...(installable ? [{ label: "Installer l'application", icon: 'bi-phone', onClick: install, separatorBefore: !user.isGuest }] : []),
    ...(user.isAdmin ? [{ label: 'Utilisateurs', icon: 'bi-people', to: '/users', separatorBefore: !installable && !user.isGuest }] : []),
    ...(user.isAdmin ? [{ label: 'Consommation', icon: 'bi-receipt', to: '/billing' }] : []),
    ...(user.conversationsOnly ? [] : [{ label: 'Premiers pas', icon: 'bi-compass', to: '/welcome', separatorBefore: !installable && !user.isAdmin && !user.isGuest }]),
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
  // Les variables (`open`) changent quand un super administrateur ouvre une session pas encore en onglet : on garde
  // les données précédentes le temps du chargement, sinon la liste se vide (défilement perdu, aucune ligne active).
  const sidebarQuery = usePollingQuery<{ projects: SidebarProject[]; chats: SidebarSession[]; guestProjects: GuestProject[] }>(SIDEBAR, { variables: { open }, pollInterval: 5000, fetchPolicy: 'cache-and-network' });
  const data = sidebarQuery.data ?? sidebarQuery.previousData;
  const chats = data?.chats ?? [];
  const guestProjects = data?.guestProjects ?? [];
  // Accès restreint (invité seulement) : la sidebar se réduit aux conversations et aux artefacts partagés.
  const restricted = Boolean(user?.conversationsOnly);
  const prQuery = usePollingQuery<{ projects: { id: string; worksessions: { id: string; trackedPullRequest: PullRequestRef | null }[] }[] }>(SIDEBAR_PULL_REQUESTS, { variables: { open }, pollInterval: 60_000 });
  const prData = prQuery.data ?? prQuery.previousData;
  const { data: inboxData } = usePollingQuery<{ inboxCounts: { total: number } }>(INBOX_COUNTS, { variables: { projectId: projectWindowId }, pollInterval: 5000 });
  const inboxTotal = inboxData?.inboxCounts.total ?? 0;
  const prByWorksession = useMemo(() => new Map((prData?.projects ?? []).flatMap((p) => p.worksessions.map((w) => [w.id, w.trackedPullRequest] as const))), [prData]);
  const prOf = useCallback((worksessionId: string | null) => (worksessionId ? prByWorksession.get(worksessionId) ?? null : null), [prByWorksession]);
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

  // Fenêtre dédiée à un projet : la sidebar ne montre que lui, toujours déplié.
  const windowProject = projectWindowId ? (data?.projects.find((p) => p.id === projectWindowId) ?? null) : null;
  const shownProjects = projectWindowId ? (windowProject ? [windowProject] : []) : (data?.projects ?? []);
  useEffect(() => {
    if (windowProject) document.title = `${windowProject.name} · Skipper`;
  }, [windowProject?.name]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Défilement vers la ligne courante, une fois par chemin, quand elle est hors de vue — seulement quand on arrive
  // d'ailleurs (onglet, recherche, notification, lien). Un clic dans la sidebar ne la fait jamais défiler : la ligne
  // cliquée est sous les yeux, et une carte qui se déplie au clic ne doit pas faire sauter la liste.
  const scrolledFor = useRef<string | null>(null);
  const clickedIn = useRef<string | null>(null);
  const onSidebarClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[href]');
    const to = a ? new URL((a as HTMLAnchorElement).href, window.location.href).pathname : null;
    clickedIn.current = to && to !== location.pathname ? to : null;
  };
  useEffect(() => {
    if (!data || scrolledFor.current === location.pathname) return;
    scrolledFor.current = location.pathname;
    if (clickedIn.current === location.pathname) {
      clickedIn.current = null;
      return;
    }
    clickedIn.current = null;
    const root = explorerRef.current;
    // La ligne ou la puce la plus précise d'abord : la carte active (.wb-ws.active) englobe ses lignes et la précède
    // dans le document, et viser toute la carte la recentrerait dès qu'elle dépasse un peu.
    const target =
      root?.querySelector<HTMLElement>('.wb-chip.active, .wb-session-row.active, .wb-row.active') ??
      root?.querySelector<HTMLElement>('.wb-ws.active > .wb-ws-head');
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
    <aside className="wb-sidebar" onClickCapture={onSidebarClick}>
      <div className="wb-brand">
        {projectWindowId ? (
          <Link to={`/projects/${projectWindowId}`} title="Fenêtre dédiée au projet : tableau de bord du projet" className="wb-brand-project">
            <Logo size={18} />
            <span className="wb-brand-name">{windowProject?.name ?? 'Projet'}</span>
          </Link>
        ) : (
          <Link to="/" title="Tableau de bord">
            <Logo size={18} />
            Skipper
          </Link>
        )}
        <span className="wb-brand-actions">
          {projectWindowId && (
            <button type="button" className="wb-plus" title="Ouvrir tout Skipper (tous les projets) dans un nouvel onglet" aria-label="Ouvrir tout Skipper" onClick={() => openFullSkipper('/')}>
              <i className="bi bi-box-arrow-up-right" />
            </button>
          )}
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

      {!restricted && (
        <button type="button" className="wb-search-btn" onClick={() => openSearch()}>
          <i className="bi bi-search" /> Rechercher…
          <kbd>{displayComboText('mod+k')}</kbd>
        </button>
      )}

      <nav className="wb-menu" aria-label="Navigation principale">
        {(restricted ? RESTRICTED_MENU : projectWindowId ? projectMenu(projectWindowId) : MAIN_MENU).map((m) => (
          <NavLink key={m.to} to={m.to} end={m.to !== '/inbox'} className="wb-menu-item" title={m.title ?? m.label}>
            <i className={`bi ${m.icon} wb-icon`} />
            <span className="wb-menu-label">{m.label}</span>
            {m.to === '/inbox' && inboxTotal > 0 && (
              <span className="wb-badge" title="Éléments qui attendent une action de votre part">
                {inboxTotal}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {!user?.isGuest && <FavoritesSection projectId={projectWindowId} expanded={expanded.favorites ?? true} onToggle={() => toggle('favorites', true)} />}

      {!projectWindowId && <GuestProjectsSection projects={guestProjects} activeProjectId={activeProjectId} />}

      {restricted ? (
        <div className="wb-explorer" ref={explorerRef}>
          {data && guestProjects.length === 0 && <div className="wb-row wb-empty">Aucune conversation : personne ne vous a encore invité sur un projet.</div>}
        </div>
      ) : (
      <>
      <div className="wb-section-title">
        {projectWindowId ? (
          <span className="wb-section-link">Sessions</span>
        ) : (
          <Link to="/projects" className="wb-section-link" title="Tous les projets">
            Projets
          </Link>
        )}
        <button
          type="button"
          className="wb-section-action wb-filter"
          title={filter === 'mine' ? 'Mes sessions seulement : cliquer pour voir celles de tout le monde' : 'Sessions de tout le monde : cliquer pour ne voir que les miennes'}
          onClick={() => setFilterPersist(filter === 'mine' ? 'all' : 'mine')}
        >
          <i className={`bi ${filter === 'mine' ? 'bi-person' : 'bi-people'}`} /> {filter === 'mine' ? 'Les miennes' : 'Tout le monde'}
        </button>
        {!projectWindowId && (
          <Link to="/projects/new" className="wb-section-action" title="Nouveau projet">
            <i className="bi bi-plus-lg" />
          </Link>
        )}
      </div>

      <div className="wb-explorer" ref={explorerRef}>
        {!data && (
          <div className="wb-row wb-empty">
            <Spinner animation="border" size="sm" className="me-2" /> chargement des projets…
          </div>
        )}
        {[...shownProjects]
          .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal))
          .map((p) => {
          const open = projectWindowId ? true : (expanded[p.id] ?? projectDefaultOpen(p));
          const list = workspaces.ofProject(p.id);
          const collapsedPending = !open ? p.sessions.filter((s) => participates(s, userId)).reduce((n, s) => n + s.pendingRequestCount, 0) : 0;
          return (
            <div key={p.id} className={`wb-project${p.isPersonal ? ' wb-personal' : ''}`}>
              <div className={`wb-row wb-project-row${p.id === activeProjectId ? ' active' : ''}`}>
                {!projectWindowId && (
                  <button type="button" className="wb-chevron" onClick={() => toggle(p.id, projectDefaultOpen(p))} title={open ? 'Replier' : 'Déplier'}>
                    <i className={`bi bi-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 10 }} />
                  </button>
                )}
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
                      project={{ id: p.id, name: p.name, canManage: p.myRole === 'ADMIN', isPersonal: p.isPersonal, paths: [...p.sessions.map((s) => `/sessions/${s.id}`), ...p.terminals.map((t) => `/terminals/${t.id}`)] }}
                      onClose={() => setMenuFor(null)}
                    />
                  )}
                </span>
              </div>
              {open && (
              <div className="wb-project-body">
              {p.isPersonal && <ChatsBlock chats={chats} expanded={expanded[`chats:${p.id}`] ?? true} onToggle={() => toggle(`chats:${p.id}`, true)} />}
              {(() => {
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
                // Les dossiers de la personne restent à plat ; ceux des autres sont rangés par personne ou agent, sous une
                // ligne repliable. Avec le filtre « les miennes », ces groupes sont cachés (comptés), sauf celui de la page affichée.
                const isShown = (ws: Workspace) => location.pathname.startsWith(`/sessions/${ws.session!.id}`);
                // Les sessions lancées par une planification se rangent sous une seule ligne, celle de la planification.
                const { rest: plainCards, groups: runGroups } = scheduleGroups(cards);
                const { mine: mineCards, groups } = ownerGroups(plainCards, userId);
                const othersVisible = !(filter === 'mine' && !showOthers);
                // Avec « les miennes », un groupe ne garde que les sessions de la personne (celles d'un agent qu'elle a
                // demandées) et celle de la page affichée.
                const shownGroups = othersVisible ? groups : groups.map((g) => ({ ...g, items: g.items.filter((ws) => participates(ws.session!, userId) || isShown(ws)) })).filter((g) => g.items.length > 0);
                const shownCount = new Map(shownGroups.map((g) => [g.key, g.items.length]));
                const shownRuns = othersVisible ? runGroups : runGroups.filter((g) => g.items.some((ws) => participates(ws.session!, userId) || isShown(ws)));
                const hiddenOthers = groups.reduce((n, g) => n + g.items.length - (shownCount.get(g.key) ?? 0), 0) + runGroups.filter((g) => !shownRuns.includes(g)).reduce((n, g) => n + g.items.length, 0);
                const card = (ws: Workspace, label?: string) => (
                  <WorkspaceCard
                    key={ws.key}
                    ws={ws}
                    pr={ws.worksessionId ? prByWorksession.get(ws.worksessionId) : null}
                    prOf={prOf}
                    expanded={expanded[ws.key] ?? false}
                    onToggle={() => toggle(ws.key, false)}
                    tabUrl={tabs.find((t) => t.key === ws.key)?.url ?? null}
                    filterMine={filter === 'mine'}
                    showOthers={showOthers}
                    onShowOthers={() => setOthersShown((prev) => new Set([...prev, p.id]))}
                    label={label}
                  />
                );
                return (
                  <>
                    {mineCards.map((ws) => card(ws))}
                    {shownRuns.map((g) => {
                      const groupKey = `schedule:${p.id}:${g.key}`;
                      const groupOpen = expanded[groupKey] ?? true;
                      return (
                        <div key={groupKey} className="wb-schedule-block">
                          <ScheduleGroupRow group={g} projectId={p.id} canRun={p.myRole === 'ADMIN' || p.myRole === 'MEMBER'} expanded={groupOpen} onToggle={() => toggle(groupKey, true)} />
                          {groupOpen && g.items.map((ws) => card(ws, runLabel(ws.name, g.schedule.name)))}
                        </div>
                      );
                    })}
                    {shownGroups.map((g) => {
                      const groupKey = `owner:${p.id}:${g.key}`;
                      // Déplié d'office quand il contient une session de la personne (agent qu'elle a sollicité), celle de
                      // la page affichée ou une demande en attente.
                      const defaultOpen = g.items.some((ws) => isShown(ws) || ws.session!.pendingRequestCount > 0 || participates(ws.session!, userId));
                      const groupOpen = expanded[groupKey] ?? defaultOpen;
                      return (
                        <div key={groupKey} className="wb-owner-block">
                          <OwnerGroupRow group={g} expanded={groupOpen} onToggle={() => toggle(groupKey, defaultOpen)} />
                          {groupOpen && g.items.map((ws) => card(ws, g.agent ? runLabel(ws.name, g.agent.name) : undefined))}
                        </div>
                      );
                    })}
                    {hiddenOthers > 0 && (
                      <button type="button" className="wb-row wb-empty wb-row-btn" style={{ paddingLeft: 8 }} title="Afficher les sessions des autres personnes et des agents, rangées par personne ou agent" onClick={() => setOthersShown((prev) => new Set([...prev, p.id]))}>
                        <i className="bi bi-people me-1" /> + {hiddenOthers} session{hiddenOthers > 1 ? 's' : ''} des autres
                      </button>
                    )}
                    {cards.length === 0 && !(p.isPersonal && chats.length > 0) && (
                      <div className="wb-row wb-empty" style={{ paddingLeft: 8 }}>
                        aucune session
                      </div>
                    )}
                  </>
                );
              })()}
              </div>
              )}
            </div>
          );
        })}
        {data && projectWindowId && !windowProject && (
          <div className="wb-row wb-empty">
            Ce projet n'existe plus ou vous n'y avez plus accès.{' '}
            <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={leaveProjectWindow}>
              Afficher tout Skipper
            </button>
          </div>
        )}
        {data && !projectWindowId && data.projects.length === 0 && (
          <div className="wb-row wb-empty">
            Aucun projet. <Link to="/projects">Créer le premier</Link>
          </div>
        )}
      </div>
      </>
      )}
      <div className="wb-menu wb-menu-bottom">
        <UserBlock />
      </div>
    </aside>
  );
}
