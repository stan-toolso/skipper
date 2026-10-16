/** `queued` : exécution de workflow déclenchée par un événement, en attente d'une place. */
export type RunStatus = 'queued' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** `event` : workflow lancé par un événement du projet (une tâche créée). */
export type RunTrigger = 'manual' | 'schedule' | 'workflow' | 'test' | 'event';
export type AgentOutputFormat = 'text' | 'json';

export const RUN_STATUSES: RunStatus[] = ['queued', 'pending', 'running', 'succeeded', 'failed', 'cancelled'];
export const RUN_TRIGGERS: RunTrigger[] = ['manual', 'schedule', 'workflow', 'test', 'event'];
export const SETTLED_RUN_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Variable déclarée par un agent (ou un déclencheur de workflow) : remplie au lancement, disponible comme `{{input.<clé>}}`. */
export interface InputVariable {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  defaultValue: string | null;
}

/** Planification d'un agent ou d'un workflow : une exécution à chaque échéance de l'expression cron. */
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

/**
 * Un agent : configuration réutilisable et paramétrée — modèle (appel direct : `llm`) ou type de session et
 * ses options, prompt système, modèle d'instruction avec variables, sortie attendue. Chaque exécution rend la
 * réponse ; pour un agent de session, une session dédiée est créée, interrogée, puis terminée.
 */
export interface Agent {
  id: string;
  projectId: string;
  name: string;
  description: string;
  provider: string;
  config: Record<string, unknown>;
  systemPrompt: string;
  promptTemplate: string;
  inputs: InputVariable[];
  outputFormat: AgentOutputFormat;
  outputSchema: string | null;
  worksessionId: string | null;
  timeoutMinutes: number;
  schedule: AutomationSchedule | null;
  scheduleInputs: Record<string, unknown>;
  /** Personne dont les comptes servent aux exécutions planifiées (celle qui a réglé la planification). */
  scheduleOwnerId: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentInput {
  name?: string | null;
  description?: string | null;
  provider?: string | null;
  config?: Record<string, unknown> | null;
  systemPrompt?: string | null;
  promptTemplate?: string | null;
  inputs?: InputVariable[] | null;
  outputFormat?: AgentOutputFormat | null;
  outputSchema?: string | null;
  worksessionId?: string | null;
  timeoutMinutes?: number | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  projectId: string;
  ownerId: string | null;
  sessionId: string | null;
  workflowRunId: string | null;
  nodeKey: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  inputs: Record<string, unknown>;
  /** Instruction rendue, envoyée à l'agent. */
  prompt: string;
  output: string | null;
  outputJson: unknown | null;
  error: string | null;
  costUsd: number;
  durationMs: number | null;
  heartbeatAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface AgentRunFilter {
  agentId?: string;
  projectId?: string;
  projectIds?: string[];
  workflowRunId?: string;
  status?: RunStatus[];
  limit?: number;
}
