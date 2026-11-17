import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../graphql/operations';
import { subagentTranscript } from './subagentTranscript';

const ev = (id: string, type: string, payload: Record<string, unknown>): SessionEvent => ({ id, sessionId: 's1', type, payload, createdAt: '2026-11-17T10:00:00Z' });

describe('subagentTranscript', () => {
  it("fait de l'appel Agent l'instruction et rend visibles les messages du sous-agent", () => {
    const events = [
      ev('1', 'claude.assistant', { message: { content: [{ type: 'text', text: 'Je lance' }, { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Explore le front', subagent_type: 'Explore', prompt: 'Cherche les composants', run_in_background: true } }] } }),
      ev('2', 'claude.assistant', { parent_tool_use_id: 'tu1', message: { content: [{ type: 'text', text: 'Je regarde' }] } }),
      ev('3', 'claude.assistant', { parent_tool_use_id: 'tu9', message: { content: [] } }),
    ];
    const { events: out, call } = subagentTranscript(events, 'tu1');
    expect(call).toEqual({ description: 'Explore le front', agentType: 'Explore', prompt: 'Cherche les composants', background: true });
    expect(out.map((e) => e.type)).toEqual(['instruction', 'claude.assistant', 'claude.assistant']);
    expect(out[0].payload.text).toBe('Cherche les composants');
    expect(out[1].payload).not.toHaveProperty('parent_tool_use_id');
    expect(out[2].payload.parent_tool_use_id).toBe('tu9');
  });

  it("sans l'appel (hors de la page chargée), garde les messages", () => {
    const { events: out, call } = subagentTranscript([ev('2', 'claude.user', { parent_tool_use_id: 'tu1', message: { content: [] } })], 'tu1');
    expect(call).toBeNull();
    expect(out).toHaveLength(1);
  });
});
