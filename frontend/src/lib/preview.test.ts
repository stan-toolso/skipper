import { describe, expect, it } from 'vitest';
import { depsLabel, formatDuration, previewSummary, type PreviewInfo } from './preview';

const base: PreviewInfo = {
  worksessionId: 'w', enabled: true, status: 'RUNNING', configured: true, configSource: '.skipper/preview.json', configError: null, command: 'npm run dev',
  url: 'https://x.apercu.exemple.fr', error: null, startedAt: null, readyAt: null, depsMode: null, installCommand: null, installMs: null, readyMs: null,
};

describe('aperçu : libellés', () => {
  it('formate les durées', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4200)).toBe('4,2 s');
    expect(formatDuration(72_000)).toBe('1 min 12 s');
    expect(formatDuration(120_000)).toBe('2 min');
  });
  it('dit ce qu’il est advenu des dépendances', () => {
    expect(depsLabel({ depsMode: 'snapshot', installCommand: null, installMs: null })).toBe('dépendances liées depuis le cache, rien à installer');
    expect(depsLabel({ depsMode: 'nearest', installCommand: 'npm install', installMs: 9000 })).toBe('dépendances liées depuis le cache puis complétées (9 s)');
    expect(depsLabel({ depsMode: 'present', installCommand: null, installMs: null })).toBe('dépendances déjà à jour');
    expect(depsLabel({ depsMode: 'none', installCommand: 'npm ci', installMs: 95_000 })).toBe('dépendances installées (1 min 35 s)');
    expect(depsLabel({ depsMode: 'none', installCommand: null, installMs: null })).toBeNull();
  });
  it('résume un aperçu prêt', () => {
    expect(previewSummary({ ...base, readyMs: 3400, depsMode: 'snapshot' })).toBe('Prêt en 3,4 s · dépendances liées depuis le cache, rien à installer');
    expect(previewSummary(base)).toBe('Prêt');
  });
});
