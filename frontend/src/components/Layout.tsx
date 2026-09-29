import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from '../workbench/Sidebar';
import TabBar from '../workbench/TabBar';
import { TabsProvider } from '../workbench/TabsContext';
import GitPanel from '../workbench/GitPanel';
import { GitTargetProvider } from '../workbench/GitTargetContext';
import '../workbench/workbench.css';

/** Workbench : sidebar (menus + explorateur) et panneau principal à onglets. */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // Sur mobile la sidebar est un tiroir : ouvert par le bouton menu, refermé à chaque navigation.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => setSidebarOpen(false), [pathname]);
  const flush =
    (/^\/sessions\/[^/]+$/.test(pathname) && pathname !== '/sessions/new') || /^\/terminals\/[^/]+$/.test(pathname) || /^\/(?:projects|worktrees)\/[^/]+\/files(?:\/|$)/.test(pathname);
  return (
    <TabsProvider>
      <GitTargetProvider>
        <div className={`wb${sidebarOpen ? ' sidebar-open' : ''}`}>
          <Sidebar />
          {sidebarOpen && <div className="wb-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
          <div className="wb-main">
            <TabBar onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
            <div className={`wb-content${flush ? ' flush' : ''}`}>{children}</div>
          </div>
          <GitPanel />
        </div>
      </GitTargetProvider>
    </TabsProvider>
  );
}
