import { describe, expect, it } from 'vitest';
import { runOutcome, summarizeEvents, toolLabel } from './outcome.js';

const result = (payload: Record<string, unknown>) => ({ type: 'claude.result', payload });

describe('summarizeEvents', () => {
  it('additionne le coût et la durée des tours et garde la dernière réponse', () => {
    const s = summarizeEvents([
      { type: 'usage', payload: { deltaUsd: 0.1 } },
      result({ duration_ms: 1000, result: 'Premier tour' }),
      { type: 'usage', payload: { deltaUsd: 0.05 } },
      result({ duration_ms: 500, result: '  Rien de neuf aujourd’hui.  ' }),
    ]);
    expect(s.cost).toBeCloseTo(0.15);
    expect(s.durationMs).toBe(1500);
    expect(s.error).toBeNull();
    expect(s.answer).toBe('Rien de neuf aujourd’hui.');
    expect(s.denied).toEqual([]);
  });

  it('relève les outils refusés, sans doublon et sous un nom lisible', () => {
    const s = summarizeEvents([
      result({
        result: "Je ne peux pas lire la base : l'accès est refusé.",
        permission_denials: [{ tool_name: 'mcp__vault__sql_query' }, { tool_name: 'mcp__vault__sql_query' }, { tool_name: 'Bash' }, { nope: 1 }],
      }),
    ]);
    expect(s.denied).toEqual(['vault.sql_query', 'Bash']);
  });

  it("retient l'erreur d'un tour et l'échec de la session", () => {
    expect(summarizeEvents([result({ is_error: true, subtype: 'error_max_turns' })]).error).toBe('error_max_turns');
    expect(summarizeEvents([{ type: 'status', payload: { status: 'failed', error: 'conteneur arrêté' } }]).error).toBe('conteneur arrêté');
  });
});

describe('runOutcome', () => {
  const base = { cost: 0, durationMs: 1, error: null, denied: [], answer: null };
  const idle = { stillBusy: false, pendingRequest: null };

  it("note « bloquée » une exécution dont un outil a été refusé, même si l'agent a répondu", () => {
    expect(runOutcome({ ...base, denied: ['vault.sql_query'], answer: 'Accès refusé' }, idle)).toEqual({ status: 'blocked', message: 'Autorisation refusée : vault.sql_query' });
  });

  it('note « bloquée » une exécution qui attend une réponse humaine', () => {
    expect(runOutcome(base, { stillBusy: false, pendingRequest: 'Autoriser sql_query ?' }).status).toBe('blocked');
  });

  it("l'erreur l'emporte, puis le délai dépassé ; sinon terminée", () => {
    expect(runOutcome({ ...base, error: 'boum', denied: ['Bash'] }, idle)).toEqual({ status: 'failed', message: 'boum' });
    expect(runOutcome(base, { stillBusy: true, pendingRequest: null }).status).toBe('timeout');
    expect(runOutcome(base, idle)).toEqual({ status: 'done', message: null });
  });
});

describe('toolLabel', () => {
  it('raccourcit les outils MCP', () => {
    expect(toolLabel('mcp__vault__sql_query')).toBe('vault.sql_query');
    expect(toolLabel('Read')).toBe('Read');
  });
});
