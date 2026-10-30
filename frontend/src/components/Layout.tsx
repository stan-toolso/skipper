import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from '../workbench/Sidebar';
import TabBar from '../workbench/TabBar';
import WorkspaceTabs from '../workbench/WorkspaceTabs';
import { TabsProvider } from '../workbench/TabsContext';
import GitPanel from '../workbench/GitPanel';
import { GitTargetProvider } from '../workbench/GitTargetContext';
import { RenameWorksessionProvider } from '../workbench/RenameWorksession';
import { SessionLauncherProvider } from './SessionLauncher';
import { SearchPaletteProvider } from './SearchPalette';
import { ShortcutsHelpProvider } from './ShortcutsHelp';
import StatusBanners from './StatusBanners';
import { useShortcut } from '../lib/useShortcut';
import '../workbench/workbench.css';

const SIDEBAR_WIDTH_KEY = 'skipper.workbench.sidebarWidth';
const SIDEBAR_COLLAPSED_KEY = 'skipper.workbench.sidebarCollapsed';
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 640;
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, SIDEBAR_MIN), Math.min(SIDEBAR_MAX, window.innerWidth - 320)));

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
};

/** Largeur de la sidebar sur ordinateur, réglable à la souris ou au clavier et mémorisée dans le navigateur. */
function useSidebarWidth(rootRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(read(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampWidth(saved) : SIDEBAR_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number; live: number } | null>(null);
  useEffect(() => write(SIDEBAR_WIDTH_KEY, String(width)), [width]);
  const endDrag = () => {
    if (!drag.current) return;
    setWidth(drag.current.live);
    drag.current = null;
    setDragging(false);
  };
  const handleProps = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, w: width, live: width };
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      drag.current.live = clampWidth(drag.current.w + e.clientX - drag.current.x);
      rootRef.current?.style.setProperty('--wb-sidebar-w', `${drag.current.live}px`);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: () => setWidth(SIDEBAR_DEFAULT),
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key === 'ArrowLeft') setWidth((w) => clampWidth(w - step));
      else if (e.key === 'ArrowRight') setWidth((w) => clampWidth(w + step));
      else return;
      e.preventDefault();
    },
  };
  return { width, dragging, handleProps };
}

/** ⌘L : copie l'URL de la page courante. */
function CopyUrlToast() {
  const [toast, setToast] = useState<string | null>(null);
  useShortcut({ id: 'page.copyUrl', keys: ['mod+l'], label: "Copier l'adresse de la page", scope: 'global' }, () => {
    const show = (msg: string) => {
      setToast(msg);
      setTimeout(() => setToast(null), 1800);
    };
    if (!navigator.clipboard) return show('Copie indisponible');
    navigator.clipboard.writeText(window.location.href).then(() => show('Adresse copiée'), () => show('Copie refusée'));
  });
  return toast ? <div className="wb-toast">{toast}</div> : null;
}

/** Workbench : sidebar (menus + explorateur), panneau principal à onglets, panneau git / tâche à droite. */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => read(SIDEBAR_COLLAPSED_KEY) === '1');
  useEffect(() => setSidebarOpen(false), [pathname]);
  useEffect(() => write(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'), [collapsed]);
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth(rootRef);
  const flush = /^\/sessions\/[^/]+(?:\/browser)?$/.test(pathname) || /^\/chats\/[^/]+$/.test(pathname) || /^\/terminals\/[^/]+$/.test(pathname) || /^\/(?:projects|worksessions)\/[^/]+\/files(?:\/|$)/.test(pathname) || /^\/shared\/[^/]+$/.test(pathname);
  return (
    <TabsProvider>
      <GitTargetProvider>
        <SessionLauncherProvider>
          <RenameWorksessionProvider>
            <SearchPaletteProvider>
              <ShortcutsHelpProvider>
                <div
                  ref={rootRef}
                  className={`wb${sidebarOpen ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}${sidebar.dragging ? ' resizing' : ''}`}
                  style={{ '--wb-sidebar-w': `${sidebar.width}px` } as CSSProperties}
                >
                  <Sidebar onCollapse={() => setCollapsed(true)} />
                  <div
                    className={`wb-resizer${sidebar.dragging ? ' dragging' : ''}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Largeur de la barre latérale"
                    aria-valuenow={sidebar.width}
                    aria-valuemin={SIDEBAR_MIN}
                    aria-valuemax={SIDEBAR_MAX}
                    tabIndex={0}
                    title="Glisser pour redimensionner · double-clic pour revenir à la largeur par défaut"
                    {...sidebar.handleProps}
                  />
                  {sidebarOpen && <div className="wb-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
                  <div className="wb-main">
                    <StatusBanners />
                    <TabBar
                      onToggleSidebar={() => {
                        if (window.matchMedia('(min-width: 768px)').matches) setCollapsed((v) => !v);
                        else setSidebarOpen((v) => !v);
                      }}
                      sidebarOpen={sidebarOpen}
                      sidebarCollapsed={collapsed}
                    />
                    <WorkspaceTabs />
                    <div className={`wb-content${flush ? ' flush' : ''}`}>{children}</div>
                  </div>
                  <GitPanel />
                  <CopyUrlToast />
                </div>
              </ShortcutsHelpProvider>
            </SearchPaletteProvider>
          </RenameWorksessionProvider>
        </SessionLauncherProvider>
      </GitTargetProvider>
    </TabsProvider>
  );
}
