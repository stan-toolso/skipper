import { failStaleAgentRuns, startAgentRun } from '../agents/execution.js';
import { agentRepository } from '../agents/repository.js';
import type { Agent } from '../agents/types.js';
import { nextRun, parseCron } from '../schedules/cron.js';
import { serverSettings } from '../settings/server.js';
import { failStaleWorkflowRuns } from './engine.js';
import { workflowRepository } from './repository.js';
import { dispatchQueue, workflowService } from './service.js';
import type { Workflow } from './types.js';

const TICK_MS = 30_000;
/** Une échéance manquée (serveur arrêté) est encore exécutée si elle date de moins de dix minutes ; au-delà, on attend la suivante. */
const MISSED_GRACE_MS = 10 * 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Ordonnanceur des agents et des workflows : toutes les trente secondes, les échéances passées sont
 * réservées atomiquement et lancées ; les exécutions perdues par un arrêt du serveur passent en échec.
 */
async function runScheduledAgent(agent: Agent): Promise<void> {
  if (serverSettings.maintenance) {
    await agentRepository.setLastResult(agent.id, 'Ignorée : le serveur est en maintenance');
    return;
  }
  const active = await agentRepository.listRuns({ agentId: agent.id, status: ['pending', 'running'], limit: 1 });
  if (active.length) {
    await agentRepository.setLastResult(agent.id, "Ignorée : l'exécution précédente n'est pas terminée");
    return;
  }
  await startAgentRun(agent, { inputs: agent.scheduleInputs, trigger: 'schedule', ownerId: agent.scheduleOwnerId ?? agent.createdById });
}

async function runScheduledWorkflow(workflow: Workflow): Promise<void> {
  if (!workflow.enabled) {
    await workflowRepository.setLastResult(workflow.id, 'Ignorée : le workflow est en pause');
    return;
  }
  if (serverSettings.maintenance) {
    await workflowRepository.setLastResult(workflow.id, 'Ignorée : le serveur est en maintenance');
    return;
  }
  if (await workflowRepository.countActive(workflow.id)) {
    await workflowRepository.setLastResult(workflow.id, "Ignorée : l'exécution précédente n'est pas terminée");
    return;
  }
  try {
    await workflowService.run(workflow.id, { inputs: workflow.scheduleInputs, trigger: 'schedule', ownerId: workflow.scheduleOwnerId ?? workflow.createdById });
  } catch (err) {
    await workflowRepository.setLastResult(workflow.id, `Erreur : ${(err as Error).message}`);
  }
}

interface Scheduled {
  id: string;
  schedule: { cron: string; timezone: string; nextRunAt: Date | null } | null;
}

async function tickKind<T extends Scheduled>(kind: string, due: T[], claim: (id: string, expected: Date, next: Date | null, now: Date) => Promise<T | null>, setResult: (id: string, result: string) => Promise<void>, run: (item: T) => Promise<void>, now: Date): Promise<void> {
  for (const item of due) {
    if (!item.schedule?.nextRunAt) continue;
    let next: Date | null = null;
    try {
      next = nextRun(parseCron(item.schedule.cron), now, item.schedule.timezone);
    } catch (err) {
      console.error(`[automation] expression cron invalide (${kind} ${item.id}) : ${(err as Error).message}`);
    }
    const claimed = await claim(item.id, item.schedule.nextRunAt, next, now);
    if (!claimed) continue;
    if (now.getTime() - item.schedule.nextRunAt.getTime() > MISSED_GRACE_MS) {
      await setResult(item.id, `Échéance du ${item.schedule.nextRunAt.toISOString()} manquée (serveur arrêté), non rattrapée`);
      continue;
    }
    await run(claimed).catch((err) => console.error(`[automation] exécution planifiée (${kind} ${item.id})`, err));
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const lostAgents = await failStaleAgentRuns(now);
    const lostWorkflows = await failStaleWorkflowRuns(now);
    if (lostAgents || lostWorkflows) console.warn(`[automation] exécutions perdues passées en échec : ${lostAgents} agent(s), ${lostWorkflows} workflow(s)`);
    await tickKind('agent', await agentRepository.listDue(now), agentRepository.claim.bind(agentRepository), agentRepository.setLastResult.bind(agentRepository), runScheduledAgent, now);
    await tickKind('workflow', await workflowRepository.listDue(now), workflowRepository.claim.bind(workflowRepository), workflowRepository.setLastResult.bind(workflowRepository), runScheduledWorkflow, now);
    // Exécutions restées en file (serveur arrêté, maintenance levée).
    for (const workflowId of await workflowRepository.listWithQueue()) await dispatchQueue(workflowId).catch((err) => console.error(`[automation] file du workflow ${workflowId}`, err));
  } finally {
    ticking = false;
  }
}

export const automationScheduler = {
  /** Démarrage : les échéances manquées depuis plus de dix minutes sont recalculées (pas de rattrapage en rafale), puis la boucle démarre. */
  async start(): Promise<number> {
    const now = new Date();
    let skipped = 0;
    const recompute = async <T extends Scheduled>(items: T[], setNext: (id: string, next: Date | null) => Promise<void>, setResult: (id: string, result: string) => Promise<void>) => {
      for (const item of items) {
        if (!item.schedule) continue;
        if (item.schedule.nextRunAt && now.getTime() - item.schedule.nextRunAt.getTime() <= MISSED_GRACE_MS) continue;
        try {
          await setNext(item.id, nextRun(parseCron(item.schedule.cron), now, item.schedule.timezone));
          if (item.schedule.nextRunAt) {
            skipped++;
            await setResult(item.id, `Échéance du ${item.schedule.nextRunAt.toISOString()} manquée (serveur arrêté), non rattrapée`);
          }
        } catch (err) {
          console.error(`[automation] expression cron invalide (${item.id}) : ${(err as Error).message}`);
        }
      }
    };
    await recompute(await agentRepository.listScheduled(), agentRepository.setNextRunAt.bind(agentRepository), agentRepository.setLastResult.bind(agentRepository));
    await recompute(await workflowRepository.listScheduled(), workflowRepository.setNextRunAt.bind(workflowRepository), workflowRepository.setLastResult.bind(workflowRepository));
    timer = setInterval(() => void tick().catch((err) => console.error('[automation] ordonnanceur', err)), TICK_MS);
    timer.unref();
    return skipped;
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
