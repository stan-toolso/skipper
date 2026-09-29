import { useNavigate } from 'react-router-dom';
import NotificationBell from './NotificationBell';
import { useTabs, type TabKind } from './TabsContext';

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
  other: 'bi-file-earmark',
};

/** Barre d'onglets du panneau principal. */
export default function TabBar() {
  const { tabs, activeKey, closeTab, closeOthers } = useTabs();
  const navigate = useNavigate();

  return (
    <div className="wb-topbar">
      <div className="wb-tabbar" role="tablist">
        {tabs.map((tab) => (
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
            if (window.confirm(`Fermer les autres onglets que « ${tab.title} » ?`)) closeOthers(tab.key);
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
      <div className="wb-tabbar-right">
        <NotificationBell />
      </div>
    </div>
  );
}
