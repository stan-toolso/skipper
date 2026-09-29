import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from '../workbench/Sidebar';
import TabBar from '../workbench/TabBar';
import { TabsProvider } from '../workbench/TabsContext';
import '../workbench/workbench.css';

/** Workbench : sidebar (menus + explorateur) et panneau principal à onglets. */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const flush = (/^\/sessions\/[^/]+$/.test(pathname) && pathname !== '/sessions/new') || /^\/terminals\/[^/]+$/.test(pathname);
  return (
    <TabsProvider>
      <div className="wb">
        <Sidebar />
        <div className="wb-main">
          <TabBar />
          <div className={`wb-content${flush ? ' flush' : ''}`}>{children}</div>
        </div>
      </div>
    </TabsProvider>
  );
}
