import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../graphql/operations';
import { nextEventsState, type SessionEventsState } from './sessionEvents';

const ev = (id: string): SessionEvent => ({ id, sessionId: 's', type: 'stdout', payload: { text: id }, createdAt: '2026-10-30T10:00:00Z' });
const base: SessionEventsState = { sessionId: 's', events: [ev('1')], loaded: true, draft: null };

describe('nextEventsState', () => {
  it("renvoie l'état précédent tel quel quand rien n'a changé (pas de re-rendu)", () => {
    expect(nextEventsState(base, [], null, false)).toBe(base);
    const typing = { ...base, draft: { text: 'Bonjour', thinking: false } };
    expect(nextEventsState(typing, [], { text: 'Bonjour', thinking: false }, false)).toBe(typing);
  });

  it('ajoute les événements de la page en fin de liste', () => {
    const next = nextEventsState(base, [ev('2'), ev('3')], null, false);
    expect(next.events.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(next.loaded).toBe(true);
  });

  it("marque l'historique rattrapé dès qu'une page n'est pas pleine, et le reste ensuite", () => {
    const loading: SessionEventsState = { sessionId: 's', events: [], loaded: false, draft: null };
    expect(nextEventsState(loading, [ev('1')], null, true).loaded).toBe(false);
    const done = nextEventsState(loading, [ev('1')], null, false);
    expect(done.loaded).toBe(true);
    expect(nextEventsState(done, [ev('2')], null, true).loaded).toBe(true);
  });

  it('change d’état quand le brouillon apparaît, grandit ou disparaît', () => {
    const typing = nextEventsState(base, [], { text: 'Bon', thinking: false }, false);
    expect(typing).not.toBe(base);
    const more = nextEventsState(typing, [], { text: 'Bonjour', thinking: false }, false);
    expect(more.draft?.text).toBe('Bonjour');
    expect(more.events).toBe(base.events);
    expect(nextEventsState(more, [], null, false).draft).toBeNull();
  });
});
