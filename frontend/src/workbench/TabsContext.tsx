import { useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SIDEBAR } from '../graphql/operations';
import { EMPTY_INDEX, WorkspaceIndex, openItemsOf, workspaceTitle, type SidebarProject } from './workspaces';

export type TabKind =
  | 'dashboard'
  | 'projects'
  | 'sessions'
  | 'requests'
  | 'project'
  | 'project-form'
  | 'context'
  | 'vault'
  | 'session'
  | 'chat'
  | 'chats'
  | 'browser'
  | 'terminal'
  | 'tasks'
  | 'task'
  | 'history'
  | 'settings'
  | 'users'
  | 'files'
  | 'file'
  | 'worksession'
  | 'shared-pages'
  | 'shared-page'
  | 'workflows'
  | 'workflow'
  | 'workflow-run'
  | 'other';

export interface Tab {
  /** Clé = pathname, ou clé du dossier de travail pour tout ce qui s'ouvre dedans (fichiers, sessions, terminaux). */
  key: string;
  /** Dernière URL complète visitée pour cet onglet (pathname + search). */
  url: string;
  title: string;
  kind: TabKind;
}

interface TabsState {
  tabs: Tab[];
  activeKey: string;
  /** Index des dossiers de travail (vide tant que la sidebar n'est pas chargée). */
  workspaces: WorkspaceIndex;
  closeTab: (key: string) => void;
  /** Ferme d'un coup les onglets dont la clé vérifie `match` ; un onglet de dossier dont seule la page affichée correspond revient sur ses fichiers. */
  closeMatching: (match: (key: string) => boolean) => void;
  closeOthers: (key: string) => void;
  closeRight: (key: string) => void;
  closeAll: () => void;
  reopenClosed: () => void;
  canReopen: boolean;
  setTitle: (key: string, title: string) => void;
  /** Onglet précédent / suivant (en boucle), onglet n° n (9 = le dernier). */
  previous: () => void;
  next: () => void;
  goTo: (n: number) => void;
}

const TabsContext = createContext<TabsState | null>(null);
const STORAGE_KEY = 'skipper.workbench.tabs';
const REOPEN_MAX = 20;

/** Clé d'un chemin hors dossier : l'explorateur ramène chaque fichier à son onglet Fichiers. */
export function tabKey(pathname: string): string {
  const files = pathname.match(/^(\/(?:projects|worksessions)\/[^/]+\/files)(?:\/|$)/);
  return files ? files[1] : pathname;
}

const pathOf = (url: string) => url.split('?')[0];

/** Titre et type par défaut d'un onglet à partir de son chemin (les pages affinent le titre). */
export function describeRoute(pathname: string): { title: string; kind: TabKind } {
  if (pathname === '/') return { title: 'Tableau de bord', kind: 'dashboard' };
  if (pathname === '/projects') return { title: 'Projets', kind: 'projects' };
  if (pathname === '/projects/new') return { title: 'Nouveau projet', kind: 'project-form' };
  if (/^\/projects\/[^/]+\/edit$/.test(pathname)) return { title: 'Modifier le projet', kind: 'project-form' };
  if (/^\/projects\/[^/]+\/context$/.test(pathname)) return { title: 'Contexte', kind: 'context' };
  if (/^\/projects\/[^/]+\/tasks$/.test(pathname)) return { title: 'Tâches', kind: 'tasks' };
  if (/^\/projects\/[^/]+\/vault$/.test(pathname)) return { title: 'Coffre', kind: 'vault' };
  if (/^\/projects\/[^/]+\/history$/.test(pathname)) return { title: 'Historique', kind: 'history' };
  if (pathname === '/tasks') return { title: 'Tâches', kind: 'tasks' };
  if (/^\/tasks\/[^/]+$/.test(pathname)) return { title: 'Tâche', kind: 'task' };
  if (pathname === '/vault') return { title: 'Coffre', kind: 'vault' };
  if (pathname === '/workflows' || /^\/projects\/[^/]+\/workflows$/.test(pathname)) return { title: 'Workflows', kind: 'workflows' };
  if (/^\/workflows\/[^/]+\/runs\/[^/]+$/.test(pathname)) return { title: 'Exécution', kind: 'workflow-run' };
  if (/^\/workflows\/[^/]+$/.test(pathname)) return { title: 'Workflow', kind: 'workflow' };
  if (pathname === '/shared') return { title: 'Pages', kind: 'shared-pages' };
  if (/^\/shared\/[^/]+$/.test(pathname)) return { title: 'Page', kind: 'shared-page' };
  if (pathname === '/users') return { title: 'Utilisateurs', kind: 'users' };
  if (/^\/projects\/[^/]+$/.test(pathname)) return { title: 'Projet', kind: 'project' };
  if (pathname === '/sessions') return { title: 'Sessions', kind: 'sessions' };
  if (pathname === '/chats') return { title: 'Chats', kind: 'chats' };
  if (/^\/chats\/[^/]+$/.test(pathname)) return { title: 'Chat', kind: 'chat' };
  if (pathname === '/me') return { title: 'Mon espace', kind: 'project' };
  if (/^\/sessions\/[^/]+$/.test(pathname)) return { title: 'Session', kind: 'session' };
  if (/^\/sessions\/[^/]+\/browser$/.test(pathname)) return { title: 'Navigateur', kind: 'browser' };
  if (pathname === '/requests') return { title: 'Demandes', kind: 'requests' };
  if (pathname === '/settings') return { title: 'Paramètres', kind: 'settings' };
  const files = pathname.match(/^\/(?:projects|worksessions)\/[^/]+\/files(?:\/(.*))?$/);
  if (files) {
    if (!files[1]) return { title: 'Fichiers', kind: 'files' };
    const name = files[1].split('/').pop() ?? files[1];
    try {
      return { title: decodeURIComponent(name), kind: 'file' };
    } catch {
      return { title: name, kind: 'file' };
    }
  }
  if (/^\/terminals\/[^/]+$/.test(pathname)) return { title: 'Terminal', kind: 'terminal' };
  return { title: pathname, kind: 'other' };
}

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Tab[]) : [];
    // Onglets enregistrés avant le renommage worktree → work session : leurs adresses suivent.
    const renamed = (u: string) => u.replace(/^\/worktrees\//, '/worksessions/');
    return Array.isArray(parsed)
      ? parsed
          .filter((t) => t && typeof t.key === 'string' && typeof t.url === 'string')
          .map((t) => ({ ...t, key: renamed(t.key), url: renamed(t.url), kind: (t.kind as string) === 'worktree' ? 'worksession' : t.kind }))
      : [];
  } catch {
    return [];
  }
}

/**
 * Range chaque onglet dans son dossier de travail quand l'index le connaît : un onglet de session ouvert
 * avant le chargement de la sidebar (ou mémorisé par une version antérieure) rejoint l'onglet du dossier ;
 * plusieurs onglets tombant sur le même dossier fusionnent (position du premier, URL du chemin courant).
 */
export function groupTabs(tabs: Tab[], index: WorkspaceIndex, currentPath: string): Tab[] {
  let changed = false;
  const out: Tab[] = [];
  const positions = new Map<string, number>();
  for (const tab of tabs) {
    const wsKey = index.keyOf(pathOf(tab.url));
    const ws = wsKey ? index.get(wsKey) : undefined;
    const key = ws ? ws.key : tab.key;
    const existing = positions.get(key);
    if (existing !== undefined) {
      changed = true;
      if (pathOf(tab.url) === currentPath) out[existing] = { ...out[existing], url: tab.url };
      continue;
    }
    const next: Tab = ws ? { key, url: tab.url, title: workspaceTitle(ws), kind: 'worksession' } : tab;
    if (next.key !== tab.key || next.title !== tab.title || next.kind !== tab.kind) changed = true;
    positions.set(key, out.length);
    out.push(next);
  }
  return changed ? out : tabs;
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [closed, setClosed] = useState<Tab[]>([]);

  // Les dossiers de travail viennent de la requête Sidebar, que la sidebar interroge ; ici on lit le cache et on
  // demande la liste une fois, avec les éléments ouverts (projets non membres d'un super administrateur).
  const open = useMemo(() => (user?.isSuperAdmin ? openItemsOf([...tabs.map((t) => t.url), location.pathname]) : null), [user?.isSuperAdmin, tabs, location.pathname]);
  const { data } = useQuery<{ projects: SidebarProject[] }>(SIDEBAR, { variables: { open }, fetchPolicy: 'cache-first' });
  const workspaces = useMemo(() => (data ? new WorkspaceIndex(data.projects) : EMPTY_INDEX), [data]);

  const resolveKey = useCallback((pathname: string) => workspaces.keyOf(pathname) ?? tabKey(pathname), [workspaces]);
  const activeKey = resolveKey(location.pathname);

  // Chaque navigation ouvre (ou réactive) l'onglet correspondant ; les onglets déjà ouverts sont rangés dans leur dossier.
  useEffect(() => {
    const url = location.pathname + location.search;
    setTabs((prev) => {
      const grouped = groupTabs(prev, workspaces, location.pathname);
      const key = resolveKey(location.pathname);
      const existing = grouped.find((t) => t.key === key);
      if (existing) return existing.url === url ? grouped : grouped.map((t) => (t.key === key ? { ...t, url } : t));
      const ws = workspaces.get(key);
      const { title, kind } = ws ? { title: workspaceTitle(ws), kind: 'worksession' as TabKind } : describeRoute(key);
      return [...grouped, { key, url, title, kind }];
    });
  }, [location.pathname, location.search, workspaces, resolveKey]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      /* stockage indisponible : les onglets ne sont simplement pas mémorisés */
    }
  }, [tabs]);

  const closeMatching = useCallback(
    (match: (key: string) => boolean) => {
      const current = tabsRef.current;
      const removed = current.filter((t) => match(t.key));
      // Un onglet de dossier dont seule la page affichée est retirée (session supprimée...) revient sur ses fichiers.
      const remaining = current.filter((t) => !match(t.key)).map((t) => (t.kind === 'worksession' && t.key !== pathOf(t.url) && match(pathOf(t.url)) ? { ...t, url: t.key } : t));
      tabsRef.current = remaining;
      if (removed.length || remaining.some((t, i) => t !== current[i])) setTabs(remaining);
      if (removed.length) setClosed((prev) => [...prev, ...removed].slice(-REOPEN_MAX));
      if (match(activeKey)) {
        const index = current.findIndex((t) => t.key === activeKey);
        const next = current.slice(index + 1).find((t) => !match(t.key)) ?? current.slice(0, Math.max(index, 0)).reverse().find((t) => !match(t.key));
        navigate(next ? next.url : '/');
      } else if (match(location.pathname) && location.pathname !== activeKey) {
        navigate(activeKey);
      }
    },
    [activeKey, navigate, location.pathname],
  );

  const closeTab = useCallback((key: string) => closeMatching((k) => k === key), [closeMatching]);
  const closeOthers = useCallback((key: string) => closeMatching((k) => k !== key), [closeMatching]);
  const closeRight = useCallback(
    (key: string) => {
      const index = tabsRef.current.findIndex((t) => t.key === key);
      if (index < 0) return;
      const right = new Set(tabsRef.current.slice(index + 1).map((t) => t.key));
      closeMatching((k) => right.has(k));
    },
    [closeMatching],
  );
  const closeAll = useCallback(() => closeMatching(() => true), [closeMatching]);

  const reopenClosed = useCallback(() => {
    setClosed((prev) => {
      const last = prev[prev.length - 1];
      if (last) navigate(last.url);
      return prev.slice(0, -1);
    });
  }, [navigate]);

  const setTitle = useCallback((key: string, title: string) => {
    // Un onglet de dossier garde le nom de son dossier quelle que soit la page affichée.
    setTabs((prev) => (prev.some((t) => t.key === key && t.kind !== 'worksession' && t.title !== title) ? prev.map((t) => (t.key === key && t.kind !== 'worksession' ? { ...t, title } : t)) : prev));
  }, []);

  const step = useCallback(
    (delta: number) => {
      const current = tabsRef.current;
      if (current.length < 2) return;
      const index = current.findIndex((t) => t.key === activeKey);
      const next = current[(index + delta + current.length) % current.length];
      if (next) navigate(next.url);
    },
    [activeKey, navigate],
  );
  const goTo = useCallback(
    (n: number) => {
      const current = tabsRef.current;
      const tab = n >= 9 ? current[current.length - 1] : current[n - 1];
      if (tab) navigate(tab.url);
    },
    [navigate],
  );

  const value = useMemo<TabsState>(
    () => ({ tabs, activeKey, workspaces, closeTab, closeMatching, closeOthers, closeRight, closeAll, reopenClosed, canReopen: closed.length > 0, setTitle, previous: () => step(-1), next: () => step(1), goTo }),
    [tabs, activeKey, workspaces, closeTab, closeMatching, closeOthers, closeRight, closeAll, reopenClosed, closed.length, setTitle, step, goTo],
  );
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs(): TabsState {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('useTabs doit être utilisé dans un TabsProvider');
  return ctx;
}

/** Permet à une page de donner son vrai titre à son onglet (ex. nom de la session) une fois ses données chargées. */
export function useTabTitle(title: string | null | undefined): void {
  const { setTitle } = useTabs();
  const { pathname } = useLocation();
  useEffect(() => {
    if (title) setTitle(tabKey(pathname), title);
  }, [title, pathname, setTitle]);
}
