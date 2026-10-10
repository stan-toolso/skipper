import { useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { RunStatusBadge, RunTriggerBadge } from '../components/automation/RunBadges';
import RunLogs from '../components/automation/workflow/RunLogs';
import WorkflowCanvas from '../components/automation/workflow/WorkflowCanvas';
import PageLoading from '../components/PageLoading';
import { CANCEL_WORKFLOW_RUN, WORKFLOW_RUN, type WorkflowRunDetail, type WorkflowRunNode } from '../graphql/automation';
import { fmtDateTime, isRunActive, nodeStatusLabels, nodeTypeInfo, prettyJson, runDurationMs } from '../lib/automation';
import { formatCost, formatDuration } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import '../components/automation/automation.css';

function NodeDetail({ node, label }: { node: WorkflowRunNode; label: string }) {
  const duration = node.startedAt ? (node.finishedAt ? new Date(node.finishedAt).getTime() : Date.now()) - new Date(node.startedAt).getTime() : null;
  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <i className={`bi ${nodeTypeInfo[node.nodeType as keyof typeof nodeTypeInfo]?.icon ?? 'bi-circle'} text-secondary`} />
        <span className="fw-semibold">{label}</span>
        <code className="small text-secondary">{node.nodeKey}</code>
        <span className={`small ${node.status === 'failed' ? 'text-danger' : node.status === 'succeeded' ? 'text-success' : 'text-secondary'}`}>
          {nodeStatusLabels[node.status] ?? node.status}
          {duration !== null && ` · ${formatDuration(duration)}`}
        </span>
        {node.agentRun?.session && (
          <Link to={`/sessions/${node.agentRun.session.id}`} className="small">
            <i className="bi bi-chat-dots me-1" />
            {node.agentRun.session.name}
          </Link>
        )}
      </div>
      {node.error && (
        <Alert variant="danger" className="py-2">
          {node.error}
        </Alert>
      )}
      {node.input !== null && node.input !== undefined && (
        <>
          <div className="small fw-semibold mb-1">Entrée</div>
          <pre className="auto-pre mb-2">{prettyJson(node.input)}</pre>
        </>
      )}
      {node.output !== null && node.output !== undefined && (
        <>
          <div className="small fw-semibold mb-1">Sortie</div>
          <pre className="auto-pre">{prettyJson(node.output)}</pre>
        </>
      )}
    </div>
  );
}

/** Une exécution de workflow : le graphe coloré par l'état des nœuds, le détail d'un nœud, le journal, la sortie. */
export default function WorkflowRunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const [selected, setSelected] = useState<string | null>(null);
  const [logNode, setLogNode] = useState<string | null>(null);
  const { data, loading, error, startPolling, stopPolling } = usePollingQuery<{ workflowRun: WorkflowRunDetail | null }>(WORKFLOW_RUN, { variables: { id: runId }, pollInterval: 3000 });
  const run = data?.workflowRun;
  useTabTitle(run ? `Exécution · ${run.workflow.name}` : null);
  const active = run ? isRunActive(run.status) : true;
  // Exécution terminée : plus besoin de sonder.
  useEffect(() => {
    if (!run) return;
    if (active) startPolling(3000);
    else stopPolling();
  }, [run, active, startPolling, stopPolling]);
  const [cancel, { loading: cancelling }] = useMutation(CANCEL_WORKFLOW_RUN);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!run) return <Alert variant="warning">Exécution introuvable.</Alert>;
  const statuses: Record<string, string> = {};
  for (const n of run.nodes) statuses[n.nodeKey] = n.status;
  const selectedNode = run.nodes.find((n) => n.nodeKey === selected);
  const selectedDef = run.definition.nodes.find((n) => n.key === selected);
  const duration = runDurationMs(run);

  return (
    <>
      <Link to={`/workflows/${id}`} className="small">
        ← {run.workflow.name}
      </Link>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <h1 className="h4 mb-0 d-flex align-items-center gap-2 flex-wrap">
          Exécution du {fmtDateTime(run.createdAt)}
          <RunStatusBadge status={run.status} />
          <RunTriggerBadge trigger={run.trigger} />
        </h1>
        {active && (
          <Button size="sm" variant="outline-danger" disabled={cancelling || run.cancelRequested} onClick={() => void cancel({ variables: { id: run.id } })}>
            <i className="bi bi-stop-circle me-1" /> {run.cancelRequested ? 'Annulation demandée…' : 'Annuler'}
          </Button>
        )}
      </div>
      <div className="small text-secondary mb-2 d-flex gap-3 flex-wrap">
        {run.owner && <span>par {run.owner.name}</span>}
        {duration !== null && <span>{formatDuration(duration)}</span>}
        {run.costUsd > 0 && <span>{formatCost(run.costUsd)}</span>}
        {run.triggerKey && <span>départ : {run.definition.nodes.find((n) => n.key === run.triggerKey)?.label ?? run.triggerKey}</span>}
        <span>
          {run.nodes.filter((n) => n.status === 'succeeded').length} / {run.definition.nodes.length} nœuds réussis
        </span>
      </div>
      {run.error && (
        <Alert variant="danger" className="py-2">
          {run.error}
        </Alert>
      )}
      <div className="wf-editor readonly mb-3" style={{ height: 420, minHeight: 320 }}>
        <WorkflowCanvas definition={run.definition} readonly selectedKey={selected} onSelect={setSelected} statuses={statuses} />
        <div className="wf-inspector">
          {selectedNode && selectedDef ? (
            <NodeDetail node={selectedNode} label={selectedDef.label} />
          ) : (
            <>
              <div className="fw-semibold mb-2">Entrées de l'exécution</div>
              <pre className="auto-pre mb-3">{prettyJson(run.inputs) || '—'}</pre>
              <div className="fw-semibold mb-2">Sortie</div>
              {run.output === null || run.output === undefined ? <div className="text-secondary small">{active ? 'En cours…' : 'Aucune sortie (pas de nœud de fin atteint).'}</div> : <pre className="auto-pre">{prettyJson(run.output)}</pre>}
              <div className="text-secondary small mt-3">Cliquez un nœud pour voir son entrée, sa sortie et sa session.</div>
            </>
          )}
        </div>
      </div>
      <Row className="g-3">
        <Col lg={12}>
          <Card>
            <Card.Header>Journal</Card.Header>
            <Card.Body>
              <RunLogs logs={run.logs} nodeKey={logNode} onPickNode={setLogNode} />
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </>
  );
}
