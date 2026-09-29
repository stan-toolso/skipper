import { useNavigate } from 'react-router-dom';
import { useTabs, type TabKind } from './TabsContext';

const icons: Record<TabKind, string> = {
  projects: '▣',
  sessions: '≡',
  requests: '⏸',
  project: '▣',
  'project-form': '✎',
  context: '☷',
  session: '✻',
  'new-session': '+',
  terminal: '>_',
  other: '·',
};

/** Barre d'onglets du panneau principal, à la manière d'un éditeur. */
export default function TabBar() {
  const { tabs, activeKey, closeTab, closeOthers } = useTabs();
  const navigate = useNavigate();

  return (
    <div className="wb-tabbar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tab"
          aria-selected={tab.key === activeKey}
          className={`wb-tab${tab.key === activeKey ? ' active' : ''}`}
          title={tab.url}
          onClick={() => navigate(tab.url)}
          onAuxClick={(e) => {
            // Clic molette : fermer, comme dans un éditeur.
            if (e.button === 1) closeTab(tab.key);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (window.confirm(`Fermer les autres onglets que « ${tab.title} » ?`)) closeOthers(tab.key);
          }}
        >
          <span className={`wb-tab-icon kind-${tab.kind}`}>{icons[tab.kind]}</span>
          <span className="wb-tab-title">{tab.title}</span>
          <button
            type="button"
            className="wb-tab-close"
            title="Fermer"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.key);
            }}
          >
            ×
          </button>
        </div>
      ))}
      {tabs.length === 0 && <div className="wb-tab-empty">Aucun onglet ouvert</div>}
    </div>
  );
}
