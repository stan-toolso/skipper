import { lazy, Suspense } from 'react';
import { Spinner } from 'react-bootstrap';
import { Navigate, Route, Routes, useLocation, type Location } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import { DialogProvider } from './components/Dialogs';
import TabPages from './workbench/TabPages';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
const SubagentPage = lazy(() => import('./pages/SubagentPage'));
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage'));
const ProjectMembersPage = lazy(() => import('./pages/ProjectMembersPage'));
const ProjectCustomPage = lazy(() => import('./pages/ProjectCustomPage'));
const ProjectTabsPage = lazy(() => import('./pages/ProjectTabsPage'));
import LoginPage from './pages/LoginPage';
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
import SessionsPage from './pages/SessionsPage';
import SessionDetailPage from './pages/SessionDetailPage';
import RequestsPage from './pages/RequestsPage';
import InboxPage from './pages/InboxPage';
import DashboardPage from './pages/DashboardPage';
import TasksPage from './pages/TasksPage';
const ConversationsPage = lazy(() => import('./pages/ConversationsPage'));
import TaskPage from './pages/TaskPage';
import PersonalSpaceRedirect from './pages/PersonalSpaceRedirect';
import PageLoading from './components/PageLoading';
import ProjectWindowNotice from './components/ProjectWindowNotice';
import { projectWindowId, projectWindowRoute } from './lib/projectWindow';
import { useTabs } from './workbench/TabsContext';
import { ProjectRoleGate, RestrictedHome } from './components/GuestGate';
import ProjectConfigShell from './components/ProjectConfigShell';

// Pages chargées à la demande (découpage du bundle) : éditeurs CodeMirror (fichiers, contexte), terminal xterm,
// graphe des workflows (xyflow, dagre) et pages rarement ouvertes restent hors du bundle principal, que
// l'application analyse et compile à chaque démarrage. Le service worker les précache après coup.
const ProjectFormPage = lazy(() => import('./pages/ProjectFormPage'));
const ContextPage = lazy(() => import('./pages/ContextPage'));
const SessionHistoryPage = lazy(() => import('./pages/SessionHistoryPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const BrowserPage = lazy(() => import('./pages/BrowserPage'));
const TerminalPage = lazy(() => import('./pages/TerminalPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ChromeConnectPage = lazy(() => import('./pages/ChromeConnectPage'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const FilesPage = lazy(() => import('./pages/FilesPage'));
const VaultPage = lazy(() => import('./pages/VaultPage'));
const ProjectVaultPage = lazy(() => import('./pages/ProjectVaultPage'));
const ProjectEnvPage = lazy(() => import('./pages/ProjectEnvPage'));
const SharedPagesPage = lazy(() => import('./pages/SharedPagesPage'));
const SharedPagePage = lazy(() => import('./pages/SharedPagePage'));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage'));
const SchedulesPage = lazy(() => import('./pages/SchedulesPage'));
const WorkflowPage = lazy(() => import('./pages/WorkflowPage'));
const WorkflowRunPage = lazy(() => import('./pages/WorkflowRunPage'));
const ChatsPage = lazy(() => import('./pages/ChatsPage'));
const ProjectPullRequestsPage = lazy(() => import('./pages/ProjectPullRequestsPage'));
const ProjectDeliveriesPage = lazy(() => import('./pages/ProjectDeliveriesPage'));
const ProjectUsagePage = lazy(() => import('./pages/ProjectUsagePage'));
const RepoPage = lazy(() => import('./pages/RepoPage'));
const ProjectAgentsPage = lazy(() => import('./pages/ProjectAgentsPage'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const SharedSessionPage = lazy(() => import('./pages/SharedSessionPage'));
const GuestLayout = lazy(() => import('./components/GuestLayout'));

/** Routes des pages ; `location` est celle de l'onglet rendu (figée pour un onglet caché). */
function PageRoutes({ location, isAdmin, restricted }: { location: Location; isAdmin: boolean; restricted: boolean }) {
  const { workspaces } = useTabs();
  // Fenêtre dédiée à un projet : une page d'un autre projet (ou la session d'un autre projet) ne s'y affiche pas.
  if (projectWindowId) {
    const route = projectWindowRoute(location.pathname, projectWindowId);
    const wsKey = workspaces.keyOf(location.pathname);
    const ws = wsKey ? workspaces.get(wsKey) : undefined;
    const otherSession = Boolean(ws) && ws!.projectId !== projectWindowId;
    if ((route && 'foreign' in route) || otherSession) return <ProjectWindowNotice pathname={location.pathname} search={location.search} />;
  }
  return (
    <Suspense fallback={<PageLoading className="p-3" />}>
      <Routes location={location}>
      {/* Accès restreint (invité seulement) : l'accueil mène aux conversations du projet où l'on est invité. */}
      <Route path="/" element={restricted ? <RestrictedHome /> : <DashboardPage />} />
      <Route path="/projects" element={restricted ? <Navigate to="/" replace /> : <ProjectsPage />} />
      <Route path="/projects/new" element={restricted ? <Navigate to="/" replace /> : <ProjectFormPage />} />
      {/* Les pages d'un projet passent par la garde des invités : un invité du projet n'y voit que ses conversations. */}
      <Route path="/projects/:id" element={<ProjectRoleGate><ProjectDetailPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/edit" element={<ProjectRoleGate><ProjectConfigShell><ProjectFormPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/settings" element={<ProjectRoleGate><ProjectConfigShell><ProjectSettingsPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/tabs" element={<ProjectRoleGate><ProjectConfigShell><ProjectTabsPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/members" element={<ProjectRoleGate><ProjectConfigShell><ProjectMembersPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/p/:slug" element={<ProjectRoleGate><ProjectCustomPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/context" element={<ProjectRoleGate><ProjectConfigShell><ContextPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/tasks" element={<ProjectRoleGate><TasksPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/artifacts" element={<ProjectRoleGate><SharedPagesPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/conversations" element={<ConversationsPage />} />
      <Route path="/projects/:id/conversations/:slug" element={<ConversationsPage />} />
      <Route path="/projects/:id/agents" element={<ProjectRoleGate><ProjectConfigShell><ProjectAgentsPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/agents/:agentId" element={<ProjectRoleGate><ProjectConfigShell><AgentPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/pull-requests" element={<ProjectRoleGate><ProjectPullRequestsPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/deliveries" element={<ProjectRoleGate><ProjectDeliveriesPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/usage" element={<ProjectRoleGate><ProjectConfigShell><ProjectUsagePage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/repo" element={<ProjectRoleGate><RepoPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/vault" element={<ProjectRoleGate><ProjectConfigShell><ProjectVaultPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/env" element={<ProjectRoleGate><ProjectConfigShell><ProjectEnvPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/history" element={<ProjectRoleGate><ProjectConfigShell><SessionHistoryPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/audit" element={<ProjectRoleGate><ProjectConfigShell><AuditPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/projects/:id/connections" element={<RedirectToVault />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/:id" element={<TaskPage />} />
      <Route path="/vault" element={<VaultPage />} />
      <Route path="/schedules" element={<SchedulesPage />} />
      <Route path="/projects/:id/schedules" element={<ProjectRoleGate><ProjectConfigShell><SchedulesPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/workflows" element={<WorkflowsPage />} />
      <Route path="/workflows/:id" element={<WorkflowPage />} />
      <Route path="/workflows/:id/runs/:runId" element={<WorkflowRunPage />} />
      <Route path="/projects/:id/workflows" element={<ProjectRoleGate><ProjectConfigShell><WorkflowsPage /></ProjectConfigShell></ProjectRoleGate>} />
      <Route path="/shared" element={<SharedPagesPage />} />
      <Route path="/shared/:id" element={<SharedPagePage />} />
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/sessions/:id" element={<SessionDetailPage />} />
      <Route path="/chats" element={<ChatsPage />} />
      <Route path="/chats/:id" element={<SessionDetailPage />} />
      <Route path="/me" element={<PersonalSpaceRedirect />} />
      <Route path="/sessions/:id/browser" element={<BrowserPage />} />
      <Route path="/sessions/:id/subagents/:toolUseId" element={<SubagentPage />} />
      {/* Page publiée par la session, ouverte dans son dossier ; /shared/:id reste la page à part entière (lien partagé, sans session). */}
      <Route path="/sessions/:sessionId/pages/:id" element={<SharedPagePage />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/requests" element={<RequestsPage />} />
      <Route path="/terminals/:id" element={<TerminalPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/chrome/connect" element={<ChromeConnectPage />} />
      <Route path="/welcome" element={<OnboardingPage />} />
      {isAdmin && <Route path="/users" element={<UsersPage />} />}
      {isAdmin && <Route path="/billing" element={<BillingPage />} />}
      <Route path="/projects/:id/files" element={<ProjectRoleGate><FilesPage /></ProjectRoleGate>} />
      <Route path="/projects/:id/files/*" element={<ProjectRoleGate><FilesPage /></ProjectRoleGate>} />
      <Route path="/sessions/:id/files" element={<FilesPage />} />
      <Route path="/sessions/:id/files/*" element={<FilesPage />} />
      <Route path="/worktrees/*" element={<Navigate to="/" replace />} />
      <Route path="/worksessions/*" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function RedirectToVault() {
  const path = window.location.pathname.replace(/\/connections$/, '/vault');
  return <Navigate to={path} replace />;
}

/** Sans utilisateur connecté, seule la page de connexion est affichée. */
function Gate() {
  const { user, loading, error } = useAuth();
  if (loading && !user) {
    return (
      <div className="d-flex align-items-center justify-content-center" style={{ minHeight: '100vh' }}>
        <Spinner animation="border" size="sm" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="d-flex align-items-center justify-content-center text-secondary" style={{ minHeight: '100vh' }}>
        Le serveur ne répond pas ({error.message}).
      </div>
    );
  }
  if (!user) return <LoginPage />;
  // Invité des pages partagées : seulement les pages partagées avec lui, sans sidebar ni onglets.
  if (user.isGuest)
    return (
      <Suspense fallback={<PageLoading />}>
        <GuestLayout />
      </Suspense>
    );
  return (
    <Layout>
      <TabPages render={(location) => <PageRoutes location={location} isAdmin={user.isAdmin} restricted={Boolean(user.conversationsOnly)} />} />
    </Layout>
  );
}

export default function App() {
  // Lien public d'une session (/share/<token>) : lisible sans compte, hors de l'application (ni connexion, ni sidebar).
  const { pathname } = useLocation();
  // Lien pour choisir son mot de passe : hors de l'application, connecté ou non.
  if (pathname === '/reset-password')
    return (
      <Suspense fallback={<PageLoading />}>
        <ResetPasswordPage />
      </Suspense>
    );
  if (pathname.startsWith('/share/'))
    return (
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/share/:token" element={<SharedSessionPage />} />
        </Routes>
      </Suspense>
    );
  return (
    <AuthProvider>
      <DialogProvider>
        <Gate />
      </DialogProvider>
    </AuthProvider>
  );
}
