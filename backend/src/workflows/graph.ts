import { z } from 'zod';
import { LLM_PROVIDER } from '../agents/llm.js';
import { placeholders } from '../agents/template.js';
import type { Agent, InputVariable } from '../agents/types.js';
import { AppError } from '../errors.js';
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskPerson } from '../tasks/types.js';
import { conditionPaths, conditionProblems, conditionSchema, type ConditionGroup } from './conditions.js';
import { ExpressionError, expressionPaths } from './expressions.js';
import { taskFilterProblems, taskFilterSchema, type TaskFilterGroup } from './taskFilter.js';
import { FALLIBLE_NODE_TYPES, TRIGGER_EVENTS, WORKFLOW_NODE_TYPES, type EdgeHandle, type NewTaskTemplate, type NodeRunStatus, type TriggerEvent, type WorkflowDefinition, type WorkflowEdge, type WorkflowIssue, type WorkflowNode, type WorkflowNodeType } from './types.js';

/** Aides de graphe des workflows : lecture, validation, parcours. Fonctions pures (testées). */

const variableSchema = z.object({
  key: z.string(),
  label: z.string().optional().default(''),
  description: z.string().nullable().optional().default(null),
  required: z.boolean().optional().default(false),
  defaultValue: z.string().nullable().optional().default(null),
});

const nodeSchema = z.object({
  key: z.string().min(1).max(64),
  type: z.enum(WORKFLOW_NODE_TYPES as [WorkflowNodeType, ...WorkflowNodeType[]]),
  label: z.string().max(200).optional().default(''),
  position: z.object({ x: z.number(), y: z.number() }).optional().default({ x: 0, y: 0 }),
  variables: z.array(variableSchema).optional(),
  event: z.enum(TRIGGER_EVENTS as [TriggerEvent, ...TriggerEvent[]]).optional(),
  taskFilter: taskFilterSchema.nullable().optional(),
  agentId: z.string().nullable().optional(),
  inputs: z.record(z.string(), z.string()).optional(),
  timeoutMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  taskId: z.string().max(500).optional(),
  provider: z.string().max(50).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  prompt: z.string().max(50_000).optional(),
  includeTask: z.boolean().optional(),
  worktreeMode: z.enum(['new', 'existing', 'main']).optional(),
  worktreeId: z.string().nullable().optional(),
  wait: z.boolean().optional(),
  sessionOwner: z.string().max(500).optional(),
  sessionName: z.string().max(500).optional(),
  branch: z.string().max(500).optional(),
  endAfterTurn: z.boolean().optional(),
  newTask: z
    .object({
      title: z.string().max(2000).optional(),
      description: z.string().max(50_000).optional(),
      priority: z.string().max(500).optional(),
      status: z.string().max(500).optional(),
      dueDate: z.string().max(500).optional(),
      assignee: z.string().max(500).optional(),
      reporter: z.string().max(500).optional(),
      fields: z.array(z.object({ key: z.string().max(200), value: z.string().max(5000) })).max(50).optional(),
    })
    .optional(),
  condition: conditionSchema.nullable().optional(),
  expression: z.string().max(2000).optional(),
  message: z.string().max(20_000).optional(),
});

const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.enum(['default', 'true', 'false', 'error']).nullable().optional(),
});

const definitionSchema = z.object({ nodes: z.array(nodeSchema).max(200), edges: z.array(edgeSchema).max(1000) });

/** Lit une définition brute (JSON de l'interface) ; lève AppError si elle est malformée. */
export function parseDefinition(raw: unknown): WorkflowDefinition {
  const parsed = definitionSchema.safeParse(raw ?? { nodes: [], edges: [] });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(`Définition de workflow invalide : ${first.path.join('.')} ${first.message}`);
  }
  const nodes: WorkflowNode[] = parsed.data.nodes.map((n) => ({
    key: n.key,
    type: n.type,
    label: n.label,
    position: n.position,
    ...(n.type === 'trigger' ? { variables: (n.variables ?? []) as InputVariable[], event: n.event ?? 'manual', taskFilter: (n.taskFilter ?? null) as TaskFilterGroup | null } : {}),
    ...(n.type === 'agent' ? { agentId: n.agentId ?? null, inputs: n.inputs ?? {}, timeoutMinutes: n.timeoutMinutes ?? null, taskId: n.taskId ?? '' } : {}),
    ...(n.type === 'task' ? { taskId: n.taskId ?? '', provider: n.provider ?? 'claude', config: n.config ?? {}, prompt: n.prompt ?? '', includeTask: n.includeTask ?? true, worktreeMode: n.worktreeMode ?? 'new', worktreeId: n.worktreeId ?? null, wait: n.wait ?? true, timeoutMinutes: n.timeoutMinutes ?? null, sessionOwner: n.sessionOwner ?? '' } : {}),
    ...(n.type === 'session'
      ? { sessionName: n.sessionName ?? '', provider: n.provider ?? 'claude', config: n.config ?? {}, prompt: n.prompt ?? '', worktreeMode: n.worktreeMode ?? 'main', worktreeId: n.worktreeId ?? null, branch: n.branch ?? '', wait: n.wait ?? true, endAfterTurn: n.endAfterTurn ?? false, timeoutMinutes: n.timeoutMinutes ?? null, sessionOwner: n.sessionOwner ?? '' }
      : {}),
    ...(n.type === 'createTask'
      ? { newTask: { title: n.newTask?.title ?? '', description: n.newTask?.description ?? '', priority: n.newTask?.priority ?? '', status: n.newTask?.status ?? '', dueDate: n.newTask?.dueDate ?? '', assignee: n.newTask?.assignee ?? '', reporter: n.newTask?.reporter ?? '', fields: n.newTask?.fields ?? [] } satisfies NewTaskTemplate }
      : {}),
    ...(n.type === 'condition' ? { condition: (n.condition ?? null) as ConditionGroup | null, expression: n.condition ? '' : (n.expression ?? '') } : {}),
    ...(n.type === 'end' ? { message: n.message ?? '' } : {}),
  }));
  const edges: WorkflowEdge[] = parsed.data.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null }));
  return { nodes, edges };
}

/** Les nœuds déclencheurs d'un workflow : chacun le démarre sur son propre événement, avec ses propres entrées. */
export const triggersOf = (def: WorkflowDefinition): WorkflowNode[] => def.nodes.filter((n) => n.type === 'trigger');

/** Un déclencheur du workflow : celui de cette clé, ou — sans clé — le déclencheur par défaut (premier manuel, sinon premier). */
export function triggerOf(def: WorkflowDefinition, key?: string | null): WorkflowNode | undefined {
  const triggers = triggersOf(def);
  if (key) return triggers.find((t) => t.key === key);
  return triggers.find((t) => (t.event ?? 'manual') === 'manual') ?? triggers[0];
}

/** Événement qui démarre un déclencheur (`manual` : à la main ou par sa planification). */
export const triggerEvent = (trigger: WorkflowNode | undefined): TriggerEvent => trigger?.event ?? 'manual';

/** Les déclencheurs du workflow qui écoutent un événement. */
export const triggersFor = (def: WorkflowDefinition, event: TriggerEvent): WorkflowNode[] => triggersOf(def).filter((t) => triggerEvent(t) === event);

/** Entrée des workflows démarrés par une tâche créée : son identifiant (rempli par l'événement ; demandé pour un lancement manuel). */
export const TASK_ID_INPUT = 'taskId';
const taskIdVariable: InputVariable = { key: TASK_ID_INPUT, label: 'Identifiant de la tâche', description: "La tâche que l'exécution traite (remplie par l'événement ; demandée pour un lancement manuel)", required: true, defaultValue: null };

/** Variables d'un déclencheur (déclarées sur lui, plus l'identifiant de tâche d'un déclencheur de tâche) ; sans clé, du déclencheur par défaut. */
export const workflowVariables = (def: WorkflowDefinition, triggerKey?: string | null): InputVariable[] => {
  const trigger = triggerOf(def, triggerKey);
  const declared = trigger?.variables ?? [];
  return triggerEvent(trigger) === 'task.created' ? [taskIdVariable, ...declared.filter((v) => v.key !== TASK_ID_INPUT)] : declared;
};

/** Champs d'une tâche vus par les modèles (`input.task.<champ>`). */
export const TASK_FIELDS = ['id', 'title', 'description', 'priority', 'status', 'createdBy', 'dueDate', 'assignee', 'reporter', 'fields'] as const;
export const TASK_PERSON_FIELDS = ['name', 'email'] as const;

const personContext = (person: Task['assignee']) => (person ? { name: person.name ?? '', email: person.email ?? '' } : null);

/** La tâche telle que les workflows la voient ; `fields` indexe les champs personnalisés par clé. */
export function taskContext(task: Task): Record<(typeof TASK_FIELDS)[number], unknown> {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    createdBy: task.createdByType,
    dueDate: task.dueDate ?? '',
    assignee: personContext(task.assignee),
    reporter: personContext(task.reporter),
    fields: Object.fromEntries(task.customFields.map((f) => [f.key, f.value])),
  };
}

/** Personnes nommées par un modèle rendu : e-mails (en minuscules) ou identifiants, séparés par virgules, points-virgules, espaces ou lignes ; doublons retirés. */
export function peopleRefs(text: string): string[] {
  const refs = text
    .split(/[\s,;]+/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => (r.includes('@') ? r.toLowerCase() : r));
  return [...new Set(refs)];
}

/** Une personne d'une tâche créée, d'après un modèle rendu : `Nom <e-mail>`, un e-mail, ou un nom ; null si vide. */
export function parseTaskPerson(text: string): TaskPerson | null {
  const value = text.trim();
  if (!value) return null;
  const angled = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(value);
  if (angled) return { name: angled[1].trim().replace(/^"|"$/g, '') || null, email: angled[2].toLowerCase() };
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return { name: null, email: value.toLowerCase() };
  return { name: value, email: null };
}

/** Un modèle est statique (sans emplacement) : sa valeur se vérifie à l'enregistrement. */
const isStatic = (template: string) => !template.includes('{{');

export const incomingEdges = (def: WorkflowDefinition, key: string): WorkflowEdge[] => def.edges.filter((e) => e.target === key);
export const outgoingEdges = (def: WorkflowDefinition, key: string): WorkflowEdge[] => def.edges.filter((e) => e.source === key);

/** Clés des nœuds en amont de `key` (ses ancêtres). */
export function upstreamOf(def: WorkflowDefinition, key: string): Set<string> {
  const seen = new Set<string>();
  const stack = incomingEdges(def, key).map((e) => e.source);
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const e of incomingEdges(def, k)) stack.push(e.source);
  }
  return seen;
}

/** Clés atteignables depuis les déclencheurs (toutes arêtes suivies). */
export function reachableFromTrigger(def: WorkflowDefinition): Set<string> {
  const seen = new Set<string>();
  const stack = triggersOf(def).map((t) => t.key);
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const e of outgoingEdges(def, k)) stack.push(e.target);
  }
  return seen;
}

/** Épluche les nœuds sans prédécesseur (ou sans successeur si `reverse`) ; ce qui reste est sur ou entre des cycles. */
function peel(def: WorkflowDefinition, reverse: boolean): Set<string> {
  const keys = new Set(def.nodes.map((n) => n.key));
  const edges = def.edges.filter((e) => keys.has(e.source) && keys.has(e.target) && e.source !== e.target);
  const from = (e: WorkflowEdge) => (reverse ? e.target : e.source);
  const to = (e: WorkflowEdge) => (reverse ? e.source : e.target);
  const degree = new Map([...keys].map((k) => [k, 0]));
  for (const e of edges) degree.set(to(e), (degree.get(to(e)) ?? 0) + 1);
  const queue = [...keys].filter((k) => degree.get(k) === 0);
  const removed = new Set<string>();
  while (queue.length) {
    const k = queue.shift()!;
    removed.add(k);
    for (const e of edges) {
      if (from(e) !== k) continue;
      const d = (degree.get(to(e)) ?? 0) - 1;
      degree.set(to(e), d);
      if (d === 0) queue.push(to(e));
    }
  }
  const rest = new Set([...keys].filter((k) => !removed.has(k)));
  for (const e of def.edges) if (e.source === e.target && keys.has(e.source)) rest.add(e.source);
  return rest;
}

/** Clés des nœuds sur un cycle (vide quand le graphe est acyclique). */
export function cycleNodes(def: WorkflowDefinition): Set<string> {
  const forward = peel(def, false);
  const backward = peel(def, true);
  return new Set([...forward].filter((k) => backward.has(k)));
}

const handleOf = (e: WorkflowEdge): EdgeHandle => e.sourceHandle ?? 'default';

/** Valide une définition : erreurs de structure (l'exécution est refusée) et avertissements. `agents` : les agents du projet par identifiant. */
export function validateDefinition(def: WorkflowDefinition, agents: Map<string, Agent>, options: { providers?: Set<string> } = {}): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const error = (nodeKey: string | null, message: string, edgeId?: string) => issues.push({ nodeKey, edgeId: edgeId ?? null, severity: 'error', message });
  const warning = (nodeKey: string | null, message: string, edgeId?: string) => issues.push({ nodeKey, edgeId: edgeId ?? null, severity: 'warning', message });

  const byKey = new Map<string, WorkflowNode>();
  for (const n of def.nodes) {
    if (byKey.has(n.key)) error(n.key, `Deux nœuds partagent la clé « ${n.key} »`);
    byKey.set(n.key, n);
  }
  const triggers = triggersOf(def);
  if (triggers.length === 0) error(null, "Le workflow a besoin d'un nœud déclencheur (son départ)");
  if (def.nodes.length && !def.nodes.some((n) => FALLIBLE_NODE_TYPES.includes(n.type))) warning(null, 'Le workflow ne fait rien : ajoutez une étape agent, session ou tâche');

  for (const e of def.edges) {
    const source = byKey.get(e.source);
    const target = byKey.get(e.target);
    if (!source || !target) {
      error(null, "Une arête pointe vers un nœud qui n'existe plus", e.id);
      continue;
    }
    if (e.source === e.target) error(e.source, 'Un nœud ne peut pas se relier à lui-même', e.id);
    const handle = handleOf(e);
    if (source.type === 'condition' && handle !== 'true' && handle !== 'false') error(source.key, "Les arêtes qui quittent une condition prennent sa branche « oui » ou « non »", e.id);
    if (source.type !== 'condition' && (handle === 'true' || handle === 'false')) error(source.key, 'Seule une condition a des branches « oui » / « non »', e.id);
    if (handle === 'error' && !FALLIBLE_NODE_TYPES.includes(source.type)) error(source.key, "Seuls un agent, une tâche, une session ou une création de tâche ont une branche « en cas d'erreur »", e.id);
    if (target.type === 'trigger') error(target.key, "Rien ne peut mener au déclencheur : c'est le départ", e.id);
    if (source.type === 'end') error(source.key, "Un nœud de fin n'a pas d'arête sortante", e.id);
  }

  for (const key of cycleNodes(def)) error(key, 'Le graphe boucle : un nœud ramène à lui-même');

  const reachable = reachableFromTrigger(def);
  const taskFieldOk = (parts: string[], prefix: string): string | null => {
    if (parts.length < 1 || !(TASK_FIELDS as readonly string[]).includes(parts[0])) return `utilisez ${prefix}.<champ> (${TASK_FIELDS.join(', ')})`;
    if (parts[0] === 'fields' && parts.length < 2) return `utilisez ${prefix}.fields.<clé du champ personnalisé>`;
    if ((parts[0] === 'assignee' || parts[0] === 'reporter') && (parts.length > 2 || (parts.length === 2 && !(TASK_PERSON_FIELDS as readonly string[]).includes(parts[1])))) return `utilisez ${prefix}.${parts[0]}.<${TASK_PERSON_FIELDS.join(' ou ')}>`;
    return null;
  };
  // Un nœud voit les entrées des déclencheurs qui mènent à lui (quel que soit celui qui a démarré l'exécution).
  const startsOf = (upstream: Set<string>) => triggers.filter((t) => upstream.has(t.key));
  const declaredPathOk = (path: string, upstream: Set<string>): string | null => {
    const parts = path.split('.');
    const starts = startsOf(upstream);
    const events = new Set(starts.map(triggerEvent));
    const variables = new Set(starts.flatMap((t) => workflowVariables(def, t.key).map((v) => v.key)));
    if (parts[0] === 'input') {
      if (parts.length < 2) return 'utilisez input.<variable>';
      if (parts[1] === 'task' && events.has('task.created')) return parts.length === 2 ? null : taskFieldOk(parts.slice(2), 'input.task');
      return variables.has(parts[1]) ? null : `le workflow ne déclare aucune variable « ${parts[1]} »`;
    }
    if (parts[0] === 'nodes') {
      if (parts.length < 2) return 'utilisez nodes.<clé>.output';
      if (!byKey.has(parts[1])) return `aucun nœud n'a la clé « ${parts[1]} »`;
      if (!upstream.has(parts[1])) return `le nœud « ${parts[1]} » ne s'exécute pas avant celui-ci : sa sortie sera vide`;
      return null;
    }
    if (parts[0] === 'run' || parts[0] === 'workflow') return null;
    if (parts.length === 1) return variables.has(parts[0]) ? null : `le workflow ne déclare aucune variable « ${parts[0]} »`;
    return `référence inconnue « ${parts[0]} » (utilisez input.<variable> ou nodes.<clé>.output)`;
  };
  const checkTemplates = (n: WorkflowNode, upstream: Set<string>, templates: [string, string][]) => {
    for (const [label, template] of templates) {
      for (const path of placeholders(template)) {
        const problem = declaredPathOk(path, upstream);
        if (problem) warning(n.key, `${label} utilise {{${path}}} : ${problem}`);
      }
    }
  };

  for (const n of def.nodes) {
    const upstream = upstreamOf(def, n.key);
    const outgoing = outgoingEdges(def, n.key);
    if (n.type !== 'trigger' && !reachable.has(n.key)) warning(n.key, "Ce nœud n'est pas relié au déclencheur : il ne s'exécutera jamais");
    switch (n.type) {
      case 'trigger':
        if (!outgoing.length) warning(n.key, 'Le déclencheur ne mène nulle part');
        if (n.event === 'task.created') {
          if ((n.variables ?? []).some((v) => v.key === TASK_ID_INPUT || v.key === 'task')) error(n.key, `« ${TASK_ID_INPUT} » et « task » sont réservés par le déclencheur de tâche : renommez cette variable`);
          if (n.taskFilter) for (const problem of [...new Set(taskFilterProblems(n.taskFilter))]) error(n.key, problem);
        } else if (n.taskFilter?.items.length) warning(n.key, "Le filtre ne s'applique qu'aux tâches créées : il est ignoré");
        break;
      case 'agent': {
        const agent = n.agentId ? agents.get(n.agentId) : undefined;
        if (!n.agentId) error(n.key, "Choisissez l'agent à exécuter");
        else if (!agent) error(n.key, "L'agent de ce nœud n'existe plus (ou appartient à un autre projet)");
        else {
          for (const v of agent.inputs) {
            const template = n.inputs?.[v.key];
            if (v.required && v.defaultValue === null && !template?.trim()) warning(n.key, `L'entrée « ${v.label || v.key} » de l'agent est obligatoire mais vide`);
          }
          for (const key of Object.keys(n.inputs ?? {})) if (!agent.inputs.some((v) => v.key === key)) warning(n.key, `L'agent ne déclare aucune entrée « ${key} » : cette valeur est ignorée`);
        }
        checkTemplates(n, upstream, Object.entries(n.inputs ?? {}).map(([key, t]): [string, string] => [`L'entrée « ${key} »`, t]));
        if (n.taskId?.trim()) {
          if (agent?.provider === LLM_PROVIDER) error(n.key, "Un agent qui appelle le modèle directement n'a pas de session : il ne peut pas résoudre une tâche (choisissez un agent de session)");
          checkTemplates(n, upstream, [['La tâche', n.taskId]]);
        }
        if (!outgoing.length && !n.taskId?.trim()) warning(n.key, "Cet agent ne mène nulle part : le workflow s'arrête après lui");
        break;
      }
      case 'task': {
        if (!n.taskId?.trim()) error(n.key, startsOf(upstream).some((t) => triggerEvent(t) === 'task.created') ? 'Nommez la tâche à traiter (ex. {{input.task.id}})' : 'Nommez la tâche à traiter (son identifiant, ou {{input.…}})');
        if (n.provider === LLM_PROVIDER) error(n.key, "Une tâche s'exécute dans une session : choisissez un type de session");
        else if (n.provider && options.providers && !options.providers.has(n.provider)) error(n.key, `Type de session inconnu « ${n.provider} »`);
        if (n.worktreeMode === 'existing' && !n.worktreeId) error(n.key, 'Choisissez le worktree où travailler');
        if (n.includeTask === false && !n.prompt?.trim()) error(n.key, "Écrivez l'instruction : le texte de la tâche n'est pas inclus");
        checkTemplates(n, upstream, [
          ['La tâche', n.taskId ?? ''],
          ["L'instruction", n.prompt ?? ''],
          ['Le propriétaire', n.sessionOwner ?? ''],
        ]);
        break;
      }
      case 'session': {
        if (!n.prompt?.trim()) error(n.key, "Écrivez l'instruction de la session");
        if (n.provider === LLM_PROVIDER) error(n.key, 'Choisissez un type de session');
        else if (n.provider && options.providers && !options.providers.has(n.provider)) error(n.key, `Type de session inconnu « ${n.provider} »`);
        if (n.worktreeMode === 'existing' && !n.worktreeId) error(n.key, 'Choisissez le worktree où travailler');
        if (n.endAfterTurn && n.wait === false) warning(n.key, "La session n'est terminée après son premier tour que si l'exécution l'attend");
        checkTemplates(n, upstream, [
          ['Le nom', n.sessionName ?? ''],
          ["L'instruction", n.prompt ?? ''],
          ['La branche', n.worktreeMode === 'new' ? (n.branch ?? '') : ''],
          ['Le propriétaire', n.sessionOwner ?? ''],
        ]);
        break;
      }
      case 'createTask': {
        const t = n.newTask;
        if (!t?.title.trim()) error(n.key, 'Écrivez le titre de la tâche');
        if (t?.priority.trim() && isStatic(t.priority) && !(TASK_PRIORITIES as string[]).includes(t.priority.trim())) error(n.key, `Priorité inconnue « ${t.priority.trim()} » (${TASK_PRIORITIES.join(', ')})`);
        if (t?.status.trim() && isStatic(t.status) && !(TASK_STATUSES as string[]).includes(t.status.trim())) error(n.key, `Statut inconnu « ${t.status.trim()} » (${TASK_STATUSES.join(', ')})`);
        if (t?.dueDate.trim() && isStatic(t.dueDate) && !/^\d{4}-\d{2}-\d{2}$/.test(t.dueDate.trim())) error(n.key, "L'échéance doit être au format AAAA-MM-JJ");
        const keys = (t?.fields ?? []).map((f) => f.key.trim().toLowerCase());
        if (keys.some((k) => !k)) error(n.key, "Un champ personnalisé n'a pas de clé");
        if (new Set(keys).size !== keys.length) error(n.key, 'Deux champs personnalisés partagent une clé');
        if (t) checkTemplates(n, upstream, [['Le titre', t.title], ['La description', t.description], ['La priorité', t.priority], ['Le statut', t.status], ["L'échéance", t.dueDate], ['Le responsable', t.assignee], ['Le rapporteur', t.reporter], ...t.fields.map((f): [string, string] => [`Le champ « ${f.key} »`, f.value])]);
        break;
      }
      case 'condition': {
        if (n.condition) {
          for (const problem of conditionProblems(n.condition)) error(n.key, problem);
          for (const path of conditionPaths(n.condition)) {
            const problem = declaredPathOk(path, upstream);
            if (problem) warning(n.key, `La condition utilise ${path} : ${problem}`);
          }
        } else if (!n.expression?.trim()) error(n.key, 'Ajoutez une règle à la condition');
        else {
          try {
            for (const path of expressionPaths(n.expression)) {
              const problem = declaredPathOk(path, upstream);
              if (problem) warning(n.key, `La condition utilise ${path} : ${problem}`);
            }
          } catch (err) {
            if (err instanceof ExpressionError) error(n.key, `Condition invalide : ${err.message}`);
            else throw err;
          }
        }
        const handles = new Set(outgoing.map(handleOf));
        if (!handles.has('true') && !handles.has('false')) warning(n.key, 'La condition ne mène nulle part');
        else if (!handles.has('true')) warning(n.key, 'Rien ne suit la branche « oui »');
        else if (!handles.has('false')) warning(n.key, 'Rien ne suit la branche « non »');
        break;
      }
      case 'end':
        checkTemplates(n, upstream, [['La sortie', n.message ?? '']]);
        break;
      default:
    }
  }
  return issues;
}

/** État d'un nœud pendant une exécution, tel que le moteur le suit. */
export interface NodeState {
  status: NodeRunStatus;
  /** Nœuds de condition : la branche prise. */
  branch?: boolean;
}

const SETTLED: NodeRunStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];
export const isSettled = (s: NodeRunStatus): boolean => SETTLED.includes(s);

/** Une arête porte-t-elle le flux, d'après l'état de sa source ? */
export function edgeActive(def: WorkflowDefinition, e: WorkflowEdge, states: Map<string, NodeState>): boolean {
  const source = def.nodes.find((n) => n.key === e.source);
  const state = states.get(e.source);
  if (!source || !state) return false;
  const handle = handleOf(e);
  if (state.status === 'failed') return handle === 'error';
  if (state.status !== 'succeeded') return false;
  if (source.type === 'condition') return handle === (state.branch ? 'true' : 'false');
  return handle === 'default';
}

/**
 * Prochains pas d'une exécution : les nœuds en attente dont tous les prédécesseurs sont réglés, partagés
 * entre ceux qui s'exécutent (une arête active les atteint, ou c'est le déclencheur de départ) et ceux qui
 * sont passés (les autres déclencheurs, et ce qu'eux seuls amènent). `startKey` : ce déclencheur.
 */
export function nextSteps(def: WorkflowDefinition, states: Map<string, NodeState>, startKey?: string | null): { run: string[]; skip: string[] } {
  const start = triggerOf(def, startKey)?.key;
  const run: string[] = [];
  const skip: string[] = [];
  for (const n of def.nodes) {
    if ((states.get(n.key)?.status ?? 'pending') !== 'pending') continue;
    const incoming = incomingEdges(def, n.key);
    if (!incoming.every((e) => isSettled(states.get(e.source)?.status ?? 'pending'))) continue;
    if (incoming.length === 0) {
      // Seul le déclencheur de départ démarre de lui-même ; un nœud orphelin ne s'exécute jamais.
      (n.type === 'trigger' && n.key === start ? run : skip).push(n.key);
      continue;
    }
    (incoming.some((e) => edgeActive(def, e, states)) ? run : skip).push(n.key);
  }
  return { run, skip };
}

/** Un nœud en échec est-il rattrapé par une branche « en cas d'erreur » ? */
export const failureHandled = (def: WorkflowDefinition, key: string): boolean => outgoingEdges(def, key).some((e) => handleOf(e) === 'error');
