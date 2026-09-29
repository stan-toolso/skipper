import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Form, Nav, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import RequestCard from '../components/RequestCard';
import { REQUESTS, type HumanRequest, type RequestStatus } from '../graphql/operations';

const statusLabels: Record<RequestStatus, { label: string; bg: string }> = {
  PENDING: { label: 'En attente', bg: 'warning' },
  ANSWERED: { label: 'Répondue', bg: 'success' },
  CANCELLED: { label: 'Annulée', bg: 'secondary' },
  EXPIRED: { label: 'Expirée', bg: 'dark' },
};
const typeLabels: Record<string, string> = { permission: 'Autorisation', question: 'Question', input: 'Saisie' };

/** Résumé lisible de la réponse d'une demande selon son type. */
function summarizeResponse(r: HumanRequest): string {
  if (!r.response) return '—';
  if (r.type === 'permission') {
    const d = r.response.decision === 'allow' ? (r.response.always ? 'Autorisé (toujours)' : 'Autorisé') : 'Refusé';
    return r.response.message ? `${d} — ${String(r.response.message)}` : d;
  }
  if (r.type === 'question') {
    const answers = (r.response.answers ?? {}) as Record<string, string>;
    return Object.values(answers).join(' ; ') || '—';
  }
  return typeof r.response.text === 'string' ? r.response.text : JSON.stringify(r.response);
}

function summarizePayload(r: HumanRequest): string {
  const p = r.payload as { toolName?: string; input?: Record<string, unknown> };
  if (r.type === 'permission' && p.input) {
    const detail = typeof p.input.command === 'string' ? p.input.command : typeof p.input.file_path === 'string' ? p.input.file_path : '';
    return detail ? `${p.toolName ?? ''} ${detail}` : p.toolName ?? '';
  }
  return '';
}

/** Demandes en attente (cartes de réponse) et historique complet (table filtrable). */
export default function RequestsPage() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [filter, setFilter] = useState<RequestStatus | ''>('');

  const pending = useQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 2000 });
  const history = useQuery<{ requests: HumanRequest[] }>(REQUESTS, {
    variables: { status: filter || null, limit: 200, newestFirst: true },
    pollInterval: 5000,
    skip: tab !== 'history',
  });

  const pendingCount = pending.data?.requests.length ?? 0;

  return (
    <>
      <h1 className="h3 mb-3">Demandes</h1>
      <Nav variant="tabs" activeKey={tab} onSelect={(k) => setTab((k as 'pending' | 'history') ?? 'pending')} className="mb-3">
        <Nav.Item>
          <Nav.Link eventKey="pending">
            En attente{' '}
            {pendingCount > 0 && (
              <Badge bg="warning" text="dark" pill>
                {pendingCount}
              </Badge>
            )}
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="history">Historique</Nav.Link>
        </Nav.Item>
      </Nav>

      {tab === 'pending' && (
        <>
          {pending.error && <Alert variant="danger">Erreur : {pending.error.message}</Alert>}
          {pending.loading && !pending.data && <Spinner animation="border" size="sm" />}
          {pending.data && pendingCount === 0 && <p className="text-secondary">Aucune demande en attente. Les agents n'ont besoin de rien pour le moment.</p>}
          {pending.data?.requests.map((r) => (
            <RequestCard key={r.id} request={r} showSession />
          ))}
        </>
      )}

      {tab === 'history' && (
        <>
          <div className="d-flex justify-content-end mb-2">
            <Form.Select size="sm" value={filter} onChange={(e) => setFilter(e.target.value as RequestStatus | '')} style={{ width: 'auto' }}>
              <option value="">Tous les statuts</option>
              {(Object.keys(statusLabels) as RequestStatus[]).map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s].label}
                </option>
              ))}
            </Form.Select>
          </div>
          {history.error && <Alert variant="danger">Erreur : {history.error.message}</Alert>}
          {history.loading && !history.data && <Spinner animation="border" size="sm" />}
          {history.data && (
            <Table hover responsive size="sm" className="align-middle">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Demande</th>
                  <th>Session</th>
                  <th>Statut</th>
                  <th>Réponse</th>
                </tr>
              </thead>
              <tbody>
                {history.data.requests.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-secondary">
                      Aucune demande.
                    </td>
                  </tr>
                )}
                {history.data.requests.map((r) => (
                  <tr key={r.id}>
                    <td className="text-secondary small text-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                      {r.answeredAt && <div title="Traitée">→ {new Date(r.answeredAt).toLocaleTimeString()}</div>}
                    </td>
                    <td>
                      <Badge bg="secondary">{typeLabels[r.type] ?? r.type}</Badge>
                    </td>
                    <td>
                      {r.title}
                      {summarizePayload(r) && (
                        <div className="small text-secondary text-break">
                          <code>{summarizePayload(r)}</code>
                        </div>
                      )}
                    </td>
                    <td className="small">
                      <Link to={`/sessions/${r.session.id}`}>{r.session.name}</Link>
                      <div className="text-secondary">{r.session.project.name}</div>
                    </td>
                    <td>
                      <Badge bg={statusLabels[r.status].bg} text={r.status === 'PENDING' ? 'dark' : undefined}>
                        {statusLabels[r.status].label}
                      </Badge>
                    </td>
                    <td className="small text-break">{summarizeResponse(r)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </>
  );
}
