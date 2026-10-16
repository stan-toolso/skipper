import { cancelAgentRun, collectOutput, HEARTBEAT_MS, runAgent, STALE_AFTER_MS } from '../agents/execution.js';
import { agentRepository } from '../agents/repository.js';
import { agentService } from '../agents/service.js';
import { render } from '../agents/template.js';
import type { Agent, AgentRun } from '../agents/types.js';
import { notificationService } from '../notifications/service.js';
import { projectService, slugify } from '../projects/service.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { startTaskSession } from '../tasks/launch.js';
import { taskService } from '../tasks/service.js';
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from '../tasks/types.js';
import { userRepository } from '../users/repository.js';
import { userService } from '../users/service.js';
import { ROLE_RANK, type User } from '../users/types.js';
import { worksessionService } from '../worksessions/service.js';
import { conditionHolds, describeCondition } from './conditions.js';
import { evaluateCondition } from './expressions.js';
import { failureHandled, nextSteps, parseTaskPerson, peopleRefs, taskContext, triggerOf, type NodeState } from './graph.js';
import { workflowRepository } from './repository.js';
import { FALLIBLE_NODE_TYPES, type LogLevel, type Workflow, type WorkflowNode, type WorkflowNodeType, type WorkflowRun } from './types.js';

/** Appelés quand une exécution est réglée (la file de son workflow peut avancer). */
const settledListeners: ((run: WorkflowRun) => void)[] = [];
export const onRunSettled = (listener: (run: WorkflowRun) => void): void => void settledListeners.push(listener);

/** Exécutions annulées depuis ce processus (le moteur relit aussi le drapeau en base). */
const cancelled = new Set<string>();

interface NodeContext {
  status: string;
  output: unknown;
  json?: unknown;
  result?: boolean;
  error?: string | null;
  sessionId?: string | null;
  costUsd?: number;
  /** Agent qui résout une tâche : la tâche après le tour (statut, branche…) ; tâche créée par un nœud « créer une tâche ». */
  task?: Record<string, unknown> | null;
  /** Nœud « session » : la branche de sa work session. */
  branch?: string | null;
}

/** Ce que voient les modèles et les conditions pendant une exécution. */
export interface RunContext {
  input: Record<string, unknown>;
  nodes: Record<string, NodeContext>;
  run: { id: string; startedAt: string; trigger: string; triggerKey: string | null };
  workflow: { id: string; name: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isActive = (run: WorkflowRun) => run.status === 'pending' || run.status === 'running';
const STEP_VERBS: Record<WorkflowNodeType, string> = { trigger: 'Départ', agent: "Exécution de l'agent", task: 'Traitement de la tâche', session: 'Ouverture de la session', createTask: 'Création de la tâche', condition: 'Évaluation de la condition', end: 'Fin atteinte' };
const fmtCost = (usd: number) => `${usd.toFixed(usd < 0.1 ? 3 : 2).replace('.', ',')} $`;

/** Ce qu'un nœud garde de son contexte dans son enregistrement (`workflow_run_nodes.output`). */
function recordOf(ctx: NodeContext): Record<string, unknown> {
  return { output: ctx.output, json: ctx.json ?? null, ...(ctx.task ? { task: ctx.task } : {}), ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(ctx.branch ? { branch: ctx.branch } : {}) };
}

class Execution {
  private readonly states = new Map<string, NodeState>();
  private readonly context: RunContext;
  private readonly agents: Map<string, Agent>;
  private readonly endOutputs: Record<string, string> = {};
  private costUsd = 0;
  private fatal: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly workflow: Workflow,
    private run: WorkflowRun,
    agents: Agent[],
  ) {
    this.agents = new Map(agents.map((a) => [a.id, a]));
    this.context = { input: run.inputs, nodes: {}, run: { id: run.id, startedAt: new Date().toISOString(), trigger: run.trigger, triggerKey: triggerOf(run.definition, run.triggerKey)?.key ?? null }, workflow: { id: workflow.id, name: workflow.name } };
  }

  private get def() {
    return this.run.definition;
  }

  private node(key: string): WorkflowNode {
    const node = this.def.nodes.find((n) => n.key === key);
    if (!node) throw new Error(`Nœud ${key} introuvable`);
    return node;
  }

  private label(node: WorkflowNode): string {
    return node.label?.trim() || node.key;
  }

  private async log(level: LogLevel, message: string, nodeKey: string | null = null, data: unknown = null): Promise<void> {
    await workflowRepository.addLog(this.run.id, level, message, nodeKey, data).catch((err) => console.warn(`[workflows] journal de ${this.run.id} : ${(err as Error).message}`));
  }

  private async setState(key: string, state: NodeState, patch: Parameters<typeof workflowRepository.upsertNode>[3] = {}): Promise<void> {
    this.states.set(key, state);
    await workflowRepository.upsertNode(this.run.id, key, this.node(key).type, { status: state.status, ...patch });
  }

  private async isCancelled(): Promise<boolean> {
    if (cancelled.has(this.run.id)) return true;
    const fresh = await workflowRepository.findRun(this.run.id);
    if (!fresh) return true;
    this.run = fresh;
    return fresh.cancelRequested || !isActive(fresh);
  }

  async start(): Promise<WorkflowRun> {
    const startedAt = new Date();
    this.run = (await workflowRepository.updateRun(this.run.id, { status: 'running', startedAt, heartbeatAt: startedAt })) ?? this.run;
    this.heartbeat = setInterval(() => void workflowRepository.updateRun(this.run.id, { heartbeatAt: new Date() }).catch(() => undefined), HEARTBEAT_MS);
    this.heartbeat.unref();
    const start = triggerOf(this.def, this.run.triggerKey);
    await this.log('info', `Exécution démarrée (${this.run.trigger}${start && this.def.nodes.filter((n) => n.type === 'trigger').length > 1 ? `, depuis « ${this.label(start)} »` : ''})`, null, { inputs: this.run.inputs });
    try {
      await this.loop();
    } catch (err) {
      this.fatal = this.fatal ?? (err as Error).message;
      console.error(`[workflows] exécution ${this.run.id} plantée`, err);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
    }
    return this.finish();
  }

  private async loop(): Promise<void> {
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (await this.isCancelled()) {
        await this.log('warn', 'Annulation demandée : arrêt des étapes en cours');
        await this.cancelRunning(running);
        return;
      }
      if (this.fatal) {
        await this.cancelRunning(running);
        return;
      }
      const { run: toRun, skip } = nextSteps(this.def, this.states, this.run.triggerKey);
      for (const key of skip) {
        await this.setState(key, { status: 'skipped' }, { finishedAt: new Date() });
        this.context.nodes[key] = { status: 'skipped', output: null };
        const skipped = this.node(key);
        await this.log('debug', `« ${this.label(skipped)} » passé : ${skipped.type === 'trigger' ? "l'exécution est partie d'un autre déclencheur" : "aucune branche active n'y mène"}`, key);
      }
      for (const key of toRun) {
        const promise = this.executeNode(key).finally(() => running.delete(key));
        running.set(key, promise);
      }
      if (running.size === 0) {
        if (!skip.length && !toRun.length) return;
        continue;
      }
      await Promise.race(running.values());
    }
  }

  /** Marque annulés les nœuds en attente et arrête les exécutions d'agent encore en cours. */
  private async cancelRunning(running: Map<string, Promise<void>>): Promise<void> {
    const active = await agentRepository.listRuns({ workflowRunId: this.run.id, status: ['pending', 'running'] });
    for (const ar of active) await cancelAgentRun(ar.id).catch(() => undefined);
    await Promise.allSettled(running.values());
    for (const n of this.def.nodes) {
      const status = this.states.get(n.key)?.status ?? 'pending';
      if (status === 'pending' || status === 'running') await this.setState(n.key, { status: 'cancelled' }, { finishedAt: new Date() });
    }
  }

  private async executeNode(key: string): Promise<void> {
    const node = this.node(key);
    const startedAt = new Date();
    await this.setState(key, { status: 'running' }, { startedAt });
    await this.log('info', `${STEP_VERBS[node.type] ?? 'Départ'} « ${this.label(node)} »`, key);
    try {
      let state: NodeState;
      let ctx: NodeContext;
      switch (node.type) {
        case 'trigger':
          ctx = { status: 'succeeded', output: this.run.inputs };
          state = { status: 'succeeded' };
          break;
        case 'agent':
        case 'task':
        case 'session':
        case 'createTask': {
          const result = node.type === 'agent' ? await this.executeAgent(node) : node.type === 'task' ? await this.executeTask(node) : node.type === 'session' ? await this.executeSession(node) : await this.executeCreateTask(node);
          ctx = result.ctx;
          state = { status: result.ok ? 'succeeded' : 'failed' };
          if (!result.ok) {
            this.context.nodes[key] = ctx;
            await this.setState(key, state, { output: recordOf(node.type === 'agent' ? { ...ctx, sessionId: null } : ctx), error: ctx.error ?? 'échec', finishedAt: new Date() });
            if (failureHandled(this.def, key)) await this.log('warn', `« ${this.label(node)} » a échoué : ${ctx.error ?? 'erreur'} — on suit sa branche « en cas d'erreur »`, key);
            else {
              this.fatal = `« ${this.label(node)} » a échoué : ${ctx.error ?? 'erreur'}`;
              await this.log('error', this.fatal, key);
            }
            return;
          }
          break;
        }
        case 'condition': {
          const result = node.condition ? conditionHolds(node.condition, this.context) : evaluateCondition(node.expression ?? '', this.context);
          ctx = { status: 'succeeded', output: result, result };
          state = { status: 'succeeded', branch: result };
          await this.log('info', `« ${this.label(node)} » → ${result ? 'oui' : 'non'}`, key, { expression: node.condition ? describeCondition(node.condition) : node.expression });
          break;
        }
        case 'end': {
          const text = render(node.message ?? '', this.context).trim();
          this.endOutputs[key] = text;
          ctx = { status: 'succeeded', output: text };
          state = { status: 'succeeded' };
          break;
        }
        default:
          throw new Error(`Type de nœud inconnu ${String(node.type)}`);
      }
      this.context.nodes[key] = ctx;
      await this.setState(key, state, { output: recordOf(node.type === 'agent' ? { ...ctx, sessionId: null } : ctx), finishedAt: new Date() });
      if (node.type !== 'condition') await this.log('info', `« ${this.label(node)} » terminé`, key, FALLIBLE_NODE_TYPES.includes(node.type) ? { durationMs: Date.now() - startedAt.getTime() } : null);
    } catch (err) {
      const message = (err as Error).message;
      this.context.nodes[key] = { status: 'failed', output: null, error: message };
      await this.setState(key, { status: 'failed' }, { error: message, finishedAt: new Date() });
      this.fatal = `« ${this.label(node)} » a échoué : ${message}`;
      await this.log('error', this.fatal, key);
    }
  }

  /** La tâche qu'un nœud nomme, si elle peut être prise (même projet, ouverte, pas déjà traitée par une session). */
  private async takeableTask(taskId: string): Promise<{ task: Task | null; error: string | null }> {
    const task = taskId ? await taskService.get(taskId).catch(() => null) : null;
    if (!task || task.projectId !== this.workflow.projectId) return { task: null, error: taskId ? `Tâche ${taskId} introuvable dans ce projet` : "L'identifiant de la tâche est vide" };
    if (task.sessionId && task.status !== 'todo') return { task, error: `La tâche « ${task.title} » est déjà traitée par une autre session` };
    if (task.status === 'done' || task.status === 'cancelled') return { task, error: `La tâche « ${task.title} » est ${task.status === 'done' ? 'terminée' : 'annulée'}` };
    return { task, error: null };
  }

  private snapshot(t: Task | null) {
    return t ? { ...taskContext(t), branch: t.branch } : null;
  }

  /** Nœud « tâche » : une session sur la tâche, configurée sur le nœud. La session reste ouverte pour l'humain qui prend le relais. */
  private async executeTask(node: WorkflowNode): Promise<{ ok: boolean; ctx: NodeContext }> {
    const taskId = render(node.taskId ?? '', this.context).trim();
    const instructions = render(node.prompt ?? '', this.context).trim();
    const ownerRefs = peopleRefs(render(node.sessionOwner ?? '', this.context));
    await workflowRepository.upsertNode(this.run.id, node.key, 'task', { input: { taskId, instructions, provider: node.provider, worksession: node.worksessionMode, ...(ownerRefs.length ? { owner: ownerRefs[0] } : {}) } });
    const taken = await this.takeableTask(taskId);
    if (taken.error) return { ok: false, ctx: { status: 'failed', output: null, error: taken.error, task: this.snapshot(taken.task) } };
    const people = await this.sessionOwner(node.key, ownerRefs);

    let session: Session;
    try {
      const created = await startTaskSession(taskId, {
        ownerId: people.ownerId,
        provider: node.provider || 'claude',
        config: node.config ?? {},
        worksessionId: node.worksessionMode === 'existing' ? (node.worksessionId ?? null) : null,
        instructions,
        includeTask: node.includeTask !== false,
        workflowRunId: this.run.id,
        autoStart: false,
      });
      session = await sessionService.start(created.id);
    } catch (err) {
      const fresh = await taskService.get(taskId).catch(() => null);
      return { ok: false, ctx: { status: 'failed', output: null, error: (err as Error).message, task: this.snapshot(fresh) } };
    }
    await this.log('info', `Session démarrée sur la tâche « ${taken.task!.title} »${people.owner ? ` pour ${people.owner.name}` : ''}`, node.key, { sessionId: session.id, taskId, ownerId: session.ownerId });
    const result = async (extra: Partial<NodeContext> & { ok: boolean }) => {
      const { ok, ...rest } = extra;
      const t = await taskService.get(taskId).catch(() => null);
      return { ok, ctx: { status: ok ? 'succeeded' : 'failed', output: '', sessionId: session.id, costUsd: session.costUsd, ...rest, task: this.snapshot(t) } as NodeContext };
    };
    if (node.wait === false) return result({ ok: true });
    const turn = await this.awaitTurn(node, session);
    if (!turn.settled) return result({ ok: false, error: turn.error });
    await this.log('info', `La session de « ${this.label(node)} » reste ouverte sur la tâche`, node.key, { sessionId: session.id, taskId });
    return result({ ok: !turn.error, output: turn.output, error: turn.error, costUsd: turn.session.costUsd });
  }

  /** Attend la fin du premier tour de la session d'un nœud, dans son délai ; une exécution annulée arrête la session. */
  private async awaitTurn(node: WorkflowNode, started: Session): Promise<{ settled: boolean; session: Session; output: string; error: string | null }> {
    let session = started;
    const timeoutMs = (node.timeoutMinutes ?? 60) * 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      session = await sessionService.waitForIdle(session.id, Math.max(1000, Math.min(deadline - Date.now(), HEARTBEAT_MS)));
      const settled = (session.status !== 'running' && session.status !== 'queued' && session.status !== 'pending') || session.activity === 'idle';
      if (settled) break;
      if (await this.isCancelled()) {
        await sessionService.stop(session.id).catch(() => undefined);
        return { settled: false, session, output: '', error: 'Annulée : la session a été arrêtée' };
      }
      if (Date.now() >= deadline) return { settled: false, session, output: '', error: `Encore au travail après ${Math.round(timeoutMs / 60_000)} min : la session reste ouverte` };
    }
    this.costUsd += session.costUsd;
    const { output, error } = await collectOutput(session);
    const failure = error ?? (session.status === 'failed' ? (session.error ?? 'La session a échoué') : session.status === 'stopped' || session.status === 'interrupted' ? `La session a été ${session.status === 'stopped' ? 'arrêtée' : 'interrompue'}` : null);
    return { settled: true, session, output, error: failure };
  }

  /** Nœud « session » : une session sans tâche, configurée sur le nœud. */
  private async executeSession(node: WorkflowNode): Promise<{ ok: boolean; ctx: NodeContext }> {
    const name = render(node.sessionName ?? '', this.context).trim().slice(0, 80) || this.label(node);
    const instructions = render(node.prompt ?? '', this.context).trim();
    const ownerRefs = peopleRefs(render(node.sessionOwner ?? '', this.context));
    const mode = node.worksessionMode === 'existing' ? 'existing' : 'new';
    const branch = mode === 'new' ? render(node.branch ?? '', this.context).trim() || `workflow/${slugify(this.label(node)).slice(0, 40) || node.key}-${this.run.id.slice(0, 8)}` : null;
    await workflowRepository.upsertNode(this.run.id, node.key, 'session', { input: { name, instructions, provider: node.provider, worksession: mode, ...(branch ? { branch } : {}), ...(ownerRefs.length ? { owner: ownerRefs[0] } : {}) } });
    if (!instructions) return { ok: false, ctx: { status: 'failed', output: null, error: "L'instruction est vide" } };
    const people = await this.sessionOwner(node.key, ownerRefs);

    let session: Session;
    let worksessionBranch: string | null = null;
    try {
      let worksessionId: string | null = null;
      if (mode === 'existing') {
        worksessionId = node.worksessionId ?? null;
        worksessionBranch = worksessionId ? (await worksessionService.get(worksessionId)).branch : null;
      } else if (branch) {
        const worksession = await this.branchWorksession(node, branch, name, people.ownerId);
        worksessionId = worksession.id;
        worksessionBranch = worksession.branch;
      }
      const created = await sessionService.create({ projectId: this.workflow.projectId, worksessionId, name, provider: node.provider || 'claude', prompt: instructions, config: node.config ?? {}, ownerId: people.ownerId, workflowRunId: this.run.id, autoStart: false });
      session = await sessionService.start(created.id);
    } catch (err) {
      return { ok: false, ctx: { status: 'failed', output: null, error: (err as Error).message, branch: worksessionBranch } };
    }
    await this.log('info', `Session « ${name} » démarrée${people.owner ? ` pour ${people.owner.name}` : ''}`, node.key, { sessionId: session.id, ownerId: session.ownerId, ...(worksessionBranch ? { branch: worksessionBranch } : {}) });
    const base: NodeContext = { status: 'succeeded', output: '', sessionId: session.id, costUsd: session.costUsd, branch: worksessionBranch };
    if (node.wait === false) return { ok: true, ctx: base };

    const turn = await this.awaitTurn(node, session);
    if (!turn.settled) return { ok: false, ctx: { ...base, status: 'failed', error: turn.error } };
    const alive = turn.session.status === 'running' || turn.session.status === 'queued' || turn.session.status === 'pending';
    if (node.endAfterTurn && alive) {
      await sessionService
        .end(session.id)
        .then(() => this.log('info', `La session de « ${this.label(node)} » est terminée`, node.key, { sessionId: session.id }))
        .catch((err) => this.log('warn', `Impossible de terminer la session : ${(err as Error).message}`, node.key));
    } else if (!alive) await this.log('info', `La session de « ${this.label(node)} » est finie (${turn.session.status})`, node.key, { sessionId: session.id });
    else await this.log('info', `La session de « ${this.label(node)} » reste ouverte`, node.key, { sessionId: session.id });
    return { ok: !turn.error, ctx: { ...base, status: turn.error ? 'failed' : 'succeeded', output: turn.output, error: turn.error, costUsd: turn.session.costUsd } };
  }

  /**
   * La work session d'un nœud « session » sur `branch` : celle du projet sur cette branche s'il en existe une,
   * sinon une nouvelle (projet sans dépôt : un dossier nommé d'après la branche).
   */
  private async branchWorksession(node: WorkflowNode, branch: string, label: string, userId: string | null) {
    const project = await projectService.get(this.workflow.projectId);
    const wanted = project.gitUrl ? branch : slugify(branch);
    const existing = (await worksessionService.listByProject(project.id)).find((w) => w.branch === wanted);
    if (existing) {
      await this.log('info', `Travail dans la work session existante ${project.gitUrl ? `de la branche ${branch}` : `« ${existing.name} »`}`, node.key, { worksessionId: existing.id });
      return existing;
    }
    try {
      const worksession = await worksessionService.create(project.id, { branch: project.gitUrl ? branch : null, name: project.gitUrl ? null : wanted, label }, userId);
      await this.log('info', `Work session créée${project.gitUrl ? ` sur la branche ${branch}` : ` : ${worksession.name}`}`, node.key, { worksessionId: worksession.id });
      return worksession;
    } catch (err) {
      throw new Error(`Impossible de créer la work session ${branch} : ${(err as Error).message}`);
    }
  }

  /** Nœud « créer une tâche » : une tâche du projet d'après les modèles du nœud. Créée par automatisation : elle peut démarrer les workflows qui écoutent les tâches créées, jamais celui-ci. */
  private async executeCreateTask(node: WorkflowNode): Promise<{ ok: boolean; ctx: NodeContext }> {
    const t = node.newTask;
    const text = (template: string | undefined) => render(template ?? '', this.context).trim();
    const input = {
      title: text(t?.title).replace(/\s+/g, ' ').slice(0, 500),
      description: text(t?.description),
      priority: text(t?.priority),
      status: text(t?.status),
      dueDate: text(t?.dueDate),
      assignee: text(t?.assignee),
      reporter: text(t?.reporter),
      fields: (t?.fields ?? []).map((f) => ({ key: f.key.trim(), value: text(f.value) })).filter((f) => f.key && f.value),
    };
    await workflowRepository.upsertNode(this.run.id, node.key, 'createTask', { input });
    if (!input.title) return { ok: false, ctx: { status: 'failed', output: null, error: 'Le titre de la tâche est vide' } };
    let priority: TaskPriority = 'medium';
    if (input.priority) {
      if ((TASK_PRIORITIES as string[]).includes(input.priority.toLowerCase())) priority = input.priority.toLowerCase() as TaskPriority;
      else await this.log('warn', `Priorité inconnue « ${input.priority} » : la tâche est créée en priorité moyenne`, node.key);
    }
    let status: TaskStatus = 'todo';
    if (input.status) {
      const value = input.status.toLowerCase().replace(/[\s-]+/g, '_');
      if ((TASK_STATUSES as string[]).includes(value)) status = value as TaskStatus;
      else await this.log('warn', `Statut inconnu « ${input.status} » : la tâche est créée à faire`, node.key);
    }
    let dueDate: string | null = null;
    if (input.dueDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) dueDate = input.dueDate;
      else await this.log('warn', `L'échéance « ${input.dueDate} » n'est pas au format AAAA-MM-JJ : la tâche n'en a pas`, node.key);
    }
    try {
      const task = await taskService.create(
        this.workflow.projectId,
        { title: input.title, description: input.description, priority, status, dueDate, customFields: input.fields, assignee: await this.taskPerson(input.assignee), reporter: await this.taskPerson(input.reporter) },
        { type: 'agent', sessionId: null, name: `Workflow ${this.workflow.name}`, workflowRunId: this.run.id },
      );
      await this.log('info', `Tâche « ${task.title} » créée`, node.key, { taskId: task.id });
      return { ok: true, ctx: { status: 'succeeded', output: task.id, task: this.snapshot(task) } };
    } catch (err) {
      return { ok: false, ctx: { status: 'failed', output: null, error: (err as Error).message } };
    }
  }

  /** Une personne d'une tâche créée : un utilisateur de Skipper désigné par son e-mail prête son nom. */
  private async taskPerson(text: string) {
    const person = parseTaskPerson(text);
    if (person?.email && !person.name) {
      const user = await userRepository.findByEmail(person.email).catch(() => null);
      if (user) return { name: user.name, email: person.email };
    }
    return person;
  }

  /** Un membre du projet désigné par un e-mail ou un identifiant, ou pourquoi il ne peut pas lancer la session. */
  private async projectMember(ref: string): Promise<{ user: User | null; problem: string | null }> {
    const user = ref.includes('@') ? await userRepository.findByEmail(ref) : UUID_RE.test(ref) ? await userRepository.findById(ref) : null;
    if (!user) return { user: null, problem: `aucun utilisateur « ${ref} »` };
    const role = await userService.roleFor(user.id, this.workflow.projectId);
    if (!role || ROLE_RANK[role] < ROLE_RANK.member) return { user: null, problem: `${user.name} ne peut pas lancer de session dans ce projet (rôle membre requis)` };
    return { user, problem: null };
  }

  /** Propriétaire de la session d'un nœud « tâche » ou « session », d'après son modèle ; introuvable : le propriétaire de l'exécution (avertissement). */
  private async sessionOwner(nodeKey: string, ownerRefs: string[]): Promise<{ ownerId: string | null; owner: User | null }> {
    let owner: User | null = null;
    if (ownerRefs.length > 1) await this.log('warn', `Plusieurs propriétaires (${ownerRefs.join(', ')}) : le premier est retenu`, nodeKey);
    if (ownerRefs[0]) {
      const found = await this.projectMember(ownerRefs[0]);
      if (found.user) owner = found.user;
      else await this.log('warn', `Propriétaire de la session : ${found.problem} — la session utilise les comptes du propriétaire de l'exécution`, nodeKey);
    }
    return { ownerId: owner?.id ?? this.run.ownerId, owner };
  }

  private async executeAgent(node: WorkflowNode): Promise<{ ok: boolean; ctx: NodeContext }> {
    const agent = node.agentId ? this.agents.get(node.agentId) : undefined;
    if (!agent) return { ok: false, ctx: { status: 'failed', output: null, error: "L'agent de ce nœud n'existe plus" } };
    const inputs: Record<string, unknown> = {};
    for (const [k, template] of Object.entries(node.inputs ?? {})) inputs[k] = render(template, this.context);
    const taskId = node.taskId?.trim() ? render(node.taskId, this.context).trim() : null;
    await workflowRepository.upsertNode(this.run.id, node.key, 'agent', { input: taskId ? { ...inputs, taskId } : inputs });
    if (taskId !== null) {
      const { task, error } = await this.takeableTask(taskId);
      if (error) return { ok: false, ctx: { status: 'failed', output: null, error, task: this.snapshot(task) } };
    }
    let announced = false;
    const onUpdate = (ar: AgentRun) => {
      void workflowRepository.upsertNode(this.run.id, node.key, 'agent', { agentRunId: ar.id }).catch(() => undefined);
      if (ar.sessionId && !announced) {
        announced = true;
        void this.log('info', `Session démarrée pour « ${this.label(node)} » (${agent.name})`, node.key, { sessionId: ar.sessionId, agentRunId: ar.id });
      }
    };
    const { run } = await runAgent(agent, { inputs, trigger: 'workflow', ownerId: this.run.ownerId, workflowRunId: this.run.id, nodeKey: node.key, timeoutMinutes: node.timeoutMinutes ?? null, onUpdate, taskId });
    this.costUsd += run.costUsd;
    const ctx: NodeContext = { status: run.status, output: run.output ?? '', json: run.outputJson ?? null, error: run.error, sessionId: run.sessionId, costUsd: run.costUsd };
    if (taskId) {
      const task = await taskService.get(taskId).catch(() => null);
      ctx.task = this.snapshot(task);
      if (run.sessionId) await this.log('info', `La session de « ${this.label(node)} » reste ouverte sur la tâche${task?.branch ? ` (branche ${task.branch})` : ''}`, node.key, { sessionId: run.sessionId, taskId });
    }
    return { ok: run.status === 'succeeded', ctx };
  }

  private async finish(): Promise<WorkflowRun> {
    const current = (await workflowRepository.findRun(this.run.id)) ?? this.run;
    const wasCancelled = cancelled.has(this.run.id) || current.cancelRequested || current.status === 'cancelled';
    cancelled.delete(this.run.id);
    const status = wasCancelled ? 'cancelled' : this.fatal ? 'failed' : 'succeeded';
    const ends = Object.entries(this.endOutputs);
    const output = ends.length === 0 ? null : ends.length === 1 ? ends[0][1] : Object.fromEntries(ends);
    const finishedAt = new Date();
    const finished = (await workflowRepository.updateRun(this.run.id, { status, output, error: wasCancelled ? 'Annulée' : this.fatal, costUsd: this.costUsd, finishedAt, heartbeatAt: finishedAt })) ?? current;
    await this.log(status === 'succeeded' ? 'info' : status === 'failed' ? 'error' : 'warn', status === 'succeeded' ? 'Exécution réussie' : status === 'failed' ? `Exécution en échec : ${this.fatal}` : 'Exécution annulée', null, { costUsd: this.costUsd });
    this.run = finished;
    for (const listener of settledListeners) listener(finished);
    await this.notify(finished);
    return finished;
  }

  private async notify(run: WorkflowRun): Promise<void> {
    const project = await projectService.get(run.projectId).catch(() => null);
    const duration = run.startedAt ? Math.round((run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime()) : null;
    const details = [duration !== null ? formatDuration(duration) : null, fmtCost(run.costUsd), project?.name ?? null].filter(Boolean).join(' · ');
    if (run.trigger === 'schedule') await workflowRepository.setLastResult(run.workflowId, run.status === 'succeeded' ? `Terminée · ${details}` : `${run.status === 'cancelled' ? 'Annulée' : `Erreur : ${run.error ?? 'échec'}`} · ${details}`).catch(() => undefined);
    if (run.status === 'cancelled') return;
    void notificationService.notify({
      type: run.status === 'succeeded' ? 'workflow.run' : 'workflow.failed',
      title: run.status === 'succeeded' ? `Workflow « ${this.workflow.name} » terminé` : `Workflow « ${this.workflow.name} » en erreur`,
      message: run.status === 'succeeded' ? details : `${run.error ?? 'échec'} · ${details}`,
      link: `/workflows/${run.workflowId}/runs/${run.id}`,
      projectId: run.projectId,
      userId: run.ownerId,
      payload: { workflowId: run.workflowId, runId: run.id, costUsd: run.costUsd },
    });
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Exécute une exécution en attente jusqu'au bout (dans ce processus). */
export async function executeWorkflowRun(workflow: Workflow, run: WorkflowRun): Promise<WorkflowRun> {
  const agents = await agentService.list({ projectId: workflow.projectId });
  return new Execution(workflow, run, agents).start();
}

/** Demande l'arrêt d'une exécution : ses sessions d'agent sont arrêtées, les étapes en attente annulées. */
export async function cancelWorkflowRun(id: string): Promise<WorkflowRun> {
  const run = await workflowRepository.findRun(id);
  if (!run) throw new Error('Exécution introuvable');
  if (run.status === 'queued') {
    const finishedAt = new Date();
    const updated = (await workflowRepository.updateRun(id, { status: 'cancelled', cancelRequested: true, error: 'Annulée', finishedAt, heartbeatAt: finishedAt })) ?? run;
    await workflowRepository.addLog(id, 'warn', "Annulée pendant l'attente en file", null, null).catch(() => undefined);
    return updated;
  }
  if (!isActive(run)) return run;
  cancelled.add(id);
  const updated = (await workflowRepository.updateRun(id, { cancelRequested: true })) ?? run;
  const active = await agentRepository.listRuns({ workflowRunId: id, status: ['pending', 'running'] });
  for (const ar of active) await cancelAgentRun(ar.id).catch(() => undefined);
  return updated;
}

/** Les exécutions perdues par un serveur arrêté (battement périmé) passent en échec ; renvoie leur nombre. */
export async function failStaleWorkflowRuns(now = new Date()): Promise<number> {
  const stale = await workflowRepository.listStaleRuns(new Date(now.getTime() - STALE_AFTER_MS));
  for (const run of stale) {
    const active = await agentRepository.listRuns({ workflowRunId: run.id, status: ['pending', 'running'] });
    for (const ar of active) {
      await agentRepository.updateRun(ar.id, { status: 'failed', error: "Perdue : le serveur s'est arrêté pendant l'exécution", finishedAt: now, heartbeatAt: now });
      if (ar.sessionId) void sessionService.stop(ar.sessionId).catch(() => undefined);
    }
    await workflowRepository.updateRun(run.id, { status: 'failed', error: "Perdue : le serveur s'est arrêté pendant l'exécution", finishedAt: now, heartbeatAt: now });
    await workflowRepository.addLog(run.id, 'error', "Exécution perdue : le serveur s'est arrêté pendant qu'elle tournait", null, null).catch(() => undefined);
  }
  return stale.length;
}
