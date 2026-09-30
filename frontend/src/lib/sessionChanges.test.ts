import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../graphql/operations';
import { fileToolResultCount } from './sessionChanges';

let n = 0;
const event = (type: string, content: unknown[]): SessionEvent => ({ id: String(++n), sessionId: 's', type, payload: { message: { content } }, createdAt: '' });
const call = (id: string, name: string) => event('claude.assistant', [{ type: 'tool_use', id, name, input: {} }]);
const result = (id: string) => event('claude.user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

describe('fileToolResultCount', () => {
  it('compte les résultats des outils qui modifient des fichiers, pas les autres', () => {
    const events = [call('1', 'Edit'), call('2', 'Read'), result('2'), call('3', 'Bash')];
    expect(fileToolResultCount(events)).toBe(0);
    events.push(result('1'));
    expect(fileToolResultCount(events)).toBe(1);
    events.push(result('3'), call('4', 'Write'), result('4'), call('5', 'Grep'), result('5'));
    expect(fileToolResultCount(events)).toBe(3);
  });

  it('ignore les événements sans contenu exploitable', () => {
    expect(fileToolResultCount([{ id: 'x', sessionId: 's', type: 'claude.user', payload: {}, createdAt: '' }, event('status', [])])).toBe(0);
  });
});
