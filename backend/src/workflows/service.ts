import { agentService, normalizeInputs, prepareSchedule, resolveInputs } from '../agents/service.js';
import type { AutomationScheduleInput, RunTrigger } from '../agents/types.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { getProvider, providerTypes } from '../sessions/providers/registry.js';
import { serverSettings } from '../settings/server.js';
import { taskService } from '../tasks/service.js';
import { cancelWorkflowRun, executeWorkflowRun, onRunSettled } from './engine.js';
import { parseDefinition, TASK_ID_INPUT, taskContext, triggerEvent, triggerOf, triggersOf, validateDefinition, workflowVariables } from './graph.js';
import { workflowRepository, type WorkflowValues } from './repository.js';
import type { Workflow, WorkflowDefinition, WorkflowInput, WorkflowIssue, WorkflowRun, WorkflowRunFilter } from './types.js';

const DEFAULT_TIMEZONE = 'UTC';
/** Exécutions simultanées d'un même workflow (une planification n'empile jamais d'exécutions). */
const MAX_ACTIVE_RUNS = 5;

async function agentsOf(projectId: string) {
  return new Map((await agentService.list({ projectId })).map((a) => [a.id, a]));
}

/** Problèmes d'un graphe : la structure (graph.ts), plus les options de session de ses nœuds « tâche » et « session ». */
async function issuesOf(def: WorkflowDefinition, projectId: string): Promise<WorkflowIssue[]> {
  const issues = validateDefinition(def, await agentsOf(projectId), { providers: new Set(providerTypes()) });
  for (const node of def.nodes) {
    if ((node.type !== 'task' && node.type !== 'session') || !node.provider || issues.some((i) => i.nodeKey === node.key && i.severity === 'error')) continue;
    try {
      getProvider(node.provider).validateConfig?.(node.config ?? {});
    } catch (err) {
      issues.push({ nodeKey: node.key, edgeId: null, severity: 'error', message: `Options de session : ${(err as Error).message}` });
    }
  }
  return issues;
}

function normalizeDefinition(raw: unknown): WorkflowDefinition {
  const def = parseDefinition(raw);
  for (const node of def.nodes) if (node.type === 'trigger') node.variables = normalizeInputs(node.variables);
  return def;
}

/** `userId` : la personne qui enregistre ; les exécutions déclenchées par un événement utilisent les comptes de la dernière à avoir enregistré le déclencheur. */
async function validate(input: WorkflowInput, userId: string | null, current?: Workflow): Promise<WorkflowValues> {
  const name = (input.name ?? current?.name ?? '').trim();
  if (!name) throw new AppError('Le nom du workflow est obligatoire');
  const definition = input.definition === undefined || input.definition === null ? (current?.definition ?? { nodes: [], edges: [] }) : normalizeDefinition(input.definition);
  const evented = triggersOf(definition).some((t) => triggerEvent(t) !== 'manual');
  return { name, description: (input.description ?? current?.description ?? '').trim(), definition, enabled: input.enabled ?? current?.enabled ?? true, eventOwnerId: evented ? (userId ?? current?.eventOwnerId ?? null) : null };
}

/** Le déclencheur de départ d'une exécution : celui de cette clé, ou le déclencheur par défaut. */
function startTrigger(workflow: Workflow, key: string | null | undefined) {
  const trigger = triggerOf(workflow.definition, key);
  if (!trigger) throw new AppError(key ? `Le workflow n'a pas de déclencheur « ${key} »` : "Le workflow n'a pas de déclencheur");
  return trigger;
}

/** Entrées d'une exécution partie d'un déclencheur, défauts appliqués. Une exécution démarrée par une tâche voit aussi la tâche (`input.task`). */
async function runInputs(workflow: Workflow, given: Record<string, unknown> | null | undefined, triggerKey: string): Promise<Record<string, unknown>> {
  const trigger = startTrigger(workflow, triggerKey);
  const inputs = resolveInputs(workflowVariables(workflow.definition, trigger.key), given);
  if (triggerEvent(trigger) === 'task.created') {
    const id = String(inputs[TASK_ID_INPUT] ?? '').trim();
    const task = id ? await taskService.get(id).catch(() => null) : null;
    if (!task || task.projectId !== workflow.projectId) throw new AppError(`Tâche ${id} introuvable dans le projet du workflow`);
    inputs[TASK_ID_INPUT] = task.id;
    inputs.task = taskContext(task);
  }
  return inputs;
}

/** Une file à la fois par workflow (un seul serveur Skipper ; un verrou en mémoire suffit). */
const dispatching = new Map<string, Promise<number>>();

/**
 * Démarre les exécutions en file d'un workflow tant qu'il a des places (dans l'ordre d'arrivée). Appelé à
 * chaque nouvelle exécution en file, à la fin d'une exécution, et à chaque passage de l'ordonnanceur.
 * Retenu pendant la maintenance.
 */
export async function dispatchQueue(workflowId: string): Promise<number> {
  if (serverSettings.maintenance) return 0;
  const pending = dispatching.get(workflowId);
  if (pending) return pending;
  const job = (async () => {
    let started = 0;
    while ((await workflowRepository.countActive(workflowId)) < MAX_ACTIVE_RUNS) {
      const run = await workflowRepository.dequeue(workflowId);
      if (!run) break;
      const workflow = await workflowRepository.findById(workflowId);
      if (!workflow) break;
      started++;
      void executeWorkflowRun(workflow, run).catch((err) => console.error(`[workflows] exécution ${run.id}`, err));
    }
    return started;
  })().finally(() => dispatching.delete(workflowId));
  dispatching.set(workflowId, job);
  return job;
}

onRunSettled((run) => void dispatchQueue(run.workflowId).catch((err) => console.error(`[workflows] file du workflow ${run.workflowId}`, err)));

export const workflowService = {
  list: (filter?: { projectId?: string; projectIds?: string[] }) => workflowRepository.list(filter),
  find: (id: string) => workflowRepository.findById(id),
  listUsingAgent: (agentId: string) => workflowRepository.listUsingAgent(agentId),

  async get(id: string): Promise<Workflow> {
    const workflow = await workflowRepository.findById(id);
    if (!workflow) throw new NotFoundError('Workflow introuvable');
    return workflow;
  },

  async create(projectId: string, input: WorkflowInput, userId: string | null): Promise<Workflow> {
    await projectService.get(projectId);
    return workflowRepository.create(projectId, await validate(input, userId), userId);
  },

  async update(id: string, input: WorkflowInput, userId: string | null = null): Promise<Workflow> {
    const current = await this.get(id);
    const updated = await workflowRepository.update(id, await validate(input, userId, current));
    if (!updated) throw new NotFoundError('Workflow introuvable');
    return updated;
  },

  async delete(id: string): Promise<boolean> {
    await this.get(id);
    return workflowRepository.delete(id);
  },

  /** Problèmes d'un graphe (les erreurs bloquent les exécutions, pas les avertissements), vérifiés contre les agents du projet. */
  async issues(projectId: string, definition: unknown): Promise<WorkflowIssue[]> {
    let def: WorkflowDefinition;
    try {
      def = normalizeDefinition(definition);
    } catch (err) {
      return [{ nodeKey: null, severity: 'error', message: (err as Error).message }];
    }
    return issuesOf(def, projectId);
  },

  /** Lance une exécution en tâche de fond et la renvoie aussitôt (l'interface la suit par sondage). `triggerKey` : déclencheur de départ. */
  async run(id: string, opts: { inputs?: Record<string, unknown> | null; trigger: RunTrigger; ownerId: string | null; triggerKey?: string | null }): Promise<WorkflowRun> {
    const workflow = await this.get(id);
    const start = startTrigger(workflow, opts.triggerKey);
    const errors = (await issuesOf(workflow.definition, workflow.projectId)).filter((i) => i.severity === 'error');
    if (errors.length) throw new AppError(`Le workflow ne peut pas s'exécuter : ${errors.map((e) => e.message).join(' · ')}`);
    if ((await workflowRepository.countActive(id)) >= MAX_ACTIVE_RUNS) throw new AppError(`Au plus ${MAX_ACTIVE_RUNS} exécutions de ce workflow peuvent être actives en même temps`);
    const inputs = await runInputs(workflow, opts.inputs, start.key);
    const run = await workflowRepository.createRun({ workflowId: id, projectId: workflow.projectId, ownerId: opts.ownerId, trigger: opts.trigger, triggerKey: start.key, definition: workflow.definition, inputs });
    void executeWorkflowRun(workflow, run).catch((err) => console.error(`[workflows] exécution ${run.id}`, err));
    return run;
  },

  /** Met en file une exécution déclenchée par un événement : elle démarre dès que le workflow a une place. Une exécution impossible est enregistrée en échec. */
  async enqueue(workflow: Workflow, opts: { triggerKey: string; inputs: Record<string, unknown>; ownerId: string | null; reason: string }): Promise<WorkflowRun> {
    let inputs: Record<string, unknown> = opts.inputs;
    let problem: string | null = null;
    try {
      const errors = (await issuesOf(workflow.definition, workflow.projectId)).filter((i) => i.severity === 'error');
      if (errors.length) throw new AppError(`Le workflow ne peut pas s'exécuter : ${errors.map((e) => e.message).join(' · ')}`);
      if (!opts.ownerId) throw new AppError("Personne ne possède le déclencheur : enregistrez le workflow à nouveau pour que ses exécutions utilisent vos comptes");
      inputs = await runInputs(workflow, opts.inputs, opts.triggerKey);
    } catch (err) {
      problem = (err as Error).message;
    }
    const run = await workflowRepository.createRun({ workflowId: workflow.id, projectId: workflow.projectId, ownerId: opts.ownerId, trigger: 'event', triggerKey: opts.triggerKey, definition: workflow.definition, inputs, status: problem ? 'pending' : 'queued' });
    await workflowRepository.addLog(run.id, problem ? 'error' : 'info', problem ? `${opts.reason} — non démarrée : ${problem}` : `${opts.reason} — en file`, null, null);
    if (problem) {
      const finishedAt = new Date();
      return (await workflowRepository.updateRun(run.id, { status: 'failed', error: problem, finishedAt, heartbeatAt: finishedAt })) ?? run;
    }
    await dispatchQueue(workflow.id);
    return run;
  },

  async getRun(id: string): Promise<WorkflowRun> {
    const run = await workflowRepository.findRun(id);
    if (!run) throw new NotFoundError('Exécution introuvable');
    return run;
  },
  findRun: (id: string) => workflowRepository.findRun(id),
  listRuns: (filter?: WorkflowRunFilter) => workflowRepository.listRuns(filter),
  lastRun: (workflowId: string) => workflowRepository.lastRun(workflowId),
  runNodes: (runId: string) => workflowRepository.listNodes(runId),
  runLogs: (runId: string, opts?: { after?: string | null; limit?: number }) => workflowRepository.listLogs(runId, opts),

  async cancelRun(id: string): Promise<WorkflowRun> {
    await this.getRun(id);
    return cancelWorkflowRun(id);
  },

  async setSchedule(id: string, input: AutomationScheduleInput, inputs: Record<string, unknown> | null | undefined, userId: string | null): Promise<Workflow> {
    const workflow = await this.get(id);
    const schedule = prepareSchedule(input);
    const resolved = resolveInputs(workflowVariables(workflow.definition), inputs);
    const updated = await workflowRepository.setSchedule(id, { ...schedule, inputs: resolved, ownerId: userId });
    if (!updated) throw new NotFoundError('Workflow introuvable');
    return updated;
  },

  async clearSchedule(id: string): Promise<Workflow> {
    const workflow = await this.get(id);
    const updated = await workflowRepository.setSchedule(id, { cron: null, timezone: workflow.schedule?.timezone ?? DEFAULT_TIMEZONE, enabled: false, inputs: {}, ownerId: null, nextRunAt: null });
    if (!updated) throw new NotFoundError('Workflow introuvable');
    return updated;
  },
};
