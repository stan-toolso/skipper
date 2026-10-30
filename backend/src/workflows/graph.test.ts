import { describe, expect, it } from 'vitest';
import { cycleNodes, edgeActive, nextSteps, parseDefinition, upstreamOf, validateDefinition, type NodeState } from './graph.js';
import type { WorkflowDefinition } from './types.js';

const KEY = '11111111-2222-4333-8444-555555555555';
const llm = { backend: 'litellm', keyItemId: KEY, model: 'gpt-5', temperature: null, maxTokens: null, langfuseItemId: null } as const;

const def: WorkflowDefinition = parseDefinition({
  nodes: [
    { key: 'start', type: 'trigger', label: 'Départ', position: { x: 0, y: 0 }, variables: [{ key: 'ticket', label: 'Ticket', required: true }] },
    { key: 'review', type: 'callLlm', label: 'Relecture', position: { x: 100, y: 0 }, llm, systemPrompt: 'Tu relis des tickets.', prompt: 'Relis {{input.ticket}}', outputFormat: 'json', outputSchema: '{ "approved": true }' },
    { key: 'ok', type: 'condition', label: 'Approuvé ?', position: { x: 200, y: 0 }, expression: 'nodes.review.json.approved' },
    { key: 'fix', type: 'session', label: 'Correction', position: { x: 300, y: 0 }, provider: 'claude', prompt: 'Corrige {{nodes.review.output}}' },
    { key: 'done', type: 'end', label: 'Fin', position: { x: 300, y: 100 }, message: '{{nodes.review.output}}' },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'review' },
    { id: 'e2', source: 'review', target: 'ok' },
    { id: 'e3', source: 'ok', target: 'fix', sourceHandle: 'true' },
    { id: 'e4', source: 'ok', target: 'done', sourceHandle: 'false' },
    { id: 'e5', source: 'review', target: 'done', sourceHandle: 'error' },
  ],
});

describe('parseDefinition', () => {
  it('normalise un nœud « appel de modèle » avec ses défauts', () => {
    const node = def.nodes.find((n) => n.key === 'review')!;
    expect(node.llm).toEqual(llm);
    expect(node.outputFormat).toBe('json');
    expect(node.timeoutMinutes).toBeNull();
    const minimal = parseDefinition({ nodes: [{ key: 'a', type: 'callLlm' }], edges: [] }).nodes[0];
    expect(minimal.llm).toEqual({ backend: 'litellm', keyItemId: '', model: '', temperature: null, maxTokens: null, langfuseItemId: null });
    expect(minimal.outputFormat).toBe('text');
    expect(minimal.outputSchema).toBe('');
  });
  it('refuse un type de nœud inconnu', () => {
    expect(() => parseDefinition({ nodes: [{ key: 'a', type: 'agent' }], edges: [] })).toThrow(/invalide/);
  });
});

describe('validateDefinition', () => {
  it('accepte un graphe correct', () => {
    const issues = validateDefinition(def, { providers: new Set(['claude', 'shell']) });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('signale un appel de modèle incomplet, les arêtes orphelines et les cycles', () => {
    const broken = parseDefinition({
      nodes: [
        { key: 'start', type: 'trigger', label: 'Départ', position: { x: 0, y: 0 } },
        { key: 'a', type: 'callLlm', label: 'A', position: { x: 0, y: 0 }, llm: { backend: 'openai', keyItemId: '', model: 'gpt-5' }, prompt: '' },
        { key: 'b', type: 'session', label: 'B', position: { x: 0, y: 0 }, provider: 'claude', prompt: 'x' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
        { id: 'e4', source: 'b', target: 'zz' },
      ],
    });
    const messages = validateDefinition(broken).filter((i) => i.severity === 'error').map((i) => i.message);
    expect(messages).toContain('Choisissez la clé OpenAI dans le coffre');
    expect(messages).toContain("Écrivez l'instruction envoyée au modèle");
    expect(messages).toContain("Une arête pointe vers un nœud qui n'existe plus");
    expect(messages.some((m) => m.includes('boucle'))).toBe(true);
    expect([...cycleNodes(broken)].sort()).toEqual(['a', 'b']);
  });
  it('avertit quand un modèle référence une variable inconnue ou un nœud qui ne précède pas', () => {
    const warned = parseDefinition({
      nodes: [
        { key: 'start', type: 'trigger', label: 'Départ', position: { x: 0, y: 0 } },
        { key: 'a', type: 'callLlm', label: 'A', position: { x: 0, y: 0 }, llm, prompt: '{{input.absent}} {{nodes.b.output}}' },
        { key: 'b', type: 'end', label: 'Fin', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    });
    const warnings = validateDefinition(warned).filter((i) => i.severity === 'warning' && i.nodeKey === 'a').map((i) => i.message);
    expect(warnings.some((m) => m.includes('absent'))).toBe(true);
    expect(warnings.some((m) => m.includes("ne s'exécute pas avant"))).toBe(true);
  });
});

describe('parcours', () => {
  it('remonte les prédécesseurs', () => {
    expect([...upstreamOf(def, 'fix')].sort()).toEqual(['ok', 'review', 'start']);
  });
  it('suit les branches oui / non et « en cas d\'erreur »', () => {
    const states = new Map<string, NodeState>([
      ['start', { status: 'succeeded' }],
      ['review', { status: 'succeeded' }],
      ['ok', { status: 'succeeded', branch: false }],
    ]);
    const next = nextSteps(def, states);
    expect(next.run).toEqual(['done']);
    expect(next.skip).toEqual(['fix']);
    states.set('review', { status: 'failed' });
    expect(edgeActive(def, def.edges[4], states)).toBe(true);
    expect(edgeActive(def, def.edges[1], states)).toBe(false);
  });
  it('ne démarre que le déclencheur de départ', () => {
    expect(nextSteps(def, new Map()).run).toEqual(['start']);
  });
});
