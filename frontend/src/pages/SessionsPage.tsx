import { useMutation, useQuery } from '@apollo/client';
import { Alert, Button, ButtonGroup, Form, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import StatusBadge from '../components/StatusBadge';
import { useDialogs } from '../components/Dialogs';
import { DELETE_SESSION, PROJECTS, SESSIONS, STOP_SESSION, type Project, type Session, type SessionStatus } from '../graphql/operations';
import { useSessionLauncher } from '../components/SessionLauncher';

const statuses: SessionStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'STOPPED', 'INTERRUPTED'];

export default function SessionsPage() {
  const { openNewSession } = useSessionLauncher();
  const [status, setStatus] = useState<SessionStatus | ''>('');
  const [projectId, setProjectId] = useState('');
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const { data, loading, error, refetch } = useQuery<{ sessions: Session[] }>(SESSIONS, {
    variables: { status: status || null, projectId: projectId || null },
    pollInterval: 3000,
  });
  const [stopSession] = useMutation(STOP_SESSION);
  const { confirm } = useDialogs();
  const [deleteSession] = useMutation(DELETE_SESSION, { onCompleted: () => refetch() });

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h1 className="h3 mb-0">Sessions</h1>
        <div className="d-flex gap-2">
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
      {loading && !data && <Spinner animation="border" size="sm" />}

      {data && (
        <Table hover responsive size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Projet</th>
              <th>Type</th>
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
                  {s.schedule?.enabled && <i className="bi bi-alarm ms-2 text-secondary" title={`Planifiée : ${s.schedule.cron}${s.schedule.nextRunAt ? ` · prochaine exécution le ${new Date(s.schedule.nextRunAt).toLocaleString()}` : ''}`} />}
                </td>
                <td>
                  <Link to={`/projects/${s.project.id}`}>{s.project.name}</Link>
                </td>
                <td>
                  <code>{s.provider}</code>
                </td>
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
                    <Button
                      variant="outline-danger"
                      onClick={async () => {
                        if (await confirm({ title: 'Supprimer la session', message: `Supprimer la session « ${s.name} » et tout son historique ?`, confirmLabel: 'Supprimer', danger: true })) deleteSession({ variables: { id: s.id } });
                      }}
                    >
                      Supprimer
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
