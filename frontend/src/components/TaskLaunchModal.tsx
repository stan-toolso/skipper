import { useMutation, useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Collapse, Form, Modal } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { PROVIDERS, RESUME_TASK_SESSION, START_TASK_SESSION, type ConfigField, type Provider, type SessionStatus, type Task, type TaskModels, type TaskPriority, type TaskRef } from '../graphql/operations';
import { TASK_LAUNCH_INFO, TASK_PROMPT } from '../graphql/tasks';
import { PROJECT_AGENT_REFS, agentKindLabels, type AgentRef } from '../graphql/agents';
import AgentAvatar from './AgentAvatar';
import { bypassConnectionsWarning, taskStatusLabels } from '../lib/humanize';
import { agentConfigFields, agentConfigValues, agentProvider } from '../lib/agentSessions';
import { projectModelForTask } from '../lib/models';
import { buildConfig, FieldGroup } from './SessionLauncher';

export interface LaunchTarget {
  id: string;
  myRole?: 'ADMIN' | 'MEMBER' | 'VIEWER';
  gitUrl: string | null;
  defaultPermissionMode: string;
  approvalConnections?: string[];
}

interface TaskLauncherState {
  launchTask: (task: Task, target: LaunchTarget | undefined) => void;
}

const TaskLauncherContext = createContext<TaskLauncherState | null>(null);

export function useTaskLauncher(): TaskLauncherState {
  const ctx = useContext(TaskLauncherContext);
  if (!ctx) throw new Error('useTaskLauncher doit être utilisé dans un TaskLauncherProvider');
  return ctx;
}

/**
 * Hôte de la modale « Confier à un agent », au niveau du workbench et non dans la carte ou la ligne de la tâche :
 * le serveur passe la tâche en cours dès le début du lancement, si bien qu'au sondage suivant la carte change de
 * colonne (kanban) ou sort du filtre (liste). Rendue dans la carte, la modale disparaissait alors en plein
 * « Lancement… », sans plus pouvoir afficher d'erreur.
 */
export function TaskLauncherProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ task: Task; target: LaunchTarget | undefined; key: number } | null>(null);
  const launchTask = useCallback((task: Task, target: LaunchTarget | undefined) => setState((s) => ({ task, target, key: (s?.key ?? 0) + 1 })), []);
  const value = useMemo(() => ({ launchTask }), [launchTask]);
  return (
    <TaskLauncherContext.Provider value={value}>
      {children}
      {state && <TaskLaunchModal key={state.key} task={state.task} target={state.target} onClose={() => setState(null)} />}
    </TaskLauncherContext.Provider>
  );
}

interface ResumableSession {
  id: string;
  name: string;
  status: SessionStatus;
  archivedAt: string | null;
}

interface LaunchInfo {
  task: {
    id: string;
    branch: string | null;
    priority: TaskPriority;
    project: { id: string; defaultModel: string | null; taskModels: TaskModels | null; defaultPermissionMode: string };
    session: { id: string; name: string; archivedAt: string | null } | null;
    resumableSession: ResumableSession | null;
    worksession: { id: string; name: string; branch: string; label: string; archivedAt: string | null } | null;
    blockedBy: TaskRef[];
    autoStartWhenUnblocked: boolean;
  } | null;
}

/**
 * Tâche en attente d'autres tâches (dépendances pas terminées) : le serveur refuse de la confier à un agent. On le dit
 * d'emblée, sans ton d'erreur, avec un lien vers chaque tâche qui la bloque et vers la tâche elle-même (pour retirer
 * la dépendance), au lieu de laisser cliquer puis d'afficher le refus en rouge.
 */
function BlockedNotice({ taskId, blockers, autoStart, onNavigate }: { taskId: string; blockers: TaskRef[]; autoStart: boolean; onNavigate: () => void }) {
  const many = blockers.length > 1;
  return (
    <div className="task-launch-blocked">
      <div className="fw-semibold mb-1">
        <i className="bi bi-hourglass-split me-1" />
        {many ? 'En attente d’autres tâches' : 'En attente d’une autre tâche'}
      </div>
      <p className="mb-2">
        Cette tâche dépend de {many ? 'tâches qui ne sont pas encore terminées' : 'une tâche qui n’est pas encore terminée'}. Elle pourra être reprise dès{' '}
        {many ? 'qu’elles le seront' : 'qu’elle le sera'}
        {autoStart ? ' : elle repartira alors toute seule.' : '.'}
      </p>
      <ul className="list-unstyled mb-2">
        {blockers.map((b) => (
          <li key={b.id} className="d-flex align-items-baseline gap-2">
            <i className="bi bi-arrow-return-right text-secondary" />
            <Link to={`/tasks/${b.id}`} onClick={onNavigate}>
              {b.title}
            </Link>
            <span className="task-launch-blocked-status">{taskStatusLabels[b.status] ?? b.status}</span>
          </li>
        ))}
      </ul>
      <div className="small text-secondary">
        Si {many ? 'ces dépendances n’ont' : 'cette dépendance n’a'} plus lieu d’être,{' '}
        <Link to={`/tasks/${taskId}`} onClick={onNavigate}>
          retirez-la depuis la tâche
        </Link>
        .
      </div>
    </div>
  );
}

/** Message proposé pour reprendre la conversation, modifiable. */
export const RESUME_MESSAGE = "Reprends la tâche là où tu t'étais arrêté : relis-la (description et fil) pour voir s'il y a du nouveau, puis continue.";

/**
 * « Confier à un agent » : si la tâche a déjà une session dans son dossier, on reprend sa conversation (un message,
 * modifiable, envoyé à cette session) ; sinon, ou sur demande, on lance une nouvelle session.
 */
export default function TaskLaunchModal({ task, target, onClose }: { task: Task; target: LaunchTarget | undefined; onClose: () => void }) {
  const { data } = useQuery<LaunchInfo>(TASK_LAUNCH_INFO, { variables: { id: task.id }, fetchPolicy: 'cache-and-network' });
  const [fresh, setFresh] = useState(false);
  const resumable = data?.task?.resumableSession ?? null;
  if (!data)
    return (
      <Modal show onHide={onClose} size="lg" centered>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Confier à un agent · {task.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="small text-secondary">Chargement…</Modal.Body>
      </Modal>
    );
  const blockers = data.task?.blockedBy ?? [];
  const blocked = blockers.length > 0 ? <BlockedNotice taskId={task.id} blockers={blockers} autoStart={Boolean(data.task?.autoStartWhenUnblocked)} onNavigate={onClose} /> : null;
  if (resumable && !fresh) return <TaskResumeModal task={task} session={resumable} blocked={blocked} onFresh={() => setFresh(true)} onClose={onClose} />;
  return <TaskNewSessionModal task={task} target={target} info={data} blocked={blocked} onClose={onClose} />;
}

/**
 * Reprise de la conversation de la session de la tâche : le message lui est envoyé comme depuis sa page (transmis à
 * l'agent s'il tourne, sinon la session repart avec, historique compris) ; la session est restaurée si elle était
 * archivée et la tâche repasse en cours. On reste sur la page.
 */
function TaskResumeModal({ task, session, blocked, onFresh, onClose }: { task: Task; session: ResumableSession; blocked: ReactNode; onFresh: () => void; onClose: () => void }) {
  const [text, setText] = useState(RESUME_MESSAGE);
  const [resume, { loading, error }] = useMutation<{ resumeTaskSession: { id: string } }>(RESUME_TASK_SESSION, {
    refetchQueries: ['Tasks', 'TaskPage', 'TaskDetail', 'Sidebar'],
    onCompleted: onClose,
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim() && !blocked) void resume({ variables: { id: task.id, text } }).catch(() => undefined);
  };
  const state = session.archivedAt
    ? 'Elle est archivée : elle sera restaurée avec son dossier.'
    : session.status === 'RUNNING'
      ? "Elle tourne : le message est transmis à l'agent."
      : session.status === 'QUEUED'
        ? "Elle est en file d'attente : arrêtez-la d'abord, ou lancez une nouvelle session."
        : 'Elle repart avec ce message, là où elle s’était arrêtée.';
  return (
    <Modal show onHide={() => !loading && onClose()} size="lg" centered backdrop={loading ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton={!loading}>
          <Modal.Title className="h6">Reprendre · {task.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {blocked}
          <p className="small text-secondary">
            <i className="bi bi-chat-left-text me-1" />
            Le message est envoyé dans la conversation de la session{' '}
            <Link to={`/sessions/${session.id}`} onClick={onClose}>
              « {session.name} »
            </Link>
            , avec tout son historique, dans le même dossier. {state}
          </p>
          <Form.Group className="mb-2">
            <Form.Label>Message</Form.Label>
            <Form.Control as="textarea" rows={5} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
          </Form.Group>
          <button type="button" className="btn btn-link btn-sm p-0" disabled={loading || Boolean(blocked)} onClick={onFresh}>
            Lancer plutôt une nouvelle session (consigne complète de la tâche, « {session.name} » archivée)
          </button>
          {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || Boolean(blocked) || !text.trim() || session.status === 'QUEUED'}>
            {loading ? 'Envoi…' : 'Reprendre la conversation'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/**
 * Nouvelle session : consigne relue, type d'agent et ses options. L'agent travaille dans le dossier de la
 * tâche (sa branche task/… pour un projet git), créé à la première session et repris ensuite ; la session
 * précédente de la tâche, s'il y en a une d'active, est archivée. Une fois la session lancée, on reste sur la page
 * (liste, kanban, tâche) : la session apparaît sur la tâche et dans la sidebar, sans y être emmené.
 */
function TaskNewSessionModal({ task, target, info: infoData, blocked, onClose }: { task: Task; target: LaunchTarget | undefined; info: LaunchInfo; blocked: ReactNode; onClose: () => void }) {
  const { data: promptData, loading: promptLoading } = useQuery<{ taskPrompt: string }>(TASK_PROMPT, { variables: { id: task.id }, fetchPolicy: 'network-only' });
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const providers = providersData?.providers ?? [];
  const [providerType, setProviderType] = useState('');
  const [prompt, setPrompt] = useState<string | null>(null);
  // Agents du projet : la tâche peut être confiée à l'un d'eux (le Developer du projet par défaut) plutôt qu'à une session anonyme.
  const { data: agentsData } = useQuery<{ project: { id: string; agents: (AgentRef & { description: string; enabled: boolean; taskFolder: boolean; defaults: Record<string, unknown>; allowedModels: string[] })[] } | null }>(PROJECT_AGENT_REFS, { variables: { id: task.project.id } });
  const agents = (agentsData?.project?.agents ?? []).filter((a) => a.enabled);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentChosen, setAgentChosen] = useState(false);
  const effectiveAgentId = agentChosen ? agentId : (agents.find((a) => a.kind === 'DEVELOPER')?.id ?? null);
  const agent = agents.find((a) => a.id === effectiveAgentId) ?? null;
  // Type de session : celui choisi, sinon celui de l'agent, sinon le premier proposé.
  const agentType = agent ? agentProvider(agent, providers.map((p) => p.type)) : null;
  const provider = providers.find((p) => p.type === (providerType || agentType || providers[0]?.type));
  const own = infoData?.task?.worksession ?? null;
  const branch = own?.branch ?? infoData?.task?.branch ?? null;
  // Session active déjà en charge de la tâche : elle sera archivée au profit de la nouvelle.
  const previous = infoData?.task?.session && !infoData.task.session.archivedAt ? infoData.task.session : null;
  const proposedModel = projectModelForTask(infoData?.task?.project, infoData?.task?.priority);
  const [values, setValues] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const original = promptData?.taskPrompt ?? '';
  const text = prompt ?? original;
  const edited = prompt !== null && prompt !== original;

  useEffect(() => {
    if (!provider) return;
    const defaults: Record<string, string> = {};
    for (const f of provider.configFields) if (f.defaultValue) defaults[f.key] = f.defaultValue;
    // Mode d'autorisation : celui du projet (lu avec la tâche, car la boîte « À traiter » n'a pas de cible), modifiable ici.
    const modeField = provider.configFields.find((f) => f.key === 'permissionMode');
    const projectMode = infoData?.task?.project?.defaultPermissionMode ?? target?.defaultPermissionMode ?? null;
    if (modeField && projectMode && modeField.options?.some((o) => o.value === projectMode)) defaults.permissionMode = projectMode;
    // Modèle proposé par le projet pour la priorité de la tâche (s'il fait partie des modèles proposés) ; celui de l'agent l'emporte.
    if (proposedModel && provider.configFields.find((f) => f.key === 'model')?.options?.some((o) => o.value === proposedModel)) defaults.model = proposedModel;
    const fromAgent = agent ? agentConfigValues(agent, provider.configFields) : {};
    if (fromAgent.model === '') delete fromAgent.model;
    setValues({ ...defaults, ...fromAgent });
  }, [provider?.type, agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [start, { loading, error }] = useMutation<{ startTaskSession: { id: string } }>(START_TASK_SESSION, {
    refetchQueries: ['Tasks', 'TaskPage', 'TaskDetail', 'Sidebar'],
    onCompleted: () => onClose(),
  });
  // Le modèle, quand le projet en propose un pour les tâches, est montré d'emblée (pas dans les options avancées).
  const fields = useMemo(
    () =>
      agentConfigFields(agent, provider?.configFields ?? []).map((f) =>
        f.key === 'model' && proposedModel ? { ...f, advanced: false, description: `Proposé par le projet pour cette tâche : ${proposedModel}. ${f.description ?? ''}`.trim() } : f,
      ),
    [provider, agent, proposedModel],
  );
  const basic = fields.filter((f) => !f.advanced);
  const extra = fields.filter((f) => f.advanced);
  const warning = values.permissionMode === 'bypassPermissions' ? bypassConnectionsWarning(target?.approvalConnections ?? []) : null;
  const set = (f: ConfigField) => (v: string) => setValues((prev) => ({ ...prev, [f.key]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider || !text.trim() || blocked) return;
    start({
      variables: {
        id: task.id,
        provider: provider.type,
        config: buildConfig(fields, values),
        prompt: edited ? text : null,
        agentId: effectiveAgentId,
      },
    });
  };

  return (
    <Modal show onHide={() => !loading && onClose()} size="lg" centered backdrop={loading ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton={!loading}>
          <Modal.Title className="h6">Confier à un agent · {task.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {blocked}
          <Form.Group className="mb-3">
            <Form.Label className="d-flex justify-content-between">
              Consigne
              {edited && (
                <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setPrompt(null)}>
                  Revenir au texte de la tâche
                </button>
              )}
            </Form.Label>
            <Form.Control as="textarea" rows={10} className="font-monospace small" value={promptLoading ? 'Chargement…' : text} disabled={promptLoading} onChange={(e) => setPrompt(e.target.value)} />
            <Form.Text>Construite à partir de la tâche (description, champs, commentaires). Modifiez-la librement : l'agent reçoit ce texte comme première instruction.</Form.Text>
          </Form.Group>
          <div className="small text-secondary mb-3">
            <i className="bi bi-git me-1" />
            {own
              ? `L'agent reprend le dossier de travail de la tâche${target?.gitUrl && branch ? ` (branche ${branch})` : ''} : les fichiers${target?.gitUrl ? ' et la branche' : ''} des sessions précédentes.`
              : `L'agent travaille dans un dossier${target?.gitUrl ? ' sur une branche task/…' : ''} créé pour la tâche et repris par ses sessions suivantes.`}
            {previous && (
              <>
                {' '}
                La session « {previous.name} », en charge de la tâche, est archivée (arrêtée si elle tourne) : une seule session à la fois dans ce dossier.
              </>
            )}
          </div>
          {agents.length > 0 && (
            <Form.Group className="mb-3">
              <Form.Label className="d-flex align-items-center gap-2">
                Confier à {agent && <AgentAvatar agent={agent} size={18} />}
              </Form.Label>
              <Form.Select
                value={effectiveAgentId ?? ''}
                onChange={(e) => {
                  setAgentChosen(true);
                  setAgentId(e.target.value || null);
                }}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {agentKindLabels[a.kind]}
                    {a.description ? ` · ${a.description}` : ''}
                  </option>
                ))}
                <option value="">Une session sans agent (mes comptes)</option>
              </Form.Select>
              <Form.Text>{agent ? `La session appartient à ${agent.name} (ses comptes, ses instructions, son budget) ; vous en êtes le demandeur.${agent.taskFolder ? '' : ` ${agent.name} travaille dans un dossier à part, sans prendre la branche de la tâche.`}` : 'La session tourne avec vos comptes.'}</Form.Text>
            </Form.Group>
          )}
          {providers.length > 1 && (
            <Form.Group className="mb-3">
              <Form.Label>Type d'agent</Form.Label>
              <Form.Select value={provider?.type ?? ''} onChange={(e) => setProviderType(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.type} value={p.type}>
                    {p.label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
          {basic.map((f) => (
            <FieldGroup key={f.key} field={f} value={values[f.key] ?? ''} onChange={set(f)} />
          ))}
          {warning && <Alert variant="warning" className="py-2 small">{warning}</Alert>}
          {extra.length > 0 && (
            <>
              <button type="button" className="btn btn-link btn-sm p-0 mb-2" onClick={() => setAdvanced((v) => !v)}>
                <i className={`bi bi-chevron-${advanced ? 'down' : 'right'} me-1`} /> Options avancées
              </button>
              <Collapse in={advanced}>
                <div>
                  {extra.map((f) => (
                    <FieldGroup key={f.key} field={f} value={values[f.key] ?? ''} onChange={set(f)} />
                  ))}
                </div>
              </Collapse>
            </>
          )}
          {error && <Alert variant="danger" className="mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || Boolean(blocked) || !provider || promptLoading || !text.trim()}>
            {loading ? 'Lancement…' : 'Lancer la session'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
