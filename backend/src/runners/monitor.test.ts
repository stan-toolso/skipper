import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerStats } from './stats.js';

const stats = vi.fn<() => Promise<ContainerStats | null>>();
const oomKilled = vi.fn(async () => false);
vi.mock('./index.js', () => ({ runner: { stats: () => stats(), containerName: () => 'skipper-p' } }));
vi.mock('./stats.js', () => ({ containerOomKilled: () => oomKilled() }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: vi.fn() } }));
vi.mock('../projects/repository.js', () => ({ projectRepository: { list: async () => [] } }));

const { containerMonitor } = await import('./monitor.js');
const project = { id: 'p1', slug: 'p', name: 'Projet' } as never;
const sample = (memoryPercent: number | null, oomKills = 0): ContainerStats => ({
  sampledAt: new Date(),
  memoryUsedMb: Math.round((memoryPercent ?? 0) * 20.48),
  memoryLimitMb: 2048,
  memoryPercent,
  swapUsedMb: 0,
  cpuPercent: 10,
  cpuLimit: 1,
  oomKills,
  claudeProcesses: [],
});

beforeEach(() => {
  containerMonitor.reset();
  stats.mockReset();
  oomKilled.mockReset().mockResolvedValue(false);
});

describe('avertissement mémoire', () => {
  it("n'avertit qu'après une minute au-dessus de 90 %, une seule fois, réarmé sous 80 %", () => {
    const { recordSample } = containerMonitor;
    expect(recordSample('p1', sample(95), 0)).toBe(false);
    expect(containerMonitor.memoryHighSince('p1')).toEqual(new Date(0));
    expect(recordSample('p1', sample(96), 30_000)).toBe(false);
    expect(recordSample('p1', sample(97), 60_000)).toBe(true);
    expect(recordSample('p1', sample(97), 90_000)).toBe(false);
    // Passage à 85 % : le compteur de durée repart, mais l'alerte n'est pas réarmée.
    expect(recordSample('p1', sample(85), 120_000)).toBe(false);
    expect(recordSample('p1', sample(95), 150_000)).toBe(false);
    expect(recordSample('p1', sample(95), 240_000)).toBe(false);
    expect(recordSample('p1', sample(50), 270_000)).toBe(false);
    expect(containerMonitor.memoryHighSince('p1')).toBeNull();
    expect(recordSample('p1', sample(95), 300_000)).toBe(false);
    expect(recordSample('p1', sample(95), 360_000)).toBe(true);
  });
});

describe('fin de session en erreur', () => {
  it('explique un processus tué par le noyau (oom_kill en hausse, code 137)', async () => {
    containerMonitor.recordSample('p1', sample(60, 2));
    stats.mockResolvedValue(sample(70, 3));
    const message = await containerMonitor.explainFailure(project, { exitCode: 1, error: 'Claude Code process exited with code 137' });
    expect(message).toMatch(/dépassé sa limite mémoire : le noyau a tué le processus de l'agent/);
  });

  it('signale un code 137 sans trace de manque de mémoire comme probable', async () => {
    containerMonitor.recordSample('p1', sample(60, 2));
    stats.mockResolvedValue(sample(60, 2));
    expect(await containerMonitor.explainFailure(project, { exitCode: 137 })).toMatch(/probablement faute de mémoire/);
  });

  it('détecte un conteneur arrêté par le noyau (State.OOMKilled)', async () => {
    stats.mockResolvedValue(null);
    oomKilled.mockResolvedValue(true);
    expect(await containerMonitor.explainFailure(project, { exitCode: 1, error: 'x' })).toMatch(/a été arrêté par le noyau/);
  });

  it("ne dit rien d'une erreur sans rapport avec la mémoire", async () => {
    containerMonitor.recordSample('p1', sample(40, 2));
    stats.mockResolvedValue(sample(40, 2));
    expect(await containerMonitor.explainFailure(project, { exitCode: 1, error: 'error_max_turns' })).toBeNull();
  });
});
