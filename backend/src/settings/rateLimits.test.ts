import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Base et notifications simulées : on vérifie l'état fusionné et les alertes émises.
const settingsRepository = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(async () => {}), delete: vi.fn() }));
const notificationService = vi.hoisted(() => ({ notify: vi.fn(async () => null) }));
vi.mock('./repository.js', () => ({ settingsRepository }));
vi.mock('../notifications/service.js', () => ({ notificationService }));

const { describeRejection, mergeRateLimit, rateLimitService, rateLimitView } = await import('./rateLimits.js');

const RESET_5H = 1790811600;
const RESET_7D = 1791028800;
const now = new Date('2026-09-30T18:00:00Z');

/** Événement tel que rapporté par le CLI (forme relevée en production). */
function info(fiveHour: number, sevenDay: number, extra: Partial<SDKRateLimitInfo> & { overageIncluded?: number } = {}): SDKRateLimitInfo {
  const { overageIncluded, ...rest } = extra;
  return {
    status: 'allowed',
    resetsAt: RESET_5H,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { resetsAt: RESET_5H, utilization: fiveHour },
      seven_day: { resetsAt: RESET_7D, utilization: sevenDay },
      ...(overageIncluded !== undefined ? { seven_day_overage_included: { resetsAt: RESET_7D, utilization: overageIncluded } } : {}),
    },
    ...rest,
  } as SDKRateLimitInfo;
}

describe('mergeRateLimit', () => {
  it("reprend les fenêtres et le statut du dernier événement", () => {
    const { state, alerts } = mergeRateLimit(null, info(0.09, 0.41), now);
    expect(state.status).toBe('allowed');
    expect(state.rateLimitType).toBe('five_hour');
    expect(state.resetsAt).toBe(new Date(RESET_5H * 1000).toISOString());
    expect(state.windows.map((w) => [w.type, w.utilization])).toEqual([
      ['five_hour', 0.09],
      ['seven_day', 0.41],
    ]);
    expect(alerts).toEqual([]);
  });

  it('utilise utilization/resetsAt de la fenêtre du statut quand unifiedWindows est absent', () => {
    const { state } = mergeRateLimit(null, { status: 'allowed_warning', rateLimitType: 'seven_day_overage_included', utilization: 0.82, resetsAt: RESET_7D }, now);
    expect(state.windows).toEqual([{ type: 'seven_day_overage_included', utilization: 0.82, resetsAt: new Date(RESET_7D * 1000).toISOString(), observedAt: now.toISOString() }]);
  });

  it('signale 75 % puis 90 % une seule fois par période', () => {
    let r = mergeRateLimit(null, info(0.5, 0.7), now);
    r = mergeRateLimit(r.state, info(0.5, 0.76), now);
    expect(r.alerts).toEqual([{ kind: 'threshold', window: 'seven_day', level: 0.75, utilization: 0.76, resetsAt: new Date(RESET_7D * 1000).toISOString() }]);
    r = mergeRateLimit(r.state, info(0.5, 0.8), now);
    expect(r.alerts).toEqual([]);
    r = mergeRateLimit(r.state, info(0.5, 0.91), now);
    expect(r.alerts.map((a) => [a.window, a.level])).toEqual([['seven_day', 0.9]]);
    r = mergeRateLimit(r.state, info(0.5, 0.95), now);
    expect(r.alerts).toEqual([]);
  });

  it('signale directement 90 % quand le seuil de 75 % est sauté', () => {
    const r = mergeRateLimit(mergeRateLimit(null, info(0.6, 0.1), now).state, info(0.92, 0.1), now);
    expect(r.alerts.map((a) => [a.window, a.level])).toEqual([['five_hour', 0.9]]);
  });

  it('réarme les seuils à la réinitialisation de la fenêtre', () => {
    let r = mergeRateLimit(null, info(0.8, 0.1), now);
    expect(r.alerts).toHaveLength(1);
    const next = { ...info(0.8, 0.1), unifiedWindows: { five_hour: { resetsAt: RESET_5H + 5 * 3600, utilization: 0.8 } } } as SDKRateLimitInfo;
    r = mergeRateLimit(r.state, next, now);
    expect(r.alerts.map((a) => [a.window, a.level])).toEqual([['five_hour', 0.75]]);
  });

  it('signale le refus une fois par période, sans alerte de seuil en double', () => {
    const rejected = info(0.12, 0.52, { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: RESET_7D, overageIncluded: 1 });
    let r = mergeRateLimit(mergeRateLimit(null, info(0.12, 0.52), now).state, rejected, now);
    expect(r.alerts).toEqual([{ kind: 'rejected', window: 'seven_day_overage_included', level: 1, utilization: 1, resetsAt: new Date(RESET_7D * 1000).toISOString() }]);
    // Un autre modèle est accepté, puis le modèle limité est retenté : pas de nouvelle alerte.
    r = mergeRateLimit(r.state, info(0.13, 0.52), now);
    expect(r.state.status).toBe('allowed');
    r = mergeRateLimit(r.state, rejected, now);
    expect(r.alerts).toEqual([]);
    expect(r.state.status).toBe('rejected');
  });

  it("garde une fenêtre absente du dernier événement jusqu'à sa réinitialisation", () => {
    const rejected = info(0.12, 0.52, { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: RESET_7D, overageIncluded: 1 });
    let r = mergeRateLimit(null, rejected, now);
    r = mergeRateLimit(r.state, info(0.13, 0.52), new Date(now.getTime() + 60_000));
    const kept = r.state.windows.find((w) => w.type === 'seven_day_overage_included');
    expect(kept).toMatchObject({ utilization: 1, observedAt: now.toISOString() });
    expect(r.state.windows.map((w) => w.type)).toEqual(['five_hour', 'seven_day', 'seven_day_overage_included']);
    r = mergeRateLimit(r.state, info(0.13, 0.52), new Date((RESET_7D + 1) * 1000));
    expect(r.state.windows.map((w) => w.type)).not.toContain('seven_day_overage_included');
  });
});

describe('rateLimitService', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settingsRepository.get.mockResolvedValue(null);
    await rateLimitService.load();
  });

  it("expose le dernier événement et notifie les administrateurs au passage de 90 %", async () => {
    rateLimitService.record(info(0.5, 0.85), now);
    rateLimitService.record(info(0.5, 0.9), now);
    const view = rateLimitView();
    expect(view?.windows.find((w) => w.type === 'seven_day')).toMatchObject({ utilization: 0.9, label: '7 jours' });
    expect(notificationService.notify).toHaveBeenCalledTimes(2);
    expect(notificationService.notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude.rate_limit', adminsOnly: true, title: 'Limite Claude à 90 % : fenêtre 7 jours' }));
    await vi.waitFor(() => expect(settingsRepository.set).toHaveBeenLastCalledWith('claude.rate_limits', rateLimitService.current()));
  });

  it("explique un tour refusé d'après le dernier état", () => {
    rateLimitService.record(info(0.12, 0.52, { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: RESET_7D, overageIncluded: 1 }), now);
    expect(describeRejection(rateLimitService.current())).toMatch(/^Tour refusé : limite .* fenêtre 7 jours \(dépassement inclus\) \(100 %\)\. Réinitialisation /);
  });
});
