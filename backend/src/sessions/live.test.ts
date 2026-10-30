import { afterEach, describe, expect, it } from 'vitest';
import { liveDraftService } from './live.js';

const S = 'session-1';

afterEach(() => liveDraftService.clear(S));

describe('liveDraftService', () => {
  it('reconstitue le texte au fil des deltas et le rend disponible', () => {
    expect(liveDraftService.get(S)).toBeNull();
    liveDraftService.apply(S, { type: 'message_start' });
    expect(liveDraftService.get(S)).toBeNull();
    liveDraftService.apply(S, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour' } });
    liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', je regarde.' } });
    expect(liveDraftService.get(S)).toMatchObject({ text: 'Bonjour, je regarde.', thinking: false });
  });

  it('signale la réflexion sans en transmettre le contenu, puis la fin du bloc', () => {
    liveDraftService.apply(S, { type: 'message_start' });
    liveDraftService.apply(S, { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } });
    expect(liveDraftService.get(S)).toMatchObject({ text: '', thinking: true });
    expect(JSON.stringify(liveDraftService.get(S))).not.toContain('secret');
    liveDraftService.apply(S, { type: 'content_block_stop', index: 0 });
    expect(liveDraftService.get(S)).toBeNull();
  });

  it('sépare deux blocs de texte successifs par une ligne vide', () => {
    liveDraftService.apply(S, { type: 'message_start' });
    liveDraftService.apply(S, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Premier.' } });
    liveDraftService.apply(S, { type: 'content_block_stop', index: 0 });
    liveDraftService.apply(S, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    liveDraftService.apply(S, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Second.' } });
    expect(liveDraftService.get(S)?.text).toBe('Premier.\n\nSecond.');
  });

  it('ignore les messages internes des sous-agents et les deltas sans texte', () => {
    expect(liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'caché' } }, 'toolu_parent')).toBe(false);
    expect(liveDraftService.get(S)).toBeNull();
    expect(liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } })).toBe(false);
    expect(liveDraftService.get(S)).toBeNull();
  });

  it('repart de zéro à chaque nouveau message et s’efface quand le message complet arrive', () => {
    liveDraftService.apply(S, { type: 'message_start' });
    liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ancien' } });
    liveDraftService.apply(S, { type: 'message_start' });
    expect(liveDraftService.get(S)).toBeNull();
    liveDraftService.apply(S, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Nouveau' } });
    expect(liveDraftService.get(S)?.text).toBe('Nouveau');
    liveDraftService.clear(S);
    expect(liveDraftService.get(S)).toBeNull();
  });
});
