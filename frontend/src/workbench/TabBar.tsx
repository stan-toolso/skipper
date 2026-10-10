import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { displayCombo } from '../lib/shortcuts';
import { useShortcut } from '../lib/useShortcut';
import NotificationBell from './NotificationBell';
import { useTabs, type Tab, type TabKind } from './TabsContext';

const icons: Record<TabKind, string> = {
  dashboard: 'bi-speedometer2',
  projects: 'bi-folder2',
  sessions: 'bi-chat-dots',
  requests: 'bi-bell',
  project: 'bi-folder2-open',
  'project-form': 'bi-pencil',
  context: 'bi-journal-text',
  vault: 'bi-shield-lock',
  session: 'bi-chat-dots-fill',
  browser: 'bi-globe2',
  terminal: 'bi-terminal',
  tasks: 'bi-check2-square',
  task: 'bi-check2-square',
  history: 'bi-clock-history',
  settings: 'bi-gear',
  users: 'bi-people',
  files: 'bi-folder2-open',
  file: 'bi-file-earmark-code',
  worktree: 'bi-diagram-2',
  'shared-pages': 'bi-file-earmark-richtext',
  'shared-page': 'bi-file-earmark-richtext',
  agents: 'bi-robot',
  agent: 'bi-robot',
  workflows: 'bi-diagram-3',
  workflow: 'bi-diagram-3',
  'workflow-run': 'bi-play-circle',
  other: 'bi-file-earmark',
};

const Keys = ({ combo }: { combo: string }) => (
  <kbd>
    {displayCombo(combo).map((c, i) => (
      <span key={i}>{c}</span>
    ))}
  </kbd>
);

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
  const { tabs, closeTab, closeOthers, closeRight, closeAll, reopenClosed, canReopen } = useTabs();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [onClose]);
  useShortcut({ id: 'tabs.menu.close', keys: ['Escape'], label: 'Fermer le menu', scope: 'context', area: "Menu d'un onglet", preventDefault: false }, () => onClose());
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const left = Math.min(x, window.innerWidth - 240);
  return (
    <div className="wb-ctx-menu" style={{ left, top: y }} role="menu" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" onClick={run(() => closeTab(tab.key))}>
        Fermer <Keys combo="alt+code:KeyW" />
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
      <button type="button" role="menuitem" disabled={!canReopen} onClick={run(reopenClosed)}>
        Rouvrir l'onglet fermé <Keys combo="alt+shift+code:KeyT" />
      </button>
    </div>
  );
}

/**
 * Barre d'onglets du panneau principal. Quand elle déborde : pas de barre de défilement, mais un
 * défilement à la molette ou au trackpad, des ombres sur les bords, l'onglet actif toujours ramené
 * en vue, et un menu qui liste tous les onglets.
 */
export default function TabBar({ onToggleSidebar, sidebarOpen = false, sidebarCollapsed = false }: { onToggleSidebar?: () => void; sidebarOpen?: boolean; sidebarCollapsed?: boolean }) {
  const { tabs, activeKey, closeTab, reopenClosed, previous, next, goTo } = useTabs();
  const navigate = useNavigate();
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ tab: Tab; index: number; x: number; y: number } | null>(null);

  // Raccourcis d'onglets, sur Alt/Option : Ctrl/⌘+W et +T appartiennent au navigateur. Alt+W tape ∑ sur un
  // clavier Mac français, d'où l'alternative Alt+< (touche physique à gauche du W ou du X).
  useShortcut({ id: 'tabs.close', keys: ['alt+code:KeyW', 'alt+code:IntlBackslash', 'alt+code:Comma'], label: "Fermer l'onglet actif", scope: 'global', area: 'Onglets' }, () => {
    if (tabs.some((t) => t.key === activeKey)) closeTab(activeKey);
  });
  useShortcut({ id: 'tabs.reopen', keys: ['alt+shift+code:KeyT'], label: "Rouvrir l'onglet fermé", scope: 'global', area: 'Onglets' }, () => reopenClosed());
  useShortcut({ id: 'tabs.previous', keys: ['alt+code:BracketLeft', 'alt+shift+code:BracketLeft'], label: 'Onglet précédent', scope: 'global', area: 'Onglets', anyShift: true }, () => previous());
  useShortcut({ id: 'tabs.next', keys: ['alt+code:BracketRight', 'alt+shift+code:BracketRight'], label: 'Onglet suivant', scope: 'global', area: 'Onglets', anyShift: true }, () => next());
  useShortcut({ id: 'tabs.go', keys: ['alt+code:digit'], label: 'Aller à l’onglet n° (9 : le dernier)', scope: 'global', area: 'Onglets' }, (e) => goTo(Number(e.code.replace('Digit', ''))));

  const updateOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateOverflow, tabs]);

  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('.wb-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeKey, tabs.length]);

  return (
    <div className="wb-topbar">
      {onToggleSidebar && (
        <button type="button" className={`wb-burger${sidebarOpen ? ' open' : ''}${sidebarCollapsed ? ' collapsed' : ''}`} onClick={onToggleSidebar} aria-label="Menu" aria-expanded={sidebarOpen} title="Menu">
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
