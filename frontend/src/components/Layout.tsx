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

const SIDEBAR_COLLAPSED_KEY = 'skipper.workbench.sidebarCollapsed';
/** Sidebar (gauche) et panneau git / session (droite) : largeur par défaut, bornes, clé de stockage et variable CSS. */
const SIDEBAR = { key: 'skipper.workbench.sidebarWidth', cssVar: '--wb-sidebar-w', def: 260, min: 180, max: 640, side: 'left' as const };
const PANEL = { key: 'skipper.workbench.panelWidth', cssVar: '--wb-panel-w', def: 320, min: 240, max: 720, side: 'right' as const };
type PanelSpec = typeof SIDEBAR | typeof PANEL;
const clampWidth = (spec: PanelSpec, w: number) => Math.round(Math.min(Math.max(w, spec.min), Math.min(spec.max, window.innerWidth - 320)));

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

/**
 * Largeur d'un panneau latéral sur ordinateur (sidebar à gauche, panneau git / session à droite), réglable à la
 * souris ou au clavier et mémorisée dans le navigateur. Pendant le glissement, seule la variable CSS bouge.
 */
function usePanelWidth(rootRef: RefObject<HTMLDivElement | null>, spec: PanelSpec) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(read(spec.key));
    return saved > 0 ? clampWidth(spec, saved) : spec.def;
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number; live: number } | null>(null);
  useEffect(() => write(spec.key, String(width)), [width, spec.key]);
  // Un panneau à droite grandit quand on tire la poignée vers la gauche.
  const sign = spec.side === 'left' ? 1 : -1;
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
      drag.current.live = clampWidth(spec, drag.current.w + sign * (e.clientX - drag.current.x));
      rootRef.current?.style.setProperty(spec.cssVar, `${drag.current.live}px`);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: () => setWidth(spec.def),
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key === 'ArrowLeft') setWidth((w) => clampWidth(spec, w - sign * step));
      else if (e.key === 'ArrowRight') setWidth((w) => clampWidth(spec, w + sign * step));
      else return;
      e.preventDefault();
    },
  };
  return { width, dragging, handleProps, min: spec.min, max: spec.max };
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
  const sidebar = usePanelWidth(rootRef, SIDEBAR);
  const panel = usePanelWidth(rootRef, PANEL);
  const flush = /^\/sessions\/[^/]+(?:\/browser)?$/.test(pathname) || /^\/terminals\/[^/]+$/.test(pathname) || /^\/(?:projects|worksessions)\/[^/]+\/files(?:\/|$)/.test(pathname) || /^\/shared\/[^/]+$/.test(pathname);
  return (
    <TabsProvider>
      <GitTargetProvider>
        <SessionLauncherProvider>
          <RenameWorksessionProvider>
            <SearchPaletteProvider>
              <ShortcutsHelpProvider>
                <div
                  ref={rootRef}
                  className={`wb${sidebarOpen ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}${sidebar.dragging || panel.dragging ? ' resizing' : ''}`}
                  style={{ '--wb-sidebar-w': `${sidebar.width}px`, '--wb-panel-w': `${panel.width}px` } as CSSProperties}
                >
                  <Sidebar onCollapse={() => setCollapsed(true)} />
                  <div
                    className={`wb-resizer${sidebar.dragging ? ' dragging' : ''}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Largeur de la barre latérale"
                    aria-valuenow={sidebar.width}
                    aria-valuemin={sidebar.min}
                    aria-valuemax={sidebar.max}
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
                  <GitPanel resizer={panel} />
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
