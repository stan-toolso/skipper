import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../graphql/operations';
import Transcript, { nonZeroExit } from './Transcript';

// Le module des adresses de l'API lit window au chargement ; sans navigateur, on le remplace.
vi.mock('../apollo', () => ({ apiBaseUrl: '' }));

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): SessionEvent => ({ id: String(++seq), sessionId: 's', type, payload, createdAt: '2026-10-08T10:00:00Z' }) as SessionEvent;
const text = (t: string) => ev('claude.assistant', { message: { content: [{ type: 'text', text: t }] } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ev('claude.assistant', { message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, out: string, isError = false) => ev('claude.user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: isError }] } });

const turn = [
  ev('instruction', { text: 'Corrige le bug' }),
  text('Je regarde le code.'),
  tool('t1', 'Read', { file_path: '/w/a.ts' }),
  result('t1', 'x'),
  tool('t2', 'Bash', { command: 'npm test' }),
  result('t2', 'ok'),
  tool('t3', 'Bash', { command: 'npm run build' }),
  result('t3', 'ok'),
  text('Le bug est corrigé.'),
  ev('claude.result', { duration_ms: 1000 }),
];
const html = (events: SessionEvent[], technical = false) => renderToStaticMarkup(<Transcript events={events} technical={technical} autoScroll={false} />);

describe('Transcript', () => {
  it('replie les étapes d’un tour et garde son dernier message en vue', () => {
    const out = html(turn);
    expect(out).toContain('Le bug est corrigé.');
    expect(out).toContain('3 étapes · 1 message · Read · Bash ×2');
    expect(out).not.toContain('Je regarde le code.');
    expect(out).not.toContain('npm test');
  });

  it('montre chaque étape en mode technique', () => {
    const out = html(turn, true);
    expect(out).not.toContain('cc-group');
    expect(out).toContain('Je regarde le code.');
    expect(out).toContain('npm test');
  });

  it('garde les questions de l’agent hors du groupe', () => {
    const out = html([ev('instruction', { text: 'Go' }), tool('t1', 'Read', { file_path: '/w/a.ts' }), result('t1', 'x'), tool('q1', 'AskUserQuestion', { questions: [{ question: 'Quelle branche ?' }] })]);
    expect(out).toContain('Quelle branche ?');
    expect(out).toContain('cc-group');
  });

  it('nomme la dernière étape d’un tour en cours', () => {
    const out = html([ev('instruction', { text: 'Go' }), tool('t1', 'Read', { file_path: '/w/a.ts' }), result('t1', 'x'), tool('t2', 'Bash', { command: 'npm test' })]);
    expect(out).toContain('Bash(npm test)…');
  });

  it('signale une commande sortie en code non nul comme un avertissement, pas une erreur', () => {
    expect(nonZeroExit('Bash', { text: 'Exit code 1\nrien trouvé', isError: true })).toEqual({ code: 1, output: 'rien trouvé' });
    expect(nonZeroExit('Bash', { text: 'Exit code 1\n', isError: true })).toBeNull();
    expect(nonZeroExit('Read', { text: 'Exit code 1\nx', isError: true })).toBeNull();
    const out = html([ev('instruction', { text: 'Go' }), tool('t1', 'Bash', { command: 'grep foo' }), result('t1', 'Exit code 1\nrien trouvé', true)], true);
    expect(out).toContain('Code de sortie 1');
    expect(out).toContain('cc-dot warn');
    expect(out).not.toContain('cc-result error');
  });
});
