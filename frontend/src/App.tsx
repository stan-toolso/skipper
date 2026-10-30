import { Spinner } from 'react-bootstrap';
import { Navigate, Route, Routes, type Location } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import { DialogProvider } from './components/Dialogs';
import TabPages from './workbench/TabPages';
import ProjectsPage from './pages/ProjectsPage';
import ProjectFormPage from './pages/ProjectFormPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import ContextPage from './pages/ContextPage';
import LoginPage from './pages/LoginPage';
import SessionsPage from './pages/SessionsPage';
import SessionDetailPage from './pages/SessionDetailPage';
import SessionHistoryPage from './pages/SessionHistoryPage';
import BrowserPage from './pages/BrowserPage';
import RequestsPage from './pages/RequestsPage';
import TerminalPage from './pages/TerminalPage';
import DashboardPage from './pages/DashboardPage';
import TasksPage from './pages/TasksPage';
import TaskPage from './pages/TaskPage';
import SettingsPage from './pages/SettingsPage';
import UsersPage from './pages/UsersPage';
import FilesPage from './pages/FilesPage';
import VaultPage from './pages/VaultPage';
import ProjectVaultPage from './pages/ProjectVaultPage';
import SharedPagesPage from './pages/SharedPagesPage';
import SharedPagePage from './pages/SharedPagePage';
import WorkflowsPage from './pages/WorkflowsPage';
import WorkflowPage from './pages/WorkflowPage';
import WorkflowRunPage from './pages/WorkflowRunPage';
import ChatsPage from './pages/ChatsPage';
import PersonalSpaceRedirect from './pages/PersonalSpaceRedirect';

/** Routes des pages ; `location` est celle de l'onglet rendu (figée pour un onglet caché). */
function PageRoutes({ location, isAdmin }: { location: Location; isAdmin: boolean }) {
  return (
    <Routes location={location}>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/new" element={<ProjectFormPage />} />
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
      <Route path="/projects/:id/edit" element={<ProjectFormPage />} />
      <Route path="/projects/:id/context" element={<ContextPage />} />
      <Route path="/projects/:id/tasks" element={<TasksPage />} />
      <Route path="/projects/:id/vault" element={<ProjectVaultPage />} />
      <Route path="/projects/:id/history" element={<SessionHistoryPage />} />
      <Route path="/projects/:id/connections" element={<RedirectToVault />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/:id" element={<TaskPage />} />
      <Route path="/vault" element={<VaultPage />} />
      <Route path="/workflows" element={<WorkflowsPage />} />
      <Route path="/workflows/:id" element={<WorkflowPage />} />
      <Route path="/workflows/:id/runs/:runId" element={<WorkflowRunPage />} />
      <Route path="/projects/:id/workflows" element={<WorkflowsPage />} />
      <Route path="/shared" element={<SharedPagesPage />} />
      <Route path="/shared/:id" element={<SharedPagePage />} />
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/sessions/:id" element={<SessionDetailPage />} />
      <Route path="/chats" element={<ChatsPage />} />
      <Route path="/chats/:id" element={<SessionDetailPage />} />
      <Route path="/me" element={<PersonalSpaceRedirect />} />
      <Route path="/sessions/:id/browser" element={<BrowserPage />} />
      <Route path="/requests" element={<RequestsPage />} />
      <Route path="/terminals/:id" element={<TerminalPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      {isAdmin && <Route path="/users" element={<UsersPage />} />}
      <Route path="/projects/:id/files" element={<FilesPage />} />
      <Route path="/projects/:id/files/*" element={<FilesPage />} />
      <Route path="/sessions/:id/files" element={<FilesPage />} />
      <Route path="/sessions/:id/files/*" element={<FilesPage />} />
      <Route path="/worktrees/*" element={<Navigate to="/" replace />} />
      <Route path="/worksessions/*" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
  return (
    <Layout>
      <TabPages render={(location) => <PageRoutes location={location} isAdmin={user.isAdmin} />} />
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <DialogProvider>
        <Gate />
      </DialogProvider>
    </AuthProvider>
  );
}
