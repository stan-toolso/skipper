import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import AgentEditor from '../components/automation/AgentEditor';
import AgentRunDetail from '../components/automation/AgentRunDetail';
import AutomationScheduleModal from '../components/automation/AutomationScheduleModal';
import InputsForm, { inputsFromRecord, inputsPayload } from '../components/automation/InputsForm';
import { RunStatusBadge, RunTriggerBadge } from '../components/automation/RunBadges';
import RunAgentModal from '../components/automation/RunAgentModal';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import { AGENT, AGENT_PROMPT_PREVIEW, AGENT_RUNS, CLEAR_AGENT_SCHEDULE, DELETE_AGENT, LLM_PROVIDER, SET_AGENT_SCHEDULE, type Agent, type AgentPromptPreview, type AgentRun, type AgentRunSummary, type LlmAgentConfig } from '../graphql/automation';
import { PROVIDERS, type Provider } from '../graphql/operations';
import { fmtDateTime, isRunActive, providerLabel, runDurationMs } from '../lib/automation';
import { formatCost, formatDuration } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import '../components/automation/automation.css';

type AgentWithRuns = Agent & { runs: AgentRunSummary[]; workflows: { id: string; name: string }[] };

/** Aperçu de l'instruction rendue avec des valeurs d'essai. */
function PromptPreview({ agent }: { agent: Agent }) {
  const [values, setValues] = useState<Record<string, string>>(() => inputsFromRecord(agent.scheduleInputs));
  const { data, error } = useQuery<{ agentPromptPreview: AgentPromptPreview }>(AGENT_PROMPT_PREVIEW, { variables: { id: agent.id, inputs: inputsPayload(values) }, fetchPolicy: 'cache-and-network' });
  return (
    <Row className="g-3">
      <Col lg={4}>
        <InputsForm variables={agent.inputs} values={values} onChange={setValues} idPrefix="preview" />
      </Col>
      <Col lg={8}>
        {error ? <Alert variant="warning" className="py-2">{error.message}</Alert> : <pre className="auto-pre">{data?.agentPromptPreview.prompt ?? '…'}</pre>}
      </Col>
    </Row>
  );
}

/** Réglages lisibles d'un agent (modèle ou type de session, prompts, variables). */
function ConfigSummary({ agent, providers }: { agent: Agent; providers: Provider[] }) {
  const llm = agent.provider === LLM_PROVIDER ? (agent.config as Partial<LlmAgentConfig>) : null;
  const provider = providers.find((p) => p.type === agent.provider);
  return (
    <Row className="g-3">
      <Col lg={5}>
        <dl className="row small mb-0">
          <dt className="col-4">Exécution</dt>
          <dd className="col-8">{providerLabel(agent.provider, providers)}</dd>
          {llm ? (
            <>
              <dt className="col-4">Modèle</dt>
              <dd className="col-8">
                <code>{llm.model}</code> via {llm.backend}
                {llm.temperature != null && ` · température ${llm.temperature}`}
                {llm.maxTokens != null && ` · ${llm.maxTokens} tokens max`}
                {llm.langfuseItemId && ' · tracé dans Langfuse'}
              </dd>
            </>
          ) : (
            Object.entries(agent.config).map(([k, v]) => (
              <span key={k} className="d-contents">
                <dt className="col-4 text-truncate">{provider?.configFields.find((f) => f.key === k)?.label ?? k}</dt>
                <dd className="col-8">
                  <code>{String(v)}</code>
                </dd>
              </span>
            ))
          )}
          <dt className="col-4">Sortie</dt>
          <dd className="col-8">{agent.outputFormat === 'JSON' ? 'JSON' : 'texte'}</dd>
          {agent.provider !== LLM_PROVIDER && (
            <>
              <dt className="col-4">Worktree</dt>
              <dd className="col-8">{agent.worktree ? agent.worktree.branch : 'dossier principal'}</dd>
            </>
          )}
          <dt className="col-4">Délai</dt>
          <dd className="col-8">{agent.timeoutMinutes} min</dd>
          <dt className="col-4">Variables</dt>
          <dd className="col-8">
            {agent.inputs.length === 0
              ? 'aucune'
              : agent.inputs.map((v) => (
                  <span key={v.key} className="me-2">
                    <code>{v.key}</code>
                    {v.required && v.defaultValue === null && ' *'}
                  </span>
                ))}
          </dd>
        </dl>
      </Col>
      <Col lg={7}>
        {agent.systemPrompt && (
          <>
            <div className="small fw-semibold mb-1">Prompt système</div>
            <pre className="auto-pre mb-3">{agent.systemPrompt}</pre>
          </>
        )}
        <div className="small fw-semibold mb-1">Instruction</div>
        <pre className="auto-pre">{agent.promptTemplate || '—'}</pre>
        {agent.outputSchema && (
          <>
            <div className="small fw-semibold mb-1 mt-3">Forme JSON attendue</div>
            <pre className="auto-pre">{agent.outputSchema}</pre>
          </>
        )}
      </Col>
    </Row>
  );
}

/** Page d'un agent : configuration, aperçu, exécutions (avec `?run=` pour en ouvrir une), planification. */
export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { confirm, showError } = useDialogs();
  const [searchParams, setSearchParams] = useSearchParams();
  const openRunId = searchParams.get('run');
  const { data, loading, error } = usePollingQuery<{ agent: AgentWithRuns | null }>(AGENT, { variables: { id }, pollInterval: 10_000 });
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const agent = data?.agent;
  useTabTitle(agent ? agent.name : null);
  const runsActive = (agent?.runs ?? []).some((r) => isRunActive(r.status));
  const { data: runsData } = usePollingQuery<{ agentRuns: AgentRun[] }>(AGENT_RUNS, { variables: { agentId: id, limit: 50 }, pollInterval: runsActive ? 3000 : 15_000 });
  const runs = runsData?.agentRuns ?? [];
  const openRun = runs.find((r) => r.id === openRunId) ?? null;

  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [section, setSection] = useState<'config' | 'preview'>('config');
  const [setSchedule, { loading: savingSchedule, error: scheduleError }] = useMutation(SET_AGENT_SCHEDULE);
  const [clearSchedule, { loading: clearingSchedule }] = useMutation(CLEAR_AGENT_SCHEDULE);
  const [remove] = useMutation(DELETE_AGENT, { refetchQueries: ['Agents'] });

  // Sans exécution demandée, la plus récente s'ouvre.
  useEffect(() => {
    if (!openRunId && runs.length) setSearchParams({ run: runs[0].id }, { replace: true });
  }, [openRunId, runs, setSearchParams]);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!agent) return <Alert variant="warning">Agent introuvable.</Alert>;
  const providers = providersData?.providers ?? [];

  const onDelete = async () => {
    if (!(await confirm({ title: "Supprimer l'agent", message: `Supprimer « ${agent.name} » et l'historique de ses exécutions ? Les workflows qui l'utilisent devront être corrigés.`, confirmLabel: 'Supprimer', danger: true }))) return;
    try {
      await remove({ variables: { id: agent.id } });
      navigate(`/projects/${agent.project.id}/agents`);
    } catch (err) {
      void showError(err);
    }
  };

  return (
    <>
      <Link to={`/projects/${agent.project.id}/agents`} className="small">
        ← Agents de {agent.project.name}
      </Link>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <h1 className="h3 mb-0">
          <i className="bi bi-robot me-2 text-secondary" />
          {agent.name}
          <Badge bg="secondary" className="ms-2 fw-normal fs-6 align-middle">
            {providerLabel(agent.provider, providers)}
          </Badge>
        </h1>
        <div className="d-flex gap-2 flex-wrap">
          <Button size="sm" onClick={() => setRunning(true)}>
            <i className="bi bi-play-fill me-1" /> Exécuter
          </Button>
          <Button size="sm" variant={agent.schedule?.enabled ? 'outline-success' : 'outline-primary'} onClick={() => setScheduling(true)}>
            <i className="bi bi-alarm me-1" /> {agent.schedule ? (agent.schedule.enabled ? 'Planifié' : 'Planification en pause') : 'Planifier'}
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={() => setEditing(true)}>
            <i className="bi bi-pencil me-1" /> Modifier
          </Button>
          <Button size="sm" variant="outline-danger" onClick={() => void onDelete()}>
            <i className="bi bi-trash" />
          </Button>
        </div>
      </div>
      {agent.description && <p className="text-secondary">{agent.description}</p>}
      <div className="small text-secondary mb-3 d-flex flex-wrap gap-3">
        {agent.schedule && (
          <span>
            <i className="bi bi-alarm me-1" />
            cron <code>{agent.schedule.cron}</code> ({agent.schedule.timezone})
            {agent.schedule.enabled && agent.schedule.nextRunAt && ` · prochaine le ${fmtDateTime(agent.schedule.nextRunAt)}`}
            {agent.schedule.lastResult && ` · dernière : ${agent.schedule.lastResult}`}
          </span>
        )}
        {agent.workflows.length > 0 && (
          <span>
            <i className="bi bi-diagram-3 me-1" />
            Utilisé par{' '}
            {agent.workflows.map((w, i) => (
              <span key={w.id}>
                {i > 0 && ', '}
                <Link to={`/workflows/${w.id}`}>{w.name}</Link>
              </span>
            ))}
          </span>
        )}
        {agent.createdBy && <span>Créé par {agent.createdBy.name}</span>}
      </div>

      <Card className="mb-3">
        <Card.Header className="d-flex gap-3">
          <Form.Check type="radio" inline id="agent-section-config" name="agent-section" label="Configuration" checked={section === 'config'} onChange={() => setSection('config')} />
          <Form.Check type="radio" inline id="agent-section-preview" name="agent-section" label="Aperçu de l'instruction" checked={section === 'preview'} onChange={() => setSection('preview')} />
        </Card.Header>
        <Card.Body>{section === 'config' ? <ConfigSummary agent={agent} providers={providers} /> : <PromptPreview agent={agent} />}</Card.Body>
      </Card>

      <Card>
        <Card.Header>Exécutions</Card.Header>
        <Card.Body>
          {runs.length === 0 ? (
            <div className="text-secondary small">Aucune exécution pour l'instant.</div>
          ) : (
            <Row className="g-3">
              <Col lg={4}>
                <Table size="sm" hover className="auto-runs mb-0">
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} role="button" className={r.id === openRunId ? 'active' : ''} onClick={() => setSearchParams({ run: r.id })}>
                        <td>
                          <RunStatusBadge status={r.status} />
                        </td>
                        <td className="small">
                          {fmtDateTime(r.createdAt)}
                          <div className="text-secondary">
                            <RunTriggerBadge trigger={r.trigger} />
                            {runDurationMs(r) !== null && ` ${formatDuration(runDurationMs(r)!)}`}
                            {r.costUsd > 0 && ` · ${formatCost(r.costUsd)}`}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Col>
              <Col lg={8}>{openRun ? <AgentRunDetail run={openRun} /> : <div className="text-secondary small">Choisissez une exécution.</div>}</Col>
            </Row>
          )}
        </Card.Body>
      </Card>

      {editing && <AgentEditor agent={agent} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {running && (
        <RunAgentModal
          agent={agent}
          onClose={() => setRunning(false)}
          onStarted={(run) => {
            setRunning(false);
            setSearchParams({ run: run.id });
          }}
        />
      )}
      {scheduling && (
        <AutomationScheduleModal
          title={agent.name}
          schedule={agent.schedule}
          scheduleInputs={agent.scheduleInputs}
          variables={agent.inputs}
          saving={savingSchedule || clearingSchedule}
          error={scheduleError}
          onSave={(input, inputs) => void setSchedule({ variables: { id: agent.id, input, inputs } }).then(() => setScheduling(false)).catch(() => undefined)}
          onClear={() => void clearSchedule({ variables: { id: agent.id } }).then(() => setScheduling(false)).catch(showError)}
          onClose={() => setScheduling(false)}
        />
      )}
    </>
  );
}
