import { describe, expect, it } from 'vitest';
import { computeStatement, monthStartOf } from './statement.js';
import { defaultBillingSettings, type BillingInputs, type BillingSettings } from './types.js';

const settings: BillingSettings = {
  ...defaultBillingSettings,
  planName: 'Cellule M',
  baseMonthlyEur: 900,
  includedProjects: 3,
  extraProjectEur: 150,
  creditPriceEur: 1,
  creditsPerUsd: 2,
  creditsPerManDay: 400,
  ctoDailyRateEur: 1200,
  ctoHoursPerDay: 8,
  usdToEur: 0.9,
};

const inputs = (over: Partial<BillingInputs> = {}): BillingInputs => ({
  monthStart: new Date(2026, 10, 1),
  now: new Date(2026, 10, 11),
  projectCount: 5,
  usageByProject: [
    { projectId: 'a', projectName: 'A', usd: 100 },
    { projectId: 'b', projectName: 'B', usd: 300 },
    { projectId: 'c', projectName: 'C', usd: 0 },
  ],
  usageByDay: [],
  // 10 USD par jour sur les 7 derniers jours.
  recentUsd: 70,
  ctoEntries: [
    { id: '1', day: '2026-11-03', hours: 4, projectId: null, projectName: null, description: '', createdByName: null, createdAt: new Date() },
    { id: '2', day: '2026-11-05', hours: 8, projectId: 'a', projectName: 'A', description: '', createdByName: null, createdAt: new Date() },
  ],
  ...over,
});

describe('computeStatement', () => {
  it('additionne abonnement, usage en crédits et temps CTO', () => {
    const s = computeStatement(settings, true, inputs(), false);
    expect(s.month).toBe('2026-11');
    expect(s.subscription).toEqual({ projects: 5, extraProjects: 2, baseEur: 900, extraEur: 300, totalEur: 1200 });
    expect(s.usage.credits).toBe(800);
    expect(s.usage.eur).toBe(800);
    expect(s.usage.manDays).toBe(2);
    expect(s.usage.byProject.map((p) => p.projectId)).toEqual(['b', 'a']);
    expect(s.cto).toMatchObject({ hours: 12, days: 1.5, eur: 1800 });
    expect(s.totalEur).toBe(1200 + 800 + 1800);
  });

  it("projette l'usage du mois en cours au rythme des 7 derniers jours, et seulement lui", () => {
    const s = computeStatement(settings, true, inputs(), false);
    expect(s.inProgress).toBe(true);
    expect(s.daysInMonth).toBe(30);
    // 400 USD réalisés + 20 jours restants × 10 USD, à 2 crédits par USD.
    expect(s.usage.projectedCredits).toBe(1200);
    expect(s.projectedTotalEur).toBe(1200 + 1200 + 1800);
    const closed = computeStatement(settings, true, inputs({ now: new Date(2026, 11, 15) }), false);
    expect(closed.inProgress).toBe(false);
    expect(closed.usage.projectedCredits).toBe(closed.usage.credits);
  });

  it('ne s’emballe pas le premier jour du mois', () => {
    const s = computeStatement(settings, true, inputs({ now: new Date(2026, 10, 1, 6), usageByProject: [{ projectId: 'a', projectName: 'A', usd: 50 }] }), false);
    // 50 USD en 6 h ne sont pas multipliés par 120 : 50 + 29,75 jours × 10 USD.
    expect(s.usage.projectedCredits).toBe(2 * (50 + 29.75 * 10));
  });

  it('ne montre le coût réel et le taux de conversion qu’au super administrateur', () => {
    const client = computeStatement(settings, true, inputs(), false);
    expect(client.operator).toBeNull();
    expect(JSON.stringify(client)).not.toContain('creditsPerUsd');
    expect(JSON.stringify(client)).not.toContain('usdToEur');
    const op = computeStatement(settings, true, inputs(), true);
    expect(op.operator).toEqual({ creditsPerUsd: 2, usdToEur: 0.9, costUsd: 400, costEur: 360, projectedCostEur: 540, projectedMarginEur: 1200 - 540 });
  });

  it('valide le mois demandé', () => {
    expect(monthStartOf('2026-02')).toEqual(new Date(2026, 1, 1));
    expect(() => monthStartOf('2026-13')).toThrow();
    expect(() => monthStartOf('nov')).toThrow();
  });
});
