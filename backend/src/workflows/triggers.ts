import { agentRepository } from '../agents/repository.js';
import { sessionRepository } from '../sessions/repository.js';
import { taskService } from '../tasks/service.js';
import type { Task, TaskActor } from '../tasks/types.js';
import { TASK_ID_INPUT, triggersFor } from './graph.js';
import { workflowRepository } from './repository.js';
import { workflowService } from './service.js';
import { taskMatches } from './taskFilter.js';
import type { Workflow, WorkflowNode } from './types.js';

/**
 * Déclencheurs événementiels des workflows : une tâche créée dans un projet démarre les workflows actifs du
 * projet dont un déclencheur « tâche créée » accepte la tâche. Les exécutions sont mises en file
 * (`workflowService.enqueue`) : une rafale de tâches n'est jamais refusée.
 */

/** Profondeur maximale de remontée des sessions parentes pour la garde anti-boucle. */
const MAX_SESSION_DEPTH = 10;

/** Le filtre d'un déclencheur « tâche créée » accepte-t-il la tâche (un filtre vide accepte tout) ? */
export function filterAccepts(trigger: WorkflowNode, task: Task): boolean {
  return trigger.taskFilter ? taskMatches(trigger.taskFilter, task) : true;
}

/** Le premier déclencheur acceptant l'événement : un workflow à plusieurs déclencheurs à l'écoute ne s'exécute qu'une fois. */
function firstAccepting(triggers: WorkflowNode[], accepts: (t: WorkflowNode) => boolean): WorkflowNode | null {
  return triggers.find(accepts) ?? null;
}

/** Workflows dont les exécutions ont mené à la session qui crée la tâche (elle ou l'une de ses parentes) : une tâche proposée par un agent d'un workflow ne le redémarre jamais. */
async function workflowsBehind(sessionId: string): Promise<Set<string>> {
  const out = new Set<string>();
  let id: string | null = sessionId;
  for (let depth = 0; id && depth < MAX_SESSION_DEPTH; depth++) {
    const session = await sessionRepository.findById(id);
    if (!session) break;
    if (session.workflowRunId) {
      const workflowRun = await workflowRepository.findRun(session.workflowRunId);
      if (workflowRun) out.add(workflowRun.workflowId);
    }
    if (session.agentRunId) {
      const agentRun = await agentRepository.findRun(session.agentRunId);
      const workflowRun = agentRun?.workflowRunId ? await workflowRepository.findRun(agentRun.workflowRunId) : null;
      if (workflowRun) out.add(workflowRun.workflowId);
    }
    id = session.parentSessionId;
  }
  return out;
}

export async function handleTaskCreated(task: Task, actor: TaskActor): Promise<void> {
  const workflows = (await workflowRepository.list({ projectId: task.projectId })).filter((w) => w.enabled && triggersFor(w.definition, 'task.created').length > 0);
  if (!workflows.length) return;
  const behind = actor.type === 'agent' && actor.sessionId ? await workflowsBehind(actor.sessionId) : new Set<string>();
  // Créée par un nœud « créer une tâche » : ne redémarre pas non plus son propre workflow.
  if (actor.workflowRunId) {
    const workflowRun = await workflowRepository.findRun(actor.workflowRunId);
    if (workflowRun) behind.add(workflowRun.workflowId);
  }
  for (const workflow of workflows) {
    if (behind.has(workflow.id)) {
      console.log(`[workflows] tâche ${task.id} créée par une session du workflow ${workflow.id} : pas de nouveau déclenchement`);
      continue;
    }
    const trigger = firstAccepting(triggersFor(workflow.definition, 'task.created'), (t) => filterAccepts(t, task));
    if (!trigger) continue;
    try {
      await workflowService.enqueue(workflow, { triggerKey: trigger.key, inputs: { [TASK_ID_INPUT]: task.id }, ownerId: workflow.eventOwnerId ?? workflow.createdById, reason: `Tâche créée : « ${task.title} »` });
    } catch (err) {
      console.error(`[workflows] mise en file du workflow ${workflow.id} pour la tâche ${task.id}`, err);
    }
  }
}

/** Branche le déclencheur sur les créations de tâches (au démarrage du serveur). */
export function registerWorkflowTriggers(): void {
  taskService.onTaskCreated('workflows', handleTaskCreated);
}

export type { Workflow };
