import type { ConditionGroup } from './conditions.js';
import type { LlmBackend } from './llm.js';
import type { TaskFilterGroup } from './taskFilter.js';

/** `queued` : exécution déclenchée par un événement, en attente d'une place. */
export type RunStatus = 'queued' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** `event` : workflow lancé par un événement du projet (une tâche créée). */
export type RunTrigger = 'manual' | 'schedule' | 'workflow' | 'test' | 'event';
export type LlmOutputFormat = 'text' | 'json';

export const RUN_STATUSES: RunStatus[] = ['queued', 'pending', 'running', 'succeeded', 'failed', 'cancelled'];
export const RUN_TRIGGERS: RunTrigger[] = ['manual', 'schedule', 'workflow', 'test', 'event'];
export const SETTLED_RUN_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Variable déclarée par un déclencheur de workflow : remplie au lancement, disponible comme `{{input.<clé>}}`. */
export interface InputVariable {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  defaultValue: string | null;
}

/** Planification d'un workflow : une exécution à chaque échéance de l'expression cron. */
export interface AutomationSchedule {
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastResult: string | null;
}

export interface AutomationScheduleInput {
  cron: string;
  timezone?: string | null;
  enabled?: boolean | null;
}

export type WorkflowNodeType = 'trigger' | 'callLlm' | 'task' | 'session' | 'createTask' | 'condition' | 'end';
export const WORKFLOW_NODE_TYPES: WorkflowNodeType[] = ['trigger', 'callLlm', 'task', 'session', 'createTask', 'condition', 'end'];

/** Types de nœuds qui peuvent échouer et ont donc une branche « en cas d'erreur ». */
export const FALLIBLE_NODE_TYPES: WorkflowNodeType[] = ['callLlm', 'task', 'session', 'createTask'];

/** Où travaille un nœud « tâche » ou « session » : une nouvelle work session (celle de la tâche pour un nœud « tâche ») ou une work session existante. */
export type TaskWorksessionMode = 'new' | 'existing';

/** Tâche créée par un nœud « créer une tâche » : des modèles rendus à l'exécution. */
export interface NewTaskTemplate {
  title: string;
  description: string;
  priority: string;
  status: string;
  dueDate: string;
  assignee: string;
  reporter: string;
  fields: { key: string; value: string }[];
}

/**
 * Nœud « appel de modèle » (`callLlm`) : comment joindre le modèle. La clé vient du coffre (un élément
 * `litellm`, ou un jeton applicatif OpenAI / Anthropic) ; l'appel est tracé dans Langfuse quand le nœud
 * nomme un élément Langfuse.
 */
export interface LlmNodeConfig {
  backend: LlmBackend;
  keyItemId: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  langfuseItemId: string | null;
}

/** Ce qui démarre un workflow : une personne ou sa planification (`manual`), ou une tâche créée dans le projet. */
export type TriggerEvent = 'manual' | 'task.created';
export const TRIGGER_EVENTS: TriggerEvent[] = ['manual', 'task.created'];

/** Sorties d'un nœud : quelles arêtes en partent, selon son issue. */
export type EdgeHandle = 'default' | 'true' | 'false' | 'error';

export interface WorkflowNode {
  /** Clé stable, référencée par les arêtes et les modèles (`nodes.<clé>.output`). */
  key: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  /** trigger : variables du workflow, remplies au lancement. */
  variables?: InputVariable[];
  /** trigger : événement qui démarre le workflow (manuel par défaut). */
  event?: TriggerEvent;
  /** trigger d'une tâche créée : conditions que la tâche doit remplir (construites visuellement) ; null = toute tâche. */
  taskFilter?: TaskFilterGroup | null;
  /** callLlm : le modèle à appeler, son prompt système (instructions), la sortie attendue. L'instruction est `prompt`. */
  llm?: LlmNodeConfig | null;
  systemPrompt?: string;
  outputFormat?: LlmOutputFormat;
  /** callLlm, sortie JSON : la forme attendue, montrée au modèle. */
  outputSchema?: string;
  /** callLlm, task, session : délai maximal en minutes (défaut : 60, ou 10 pour un appel de modèle). */
  timeoutMinutes?: number | null;
  /** task : modèle de l'identifiant d'une tâche à résoudre (`{{input.task.id}}`). */
  taskId?: string;
  /** task, session : type de session et ses options, instruction, où elle travaille, attente de la fin du tour. callLlm : l'instruction envoyée au modèle. */
  provider?: string;
  config?: Record<string, unknown>;
  prompt?: string;
  includeTask?: boolean;
  worksessionMode?: TaskWorksessionMode;
  worksessionId?: string | null;
  wait?: boolean;
  /** session : nom de la session, branche de la nouvelle work session, fin de session après le tour. */
  sessionName?: string;
  branch?: string;
  endAfterTurn?: boolean;
  /** createTask : la tâche à créer (modèles). */
  newTask?: NewTaskTemplate;
  /** task, session : modèle de la personne propriétaire de la session (e-mail ou identifiant), membre du projet ; vide : le propriétaire de l'exécution. */
  sessionOwner?: string;
  /** condition : les règles à tester (construites visuellement). */
  condition?: ConditionGroup | null;
  /** condition : formule textuelle (voir expressions.ts), évaluée quand il n'y a pas de `condition`. */
  expression?: string;
  /** end : modèle de la sortie de l'exécution. */
  message?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: EdgeHandle | null;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowIssue {
  nodeKey: string | null;
  edgeId?: string | null;
  severity: 'error' | 'warning';
  message: string;
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
  enabled: boolean;
  schedule: AutomationSchedule | null;
  scheduleInputs: Record<string, unknown>;
  scheduleOwnerId: string | null;
  /** Personne dont les comptes servent aux exécutions déclenchées par un événement : la dernière à avoir enregistré le déclencheur. */
  eventOwnerId: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowInput {
  name?: string | null;
  description?: string | null;
  definition?: WorkflowDefinition | null;
  enabled?: boolean | null;
}

export type NodeRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  projectId: string;
  ownerId: string | null;
  trigger: RunTrigger;
  /** Clé du nœud déclencheur de départ. */
  triggerKey: string | null;
  status: RunStatus;
  /** Le graphe tel qu'il était au lancement. */
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  output: unknown | null;
  error: string | null;
  costUsd: number;
  cancelRequested: boolean;
  heartbeatAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface WorkflowRunNode {
  id: string;
  runId: string;
  nodeKey: string;
  nodeType: WorkflowNodeType;
  status: NodeRunStatus;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface WorkflowRunLog {
  id: string;
  runId: string;
  nodeKey: string | null;
  level: LogLevel;
  message: string;
  data: unknown | null;
  createdAt: Date;
}

export interface WorkflowRunFilter {
  workflowId?: string;
  projectId?: string;
  projectIds?: string[];
  status?: RunStatus[];
  limit?: number;
}
