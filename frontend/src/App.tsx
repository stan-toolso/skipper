import { Spinner } from 'react-bootstrap';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import ProjectsPage from './pages/ProjectsPage';
import ProjectFormPage from './pages/ProjectFormPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import ContextPage from './pages/ContextPage';
import LoginPage from './pages/LoginPage';
import SessionsPage from './pages/SessionsPage';
import NewSessionPage from './pages/NewSessionPage';
import SessionDetailPage from './pages/SessionDetailPage';
import RequestsPage from './pages/RequestsPage';
import TerminalPage from './pages/TerminalPage';
import DashboardPage from './pages/DashboardPage';
import TasksPage from './pages/TasksPage';
import SettingsPage from './pages/SettingsPage';
import FilesPage from './pages/FilesPage';
import FileEditorPage from './pages/FileEditorPage';
import ConnectionsPage from './pages/ConnectionsPage';

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
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<ProjectFormPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/edit" element={<ProjectFormPage />} />
        <Route path="/projects/:id/context" element={<ContextPage />} />
        <Route path="/projects/:id/tasks" element={<TasksPage />} />
        <Route path="/projects/:id/connections" element={<ConnectionsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/new" element={<NewSessionPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/terminals/:id" element={<TerminalPage />} />
        {user.isAdmin && <Route path="/settings" element={<SettingsPage />} />}
        <Route path="/projects/:id/files" element={<FilesPage />} />
        <Route path="/projects/:id/files/*" element={<FileEditorPage />} />
        <Route path="/worktrees/:wid/files" element={<FilesPage />} />
        <Route path="/worktrees/:wid/files/*" element={<FileEditorPage />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
