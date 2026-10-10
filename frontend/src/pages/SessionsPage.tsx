import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, ButtonGroup, Form, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import PageLoading from '../components/PageLoading';
import { useSessionLauncher } from '../components/SessionLauncher';
import StatusBadge from '../components/StatusBadge';
import { PROJECTS, SESSIONS, STOP_SESSION, type Project, type Session, type SessionStatus } from '../graphql/operations';
import { SESSION_OWNERS } from '../graphql/sessions';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDeletions } from '../workbench/useDeletions';
import { useTabTitle } from '../workbench/TabsContext';

const statuses: SessionStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'STOPPED', 'INTERRUPTED'];
const MINE_KEY = 'skipper.sessions.mine';

/** Sessions actives (non archivées) de tous les projets, filtrables par projet, auteur et statut. */
export default function SessionsPage() {
  const { user } = useAuth();
  useTabTitle('Sessions');
  const { openNewSession } = useSessionLauncher();
  const [status, setStatus] = useState<SessionStatus | ''>('');
  const [projectId, setProjectId] = useState('');
  const [mine, setMine] = useState(() => {
    try {
      return localStorage.getItem(MINE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [ownerId, setOwnerId] = useState('');
  const toggleMine = (v: boolean) => {
    setMine(v);
    setOwnerId('');
    try {
      localStorage.setItem(MINE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const { data: ownersData } = useQuery<{ sessionOwners: { id: string; name: string; email: string }[] }>(SESSION_OWNERS, { variables: { projectId: projectId || null } });
  const { data, loading, error } = usePollingQuery<{ sessions: Session[] }>(SESSIONS, {
    variables: { status: status || null, projectId: projectId || null, ownerId: mine ? user?.id : ownerId || null, limit: 200 },
    pollInterval: 3000,
  });
  const [stopSession] = useMutation(STOP_SESSION);
  const { archiveSession } = useDeletions();

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <h1 className="h3 mb-0">Sessions</h1>
        <div className="d-flex gap-2 flex-wrap">
          <ButtonGroup size="sm">
            <Button variant={mine ? 'primary' : 'outline-secondary'} onClick={() => toggleMine(true)}>
              Mes sessions
            </Button>
            <Button variant={!mine ? 'primary' : 'outline-secondary'} onClick={() => toggleMine(false)}>
              Toutes
            </Button>
          </ButtonGroup>
          {!mine && (
            <Form.Select size="sm" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={{ width: 'auto', maxWidth: 260 }} title="Auteur">
              <option value="">Par n'importe qui</option>
              {(ownersData?.sessionOwners ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  Par {o.id === user?.id ? 'moi' : o.name}
                </option>
              ))}
            </Form.Select>
          )}
          <Form.Select size="sm" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Tous les projets</option>
            {(projectsData?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Form.Select>
          <Form.Select size="sm" value={status} onChange={(e) => setStatus(e.target.value as SessionStatus | '')} style={{ width: 'auto' }}>
            <option value="">Tous les statuts</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Form.Select>
          <Button size="sm" onClick={() => openNewSession({ projectId: projectId || null })}>
            Nouvelle session
          </Button>
        </div>
      </div>

      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <PageLoading />}

      {data && (
        <Table hover responsive size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Projet</th>
              <th>Par</th>
              <th>Statut</th>
              <th>Créée</th>
              <th>Terminée</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.sessions.length === 0 && (
              <tr>
                <td colSpan={7} className="text-secondary">
                  Aucune session.
                </td>
              </tr>
            )}
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/sessions/${s.id}`}>{s.name}</Link>
                  {s.worktree && <span className="text-secondary small ms-2"><i className="bi bi-diagram-2" /> {s.worktree.label}</span>}
                  {s.schedule?.enabled && <i className="bi bi-alarm ms-2 text-secondary" title={`Planifiée : ${s.schedule.cron}${s.schedule.nextRunAt ? ` · prochaine exécution le ${new Date(s.schedule.nextRunAt).toLocaleString()}` : ''}`} />}
                </td>
                <td>
                  <Link to={`/projects/${s.project.id}`}>{s.project.name}</Link>
                </td>
                <td className="small">{s.owner ? (s.owner.id === user?.id ? 'moi' : s.owner.name) : <span className="text-secondary">—</span>}</td>
                <td>
                  <StatusBadge status={s.status} pendingRequests={s.pendingRequestCount} />
                </td>
                <td className="text-secondary small">{new Date(s.createdAt).toLocaleString()}</td>
                <td className="text-secondary small">{s.endedAt ? new Date(s.endedAt).toLocaleString() : '—'}</td>
                <td className="text-end">
                  <ButtonGroup size="sm">
                    {s.status === 'RUNNING' && (
                      <Button variant="outline-warning" onClick={() => stopSession({ variables: { id: s.id } })}>
                        Arrêter
                      </Button>
                    )}
                    <Button variant="outline-secondary" title="Archiver : la session quitte la barre latérale et reste consultable dans l'historique du projet" onClick={() => void archiveSession({ id: s.id, name: s.name, worktreeId: s.worktree?.id ?? null })}>
                      Archiver
                    </Button>
                  </ButtonGroup>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
