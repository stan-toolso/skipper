import { describe, expect, it } from 'vitest';
import type { Agent } from '../agents/types.js';
import { edgeActive, nextSteps, parseDefinition, triggerOf, validateDefinition, workflowVariables, type NodeState } from './graph.js';
import type { WorkflowDefinition } from './types.js';

const agent = { id: 'a1', projectId: 'p1', name: 'Relecteur', inputs: [{ key: 'ticket', label: 'Ticket', required: true, defaultValue: null }], outputFormat: 'json' } as unknown as Agent;
const agents = new Map([[agent.id, agent]]);

const raw = {
  nodes: [
    { key: 'start', type: 'trigger', label: 'Départ', position: { x: 0, y: 0 }, variables: [{ key: 'ticket', label: 'Ticket', required: true, defaultValue: null }] },
    { key: 'review', type: 'agent', label: 'Relecture', position: { x: 100, y: 0 }, agentId: 'a1', inputs: { ticket: '{{input.ticket}}' } },
    { key: 'ok', type: 'condition', label: 'Approuvé ?', position: { x: 200, y: 0 }, expression: 'nodes.review.json.approved' },
    { key: 'fix', type: 'task', label: 'Corriger', position: { x: 300, y: 0 }, taskId: '{{input.taskId}}', prompt: 'Corrige' },
    { key: 'done', type: 'end', label: 'Fin', position: { x: 400, y: 0 }, message: '{{nodes.review.output}}' },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'review' },
    { id: 'e2', source: 'review', target: 'ok' },
    { id: 'e3', source: 'ok', target: 'fix', sourceHandle: 'false' },
    { id: 'e4', source: 'ok', target: 'done', sourceHandle: 'true' },
    { id: 'e5', source: 'fix', target: 'done' },
  ],
};

describe('parseDefinition', () => {
  it('normalise les nœuds avec leurs valeurs par défaut', () => {
    const def = parseDefinition(raw);
    expect(def.nodes.find((n) => n.key === 'start')).toMatchObject({ event: 'manual', taskFilter: null });
    expect(def.nodes.find((n) => n.key === 'fix')).toMatchObject({ provider: 'claude', includeTask: true, worktreeMode: 'new', wait: true });
    expect(def.edges[2].sourceHandle).toBe('false');
    expect(parseDefinition(null)).toEqual({ nodes: [], edges: [] });
  });
  it('refuse une définition malformée', () => {
    expect(() => parseDefinition({ nodes: [{ key: '', type: 'agent' }], edges: [] })).toThrow(/invalide/);
  });
});

describe('validateDefinition', () => {
  it('un graphe cohérent ne remonte aucune erreur', () => {
    const issues = validateDefinition(parseDefinition(raw), agents, { providers: new Set(['claude']) });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('signale déclencheur absent, arête orpheline, agent inconnu et branches mal utilisées', () => {
    const def: WorkflowDefinition = parseDefinition({
      nodes: [
        { key: 'a', type: 'agent', label: 'A', position: { x: 0, y: 0 }, agentId: 'absent' },
        { key: 'b', type: 'end', label: 'B', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'x', source: 'a', target: 'b', sourceHandle: 'true' },
        { id: 'y', source: 'a', target: 'zz' },
      ],
    });
    const messages = validateDefinition(def, agents).map((i) => i.message);
    expect(messages.some((m) => /déclencheur/.test(m))).toBe(true);
    expect(messages.some((m) => /n'existe plus/.test(m))).toBe(true);
    expect(messages.some((m) => /condition/.test(m))).toBe(true);
    expect(messages.some((m) => /L'agent de ce nœud n'existe plus/.test(m))).toBe(true);
  });
});

describe('déclencheurs et variables', () => {
  it("le déclencheur par défaut est le premier manuel ; un déclencheur de tâche ajoute l'identifiant de tâche", () => {
    const def = parseDefinition({
      nodes: [
        { key: 'ev', type: 'trigger', label: 'Tâche créée', position: { x: 0, y: 0 }, event: 'task.created', variables: [{ key: 'extra', label: 'Extra', required: false, defaultValue: null }] },
        { key: 'man', type: 'trigger', label: 'Manuel', position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    expect(triggerOf(def)?.key).toBe('man');
    expect(workflowVariables(def, 'ev').map((v) => v.key)).toEqual(['taskId', 'extra']);
    expect(workflowVariables(def)).toEqual([]);
  });
});

describe('nextSteps / edgeActive', () => {
  const def = parseDefinition(raw);
  const states = (entries: Record<string, NodeState>) => new Map(Object.entries(entries));

  it('seul le déclencheur de départ démarre de lui-même', () => {
    expect(nextSteps(def, states({}))).toEqual({ run: ['start'], skip: [] });
  });
  it('suit la branche de la condition et saute l’autre', () => {
    const s = states({ start: { status: 'succeeded' }, review: { status: 'succeeded' }, ok: { status: 'succeeded', branch: true } });
    expect(nextSteps(def, s)).toEqual({ run: [], skip: ['fix'] });
    s.set('fix', { status: 'skipped' });
    expect(nextSteps(def, s)).toEqual({ run: ['done'], skip: [] });
  });
  it("un échec n'active que la branche « en cas d'erreur »", () => {
    const s = states({ start: { status: 'succeeded' }, review: { status: 'failed' } });
    expect(edgeActive(def, def.edges[1], s)).toBe(false);
    expect(nextSteps(def, s)).toEqual({ run: [], skip: ['ok'] });
  });
});
