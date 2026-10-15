import { notificationService } from '../notifications/service.js';
import { projectRepository } from '../projects/repository.js';
import type { Project } from '../projects/types.js';
import { runner } from './index.js';
import { containerOomKilled, type ContainerStats } from './stats.js';

/**
 * Surveillance des conteneurs des projets : avertissement quand la mémoire dépasse 90 % de la limite
 * pendant plus d'une minute, et suivi du compteur de processus tués faute de mémoire (memory.events),
 * qui permet d'expliquer la fin d'une session tuée par le noyau.
 */
const INTERVAL_MS = 30_000;
export const MEMORY_HIGH_PERCENT = 90;
/** Durée au-dessus du seuil avant l'avertissement. */
const MEMORY_HIGH_DURATION_MS = 60_000;
/** L'avertissement est réarmé quand la mémoire redescend sous ce seuil. */
const MEMORY_REARM_PERCENT = 80;
/** Un processus tué faute de mémoire dans ce délai avant la fin d'une session en est probablement la cause. */
const OOM_RECENT_MS = 3 * 60_000;

interface ContainerState {
  highSince: number | null;
  alerted: boolean;
  oomKills: number | null;
  lastOomAt: number | null;
}

const states = new Map<string, ContainerState>();
let timer: NodeJS.Timeout | null = null;

function stateOf(projectId: string): ContainerState {
  let s = states.get(projectId);
  if (!s) states.set(projectId, (s = { highSince: null, alerted: false, oomKills: null, lastOomAt: null }));
  return s;
}

const formatMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',')} Go` : `${mb} Mo`);

/** Met à jour l'état d'un conteneur avec une nouvelle mesure ; renvoie true si l'avertissement doit partir. */
export function recordSample(projectId: string, stats: ContainerStats, now = Date.now()): boolean {
  const s = stateOf(projectId);
  if (s.oomKills !== null && stats.oomKills > s.oomKills) s.lastOomAt = now;
  // Compteur revenu en arrière : conteneur recréé.
  s.oomKills = stats.oomKills;
  const percent = stats.memoryPercent;
  if (percent === null || percent < MEMORY_HIGH_PERCENT) {
    s.highSince = null;
    if (percent === null || percent < MEMORY_REARM_PERCENT) s.alerted = false;
    return false;
  }
  s.highSince ??= now;
  if (s.alerted || now - s.highSince < MEMORY_HIGH_DURATION_MS) return false;
  s.alerted = true;
  return true;
}

async function sampleProject(project: Project): Promise<void> {
  const stats = await runner.stats(project);
  if (!stats) return;
  if (!recordSample(project.id, stats)) return;
  const sessions = stats.claudeProcesses.filter((p) => p.sessionId).length;
  void notificationService.notify({
    type: 'container.memory_high',
    title: `Conteneur de « ${project.name} » à ${Math.round(stats.memoryPercent ?? 0)} % de sa limite mémoire`,
    message: `${formatMb(stats.memoryUsedMb)} / ${formatMb(stats.memoryLimitMb ?? 0)} depuis plus d'une minute · ${stats.claudeProcesses.length} processus Claude (${sessions} de sessions). Au-delà de la limite, le noyau tue des processus : terminez les sessions inutiles ou relevez la limite.`,
    link: `/projects/${project.id}`,
    projectId: project.id,
    payload: { memoryUsedMb: stats.memoryUsedMb, memoryLimitMb: stats.memoryLimitMb, claudeProcesses: stats.claudeProcesses.length },
  });
  console.warn(`[conteneurs] ${project.slug} : ${stats.memoryUsedMb} / ${stats.memoryLimitMb} Mo`);
}

export const containerMonitor = {
  /** Mesure tous les conteneurs en marche (ceux qui ne répondent pas sont ignorés). */
  async check(): Promise<void> {
    const projects = await projectRepository.list();
    for (const project of projects) await sampleProject(project).catch((err) => console.error(`[conteneurs] mesure de ${project.slug}`, err));
  },

  /** Depuis quand la mémoire du conteneur dépasse le seuil d'avertissement (null : sous le seuil, ou pas encore mesuré). */
  memoryHighSince(projectId: string): Date | null {
    const since = states.get(projectId)?.highSince;
    return since != null ? new Date(since) : null;
  },

  recordSample,

  /**
   * Explique la fin en erreur d'une session quand le conteneur a manqué de mémoire : processus principal
   * du conteneur tué (State.OOMKilled), processus tué par le noyau depuis la dernière mesure, ou code 137
   * (SIGKILL) de `docker exec`. Renvoie null si rien ne l'indique.
   */
  async explainFailure(project: Project, result: { exitCode: number | null; error?: string | null }): Promise<string | null> {
    const killed = result.exitCode === 137 || /\b(code|status) 137\b|SIGKILL/i.test(result.error ?? '');
    const s = stateOf(project.id);
    const before = s.oomKills;
    const stats = await runner.stats(project, { fresh: true }).catch(() => null);
    const now = Date.now();
    const oomNow = stats !== null && before !== null && stats.oomKills > before;
    if (stats) recordSample(project.id, stats, now);
    const recent = oomNow || (s.lastOomAt !== null && now - s.lastOomAt < OOM_RECENT_MS);
    const containerKilled = !stats && (await containerOomKilled(runner.containerName(project)));
    const limit = stats?.memoryLimitMb ?? null;
    const usage = stats && limit ? ` (${formatMb(stats.memoryUsedMb)} utilisés sur ${formatMb(limit)} maintenant)` : '';
    const advice = 'Terminez les sessions inutiles du projet ou relevez la limite mémoire (carte « Environnement d’exécution » de la page du projet).';
    if (containerKilled) return `Le conteneur du projet a dépassé sa limite mémoire et a été arrêté par le noyau. ${advice}`;
    if (recent && killed) return `Le conteneur du projet a dépassé sa limite mémoire : le noyau a tué le processus de l'agent${usage}. ${advice}`;
    if (recent) return `Le conteneur du projet a dépassé sa limite mémoire peu avant la fin de la session : un processus a été tué par le noyau${usage}, probablement celui de l'agent ou d'une commande qu'il exécutait. ${advice}`;
    if (killed) return `Le processus de l'agent a été tué (SIGKILL, code 137), probablement faute de mémoire dans le conteneur${usage}. ${advice}`;
    return null;
  },

  start(): void {
    if (timer) return;
    timer = setInterval(() => void this.check().catch((err) => console.error('[conteneurs] surveillance', err)), INTERVAL_MS);
    timer.unref();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  /** Pour les tests. */
  reset(): void {
    states.clear();
  },
};
