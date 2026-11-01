import type { BillingInputs, BillingSettings, BillingStatement } from './types.js';

const DAY_MS = 86_400_000;

/** Fenêtre du rythme de consommation qui sert à la projection. */
export const RECENT_DAYS = 7;

/** Arrondi au centime (ou à 2 décimales pour les crédits et les jours). */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Premier jour du mois `AAAA-MM` (minuit, heure du serveur) ; mois courant sans argument. */
export function monthStartOf(month: string | null | undefined, now = new Date()): Date {
  if (!month) return new Date(now.getFullYear(), now.getMonth(), 1);
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`Mois invalide : ${month} (AAAA-MM attendu)`);
  return new Date(Number(m[1]), Number(m[2]) - 1, 1);
}

export const nextMonthStart = (monthStart: Date): Date => new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);

export const monthKey = (monthStart: Date): string => `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;

/**
 * Relevé d'un mois : abonnement, usage des agents en crédits, temps CTO, total et projection de fin de mois.
 * Projection de l'usage des agents : le réalisé, plus les jours restants au rythme moyen des 7 derniers jours
 * (stable en début de mois, et suit un changement de rythme) ; l'abonnement est un forfait et le temps CTO
 * n'est compté que tel que saisi.
 */
export function computeStatement(settings: BillingSettings, configured: boolean, inputs: BillingInputs, withOperator: boolean): BillingStatement {
  const { monthStart, now } = inputs;
  const monthEnd = nextMonthStart(monthStart);
  const daysInMonth = Math.round((monthEnd.getTime() - monthStart.getTime()) / DAY_MS);
  const inProgress = now >= monthStart && now < monthEnd;
  const elapsedMs = Math.min(Math.max(now.getTime() - monthStart.getTime(), 0), monthEnd.getTime() - monthStart.getTime());
  const daysElapsed = elapsedMs / DAY_MS;
  const remainingDays = inProgress ? daysInMonth - daysElapsed : 0;
  const projectedUsd = (usd: number) => usd + (inputs.recentUsd / RECENT_DAYS) * remainingDays;

  const credits = (usd: number) => usd * settings.creditsPerUsd;
  const manDays = (c: number) => (settings.creditsPerManDay > 0 ? c / settings.creditsPerManDay : 0);
  const creditEur = (c: number) => c * settings.creditPriceEur;

  const extraProjects = Math.max(0, inputs.projectCount - settings.includedProjects);
  const subscription = {
    projects: inputs.projectCount,
    extraProjects,
    baseEur: round2(settings.baseMonthlyEur),
    extraEur: round2(extraProjects * settings.extraProjectEur),
    totalEur: round2(settings.baseMonthlyEur + extraProjects * settings.extraProjectEur),
  };

  const usd = inputs.usageByProject.reduce((a, p) => a + p.usd, 0);
  const usedCredits = credits(usd);
  const projectedCredits = credits(projectedUsd(usd));
  const usage = {
    credits: round2(usedCredits),
    eur: round2(creditEur(usedCredits)),
    manDays: round2(manDays(usedCredits)),
    projectedCredits: round2(projectedCredits),
    projectedEur: round2(creditEur(projectedCredits)),
    projectedManDays: round2(manDays(projectedCredits)),
    byProject: inputs.usageByProject
      .map((p) => ({ projectId: p.projectId, projectName: p.projectName, credits: round2(credits(p.usd)), eur: round2(creditEur(credits(p.usd))), manDays: round2(manDays(credits(p.usd))) }))
      .filter((p) => p.credits > 0)
      .sort((a, b) => b.credits - a.credits),
    byDay: inputs.usageByDay.map((d) => ({ day: d.day, credits: round2(credits(d.usd)) })),
  };

  const hours = inputs.ctoEntries.reduce((a, e) => a + e.hours, 0);
  const ctoDays = settings.ctoHoursPerDay > 0 ? hours / settings.ctoHoursPerDay : 0;
  const cto = { hours: round2(hours), days: round2(ctoDays), eur: round2(ctoDays * settings.ctoDailyRateEur), entries: inputs.ctoEntries };

  const totalEur = round2(subscription.totalEur + usage.eur + cto.eur);
  const projectedTotalEur = round2(subscription.totalEur + usage.projectedEur + cto.eur);
  const { creditsPerUsd, usdToEur, ...plan } = settings;
  return {
    month: monthKey(monthStart),
    configured,
    inProgress,
    daysInMonth,
    daysElapsed: round2(daysElapsed),
    plan,
    subscription,
    usage,
    cto,
    totalEur,
    projectedTotalEur,
    operator: withOperator
      ? {
          creditsPerUsd,
          usdToEur,
          costUsd: round2(usd),
          costEur: round2(usd * usdToEur),
          projectedCostEur: round2(projectedUsd(usd) * usdToEur),
          projectedMarginEur: round2(usage.projectedEur - projectedUsd(usd) * usdToEur),
        }
      : null,
  };
}
