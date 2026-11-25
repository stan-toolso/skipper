import { describe, expect, it } from 'vitest';
import { isIdle, lastActivity } from './idle.js';
import { deriveState, parseEvents } from './state.js';

const H = 3600_000;
const now = Date.parse('2026-11-25T23:00:00Z');
const ev = (lines: [number, string][]) => parseEvents(lines.map(([ago, e]) => `${now - ago} ${e}`).join('\n'));

describe('aperçus sans visite', () => {
  const running = ev([[7 * 24 * H, 'begin'], [7 * 24 * H - 1000, 'starting'], [7 * 24 * H - 500, 'ready']]);

  it('dernier signe de vie : la visite ou la dernière étape du lancement', () => {
    expect(lastActivity(running, null)).toBe(now - 7 * 24 * H + 1000);
    expect(lastActivity(running, now - H)).toBe(now - H);
    expect(lastActivity([], null)).toBeNull();
  });

  it('lancé il y a 7 jours, jamais visité : à arrêter', () => {
    expect(isIdle(running, null, 4 * H, now)).toBe(true);
  });

  it('visité il y a une heure, ou lancé récemment : gardé', () => {
    expect(isIdle(running, now - H, 4 * H, now)).toBe(false);
    expect(isIdle(ev([[2 * H, 'begin'], [2 * H, 'starting']]), null, 4 * H, now)).toBe(false);
  });

  it('déjà arrêté ou en échec : rien à faire ; délai nul : jamais', () => {
    expect(isIdle(ev([[9 * H, 'begin'], [9 * H, 'starting'], [8 * H, 'stopped']]), null, 4 * H, now)).toBe(false);
    expect(isIdle(ev([[9 * H, 'begin'], [9 * H, 'exited 1']]), null, 4 * H, now)).toBe(false);
    expect(isIdle(running, null, 0, now)).toBe(false);
  });

  it("l'onglet Aperçu dit pourquoi il a été arrêté", () => {
    const state = deriveState(ev([[9 * H, 'begin'], [9 * H, 'starting'], [H, 'stopped idle 4']]), false, false);
    expect(state.status).toBe('STOPPED');
    expect(state.error).toBe('Arrêté après 4 h sans visite : relancez-le pour le rouvrir');
    expect(deriveState(ev([[9 * H, 'begin'], [H, 'stopped']]), false, false).error).toBeNull();
  });
});
