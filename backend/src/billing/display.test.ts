import { describe, expect, it, vi } from 'vitest';

const billing = vi.hoisted(() => ({ stored: null as null | { creditsPerUsd: number; creditPriceEur: number } }));
vi.mock('./service.js', () => ({
  billingService: {
    stored: async () => billing.stored,
    settings: async () => billing.stored ?? { creditsPerUsd: 1, creditPriceEur: 1 },
  },
}));

const { applyCostConversion, convertEventPayload, costDisplay, toStoredUsd } = await import('./display.js');

const resolve = async (resolvers: Record<string, Record<string, unknown>>, type: string, field: string, parent: object) =>
  (resolvers[type][field] as (p: object, a: object, c: object, i: never) => Promise<unknown>)(parent, {}, {}, undefined as never);

describe('conversion des coûts', () => {
  it('laisse les coûts en USD sans facturation configurée', async () => {
    billing.stored = null;
    const r = applyCostConversion({} as Record<string, Record<string, unknown>>);
    expect(await resolve(r, 'Session', 'costUsd', { costUsd: 1.5 })).toBe(1.5);
    expect(await costDisplay({})).toEqual({ unit: 'USD', creditPriceEur: null });
  });

  it('rend les champs de coût en crédits, y compris ceux qui ont déjà un résolveur', async () => {
    billing.stored = { creditsPerUsd: 4, creditPriceEur: 0.5 };
    const r = applyCostConversion({ SessionContext: { coldTurnUsd: () => 0.25 } } as Record<string, Record<string, unknown>>);
    expect(await resolve(r, 'Session', 'costUsd', { costUsd: 1.5 })).toBe(6);
    expect(await resolve(r, 'DashboardUsage', 'monthlyBudgetUsd', { monthlyBudgetUsd: null })).toBeNull();
    expect(await resolve(r, 'SessionContext', 'coldTurnUsd', {})).toBe(1);
    expect(await resolve(r, 'SessionEvent', 'payload', { type: 'usage', payload: { deltaUsd: 0.5, totalUsd: 2 } })).toEqual({ deltaUsd: 2, totalUsd: 8 });
    expect(await costDisplay({})).toEqual({ unit: 'CREDIT', creditPriceEur: 0.5 });
  });

  it('convertit les coûts du résultat d’un tour du SDK', () => {
    const out = convertEventPayload('result', { subtype: 'success', total_cost_usd: 2, modelUsage: { opus: { costUSD: 1.5, inputTokens: 10 } } }, 3) as Record<string, unknown>;
    expect(out.total_cost_usd).toBe(6);
    expect(out.modelUsage).toEqual({ opus: { costUSD: 4.5, inputTokens: 10 } });
    expect(convertEventPayload('assistant', { text: 'x' }, 3)).toEqual({ text: 'x' });
  });

  it('reconvertit en USD les budgets saisis en crédits', () => {
    expect(toStoredUsd(100, 4)).toBe(25);
    expect(toStoredUsd(null, 4)).toBeNull();
    expect(toStoredUsd(undefined, 4)).toBeUndefined();
    expect(toStoredUsd(100, null)).toBe(100);
  });
});
