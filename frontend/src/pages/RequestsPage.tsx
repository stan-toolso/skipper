import { useQuery } from '@apollo/client';
import { Alert, Spinner } from 'react-bootstrap';
import RequestCard from '../components/RequestCard';
import { REQUESTS, type HumanRequest } from '../graphql/operations';

/** Toutes les demandes en attente, toutes sessions confondues. */
export default function RequestsPage() {
  const { data, loading, error } = useQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 2000 });

  return (
    <>
      <h1 className="h3 mb-3">Demandes en attente</h1>
      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <Spinner animation="border" size="sm" />}
      {data && data.requests.length === 0 && <p className="text-secondary">Aucune demande en attente. Les agents n'ont besoin de rien pour le moment.</p>}
      {data?.requests.map((r) => (
        <RequestCard key={r.id} request={r} showSession />
      ))}
    </>
  );
}
