import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NotificationBell from './NotificationBell';
import { useTabs, type Tab, type TabKind } from './TabsContext';

const icons: Record<TabKind, string> = {
  projects: 'bi-folder2',
  sessions: 'bi-chat-dots',
  requests: 'bi-bell',
  project: 'bi-folder2-open',
  'project-form': 'bi-pencil',
  context: 'bi-journal-text',
  session: 'bi-chat-dots-fill',
  'new-session': 'bi-plus-circle',
  terminal: 'bi-terminal',
  tasks: 'bi-check2-square',
  settings: 'bi-gear',
  files: 'bi-folder2-open',
  file: 'bi-file-earmark-code',
  other: 'bi-file-earmark',
};

/** Menu listant tous les onglets ouverts (utile quand la barre déborde). */
function TabsMenu({ tabs, activeKey, onClose }: { tabs: Tab[]; activeKey: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { closeTab, closeOthers, closeAll } = useTabs();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  return (
    <div className="wb-tabs-menu" onClick={(e) => e.stopPropagation()}>
      <div className="wb-tabs-menu-list">
        {tabs.map((tab) => (
          <div key={tab.key} className={`wb-tabs-menu-item${tab.key === activeKey ? ' active' : ''}`}>
            <button
              type="button"
              className="wb-tabs-menu-open"
              onClick={() => {
                navigate(tab.url);
                onClose();
              }}
            >
              <i className={`bi ${icons[tab.kind]} wb-tab-icon kind-${tab.kind}`} />
              <span>{tab.title}</span>
            </button>
            <button type="button" className="wb-tabs-menu-close" title="Fermer" onClick={() => closeTab(tab.key)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="wb-tabs-menu-foot">
        <button type="button" onClick={() => { closeOthers(activeKey); onClose(); }} disabled={tabs.length < 2}>
          Fermer les autres
        </button>
        <button type="button" onClick={() => { closeAll(); onClose(); }} disabled={tabs.length === 0}>
          Tout fermer
        </button>
      </div>
    </div>
  );
}

/** Menu contextuel d'un onglet (clic droit), positionné au curseur. */
function TabContextMenu({ tab, index, x, y, onClose }: { tab: Tab; index: number; x: number; y: number; onClose: () => void }) {
  const { tabs, closeTab, closeOthers, closeRight, closeAll } = useTabs();
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  // Le menu reste dans la fenêtre même près du bord droit.
  const left = Math.min(x, window.innerWidth - 220);
  return (
    <div className="wb-ctx-menu" style={{ left, top: y }} role="menu" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" onClick={run(() => closeTab(tab.key))}>
        Fermer <kbd>clic molette</kbd>
      </button>
      <button type="button" role="menuitem" disabled={tabs.length < 2} onClick={run(() => closeOthers(tab.key))}>
        Fermer les autres
      </button>
      <button type="button" role="menuitem" disabled={index >= tabs.length - 1} onClick={run(() => closeRight(tab.key))}>
        Fermer à droite
      </button>
      <div className="wb-ctx-sep" />
      <button type="button" role="menuitem" onClick={run(closeAll)}>
        Tout fermer
      </button>
    </div>
  );
}

/**
 * Barre d'onglets du panneau principal. Quand elle déborde : pas de barre de défilement, mais un
 * défilement à la molette ou au trackpad, des ombres sur les bords, l'onglet actif toujours ramené
 * en vue, et un menu qui liste tous les onglets.
 */
export default function TabBar({ onToggleSidebar, sidebarOpen = false }: { onToggleSidebar?: () => void; sidebarOpen?: boolean }) {
  const { tabs, activeKey, closeTab } = useTabs();
  const navigate = useNavigate();
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ tab: Tab; index: number; x: number; y: number } | null>(null);

  const updateOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // Ombres de débordement : recalculées au défilement, au redimensionnement et quand les onglets changent.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateOverflow, tabs]);

  // L'onglet actif est toujours visible.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.wb-tab.active');
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeKey, tabs.length]);

  return (
    <div className="wb-topbar">
      {onToggleSidebar && (
        <button type="button" className={`wb-burger${sidebarOpen ? ' open' : ''}`} onClick={onToggleSidebar} aria-label="Menu" aria-expanded={sidebarOpen} title="Menu">
          <i className={`bi ${sidebarOpen ? 'bi-x-lg' : 'bi-list'}`} />
        </button>
      )}
      <div className={`wb-tabbar-wrap${overflow.left ? ' can-left' : ''}${overflow.right ? ' can-right' : ''}`}>
        <div
          className="wb-tabbar"
          role="tablist"
          ref={stripRef}
          onScroll={updateOverflow}
          onWheel={(e) => {
            // Molette verticale = défilement horizontal de la barre.
            const el = stripRef.current;
            if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            el.scrollLeft += e.deltaY;
          }}
        >
          {tabs.map((tab, index) => (
            <div
              key={tab.key}
              role="tab"
              aria-selected={tab.key === activeKey}
              className={`wb-tab${tab.key === activeKey ? ' active' : ''}`}
              title={tab.title}
              onClick={() => navigate(tab.url)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.key);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtx({ tab, index, x: e.clientX, y: e.clientY });
              }}
            >
              <i className={`bi ${icons[tab.kind]} wb-tab-icon kind-${tab.kind}`} />
              <span className="wb-tab-title">{tab.title}</span>
              <button
                type="button"
                className="wb-tab-close"
                title="Fermer l'onglet"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.key);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {tabs.length === 0 && <div className="wb-tab-empty">Ouvrez un projet ou une session depuis la barre de gauche</div>}
        </div>
      </div>
      <div className="wb-tabbar-right">
        {tabs.length > 0 && (
          <div className="wb-tabs-menu-anchor">
            <button
              type="button"
              className={`wb-bell-btn${menuOpen ? ' open' : ''}`}
              title="Tous les onglets ouverts"
              aria-label="Tous les onglets ouverts"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              <i className="bi bi-chevron-down" style={{ fontSize: 13 }} />
              {tabs.length > 1 && <span className="wb-tabs-count">{tabs.length}</span>}
            </button>
            {menuOpen && <TabsMenu tabs={tabs} activeKey={activeKey} onClose={() => setMenuOpen(false)} />}
          </div>
        )}
        <NotificationBell />
      </div>
      {ctx && <TabContextMenu tab={ctx.tab} index={ctx.index} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
    </div>
  );
}
