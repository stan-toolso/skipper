import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../graphql/operations';
import { ATTACHMENTS_ONLY_TEXT, confirmedPending, newPendingInstruction, withPendingInstructions } from './pendingInstructions';

let n = 0;
const instruction = (text: string): SessionEvent => ({ id: String(++n), sessionId: 's', type: 'instruction', payload: { text }, createdAt: '' });
const answer = (): SessionEvent => ({ id: String(++n), sessionId: 's', type: 'claude.assistant', payload: { message: { content: [{ type: 'text', text: 'ok' }] } }, createdAt: '' });

describe('withPendingInstructions', () => {
  it("ajoute l'instruction en attente à la fin, puis la retire quand le serveur l'a journalisée", () => {
    const events = [instruction('bonjour'), answer()];
    const p = newPendingInstruction('  fais ceci  ', [], events.length);
    const shown = withPendingInstructions(events, [p]);
    expect(shown).toHaveLength(3);
    expect(shown[2].type).toBe('instruction');
    expect(shown[2].payload).toMatchObject({ text: 'fais ceci', pending: true });

    const confirmed = [...events, instruction('fais ceci')];
    expect(withPendingInstructions(confirmed, [p])).toBe(confirmed);
    expect(confirmedPending(confirmed, [p])).toEqual(new Set([p.id]));
  });

  it("ne confond pas une instruction ancienne de même texte avec l'envoi en cours", () => {
    const events = [instruction('encore'), answer()];
    const p = newPendingInstruction('encore', [], events.length);
    expect(withPendingInstructions(events, [p])).toHaveLength(3);
    expect(confirmedPending(events, [p]).size).toBe(0);
  });

  it('attribue chaque événement du serveur à une seule instruction en attente (deux envois identiques)', () => {
    const events: SessionEvent[] = [];
    const p1 = newPendingInstruction('go', [], 0);
    const p2 = newPendingInstruction('go', [], 0);
    expect(withPendingInstructions(events, [p1, p2])).toHaveLength(2);
    const one = [instruction('go')];
    expect(confirmedPending(one, [p1, p2])).toEqual(new Set([p1.id]));
    expect(withPendingInstructions(one, [p1, p2])).toHaveLength(2);
    const two = [...one, instruction('go')];
    expect(withPendingInstructions(two, [p1, p2])).toBe(two);
  });

  it('donne au message sans texte le libellé du serveur, pour le reconnaître à son arrivée', () => {
    const file = { name: 'a.png', mediaType: 'image/png', size: 10, previewUrl: null };
    const p = newPendingInstruction('', [file], 0);
    expect(p.text).toBe(ATTACHMENTS_ONLY_TEXT);
    const shown = withPendingInstructions([], [p]);
    expect(shown[0].payload.localAttachments).toEqual([file]);
    expect(confirmedPending([instruction(ATTACHMENTS_ONLY_TEXT)], [p]).size).toBe(1);
  });

  it('sans instruction en attente, renvoie la liste telle quelle', () => {
    const events = [instruction('x')];
    expect(withPendingInstructions(events, [])).toBe(events);
  });
});
