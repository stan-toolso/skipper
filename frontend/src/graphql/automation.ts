import { gql } from '@apollo/client';
import type { User } from './operations';

// ---- Agents et workflows -------------------------------------------------------------------------

export type RunStatus = 'QUEUED' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type RunTrigger = 'MANUAL' | 'SCHEDULE' | 'WORKFLOW' | 'TEST' | 'EVENT';
export type AgentOutputFormat = 'TEXT' | 'JSON';

/** Variable d'un agent ou d'un déclencheur de workflow, remplie au lancement ({{input.<clé>}}). */
export interface InputVariable {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  defaultValue: string | null;
}

export interface InputVariableInput {
  key: string;
  label?: string | null;
  description?: string | null;
  required?: boolean | null;
  defaultValue?: string | null;
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

/** Appel direct d'un modèle (fournisseur `llm`) : réglages rangés dans `Agent.config`. */
export interface LlmAgentConfig {
  backend: 'litellm' | 'openai' | 'anthropic';
  keyItemId: string;
  model: string;
  temperature?: number | null;
  maxTokens?: number | null;
  langfuseItemId?: string | null;
}

export const LLM_PROVIDER = 'llm';

export interface AgentRunSummary {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  costUsd: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Agent {
  id: string;
  project: { id: string; name: string };
  name: string;
  description: string;
  provider: string;
  config: Record<string, unknown>;
  systemPrompt: string;
  promptTemplate: string;
  inputs: InputVariable[];
  outputFormat: AgentOutputFormat;
  outputSchema: string | null;
  worksession: { id: string; name: string; branch: string } | null;
  timeoutMinutes: number;
  schedule: AutomationSchedule | null;
  scheduleInputs: Record<string, unknown>;
  lastRun: AgentRunSummary | null;
  createdBy: Pick<User, 'id' | 'name'> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  agent: { id: string; name: string; outputFormat: AgentOutputFormat };
  project: { id: string; name: string };
  session: { id: string; name: string; status: string } | null;
  workflowRun: { id: string; workflow: { id: string; name: string } } | null;
  nodeKey: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  inputs: Record<string, unknown>;
  prompt: string;
  output: string | null;
  outputJson: unknown | null;
  error: string | null;
  costUsd: number;
  durationMs: number | null;
  owner: Pick<User, 'id' | 'name'> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentPromptPreview {
  inputs: Record<string, unknown>;
  prompt: string;
}

export interface LlmKeyItem {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  ownerUser: { id: string; name: string } | null;
  ownerProject: { id: string; name: string } | null;
  token: { service: string; serviceLabel: string } | null;
}

export interface AgentLlmKeys {
  litellm: LlmKeyItem[];
  langfuse: LlmKeyItem[];
  tokens: LlmKeyItem[];
}

export interface CreateAgentInput {
  projectId: string;
  name: string;
  description?: string | null;
  provider: string;
  config?: Record<string, unknown> | null;
  systemPrompt?: string | null;
  promptTemplate?: string | null;
  inputs?: InputVariableInput[] | null;
  outputFormat?: AgentOutputFormat | null;
  outputSchema?: string | null;
  worksessionId?: string | null;
  timeoutMinutes?: number | null;
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'projectId'>>;

// ---- Définition d'un workflow (miroir du backend, enregistrée telle que l'éditeur la dessine) ----

export type WorkflowNodeType = 'trigger' | 'agent' | 'task' | 'session' | 'createTask' | 'condition' | 'end';
export type TriggerEvent = 'manual' | 'task.created';
export type EdgeHandle = 'default' | 'true' | 'false' | 'error';
export type TaskWorksessionMode = 'new' | 'existing';

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
  agentId?: string | null;
  inputs?: Record<string, string>;
  timeoutMinutes?: number | null;
  taskId?: string;
  provider?: string;
  config?: Record<string, unknown>;
  prompt?: string;
  includeTask?: boolean;
  worksessionMode?: TaskWorksessionMode;
  worksessionId?: string | null;
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
  agentRun: { id: string; status: RunStatus; session: { id: string; name: string } | null } | null;
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

export const AGENT_RUN_SUMMARY_FIELDS = gql`
  fragment AgentRunSummaryFields on AgentRun {
    id
    status
    trigger
    costUsd
    durationMs
    error
    createdAt
    finishedAt
  }
`;

export const AGENT_FIELDS = gql`
  ${SCHEDULE_FIELDS}
  ${INPUT_VARIABLE_FIELDS}
  ${AGENT_RUN_SUMMARY_FIELDS}
  fragment AgentFields on Agent {
    id
    project {
      id
      name
    }
    name
    description
    provider
    config
    systemPrompt
    promptTemplate
    inputs {
      ...InputVariableFields
    }
    outputFormat
    outputSchema
    worksession {
      id
      name
      branch
    }
    timeoutMinutes
    schedule {
      ...AutomationScheduleFields
    }
    scheduleInputs
    lastRun {
      ...AgentRunSummaryFields
    }
    createdBy {
      id
      name
    }
    createdAt
    updatedAt
  }
`;

export const AGENT_RUN_FIELDS = gql`
  fragment AgentRunFields on AgentRun {
    id
    agent {
      id
      name
      outputFormat
    }
    project {
      id
      name
    }
    session {
      id
      name
      status
    }
    workflowRun {
      id
      workflow {
        id
        name
      }
    }
    nodeKey
    trigger
    status
    inputs
    prompt
    output
    outputJson
    error
    costUsd
    durationMs
    owner {
      id
      name
    }
    createdAt
    startedAt
    finishedAt
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
    agentRun {
      id
      status
      session {
        id
        name
      }
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

export const AGENTS = gql`
  ${AGENT_FIELDS}
  query Agents($projectId: ID) {
    agents(projectId: $projectId) {
      ...AgentFields
    }
  }
`;

export const AGENT = gql`
  ${AGENT_FIELDS}
  ${AGENT_RUN_SUMMARY_FIELDS}
  query Agent($id: ID!) {
    agent(id: $id) {
      ...AgentFields
      runs(limit: 30) {
        ...AgentRunSummaryFields
      }
      workflows {
        id
        name
      }
    }
  }
`;

export const AGENT_RUNS = gql`
  ${AGENT_RUN_FIELDS}
  query AgentRuns($agentId: ID, $projectId: ID, $limit: Int) {
    agentRuns(agentId: $agentId, projectId: $projectId, limit: $limit) {
      ...AgentRunFields
    }
  }
`;

export const AGENT_RUN = gql`
  ${AGENT_RUN_FIELDS}
  query AgentRun($id: ID!) {
    agentRun(id: $id) {
      ...AgentRunFields
    }
  }
`;

export const AGENT_PROMPT_PREVIEW = gql`
  query AgentPromptPreview($id: ID!, $inputs: JSON) {
    agentPromptPreview(id: $id, inputs: $inputs) {
      inputs
      prompt
    }
  }
`;

export const AGENT_LLM_KEYS = gql`
  query AgentLlmKeys {
    agentLlmKeys {
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

export const CREATE_AGENT = gql`
  ${AGENT_FIELDS}
  mutation CreateAgent($input: CreateAgentInput!) {
    createAgent(input: $input) {
      ...AgentFields
    }
  }
`;

export const UPDATE_AGENT = gql`
  ${AGENT_FIELDS}
  mutation UpdateAgent($id: ID!, $input: UpdateAgentInput!) {
    updateAgent(id: $id, input: $input) {
      ...AgentFields
    }
  }
`;

export const DELETE_AGENT = gql`
  mutation DeleteAgent($id: ID!) {
    deleteAgent(id: $id)
  }
`;

export const RUN_AGENT = gql`
  ${AGENT_RUN_FIELDS}
  mutation RunAgent($id: ID!, $inputs: JSON, $test: Boolean) {
    runAgent(id: $id, inputs: $inputs, test: $test) {
      ...AgentRunFields
    }
  }
`;

export const CANCEL_AGENT_RUN = gql`
  ${AGENT_RUN_FIELDS}
  mutation CancelAgentRun($id: ID!) {
    cancelAgentRun(id: $id) {
      ...AgentRunFields
    }
  }
`;

export const SET_AGENT_SCHEDULE = gql`
  ${AGENT_FIELDS}
  mutation SetAgentSchedule($id: ID!, $input: AutomationScheduleInput!, $inputs: JSON) {
    setAgentSchedule(id: $id, input: $input, inputs: $inputs) {
      ...AgentFields
    }
  }
`;

export const CLEAR_AGENT_SCHEDULE = gql`
  ${AGENT_FIELDS}
  mutation ClearAgentSchedule($id: ID!) {
    clearAgentSchedule(id: $id) {
      ...AgentFields
    }
  }
`;

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
