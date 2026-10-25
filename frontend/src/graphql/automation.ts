import { gql } from '@apollo/client';
import type { User } from './operations';

// ---- Workflows -----------------------------------------------------------------------------------

export type RunStatus = 'QUEUED' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type RunTrigger = 'MANUAL' | 'SCHEDULE' | 'WORKFLOW' | 'TEST' | 'EVENT';

/** Variable d'un déclencheur de workflow, remplie au lancement ({{input.<clé>}}). */
export interface InputVariable {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  defaultValue: string | null;
}

export interface AutomationSchedule {
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
}

export interface AutomationScheduleInput {
  cron: string;
  timezone?: string | null;
  enabled?: boolean | null;
}

/** Nœud « appel de modèle » : comment joindre le modèle (clé du coffre, modèle, réglages, trace Langfuse). */
export type LlmBackend = 'litellm' | 'openai' | 'anthropic';
export interface LlmNodeConfig {
  backend: LlmBackend;
  keyItemId: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  langfuseItemId: string | null;
}
export type LlmOutputFormat = 'text' | 'json';

export interface LlmKeyItem {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  ownerUser: { id: string; name: string } | null;
  ownerProject: { id: string; name: string } | null;
  token: { service: string; serviceLabel: string } | null;
}

export interface LlmKeys {
  litellm: LlmKeyItem[];
  langfuse: LlmKeyItem[];
  tokens: LlmKeyItem[];
}

// ---- Définition d'un workflow (miroir du backend, enregistrée telle que l'éditeur la dessine) ----

export type WorkflowNodeType = 'trigger' | 'callLlm' | 'task' | 'session' | 'createTask' | 'condition' | 'end';
export type TriggerEvent = 'manual' | 'task.created';
export type EdgeHandle = 'default' | 'true' | 'false' | 'error';
export type TaskWorktreeMode = 'new' | 'existing' | 'main';

export type ConditionOperator = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'matches' | 'isEmpty' | 'isNotEmpty' | 'isTrue' | 'isFalse' | 'greaterThan' | 'atLeast' | 'lessThan' | 'atMost';
export interface ConditionRule {
  kind: 'rule';
  path: string;
  operator: ConditionOperator;
  value?: string;
}
export interface ConditionGroup {
  kind: 'group';
  match: 'all' | 'any';
  items: (ConditionRule | ConditionGroup)[];
}

export type TaskFilterField = 'title' | 'description' | 'priority' | 'status' | 'createdBy' | 'dueDate' | 'assignee' | 'reporter' | 'customField';
export type TaskFilterOperator = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'matches' | 'isEmpty' | 'isNotEmpty' | 'anyOf' | 'noneOf' | 'atLeast' | 'atMost' | 'before' | 'after';
export interface TaskFilterRule {
  kind: 'rule';
  field: TaskFilterField;
  key?: string;
  operator: TaskFilterOperator;
  value?: string;
  values?: string[];
}
export interface TaskFilterGroup {
  kind: 'group';
  match: 'all' | 'any';
  items: (TaskFilterRule | TaskFilterGroup)[];
}

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

export interface WorkflowNode {
  key: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  variables?: InputVariable[];
  event?: TriggerEvent;
  taskFilter?: TaskFilterGroup | null;
  /** callLlm : modèle, instructions (prompt système), format de la réponse ; l'instruction est `prompt`. */
  llm?: LlmNodeConfig | null;
  systemPrompt?: string;
  outputFormat?: LlmOutputFormat;
  outputSchema?: string;
  timeoutMinutes?: number | null;
  taskId?: string;
  provider?: string;
  config?: Record<string, unknown>;
  prompt?: string;
  includeTask?: boolean;
  worktreeMode?: TaskWorktreeMode;
  worktreeId?: string | null;
  wait?: boolean;
  sessionName?: string;
  branch?: string;
  endAfterTurn?: boolean;
  newTask?: NewTaskTemplate;
  sessionOwner?: string;
  condition?: ConditionGroup | null;
  expression?: string;
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
  edgeId: string | null;
  severity: 'error' | 'warning';
  message: string;
}

export interface WorkflowRunSummary {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Workflow {
  id: string;
  project: { id: string; name: string };
  name: string;
  description: string;
  definition: WorkflowDefinition;
  enabled: boolean;
  issues: WorkflowIssue[];
  schedule: AutomationSchedule | null;
  scheduleInputs: Record<string, unknown>;
  eventOwner: Pick<User, 'id' | 'name'> | null;
  lastRun: WorkflowRunSummary | null;
  createdBy: Pick<User, 'id' | 'name'> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunNode {
  id: string;
  nodeKey: string;
  nodeType: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  /** Session ouverte par un nœud « tâche » ou « session ». */
  session: { id: string; name: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowRunLog {
  id: string;
  nodeKey: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data: unknown | null;
  createdAt: string;
}

export interface WorkflowRun {
  id: string;
  workflow: { id: string; name: string };
  project: { id: string; name: string };
  trigger: RunTrigger;
  triggerKey: string | null;
  status: RunStatus;
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  output: unknown | null;
  error: string | null;
  costUsd: number;
  cancelRequested: boolean;
  owner: Pick<User, 'id' | 'name'> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowRunDetail extends WorkflowRun {
  nodes: WorkflowRunNode[];
  logs: WorkflowRunLog[];
}

export interface CreateWorkflowInput {
  projectId: string;
  name: string;
  description?: string | null;
  definition?: WorkflowDefinition | null;
  enabled?: boolean | null;
}

export type UpdateWorkflowInput = Partial<Omit<CreateWorkflowInput, 'projectId'>>;

// ---- Fragments ------------------------------------------------------------------------------------

export const SCHEDULE_FIELDS = gql`
  fragment AutomationScheduleFields on AutomationSchedule {
    cron
    timezone
    enabled
    nextRunAt
    lastRunAt
    lastResult
  }
`;

export const INPUT_VARIABLE_FIELDS = gql`
  fragment InputVariableFields on InputVariable {
    key
    label
    description
    required
    defaultValue
  }
`;

export const WORKFLOW_RUN_SUMMARY_FIELDS = gql`
  fragment WorkflowRunSummaryFields on WorkflowRun {
    id
    status
    trigger
    costUsd
    error
    createdAt
    finishedAt
  }
`;

export const WORKFLOW_FIELDS = gql`
  ${SCHEDULE_FIELDS}
  ${WORKFLOW_RUN_SUMMARY_FIELDS}
  fragment WorkflowFields on Workflow {
    id
    project {
      id
      name
    }
    name
    description
    definition
    enabled
    issues {
      nodeKey
      edgeId
      severity
      message
    }
    schedule {
      ...AutomationScheduleFields
    }
    scheduleInputs
    eventOwner {
      id
      name
    }
    lastRun {
      ...WorkflowRunSummaryFields
    }
    createdBy {
      id
      name
    }
    createdAt
    updatedAt
  }
`;

export const WORKFLOW_RUN_FIELDS = gql`
  fragment WorkflowRunFields on WorkflowRun {
    id
    workflow {
      id
      name
    }
    project {
      id
      name
    }
    trigger
    triggerKey
    status
    definition
    inputs
    output
    error
    costUsd
    cancelRequested
    owner {
      id
      name
    }
    createdAt
    startedAt
    finishedAt
  }
`;

export const WORKFLOW_RUN_NODE_FIELDS = gql`
  fragment WorkflowRunNodeFields on WorkflowRunNode {
    id
    nodeKey
    nodeType
    status
    input
    output
    error
    session {
      id
      name
    }
    startedAt
    finishedAt
  }
`;

export const WORKFLOW_RUN_LOG_FIELDS = gql`
  fragment WorkflowRunLogFields on WorkflowRunLog {
    id
    nodeKey
    level
    message
    data
    createdAt
  }
`;

// ---- Requêtes -------------------------------------------------------------------------------------

export const LLM_KEYS = gql`
  query LlmKeys {
    llmKeys {
      litellm {
        id
        name
        kind
        url
        ownerUser {
          id
          name
        }
        ownerProject {
          id
          name
        }
        token {
          service
          serviceLabel
        }
      }
      langfuse {
        id
        name
        kind
        url
        ownerUser {
          id
          name
        }
        ownerProject {
          id
          name
        }
        token {
          service
          serviceLabel
        }
      }
      tokens {
        id
        name
        kind
        url
        ownerUser {
          id
          name
        }
        ownerProject {
          id
          name
        }
        token {
          service
          serviceLabel
        }
      }
    }
  }
`;

export const WORKFLOWS = gql`
  ${WORKFLOW_FIELDS}
  query Workflows($projectId: ID) {
    workflows(projectId: $projectId) {
      ...WorkflowFields
    }
  }
`;

export const WORKFLOW = gql`
  ${WORKFLOW_FIELDS}
  ${WORKFLOW_RUN_SUMMARY_FIELDS}
  ${INPUT_VARIABLE_FIELDS}
  query Workflow($id: ID!) {
    workflow(id: $id) {
      ...WorkflowFields
      variables {
        ...InputVariableFields
      }
      runs(limit: 30) {
        ...WorkflowRunSummaryFields
      }
    }
  }
`;

export const WORKFLOW_VARIABLES = gql`
  ${INPUT_VARIABLE_FIELDS}
  query WorkflowVariables($id: ID!, $triggerKey: String) {
    workflow(id: $id) {
      id
      variables(triggerKey: $triggerKey) {
        ...InputVariableFields
      }
    }
  }
`;

export const WORKFLOW_RUNS = gql`
  ${WORKFLOW_RUN_FIELDS}
  query WorkflowRuns($workflowId: ID, $projectId: ID, $limit: Int) {
    workflowRuns(workflowId: $workflowId, projectId: $projectId, limit: $limit) {
      ...WorkflowRunFields
    }
  }
`;

export const WORKFLOW_RUN = gql`
  ${WORKFLOW_RUN_FIELDS}
  ${WORKFLOW_RUN_NODE_FIELDS}
  ${WORKFLOW_RUN_LOG_FIELDS}
  query WorkflowRun($id: ID!) {
    workflowRun(id: $id) {
      ...WorkflowRunFields
      nodes {
        ...WorkflowRunNodeFields
      }
      logs(limit: 500) {
        ...WorkflowRunLogFields
      }
    }
  }
`;

export const VALIDATE_WORKFLOW = gql`
  query ValidateWorkflow($projectId: ID!, $definition: JSON!) {
    validateWorkflow(projectId: $projectId, definition: $definition) {
      nodeKey
      edgeId
      severity
      message
    }
  }
`;

// ---- Mutations ------------------------------------------------------------------------------------

export const CREATE_WORKFLOW = gql`
  ${WORKFLOW_FIELDS}
  mutation CreateWorkflow($input: CreateWorkflowInput!) {
    createWorkflow(input: $input) {
      ...WorkflowFields
    }
  }
`;

export const UPDATE_WORKFLOW = gql`
  ${WORKFLOW_FIELDS}
  mutation UpdateWorkflow($id: ID!, $input: UpdateWorkflowInput!) {
    updateWorkflow(id: $id, input: $input) {
      ...WorkflowFields
    }
  }
`;

export const DELETE_WORKFLOW = gql`
  mutation DeleteWorkflow($id: ID!) {
    deleteWorkflow(id: $id)
  }
`;

export const RUN_WORKFLOW = gql`
  ${WORKFLOW_RUN_FIELDS}
  mutation RunWorkflow($id: ID!, $inputs: JSON, $test: Boolean, $triggerKey: String) {
    runWorkflow(id: $id, inputs: $inputs, test: $test, triggerKey: $triggerKey) {
      ...WorkflowRunFields
    }
  }
`;

export const CANCEL_WORKFLOW_RUN = gql`
  ${WORKFLOW_RUN_FIELDS}
  mutation CancelWorkflowRun($id: ID!) {
    cancelWorkflowRun(id: $id) {
      ...WorkflowRunFields
    }
  }
`;

export const SET_WORKFLOW_SCHEDULE = gql`
  ${WORKFLOW_FIELDS}
  mutation SetWorkflowSchedule($id: ID!, $input: AutomationScheduleInput!, $inputs: JSON) {
    setWorkflowSchedule(id: $id, input: $input, inputs: $inputs) {
      ...WorkflowFields
    }
  }
`;

export const CLEAR_WORKFLOW_SCHEDULE = gql`
  ${WORKFLOW_FIELDS}
  mutation ClearWorkflowSchedule($id: ID!) {
    clearWorkflowSchedule(id: $id) {
      ...WorkflowFields
    }
  }
`;
