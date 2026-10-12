import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));
const { CONTEXT_WARN_TOKENS, contextEstimate, contextModel, modelProfile } = await import('./context.js');
const { pool } = await import('../db/pool.js');

describe('modelProfile', () => {
  it('reconnaît les familles de modèles et leurs alias', () => {
    expect(modelProfile('claude-opus-5-5').inputUsdPerMTok).toBe(4);
    expect(modelProfile('claude-opus-4-1-20250805').inputUsdPerMTok).toBe(5);
    expect(modelProfile('opus').inputUsdPerMTok).toBe(4);
    expect(modelProfile('claude-sonnet-4-6').inputUsdPerMTok).toBe(3);
    expect(modelProfile('sonnet').inputUsdPerMTok).toBe(2);
    expect(modelProfile('claude-haiku-4-5')).toEqual({ windowTokens: 200_000, inputUsdPerMTok: 1 });
    expect(modelProfile('claude-fable-5-1').inputUsdPerMTok).toBe(10);
    expect(modelProfile(null)).toEqual(modelProfile('opus'));
  });
});

describe('contextEstimate', () => {
  it('rapporte le contexte à la fenêtre et au tarif du modèle', () => {
    const e = contextEstimate(200_000, 'claude-opus-5-5');
    expect(e.share).toBeCloseTo(0.2);
    expect(e.coldTurnUsd).toBeCloseTo(0.8);
    expect(e.overThreshold).toBe(true);
    expect(e.warnTokens).toBe(CONTEXT_WARN_TOKENS);
  });

  it('reste neutre quand la taille est inconnue et sous le seuil', () => {
    expect(contextEstimate(null, 'opus')).toMatchObject({ tokens: null, share: null, coldTurnUsd: null, overThreshold: false });
    expect(contextEstimate(CONTEXT_WARN_TOKENS - 1, 'opus').overThreshold).toBe(false);
  });
});

describe('contextModel', () => {
  const session = (model?: string) => ({ id: 's1', config: model ? { model } : {} }) as never;
  it('préfère le dernier modèle facturé au modèle configuré', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ models: { 'claude-opus-4-1-20250805': 0.4, 'claude-haiku-4-5': 0.01 } }] } as never);
    expect(await contextModel(session('opus'))).toBe('claude-opus-4-1-20250805');
  });
  it("se rabat sur la configuration, en ignorant les alias du relevé", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ models: { default: 0.2 } }] } as never);
    expect(await contextModel(session('sonnet'))).toBe('sonnet');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    expect(await contextModel(session())).toBeNull();
  });
});
