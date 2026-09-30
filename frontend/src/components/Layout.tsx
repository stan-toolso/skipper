import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from '../workbench/Sidebar';
import TabBar from '../workbench/TabBar';
import { TabsProvider } from '../workbench/TabsContext';
import GitPanel from '../workbench/GitPanel';
import { GitTargetProvider } from '../workbench/GitTargetContext';
import { SessionLauncherProvider } from './SessionLauncher';
import '../workbench/workbench.css';

const SIDEBAR_WIDTH_KEY = 'skipper.workbench.sidebarWidth';
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 640;
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, SIDEBAR_MIN), Math.min(SIDEBAR_MAX, window.innerWidth - 320)));

/** Largeur de la sidebar sur ordinateur, réglable à la souris ou au clavier et mémorisée dans le navigateur. */
function useSidebarWidth(rootRef: RefObject<HTMLDivElement>) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampWidth(saved) : SIDEBAR_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number; live: number } | null>(null);
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, [width]);
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
      // La capture garde le glisser même au-dessus d'un terminal ou d'un éditeur qui intercepte la souris.
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, w: width, live: width };
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      // Pendant le glisser, la variable CSS est écrite directement : pas de re-rendu de la sidebar à chaque mouvement.
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

/** Workbench : sidebar (menus + explorateur) et panneau principal à onglets. */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // Sur mobile la sidebar est un tiroir : ouvert par le bouton menu, refermé à chaque navigation.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => setSidebarOpen(false), [pathname]);
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth(rootRef);
  const flush = /^\/sessions\/[^/]+$/.test(pathname) || /^\/terminals\/[^/]+$/.test(pathname) || /^\/(?:projects|worktrees)\/[^/]+\/files(?:\/|$)/.test(pathname);
  return (
    <TabsProvider>
      <GitTargetProvider>
        <SessionLauncherProvider>
          <div
            ref={rootRef}
            className={`wb${sidebarOpen ? ' sidebar-open' : ''}${sidebar.dragging ? ' resizing' : ''}`}
            style={{ '--wb-sidebar-w': `${sidebar.width}px` } as CSSProperties}
          >
            <Sidebar />
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
              <TabBar onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
              <div className={`wb-content${flush ? ' flush' : ''}`}>{children}</div>
            </div>
            <GitPanel />
          </div>
        </SessionLauncherProvider>
      </GitTargetProvider>
    </TabsProvider>
  );
}
