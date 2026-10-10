import { useLazyQuery, useMutation, useQuery } from '@apollo/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Form, Modal, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AutomationScheduleModal from '../components/automation/AutomationScheduleModal';
import { RunStatusBadge, RunTriggerBadge } from '../components/automation/RunBadges';
import NodeInspector from '../components/automation/workflow/NodeInspector';
import RunWorkflowModal from '../components/automation/workflow/RunWorkflowModal';
import WorkflowCanvas, { dragNodeType } from '../components/automation/workflow/WorkflowCanvas';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import { AGENTS, CLEAR_WORKFLOW_SCHEDULE, DELETE_WORKFLOW, SET_WORKFLOW_SCHEDULE, UPDATE_WORKFLOW, VALIDATE_WORKFLOW, WORKFLOW, type Agent, type InputVariable, type Workflow, type WorkflowDefinition, type WorkflowIssue, type WorkflowNodeType, type WorkflowRunSummary } from '../graphql/automation';
import { PROJECT_WORKTREES, PROVIDERS, type Provider, type Worktree } from '../graphql/operations';
import { fmtDateTime, nodeTypeInfo, runDurationMs } from '../lib/automation';
import { formatCost, formatDuration } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { autoLayout, newNode, PALETTE } from '../lib/workflowGraph';
import { useTabTitle } from '../workbench/TabsContext';
import '../components/automation/automation.css';

type WorkflowDetail = Workflow & { variables: InputVariable[]; runs: WorkflowRunSummary[] };

function RenameModal({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [update, { loading, error }] = useMutation(UPDATE_WORKFLOW, { onCompleted: onClose });
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void update({ variables: { id: workflow.id, input: { name: name.trim(), description: description.trim() } } }).catch(() => undefined);
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Renommer le workflow</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Nom</Form.Label>
            <Form.Control value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Form.Group>
          <Form.Group>
            <Form.Label>Description</Form.Label>
            <Form.Control as="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Form.Group>
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !name.trim()}>
            Enregistrer
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Liste des problèmes du graphe ; un clic sélectionne le nœud concerné. */
function IssuesPanel({ issues, onPick }: { issues: WorkflowIssue[]; onPick: (key: string | null) => void }) {
  if (!issues.length)
    return (
      <div className="small text-success">
        <i className="bi bi-check-circle me-1" /> Aucun problème dans le graphe.
      </div>
    );
  return (
    <div className="wf-issues">
      {issues.map((i, idx) => (
        <div key={idx} className="wf-issue" onClick={() => onPick(i.nodeKey)}>
          <i className={`bi ${i.severity === 'error' ? 'bi-exclamation-circle-fill text-danger' : 'bi-exclamation-triangle-fill text-warning'}`} />
          <span>
            {i.nodeKey && <code className="me-1">{i.nodeKey}</code>}
            {i.message}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Éditeur d'un workflow : palette, canevas, inspecteur du nœud sélectionné, validation, exécutions. */
export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { confirm, showError } = useDialogs();
  const { data, loading, error } = usePollingQuery<{ workflow: WorkflowDetail | null }>(WORKFLOW, { variables: { id }, pollInterval: 10_000 });
  const workflow = data?.workflow;
  useTabTitle(workflow ? workflow.name : null);
  const { data: agentsData } = useQuery<{ agents: Agent[] }>(AGENTS, { variables: { projectId: workflow?.project.id }, skip: !workflow });
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const { data: worktreesData } = useQuery<{ project: { worktrees: Worktree[] } | null }>(PROJECT_WORKTREES, { variables: { id: workflow?.project.id }, skip: !workflow });
  const agents = agentsData?.agents ?? [];
  const providers = providersData?.providers ?? [];
  const worktrees = (worktreesData?.project?.worktrees ?? []).filter((w) => !w.archivedAt);

  // Définition locale : repart de la version serveur tant qu'aucune modification n'est en attente.
  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [dirty, setDirty] = useState(false);
  const serverJson = workflow ? JSON.stringify(workflow.definition) : null;
  const lastServer = useRef<string | null>(null);
  useEffect(() => {
    if (!workflow || serverJson === null) return;
    if (!dirty || lastServer.current === null) {
      if (serverJson !== lastServer.current) setDef(workflow.definition);
      lastServer.current = serverJson;
    }
  }, [workflow, serverJson, dirty]);
  const change = useCallback((next: WorkflowDefinition) => {
    setDef(next);
    setDirty(true);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Validation côté serveur des modifications en attente (sinon : problèmes du graphe enregistré).
  const [validate, validation] = useLazyQuery<{ validateWorkflow: WorkflowIssue[] }>(VALIDATE_WORKFLOW, { fetchPolicy: 'network-only' });
  useEffect(() => {
    if (!dirty || !def || !workflow) return;
    const handle = setTimeout(() => void validate({ variables: { projectId: workflow.project.id, definition: def } }), 500);
    return () => clearTimeout(handle);
  }, [dirty, def, workflow, validate]);
  const issues: WorkflowIssue[] = dirty ? (validation.data?.validateWorkflow ?? []) : (workflow?.issues ?? []);
  const errors = issues.filter((i) => i.severity === 'error').length;

  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [save, { loading: saving }] = useMutation<{ updateWorkflow: Workflow }>(UPDATE_WORKFLOW);
  const [update] = useMutation(UPDATE_WORKFLOW);
  const [setSchedule, { loading: savingSchedule, error: scheduleError }] = useMutation(SET_WORKFLOW_SCHEDULE);
  const [clearSchedule, { loading: clearingSchedule }] = useMutation(CLEAR_WORKFLOW_SCHEDULE);
  const [remove] = useMutation(DELETE_WORKFLOW, { refetchQueries: ['Workflows'] });

  const selectedNode = useMemo(() => def?.nodes.find((n) => n.key === selected) ?? null, [def, selected]);
  const canvasAgents = useMemo(() => agents.map((a) => ({ id: a.id, name: a.name })), [agents]);

  const onSave = async () => {
    if (!workflow || !def) return;
    try {
      const res = await save({ variables: { id: workflow.id, input: { definition: def } } });
      if (res.data) {
        lastServer.current = JSON.stringify(res.data.updateWorkflow.definition);
        setDef(res.data.updateWorkflow.definition);
        setDirty(false);
      }
    } catch (err) {
      void showError(err);
    }
  };
  const addNode = (type: WorkflowNodeType) => {
    if (!def) return;
    const right = Math.max(0, ...def.nodes.map((n) => n.position.x));
    const node = newNode(def, type, { x: right + 280, y: 120 + (def.nodes.length % 3) * 90 });
    change({ ...def, nodes: [...def.nodes, node] });
    setSelected(node.key);
  };
  const onDelete = async () => {
    if (!workflow) return;
    if (!(await confirm({ title: 'Supprimer le workflow', message: `Supprimer « ${workflow.name} » et l'historique de ses exécutions ?`, confirmLabel: 'Supprimer', danger: true }))) return;
    try {
      await remove({ variables: { id: workflow.id } });
      navigate(`/projects/${workflow.project.id}/workflows`);
    } catch (err) {
      void showError(err);
    }
  };

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!workflow || !def) return <Alert variant="warning">Workflow introuvable.</Alert>;

  return (
    <>
      <Link to={`/projects/${workflow.project.id}/workflows`} className="small">
        ← Workflows de {workflow.project.name}
      </Link>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <h1 className="h3 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-diagram-3 text-secondary" />
          {workflow.name}
          <button type="button" className="auto-icon-btn" title="Renommer" onClick={() => setRenaming(true)}>
            <i className="bi bi-pencil small" />
          </button>
          {dirty && (
            <Badge bg="warning" text="dark" className="fw-normal fs-6">
              modifications non enregistrées
            </Badge>
          )}
        </h1>
        <div className="d-flex gap-2 flex-wrap align-items-center">
          <Form.Check type="switch" id="wf-enabled" className="me-2" label={workflow.enabled ? 'Actif' : 'En pause'} title="En pause : planification et déclencheurs ignorés ; les lancements manuels restent possibles" checked={workflow.enabled} onChange={(e) => void update({ variables: { id: workflow.id, input: { enabled: e.target.checked } } }).catch(showError)} />
          <Button size="sm" variant="outline-secondary" onClick={() => change(autoLayout(def))} title="Réorganiser les nœuds automatiquement">
            <i className="bi bi-grid-3x2-gap" />
          </Button>
          <Button size="sm" variant={dirty ? 'primary' : 'outline-secondary'} disabled={!dirty || saving} onClick={() => void onSave()}>
            <i className="bi bi-save me-1" /> {saving ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
          <Button size="sm" variant="success" disabled={dirty || errors > 0} title={dirty ? "Enregistrez d'abord" : errors ? 'Corrigez les erreurs du graphe' : ''} onClick={() => setRunning(true)}>
            <i className="bi bi-play-fill me-1" /> Exécuter
          </Button>
          <Button size="sm" variant={workflow.schedule?.enabled ? 'outline-success' : 'outline-primary'} onClick={() => setScheduling(true)}>
            <i className="bi bi-alarm me-1" /> {workflow.schedule ? (workflow.schedule.enabled ? 'Planifié' : 'Planification en pause') : 'Planifier'}
          </Button>
          <Button size="sm" variant="outline-danger" onClick={() => void onDelete()}>
            <i className="bi bi-trash" />
          </Button>
        </div>
      </div>
      {workflow.description && <p className="text-secondary small mb-2">{workflow.description}</p>}
      <div className="small text-secondary mb-2 d-flex flex-wrap gap-3">
        {workflow.schedule && (
          <span>
            <i className="bi bi-alarm me-1" />
            cron <code>{workflow.schedule.cron}</code> ({workflow.schedule.timezone})
            {workflow.schedule.enabled && workflow.enabled && workflow.schedule.nextRunAt && ` · prochaine le ${fmtDateTime(workflow.schedule.nextRunAt)}`}
          </span>
        )}
        {workflow.eventOwner && <span>Déclencheurs d'événement au nom de {workflow.eventOwner.name}</span>}
      </div>

      <div className="wf-editor mb-3">
        <div className="wf-palette">
          <div className="small text-secondary px-1">Glissez ou cliquez pour ajouter</div>
          {PALETTE.map((t) => (
            <button key={t} type="button" className="wf-palette-item" draggable onDragStart={(e) => dragNodeType(e, t)} onClick={() => addNode(t)} title={nodeTypeInfo[t].hint}>
              <i className={`bi ${nodeTypeInfo[t].icon}`} />
              <span>{nodeTypeInfo[t].label}</span>
            </button>
          ))}
          <div className="small text-secondary px-1 mt-2">Reliez la sortie d'un nœud à l'entrée du suivant. Suppr retire la sélection.</div>
        </div>
        <WorkflowCanvas definition={def} selectedKey={selected} onSelect={setSelected} onChange={change} issues={issues} agents={canvasAgents} />
        <div className="wf-inspector">
          {selectedNode ? (
            <NodeInspector
              node={selectedNode}
              definition={def}
              onChange={(node) => change({ ...def, nodes: def.nodes.map((n) => (n.key === node.key ? node : n)) })}
              onDelete={() => {
                change({ ...def, nodes: def.nodes.filter((n) => n.key !== selectedNode.key), edges: def.edges.filter((e) => e.source !== selectedNode.key && e.target !== selectedNode.key) });
                setSelected(null);
              }}
              agents={agents}
              providers={providers}
              worktrees={worktrees}
              issues={issues.filter((i) => i.nodeKey === selectedNode.key)}
            />
          ) : (
            <>
              <div className="fw-semibold mb-2">
                Problèmes du graphe
                {errors > 0 && (
                  <Badge bg="danger" className="ms-2">
                    {errors}
                  </Badge>
                )}
                {issues.length - errors > 0 && (
                  <Badge bg="warning" text="dark" className="ms-2">
                    {issues.length - errors}
                  </Badge>
                )}
              </div>
              <IssuesPanel issues={issues} onPick={setSelected} />
              <div className="text-secondary small mt-3">Sélectionnez un nœud pour le régler. Les modèles {'{{input.x}}'} et {'{{nodes.clé.output}}'} sont remplis à l'exécution.</div>
            </>
          )}
        </div>
      </div>

      <Card>
        <Card.Header>Exécutions</Card.Header>
        <Card.Body>
          {workflow.runs.length === 0 ? (
            <div className="text-secondary small">Aucune exécution pour l'instant.</div>
          ) : (
            <Table size="sm" hover className="mb-0">
              <thead>
                <tr>
                  <th>Statut</th>
                  <th>Lancée</th>
                  <th>Par</th>
                  <th>Durée</th>
                  <th>Coût</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {workflow.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <RunStatusBadge status={r.status} />
                    </td>
                    <td className="small">
                      <Link to={`/workflows/${workflow.id}/runs/${r.id}`}>{fmtDateTime(r.createdAt)}</Link>
                    </td>
                    <td>
                      <RunTriggerBadge trigger={r.trigger} />
                    </td>
                    <td className="small">{runDurationMs({ startedAt: r.createdAt, finishedAt: r.finishedAt }) !== null && r.finishedAt ? formatDuration(new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()) : '—'}</td>
                    <td className="small">{r.costUsd > 0 ? formatCost(r.costUsd) : '—'}</td>
                    <td className="small text-danger text-truncate" style={{ maxWidth: 360 }}>
                      {r.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      {renaming && <RenameModal workflow={workflow} onClose={() => setRenaming(false)} />}
      {running && <RunWorkflowModal workflow={workflow} onClose={() => setRunning(false)} onStarted={(run) => navigate(`/workflows/${workflow.id}/runs/${run.id}`)} />}
      {scheduling && (
        <AutomationScheduleModal
          title={workflow.name}
          schedule={workflow.schedule}
          scheduleInputs={workflow.scheduleInputs}
          variables={workflow.variables}
          saving={savingSchedule || clearingSchedule}
          error={scheduleError}
          onSave={(input, inputs) => void setSchedule({ variables: { id: workflow.id, input, inputs } }).then(() => setScheduling(false)).catch(() => undefined)}
          onClear={() => void clearSchedule({ variables: { id: workflow.id } }).then(() => setScheduling(false)).catch(showError)}
          onClose={() => setScheduling(false)}
        />
      )}
    </>
  );
}
