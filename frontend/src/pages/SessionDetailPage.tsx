import { useMutation, useQuery } from '@apollo/client';
import { Alert, Button, Card, Col, Row, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import EventLog from '../components/EventLog';
import RequestCard from '../components/RequestCard';
import StatusBadge from '../components/StatusBadge';
import { DELETE_SESSION, SESSION, START_SESSION, STOP_SESSION, type HumanRequest, type Session, type SessionEvent } from '../graphql/operations';

type SessionWithEvents = Session & { events: SessionEvent[]; requests: HumanRequest[] };

export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<{ session: SessionWithEvents | null }>(SESSION, {
    variables: { id },
    pollInterval: 2000,
  });
  const [startSession, { error: startError }] = useMutation(START_SESSION);
  const [stopSession, { error: stopError }] = useMutation(STOP_SESSION);
  const [deleteSession] = useMutation(DELETE_SESSION, { onCompleted: () => navigate('/sessions') });

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const session = data?.session;
  if (!session) return <Alert variant="warning">Session introuvable.</Alert>;

  const canStart = session.status !== 'RUNNING';
  const actionError = startError ?? stopError;

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div>
          <Link to="/sessions" className="small">
            ← Sessions
          </Link>
          <h1 className="h3 mb-0">
            {session.name} <StatusBadge status={session.status} pendingRequests={session.pendingRequestCount} />
          </h1>
          <div className="text-secondary small">
            Projet <Link to={`/projects/${session.project.id}`}>{session.project.name}</Link>
          </div>
        </div>
        <div className="d-flex gap-2">
          {canStart && (
            <Button size="sm" onClick={() => startSession({ variables: { id } })}>
              {session.status === 'PENDING' ? 'Démarrer' : 'Relancer'}
            </Button>
          )}
          {session.status === 'RUNNING' && (
            <Button size="sm" variant="warning" onClick={() => stopSession({ variables: { id } })}>
              Arrêter
            </Button>
          )}
          <Button
            size="sm"
            variant="outline-danger"
            onClick={() => {
              if (window.confirm('Supprimer cette session ?')) deleteSession({ variables: { id } });
            }}
          >
            Supprimer
          </Button>
        </div>
      </div>

      {actionError && <Alert variant="danger">{actionError.message}</Alert>}
      {session.error && <Alert variant="danger">{session.error}</Alert>}

      {session.requests.length > 0 && (
        <div className="mb-3">
          <h2 className="h5">L'agent attend une réponse</h2>
          {session.requests.map((r) => (
            <RequestCard key={r.id} request={r} />
          ))}
        </div>
      )}

      <Row className="g-3 mb-3">
        <Col md={4}>
          <Card className="h-100">
            <Card.Header>Informations</Card.Header>
            <Card.Body className="small">
              <dl className="row mb-0">
                <dt className="col-5">Type</dt>
                <dd className="col-7">
                  <code>{session.provider}</code>
                </dd>
                <dt className="col-5">Id externe</dt>
                <dd className="col-7 text-break">{session.externalId ?? '—'}</dd>
                <dt className="col-5">Créée</dt>
                <dd className="col-7">{new Date(session.createdAt).toLocaleString()}</dd>
                <dt className="col-5">Démarrée</dt>
                <dd className="col-7">{session.startedAt ? new Date(session.startedAt).toLocaleString() : '—'}</dd>
                <dt className="col-5">Terminée</dt>
                <dd className="col-7">{session.endedAt ? new Date(session.endedAt).toLocaleString() : '—'}</dd>
                <dt className="col-5">Code de sortie</dt>
                <dd className="col-7">{session.exitCode ?? '—'}</dd>
              </dl>
              <hr />
              <div className="text-secondary">Configuration</div>
              <pre className="mb-0">{JSON.stringify(session.config, null, 2)}</pre>
            </Card.Body>
          </Card>
        </Col>
        <Col md={8}>
          <Card className="h-100">
            <Card.Header>Prompt</Card.Header>
            <Card.Body>
              <pre className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                {session.prompt ?? <span className="text-secondary">—</span>}
              </pre>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <h2 className="h5">Journal</h2>
      <EventLog events={session.events} />
    </>
  );
}
