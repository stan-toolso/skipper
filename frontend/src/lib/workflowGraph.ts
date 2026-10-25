import dagre from '@dagrejs/dagre';
import type { InputVariable, WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '../graphql/automation';
import { nodeTypeInfo } from './automation';

/** Ordre de la palette de l'éditeur. */
export const PALETTE: WorkflowNodeType[] = ['trigger', 'callLlm', 'task', 'session', 'createTask', 'condition', 'end'];

/** Types de nœuds qui peuvent échouer : ils ont une branche « en cas d'erreur ». */
export const FALLIBLE_TYPES: WorkflowNodeType[] = ['callLlm', 'task', 'session', 'createTask'];

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 64;

/** Clé stable d'un nouveau nœud : type + numéro libre. */
export function nextKey(def: WorkflowDefinition, type: WorkflowNodeType): string {
  const base = type === 'createTask' ? 'newTask' : type === 'callLlm' ? 'llm' : type;
  let n = 1;
  while (def.nodes.some((node) => node.key === `${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Un nœud neuf avec les valeurs par défaut de son type. */
export function newNode(def: WorkflowDefinition, type: WorkflowNodeType, position: { x: number; y: number }): WorkflowNode {
  const key = nextKey(def, type);
  const base: WorkflowNode = { key, type, label: nodeTypeInfo[type].label, position };
  switch (type) {
    case 'trigger':
      return { ...base, label: def.nodes.some((n) => n.type === 'trigger') ? 'Autre déclencheur' : 'Départ', variables: [], event: 'manual', taskFilter: null };
    case 'callLlm':
      return { ...base, llm: { backend: 'litellm', keyItemId: '', model: '', temperature: null, maxTokens: null, langfuseItemId: null }, systemPrompt: '', prompt: '', outputFormat: 'text', outputSchema: '', timeoutMinutes: null };
    case 'task':
      return { ...base, taskId: '', provider: 'claude', config: {}, prompt: '', includeTask: true, worktreeMode: 'new', worktreeId: null, wait: true, timeoutMinutes: null, sessionOwner: '' };
    case 'session':
      return { ...base, sessionName: '', provider: 'claude', config: {}, prompt: '', worktreeMode: 'main', worktreeId: null, branch: '', wait: true, endAfterTurn: false, timeoutMinutes: null, sessionOwner: '' };
    case 'createTask':
      return { ...base, newTask: { title: '', description: '', priority: '', status: '', dueDate: '', assignee: '', reporter: '', fields: [] } };
    case 'condition':
      return { ...base, condition: { kind: 'group', match: 'all', items: [{ kind: 'rule', path: '', operator: 'isNotEmpty' }] }, expression: '' };
    case 'end':
      return { ...base, message: '{{nodes.' + (def.nodes.find((n) => n.type !== 'trigger')?.key ?? 'llm1') + '.output}}' };
  }
}

/** Définition de départ d'un nouveau workflow : un déclencheur seul. */
export const emptyDefinition = (): WorkflowDefinition => ({ nodes: [{ key: 'start', type: 'trigger', label: 'Départ', position: { x: 80, y: 120 }, variables: [], event: 'manual', taskFilter: null }], edges: [] });

/** Nœuds qui s'exécutent avant `key` (prédécesseurs transitifs). */
export function upstreamOf(def: WorkflowDefinition, key: string): Set<string> {
  const out = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const current = stack.pop()!;
    for (const e of def.edges) {
      if (e.target === current && !out.has(e.source)) {
        out.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return out;
}

/** Variables des déclencheurs en amont d'un nœud (celles de tous, un nœud pouvant être atteint depuis plusieurs). */
export function triggerVariablesFor(def: WorkflowDefinition, key: string | null): InputVariable[] {
  const upstream = key ? upstreamOf(def, key) : new Set<string>();
  const triggers = def.nodes.filter((n) => n.type === 'trigger' && (key === null || upstream.has(n.key) || n.key === key));
  const out: InputVariable[] = [];
  for (const t of triggers) {
    if (t.event === 'task.created' && !out.some((v) => v.key === 'taskId')) out.push({ key: 'taskId', label: 'Identifiant de la tâche', description: null, required: true, defaultValue: null });
    for (const v of t.variables ?? []) if (!out.some((o) => o.key === v.key)) out.push(v);
  }
  return out;
}

/** Chemins utilisables dans les modèles d'un nœud : variables du déclencheur, tâche de l'événement, sorties des nœuds en amont. */
export function availablePaths(def: WorkflowDefinition, key: string | null): { path: string; hint: string }[] {
  const out: { path: string; hint: string }[] = [];
  const upstream = key ? upstreamOf(def, key) : new Set<string>();
  const triggers = def.nodes.filter((n) => n.type === 'trigger' && (key === null || upstream.has(n.key)));
  for (const v of triggerVariablesFor(def, key)) out.push({ path: `input.${v.key}`, hint: v.label || v.key });
  if (triggers.some((t) => t.event === 'task.created')) {
    for (const f of ['id', 'title', 'description', 'priority', 'status', 'dueDate', 'assignee.name', 'assignee.email']) out.push({ path: `input.task.${f}`, hint: 'tâche qui a déclenché le workflow' });
  }
  for (const k of upstream) {
    const n = def.nodes.find((x) => x.key === k);
    if (!n || n.type === 'trigger' || n.type === 'condition') continue;
    out.push({ path: `nodes.${k}.output`, hint: `sortie de « ${n.label} »` });
    if (n.type === 'callLlm' && n.outputFormat === 'json') out.push({ path: `nodes.${k}.json`, hint: `sortie JSON de « ${n.label} »` });
  }
  return out;
}

/** Réorganise les nœuds de gauche à droite avec dagre. */
export function autoLayout(def: WorkflowDefinition): WorkflowDefinition {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90 });
  for (const n of def.nodes) g.setNode(n.key, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of def.edges) if (def.nodes.some((n) => n.key === e.source) && def.nodes.some((n) => n.key === e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return {
    ...def,
    nodes: def.nodes.map((n) => {
      const pos = g.node(n.key);
      return pos ? { ...n, position: { x: Math.round(pos.x - NODE_WIDTH / 2), y: Math.round(pos.y - NODE_HEIGHT / 2) } } : n;
    }),
  };
}

/** Libellé d'une arête selon sa branche. */
export function edgeLabel(e: WorkflowEdge): string | undefined {
  switch (e.sourceHandle) {
    case 'true':
      return 'oui';
    case 'false':
      return 'non';
    case 'error':
      return 'erreur';
    default:
      return undefined;
  }
}

/** Identifiant d'une nouvelle arête. */
export const edgeId = (source: string, target: string, handle: string | null | undefined) => `${source}${handle && handle !== 'default' ? `:${handle}` : ''}->${target}`;

/** Résumé d'un nœud affiché sur le canevas, sous son libellé. */
export function nodeSummary(n: WorkflowNode): string {
  switch (n.type) {
    case 'trigger':
      return n.event === 'task.created' ? 'Tâche créée' : `Manuel · ${(n.variables ?? []).length} variable${(n.variables ?? []).length > 1 ? 's' : ''}`;
    case 'callLlm':
      return n.llm?.model ? `${n.llm.model}${n.outputFormat === 'json' ? ' · JSON' : ''}` : 'modèle non choisi';
    case 'task':
      return n.taskId ? `Tâche ${n.taskId}` : 'tâche non précisée';
    case 'session':
      return n.sessionName || n.provider || 'session';
    case 'createTask':
      return n.newTask?.title || 'titre non précisé';
    case 'condition':
      return n.condition ? `${n.condition.items.length} règle${n.condition.items.length > 1 ? 's' : ''}` : n.expression || 'aucune règle';
    case 'end':
      return n.message ? 'avec sortie' : 'sans sortie';
  }
}
