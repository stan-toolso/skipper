import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { notificationService } from '../notifications/service.js';
import { settingsRepository } from './repository.js';

const KEY_RATE_LIMITS = 'claude.rate_limits';

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** Seuils d'utilisation d'une fenêtre qui déclenchent une notification aux administrateurs. */
export const RATE_LIMIT_THRESHOLDS = [0.75, 0.9] as const;

/** Une fenêtre de limite d'utilisation de l'abonnement Claude (5 h, 7 j, 7 j dépassement inclus...). */
export interface RateLimitWindow {
  type: string;
  /** Part consommée, de 0 à 1 (peut dépasser 1). */
  utilization: number | null;
  resetsAt: string | null;
  /** Dernier événement qui a rapporté cette fenêtre (une fenêtre absente des événements suivants reste affichée jusqu'à sa réinitialisation). */
  observedAt: string;
}

/** Dernier état connu des limites d'utilisation (clé `claude.rate_limits` de app_settings). */
export interface RateLimitState {
  updatedAt: string;
  /** Statut du dernier événement reçu. */
  status: RateLimitStatus;
  /** Fenêtre à laquelle se rapporte ce statut. */
  rateLimitType: string | null;
  resetsAt: string | null;
  overageStatus: RateLimitStatus | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean;
  windows: RateLimitWindow[];
  /** Seuils déjà signalés par fenêtre, pour la période en cours (réinitialisés avec la fenêtre). */
  alerts: Record<string, { resetsAt: string | null; level: number }>;
  /** Refus déjà signalés par fenêtre : date de réinitialisation de la période signalée. */
  rejections: Record<string, string | null>;
}

export interface RateLimitAlert {
  kind: 'threshold' | 'rejected';
  window: string;
  /** Seuil franchi (0,75 ou 0,9) ; pour un refus, l'utilisation rapportée. */
  level: number;
  utilization: number | null;
  resetsAt: string | null;
}

const windowOrder = ['five_hour', 'seven_day', 'seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet', 'overage'];

export const rateLimitWindowLabels: Record<string, string> = {
  five_hour: '5 heures',
  seven_day: '7 jours',
  seven_day_overage_included: '7 jours (dépassement inclus)',
  seven_day_opus: '7 jours — Opus',
  seven_day_sonnet: '7 jours — Sonnet',
  overage: 'Dépassement',
};

export const windowLabel = (type: string | null): string => (type ? (rateLimitWindowLabels[type] ?? type) : 'inconnue');

const isoFromEpoch = (s: unknown): string | null => (typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fusionne un événement `rate_limit_event` dans l'état connu et renvoie les alertes à émettre.
 * Les fenêtres rapportées par l'événement (`unifiedWindows`, plus la fenêtre du statut) remplacent
 * les précédentes ; une fenêtre absente est conservée jusqu'à sa réinitialisation (ex. la limite
 * propre à un modèle, rapportée seulement quand on l'utilise). Une alerte par seuil et par période
 * de fenêtre, un refus signalé une fois par période.
 */
export function mergeRateLimit(prev: RateLimitState | null, info: SDKRateLimitInfo, now = new Date()): { state: RateLimitState; alerts: RateLimitAlert[] } {
  const at = now.toISOString();
  const reported = new Map<string, RateLimitWindow>();
  const unified = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> }).unifiedWindows ?? {};
  for (const [type, w] of Object.entries(unified)) {
    if (w && typeof w === 'object') reported.set(type, { type, utilization: num(w.utilization), resetsAt: isoFromEpoch(w.resetsAt), observedAt: at });
  }
  if (info.rateLimitType && !reported.has(info.rateLimitType)) {
    reported.set(info.rateLimitType, { type: info.rateLimitType, utilization: num(info.utilization), resetsAt: isoFromEpoch(info.resetsAt), observedAt: at });
  }
  const windows = new Map(reported);
  for (const w of prev?.windows ?? []) {
    if (windows.has(w.type)) continue;
    if (w.resetsAt && new Date(w.resetsAt) <= now) continue;
    windows.set(w.type, w);
  }
  const rank = (t: string) => (windowOrder.includes(t) ? windowOrder.indexOf(t) : windowOrder.length);

  const alerts: RateLimitAlert[] = [];
  const alertState = { ...(prev?.alerts ?? {}) };
  const rejections = { ...(prev?.rejections ?? {}) };
  const rejectedWindow = info.status === 'rejected' ? (info.rateLimitType ?? 'unknown') : null;
  if (rejectedWindow) {
    const resetsAt = reported.get(rejectedWindow)?.resetsAt ?? isoFromEpoch(info.resetsAt);
    if (!(rejectedWindow in rejections) || rejections[rejectedWindow] !== resetsAt) {
      alerts.push({ kind: 'rejected', window: rejectedWindow, level: 1, utilization: reported.get(rejectedWindow)?.utilization ?? null, resetsAt });
    }
    rejections[rejectedWindow] = resetsAt;
  }
  for (const w of reported.values()) {
    if (w.utilization === null) continue;
    const previous = alertState[w.type];
    const already = previous && previous.resetsAt === w.resetsAt ? previous.level : 0;
    const level = [...RATE_LIMIT_THRESHOLDS].reverse().find((t) => w.utilization! >= t) ?? 0;
    if (level > already) {
      // Le refus est déjà signalé pour cette fenêtre : inutile d'annoncer aussi le seuil.
      if (w.type !== rejectedWindow) alerts.push({ kind: 'threshold', window: w.type, level, utilization: w.utilization, resetsAt: w.resetsAt });
      alertState[w.type] = { resetsAt: w.resetsAt, level };
    } else if (!previous || previous.resetsAt !== w.resetsAt) {
      alertState[w.type] = { resetsAt: w.resetsAt, level };
    }
  }

  return {
    state: {
      updatedAt: at,
      status: info.status,
      rateLimitType: info.rateLimitType ?? null,
      resetsAt: isoFromEpoch(info.resetsAt),
      overageStatus: info.overageStatus ?? null,
      overageDisabledReason: info.overageDisabledReason ?? null,
      isUsingOverage: Boolean(info.isUsingOverage),
      windows: [...windows.values()].sort((a, b) => rank(a.type) - rank(b.type)),
      alerts: alertState,
      rejections,
    },
    alerts,
  };
}

const percent = (u: number | null) => (u === null ? '?' : `${Math.round(u * 100)} %`);
const formatReset = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;

/** Texte d'une alerte, pour la notification et le transcript. */
export function describeAlert(alert: RateLimitAlert): { title: string; message: string } {
  const reset = formatReset(alert.resetsAt);
  const until = reset ? ` Réinitialisation ${reset}.` : '';
  if (alert.kind === 'rejected') {
    return {
      title: `Limite Claude atteinte : fenêtre ${windowLabel(alert.window)}`,
      message: `Les tours des sessions sont refusés par Anthropic (${percent(alert.utilization)} utilisés).${until} Changez de modèle ou attendez la réinitialisation.`,
    };
  }
  return {
    title: `Limite Claude à ${Math.round(alert.level * 100)} % : fenêtre ${windowLabel(alert.window)}`,
    message: `${percent(alert.utilization)} de la fenêtre ${windowLabel(alert.window)} consommés.${until}`,
  };
}

/** Explication d'un tour refusé pour cause de limite, d'après le dernier état connu. */
export function describeRejection(state: RateLimitState | null): string {
  if (!state || state.status !== 'rejected') {
    return "Tour refusé : limite d'utilisation de l'abonnement Claude atteinte. Changez de modèle ou réessayez plus tard.";
  }
  const reset = formatReset(state.resetsAt);
  const w = state.windows.find((x) => x.type === state.rateLimitType);
  return `Tour refusé : limite d'utilisation de l'abonnement Claude atteinte sur la fenêtre ${windowLabel(state.rateLimitType)}${w ? ` (${percent(w.utilization)})` : ''}.${reset ? ` Réinitialisation ${reset}.` : ''} Changez de modèle ou attendez la réinitialisation.`;
}

/**
 * Limites d'utilisation de l'abonnement Claude (claude.ai) : le CLI envoie un `rate_limit_event`
 * à chaque appel au modèle. On garde le dernier état (en mémoire et en base) pour l'afficher, et on
 * prévient les administrateurs au franchissement des seuils et au premier refus.
 */
class RateLimitService {
  private state: RateLimitState | null = null;
  private saving: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    this.state = await settingsRepository.get<RateLimitState>(KEY_RATE_LIMITS);
  }

  current(): RateLimitState | null {
    return this.state;
  }

  /** Enregistre un événement ; renvoie le statut précédent (pour ne journaliser que les changements). */
  record(info: SDKRateLimitInfo, now = new Date()): { previousStatus: RateLimitStatus | null; alerts: RateLimitAlert[] } {
    const previousStatus = this.state?.status ?? null;
    const { state, alerts } = mergeRateLimit(this.state, info, now);
    this.state = state;
    // Écritures sérialisées : plusieurs sessions rapportent leurs événements en parallèle.
    this.saving = this.saving
      .then(() => settingsRepository.set(KEY_RATE_LIMITS, state))
      .catch((err) => console.error('[rate-limits] enregistrement impossible', err));
    for (const alert of alerts) {
      const { title, message } = describeAlert(alert);
      void notificationService.notify({ type: 'claude.rate_limit', title, message, link: '/settings', adminsOnly: true, payload: { ...alert } });
    }
    return { previousStatus, alerts };
  }
}

export const rateLimitService = new RateLimitService();

/** État exposé à l'interface (GraphQL), avec les libellés des fenêtres. */
export function rateLimitView(state = rateLimitService.current()) {
  if (!state) return null;
  return {
    updatedAt: state.updatedAt,
    status: state.status,
    rateLimitType: state.rateLimitType,
    rateLimitLabel: state.rateLimitType ? windowLabel(state.rateLimitType) : null,
    resetsAt: state.resetsAt,
    overageStatus: state.overageStatus,
    overageDisabledReason: state.overageDisabledReason,
    isUsingOverage: state.isUsingOverage,
    windows: state.windows.map((w) => ({ ...w, label: windowLabel(w.type) })),
  };
}
