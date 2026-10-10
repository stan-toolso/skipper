import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../graphql/automation';
import { autoLayout, availablePaths, edgeId, edgeLabel, emptyDefinition, newNode, nextKey, triggerVariablesFor, upstreamOf } from './workflowGraph';

const def: WorkflowDefinition = {
  nodes: [
    { key: 'start', type: 'trigger', label: 'Départ', position: { x: 0, y: 0 }, event: 'task.created', variables: [{ key: 'env', label: 'Environnement', description: null, required: false, defaultValue: 'prod' }] },
    { key: 'review', type: 'agent', label: 'Relecture', position: { x: 0, y: 0 }, agentId: 'a1' },
    { key: 'ok', type: 'condition', label: 'Approuvé ?', position: { x: 0, y: 0 }, expression: 'nodes.review.json.approved' },
    { key: 'done', type: 'end', label: 'Fin', position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'review' },
    { id: 'e2', source: 'review', target: 'ok' },
    { id: 'e3', source: 'ok', target: 'done', sourceHandle: 'true' },
  ],
};

describe('graphe de workflow', () => {
  it('génère des clés uniques et des nœuds avec leurs valeurs par défaut', () => {
    expect(nextKey(def, 'agent')).not.toBe('review');
    const n = newNode(def, 'condition', { x: 10, y: 20 });
    expect(n.type).toBe('condition');
    expect(n.key).not.toBe('ok');
    expect(emptyDefinition().nodes[0].type).toBe('trigger');
  });
  it('remonte les prédécesseurs transitifs', () => {
    expect([...upstreamOf(def, 'done')].sort()).toEqual(['ok', 'review', 'start']);
    expect(upstreamOf(def, 'start').size).toBe(0);
  });
  it('liste les variables du déclencheur (identifiant de tâche compris) et les chemins utilisables', () => {
    expect(triggerVariablesFor(def, 'review').map((v) => v.key)).toEqual(['taskId', 'env']);
    const paths = availablePaths(def, 'done').map((p) => p.path);
    expect(paths).toContain('input.env');
    expect(paths).toContain('input.task.title');
    expect(paths).toContain('nodes.review.output');
    expect(paths).toContain('nodes.review.json');
    expect(paths).not.toContain('nodes.ok.output');
    expect(availablePaths(def, 'start').map((p) => p.path)).not.toContain('nodes.review.output');
  });
  it('dispose les nœuds de gauche à droite', () => {
    const laid = autoLayout(def);
    const x = (k: string) => laid.nodes.find((n) => n.key === k)!.position.x;
    expect(x('start')).toBeLessThan(x('review'));
    expect(x('review')).toBeLessThan(x('ok'));
    expect(x('ok')).toBeLessThan(x('done'));
  });
  it('nomme les arêtes et leurs branches', () => {
    expect(edgeLabel({ id: 'x', source: 'a', target: 'b', sourceHandle: 'true' })).toBe('oui');
    expect(edgeLabel({ id: 'x', source: 'a', target: 'b', sourceHandle: 'error' })).toBe('erreur');
    expect(edgeLabel({ id: 'x', source: 'a', target: 'b' })).toBeUndefined();
    expect(edgeId('a', 'b', 'default')).toBe('a->b');
    expect(edgeId('a', 'b', 'false')).toBe('a:false->b');
  });
});
