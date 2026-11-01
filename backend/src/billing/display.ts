import type { GraphQLFieldResolver } from 'graphql';
import { billingService } from './service.js';

/**
 * Unité d'affichage des coûts. Une cellule dont la facturation est configurée exprime tous ses coûts en
 * **crédits** (l'unité facturée au client) : le coût des modèles en USD et le taux de conversion ne sortent
 * jamais du serveur, sauf dans la vue Toolso du relevé (`BillingStatement.operator`, super administrateurs).
 * Sans facturation configurée (instance interne), les coûts restent en USD.
 *
 * Les champs `…Usd` / `usd` de l'API gardent leur nom mais portent la valeur dans l'unité d'affichage
 * (`Query.costDisplay`) ; les budgets saisis le sont dans la même unité et reconvertis en USD avant d'être
 * enregistrés (`toStoredUsd`).
 */
export type CostUnit = 'USD' | 'CREDIT';

export interface CostDisplay {
  unit: CostUnit;
  /** Prix d'un crédit en euros HT (null en USD). */
  creditPriceEur: number | null;
}

/** Crédits par USD, ou null quand les coûts restent en USD. Lu au plus une fois par requête GraphQL. */
export async function costRate(ctx: object): Promise<number | null> {
  const memo = ctx as { costRate?: Promise<number | null> };
  memo.costRate ??= billingService.stored().then((s) => (s && s.creditsPerUsd > 0 ? s.creditsPerUsd : null));
  return memo.costRate;
}

export async function costDisplay(ctx: object): Promise<CostDisplay> {
  const rate = await costRate(ctx);
  if (rate === null) return { unit: 'USD', creditPriceEur: null };
  return { unit: 'CREDIT', creditPriceEur: (await billingService.settings()).creditPriceEur };
}

const convert = (v: unknown, rate: number | null): unknown => (typeof v === 'number' && rate !== null ? Math.round(v * rate * 10_000) / 10_000 : v);

/** Valeur saisie dans l'unité d'affichage → USD enregistré (budgets). */
export function toStoredUsd(v: number | null | undefined, rate: number | null): number | null | undefined {
  return typeof v === 'number' && rate !== null ? v / rate : v;
}

/** Montant en USD rédigé dans l'unité d'affichage, pour un message d'erreur (ex. plafond atteint). */
export async function describeCost(usd: number): Promise<string> {
  const s = await billingService.stored();
  if (s && s.creditsPerUsd > 0) return `${(usd * s.creditsPerUsd).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} crédits`;
  return `${usd.toFixed(2)} $`;
}

/** Champs de coût convertis (type GraphQL → champs). */
export const COST_FIELDS: Record<string, string[]> = {
  Session: ['costUsd'],
  WorkflowRun: ['costUsd'],
  SessionContext: ['coldTurnUsd'],
  ClaudeSettings: ['monthlyBudgetUsd', 'sessionBudgetUsd'],
  OpencodeSettings: ['sessionBudgetUsd'],
  UsageByModel: ['usd'],
  UsageBySession: ['usd'],
  UsageSummary: ['monthUsd', 'totalUsd'],
  DashboardUsageDay: ['usd'],
  DashboardUsage: ['monthUsd', 'globalMonthUsd', 'monthlyBudgetUsd', 'todayUsd', 'last7DaysUsd', 'previous7DaysUsd'],
  DashboardProject: ['monthUsd'],
};

/**
 * Coûts contenus dans les événements du transcript : résultat d'un tour du SDK (`total_cost_usd`,
 * `modelUsage.*.costUSD`) et relevé de consommation (`usage` : `deltaUsd`, `totalUsd`).
 */
export function convertEventPayload(type: string, payload: unknown, rate: number | null): unknown {
  if (rate === null || !payload || typeof payload !== 'object') return payload;
  const p = payload as Record<string, unknown>;
  if (type === 'usage') return { ...p, deltaUsd: convert(p.deltaUsd, rate), totalUsd: convert(p.totalUsd, rate) };
  if (!('total_cost_usd' in p) && !('modelUsage' in p)) return payload;
  const out: Record<string, unknown> = { ...p, total_cost_usd: convert(p.total_cost_usd, rate) };
  if (p.modelUsage && typeof p.modelUsage === 'object') {
    out.modelUsage = Object.fromEntries(
      Object.entries(p.modelUsage as Record<string, unknown>).map(([model, u]) => [model, u && typeof u === 'object' ? { ...(u as object), costUSD: convert((u as { costUSD?: unknown }).costUSD, rate) } : u]),
    );
  }
  return out;
}

type ResolverMap = Record<string, Record<string, unknown> | unknown>;

/**
 * Enveloppe les résolveurs des champs de coût (et du `payload` des événements de session) pour rendre
 * leurs valeurs dans l'unité d'affichage. À appliquer une fois à la table des résolveurs.
 */
export function applyCostConversion<T extends ResolverMap>(resolvers: T): T {
  const map = resolvers as Record<string, Record<string, unknown>>;
  for (const [type, fields] of Object.entries(COST_FIELDS)) {
    map[type] ??= {};
    for (const field of fields) {
      const inner = map[type][field] as GraphQLFieldResolver<Record<string, unknown>, object> | undefined;
      map[type][field] = async (parent: Record<string, unknown>, args: unknown, ctx: object, info: never) => {
        const value = inner ? await inner(parent, args as Record<string, unknown>, ctx, info) : parent[field];
        return convert(value, await costRate(ctx));
      };
    }
  }
  map.SessionEvent ??= {};
  const innerPayload = map.SessionEvent.payload as GraphQLFieldResolver<{ type: string; payload: unknown }, object> | undefined;
  map.SessionEvent.payload = async (event: { type: string; payload: unknown }, args: unknown, ctx: object, info: never) => {
    const payload = innerPayload ? await innerPayload(event, args as Record<string, unknown>, ctx, info) : event.payload;
    return convertEventPayload(event.type, payload, await costRate(ctx));
  };
  return resolvers;
}
