import { Badge } from 'react-bootstrap';
import type { RunStatus, RunTrigger } from '../../graphql/automation';
import { runStatusLabels, runTriggerLabels } from '../../lib/automation';

/** Statut d'une exécution de workflow. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = runStatusLabels[status] ?? { label: status, bg: 'secondary' };
  return (
    <Badge bg={s.bg} text={s.text as 'dark' | undefined}>
      {status === 'RUNNING' && <span className="spinner-border spinner-border-sm me-1" style={{ width: 9, height: 9, borderWidth: 1.5 }} />}
      {s.label}
    </Badge>
  );
}

export function RunTriggerBadge({ trigger }: { trigger: RunTrigger }) {
  return (
    <Badge bg="secondary" className="fw-normal">
      {runTriggerLabels[trigger] ?? trigger}
    </Badge>
  );
}
