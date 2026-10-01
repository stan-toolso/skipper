import { Badge } from 'react-bootstrap';
import type { SessionStatus } from '../graphql/operations';

const variants: Record<SessionStatus, { bg: string; label: string }> = {
  PENDING: { bg: 'secondary', label: 'En attente' },
  QUEUED: { bg: 'info', label: "File d'attente" },
  RUNNING: { bg: 'primary', label: 'En cours' },
  COMPLETED: { bg: 'success', label: 'Terminée' },
  FAILED: { bg: 'danger', label: 'Échouée' },
  STOPPED: { bg: 'warning', label: 'Arrêtée' },
  INTERRUPTED: { bg: 'dark', label: 'Interrompue' },
};

export default function StatusBadge({ status, pendingRequests = 0 }: { status: SessionStatus; pendingRequests?: number }) {
  const v = variants[status] ?? { bg: 'secondary', label: status };
  return (
    <>
      <Badge bg={v.bg} text={v.bg === 'warning' ? 'dark' : undefined}>
        {v.label}
      </Badge>
      {pendingRequests > 0 && (
        <Badge bg="warning" text="dark" className="ms-1" title="Demandes en attente d'une réponse">
          {pendingRequests} demande{pendingRequests > 1 ? 's' : ''}
        </Badge>
      )}
    </>
  );
}
