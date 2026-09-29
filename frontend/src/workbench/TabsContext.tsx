import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export type TabKind = 'projects' | 'sessions' | 'requests' | 'project' | 'project-form' | 'context' | 'session' | 'new-session' | 'terminal' | 'other';

export interface Tab {
  /** Clé = pathname (la query string peut changer sans ouvrir un nouvel onglet). */
  key: string;
  /** Dernière URL complète visitée pour cet onglet (pathname + search). */
  url: string;
  title: string;
  kind: TabKind;
}

interface TabsState {
  tabs: Tab[];
  activeKey: string;
  closeTab: (key: string) => void;
  closeOthers: (key: string) => void;
  setTitle: (key: string, title: string) => void;
}

const TabsContext = createContext<TabsState | null>(null);
const STORAGE_KEY = 'agents.workbench.tabs';

/** Titre et type par défaut d'un onglet à partir de son chemin (les pages affinent le titre). */
export function describeRoute(pathname: string): { title: string; kind: TabKind } {
  if (pathname === '/projects') return { title: 'Projets', kind: 'projects' };
  if (pathname === '/projects/new') return { title: 'Nouveau projet', kind: 'project-form' };
  if (/^\/projects\/[^/]+\/edit$/.test(pathname)) return { title: 'Modifier le projet', kind: 'project-form' };
  if (/^\/projects\/[^/]+\/context$/.test(pathname)) return { title: 'Contexte', kind: 'context' };
  if (/^\/projects\/[^/]+$/.test(pathname)) return { title: 'Projet', kind: 'project' };
  if (pathname === '/sessions') return { title: 'Sessions', kind: 'sessions' };
  if (pathname === '/sessions/new') return { title: 'Nouvelle session', kind: 'new-session' };
  if (/^\/sessions\/[^/]+$/.test(pathname)) return { title: 'Session', kind: 'session' };
  if (pathname === '/requests') return { title: 'Demandes', kind: 'requests' };
  if (/^\/terminals\/[^/]+$/.test(pathname)) return { title: 'Terminal', kind: 'terminal' };
  return { title: pathname, kind: 'other' };
}

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Tab[]) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.key === 'string') : [];
  } catch {
    return [];
  }
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const activeKey = location.pathname;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Chaque navigation ouvre (ou réactive) l'onglet correspondant au chemin.
  useEffect(() => {
    if (location.pathname === '/') return;
    const url = location.pathname + location.search;
    setTabs((prev) => {
      const existing = prev.find((t) => t.key === location.pathname);
      if (existing) return existing.url === url ? prev : prev.map((t) => (t.key === location.pathname ? { ...t, url } : t));
      const { title, kind } = describeRoute(location.pathname);
      return [...prev, { key: location.pathname, url, title, kind }];
    });
  }, [location.pathname, location.search]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      /* stockage indisponible : les onglets ne sont simplement pas mémorisés */
    }
  }, [tabs]);

  const closeTab = useCallback(
    (key: string) => {
      const current = tabsRef.current;
      const index = current.findIndex((t) => t.key === key);
      const remaining = current.filter((t) => t.key !== key);
      setTabs(remaining);
      if (key === activeKey) {
        const next = remaining[index] ?? remaining[index - 1];
        navigate(next ? next.url : '/projects');
      }
    },
    [activeKey, navigate],
  );

  const closeOthers = useCallback(
    (key: string) => {
      const keep = tabsRef.current.find((t) => t.key === key);
      setTabs(keep ? [keep] : []);
      if (keep && keep.key !== activeKey) navigate(keep.url);
    },
    [activeKey, navigate],
  );

  const setTitle = useCallback((key: string, title: string) => {
    setTabs((prev) => (prev.some((t) => t.key === key && t.title !== title) ? prev.map((t) => (t.key === key ? { ...t, title } : t)) : prev));
  }, []);

  const value = useMemo(() => ({ tabs, activeKey, closeTab, closeOthers, setTitle }), [tabs, activeKey, closeTab, closeOthers, setTitle]);
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
    if (title) setTitle(pathname, title);
  }, [title, pathname, setTitle]);
}
