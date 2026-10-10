import { useMutation } from '@apollo/client';
import { Alert, Button, Col, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { CANCEL_AGENT_RUN, type AgentRun } from '../../graphql/automation';
import { fmtDateTime, isRunActive, prettyJson, runDurationMs } from '../../lib/automation';
import { formatCost, formatDuration } from '../../lib/humanize';
import Markdown from '../Markdown';
import { RunStatusBadge, RunTriggerBadge } from './RunBadges';

/** Détail d'une exécution d'agent : entrées, instruction rendue, réponse (Markdown ou JSON), erreur, coût. */
export default function AgentRunDetail({ run }: { run: AgentRun }) {
  const [cancel, { loading: cancelling }] = useMutation(CANCEL_AGENT_RUN, { refetchQueries: ['AgentRuns', 'Agent'] });
  const duration = runDurationMs(run);
  const json = run.agent.outputFormat === 'JSON' && run.outputJson !== null && run.outputJson !== undefined;
  return (
    <div>
      <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
        <RunStatusBadge status={run.status} />
        <RunTriggerBadge trigger={run.trigger} />
        <span className="small text-secondary">
          {fmtDateTime(run.createdAt)}
          {duration !== null && ` · ${formatDuration(duration)}`}
          {run.costUsd > 0 && ` · ${formatCost(run.costUsd)}`}
          {run.owner && ` · ${run.owner.name}`}
        </span>
        {run.session && (
          <Link to={`/sessions/${run.session.id}`} className="small">
            <i className="bi bi-chat-dots me-1" />
            {run.session.name}
          </Link>
        )}
        {run.workflowRun && (
          <Link to={`/workflows/${run.workflowRun.workflow.id}/runs/${run.workflowRun.id}`} className="small">
            <i className="bi bi-diagram-3 me-1" />
            {run.workflowRun.workflow.name}
            {run.nodeKey ? ` · ${run.nodeKey}` : ''}
          </Link>
        )}
        {isRunActive(run.status) && (
          <Button size="sm" variant="outline-danger" className="ms-auto" disabled={cancelling} onClick={() => void cancel({ variables: { id: run.id } })}>
            <i className="bi bi-stop-circle me-1" /> Annuler
          </Button>
        )}
      </div>
      {run.error && (
        <Alert variant="danger" className="py-2">
          {run.error}
        </Alert>
      )}
      <Row className="g-3">
        <Col lg={5}>
          {Object.keys(run.inputs).length > 0 && (
            <>
              <div className="small fw-semibold mb-1">Entrées</div>
              <pre className="auto-pre mb-3">{prettyJson(run.inputs)}</pre>
            </>
          )}
          <div className="small fw-semibold mb-1">Instruction envoyée</div>
          <pre className="auto-pre">{run.prompt || '—'}</pre>
        </Col>
        <Col lg={7}>
          <div className="small fw-semibold mb-1">Réponse</div>
          {run.output === null || run.output === '' ? (
            <div className="text-secondary small">{isRunActive(run.status) ? 'En cours…' : 'Aucune réponse.'}</div>
          ) : json ? (
            <pre className="auto-pre">{prettyJson(run.outputJson)}</pre>
          ) : (
            <div className="auto-pre" style={{ whiteSpace: 'normal' }}>
              <Markdown text={run.output} />
            </div>
          )}
        </Col>
      </Row>
    </div>
  );
}
