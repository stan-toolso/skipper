import { execFile } from 'node:child_process';
import { readFile, readdir, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { notificationService } from '../notifications/service.js';
import { projectRepository } from '../projects/repository.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import { serverSettings } from '../settings/server.js';
import { terminalService } from '../terminals/service.js';

const execFileAsync = promisify(execFile);
const MB = 1024 * 1024;

export interface MemoryHealth {
  totalMb: number;
  /** Mémoire disponible pour de nouveaux processus (MemAvailable : libre + caches récupérables). */
  availableMb: number;
  swapTotalMb: number;
  swapFreeMb: number;
}

export interface ClaudeProcess {
  pid: number;
  rssMb: number;
  /** Durée de vie du processus, en secondes. */
  elapsedSeconds: number;
}

export interface ContainerHealth {
  name: string;
  projectId: string | null;
  projectName: string | null;
  /** running, exited, created... */
  state: string;
  /** Texte de `docker ps` (« Up 2 hours »). */
  status: string;
  memoryUsage: string | null;
  memoryPercent: number | null;
  cpuPercent: number | null;
}

export interface WorkspaceUsage {
  name: string;
  projectId: string | null;
  sizeMb: number;
}

export interface ServerHealth {
  checkedAt: Date;
  hostname: string;
  uptimeSeconds: number;
  cpuCount: number;
  /** Charge moyenne sur 1, 5 et 15 minutes. */
  loadAverage: number[];
  memory: MemoryHealth;
  sessions: {
    running: number;
    busy: number;
    idle: number;
    queued: number;
    maxConcurrent: number;
  };
  terminals: number;
  claudeProcesses: ClaudeProcess[];
  docker: { available: boolean; version: string | null; error: string | null; containers: ContainerHealth[] };
  disk: {
    path: string;
    totalMb: number | null;
    freeMb: number | null;
    /** Taille des dossiers de WORKSPACES_ROOT (mesure en cache, refaite au plus toutes les 10 minutes). */
    workspaces: WorkspaceUsage[];
    workspacesMeasuredAt: Date | null;
  };
}

/** Mémoire d'après /proc/meminfo (Linux), à défaut d'après Node (sans swap ni caches récupérables). */
export async function readMemory(): Promise<MemoryHealth> {
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (Number.isFinite(total) && Number.isFinite(available)) {
      return {
        totalMb: Math.round(total / 1024),
        availableMb: Math.round(available / 1024),
        swapTotalMb: Math.round((kb('SwapTotal') || 0) / 1024),
        swapFreeMb: Math.round((kb('SwapFree') || 0) / 1024),
      };
    }
  } catch {
    // Pas de /proc (macOS en développement) : repli ci-dessous.
  }
  return { totalMb: Math.round(os.totalmem() / MB), availableMb: Math.round(os.freemem() / MB), swapTotalMb: 0, swapFreeMb: 0 };
}

/**
 * Processus du CLI Claude Code (ceux des conteneurs sont visibles depuis l'hôte). Les relais
 * `docker exec … claude` et le CLI de connexion du compte sont exclus : seul le processus de l'agent compte.
 */
export function parseClaudeProcesses(psOutput: string): ClaudeProcess[] {
  const result: ClaudeProcess[] = [];
  for (const raw of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const args = m[4];
    const [argv0 = '', argv1 = ''] = args.split(/\s+/);
    if (/(^|\/)(docker|sudo|bash|sh|dash)$/.test(argv0) || args.includes('/.runners/')) continue;
    // Binaire `claude` (natif, ou script lancé par node), ou CLI JavaScript du SDK.
    const isClaude = [argv0, argv1].some((t) => /(^|\/)claude(\.exe)?$/.test(t) || /claude-(code|agent-sdk)\/(cli\.js|bin\/claude)/.test(t));
    if (!isClaude || /\sauth\s/.test(` ${args} `)) continue;
    result.push({ pid: Number(m[1]), rssMb: Math.round(Number(m[2]) / 1024), elapsedSeconds: Number(m[3]) });
  }
  return result;
}

async function readClaudeProcesses(): Promise<ClaudeProcess[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,rss=,etimes=,args='], { maxBuffer: 4 * MB, timeout: 5000 });
    return parseClaudeProcesses(stdout);
  } catch {
    return [];
  }
}

/** Pourcentage de `docker stats` (« 12.34% »), null si illisible. */
const percent = (value: string | undefined) => {
  const n = Number.parseFloat((value ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
};

async function readDocker(projects: Map<string, { id: string; name: string }>): Promise<ServerHealth['docker']> {
  const run = (args: string[]) => execFileAsync('docker', args, { maxBuffer: 4 * MB, timeout: 10_000 }).then((r) => r.stdout);
  let version: string | null;
  try {
    version = (await run(['version', '--format', '{{.Server.Version}}'])).trim() || null;
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    const error = e.code === 'ENOENT' ? "Docker n'est pas installé (commande docker introuvable)" : (e.stderr || e.message).trim().split('\n').slice(-1)[0];
    return { available: false, version: null, error, containers: [] };
  }
  const containers: ContainerHealth[] = [];
  try {
    const ps = await run(['ps', '-a', '--filter', 'name=^skipper-', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}']);
    for (const lineText of ps.split('\n').filter(Boolean)) {
      const [name, state, status] = lineText.split('\t');
      const project = projects.get(name.replace(/^skipper-/, ''));
      containers.push({ name, projectId: project?.id ?? null, projectName: project?.name ?? null, state, status, memoryUsage: null, memoryPercent: null, cpuPercent: null });
    }
    if (containers.some((c) => c.state === 'running')) {
      const stats = await run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}']);
      for (const lineText of stats.split('\n').filter(Boolean)) {
        const [name, memoryUsage, memPerc, cpuPerc] = lineText.split('\t');
        const container = containers.find((c) => c.name === name);
        if (!container) continue;
        container.memoryUsage = memoryUsage?.trim() || null;
        container.memoryPercent = percent(memPerc);
        container.cpuPercent = percent(cpuPerc);
      }
    }
  } catch (err) {
    return { available: true, version, error: (err as Error).message.split('\n')[0], containers };
  }
  return { available: true, version, error: null, containers };
}

/** Taille des dossiers des workspaces : `du` est lent sur de gros dépôts, la mesure est faite en tâche de fond et mise en cache. */
const WORKSPACES_CACHE_MS = 10 * 60_000;
let workspaces: { measuredAt: Date; entries: { name: string; sizeMb: number }[] } | null = null;
let measuring: Promise<void> | null = null;

function measureWorkspaces(): Promise<void> {
  measuring ??= (async () => {
    try {
      const names = (await readdir(config.workspacesRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      const entries: { name: string; sizeMb: number }[] = [];
      for (const name of names) {
        try {
          const { stdout } = await execFileAsync('du', ['-sk', path.join(config.workspacesRoot, name)], { timeout: 60_000, maxBuffer: MB });
          entries.push({ name, sizeMb: Math.round(Number(stdout.split('\t')[0]) / 1024) });
        } catch (err) {
          // du sort en erreur sur un fichier illisible mais donne quand même le total.
          const out = (err as { stdout?: string }).stdout;
          const kb = Number(out?.split('\t')[0]);
          if (Number.isFinite(kb) && kb > 0) entries.push({ name, sizeMb: Math.round(kb / 1024) });
        }
      }
      workspaces = { measuredAt: new Date(), entries: entries.sort((a, b) => b.sizeMb - a.sizeMb) };
    } catch (err) {
      console.error('[health] mesure des workspaces', err);
    } finally {
      measuring = null;
    }
  })();
  return measuring;
}

async function readDisk(projects: Map<string, { id: string; name: string }>): Promise<ServerHealth['disk']> {
  let totalMb: number | null = null;
  let freeMb: number | null = null;
  try {
    const s = await statfs(config.workspacesRoot);
    totalMb = Math.round((s.blocks * s.bsize) / MB);
    freeMb = Math.round((s.bavail * s.bsize) / MB);
  } catch {
    // Dossier absent : seules les tailles manquent.
  }
  if (!workspaces || Date.now() - workspaces.measuredAt.getTime() > WORKSPACES_CACHE_MS) void measureWorkspaces();
  // Les dossiers « <slug>.worktrees » sont rattachés à leur projet.
  const entries = (workspaces?.entries ?? []).map((e) => ({ ...e, projectId: projects.get(e.name.replace(/\.worktrees$/, ''))?.id ?? null }));
  return { path: config.workspacesRoot, totalMb, freeMb, workspaces: entries, workspacesMeasuredAt: workspaces?.measuredAt ?? null };
}

/** Alerte mémoire : une notification quand la mémoire disponible passe sous le seuil, réarmée quand elle remonte nettement. */
const MONITOR_INTERVAL_MS = 60_000;
const ALERT_REARM_FACTOR = 1.5;
let alertArmed = true;
let monitor: NodeJS.Timeout | null = null;

export const healthService = {
  async snapshot(): Promise<ServerHealth> {
    const projectList = await projectRepository.list();
    const projects = new Map(projectList.map((p) => [p.slug, { id: p.id, name: p.name }]));
    const [memory, active, queued, claudeProcesses, docker, disk] = await Promise.all([
      readMemory(),
      sessionService.activeSummary(),
      sessionRepository.listQueued(),
      readClaudeProcesses(),
      readDocker(projects),
      readDisk(projects),
    ]);
    return {
      checkedAt: new Date(),
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
      memory,
      sessions: { running: active.active, busy: active.busy, idle: active.idle, queued: queued.length, maxConcurrent: serverSettings.current.maxConcurrentSessions },
      terminals: terminalService.liveCount(),
      claudeProcesses,
      docker,
      disk,
    };
  },

  /** Compare la mémoire disponible au seuil d'alerte et notifie les administrateurs au franchissement. */
  async checkMemory(): Promise<boolean> {
    const threshold = serverSettings.current.memoryAlertThresholdMb;
    if (!threshold) return false;
    const memory = await readMemory();
    if (memory.availableMb >= threshold) {
      if (memory.availableMb >= threshold * ALERT_REARM_FACTOR) alertArmed = true;
      return false;
    }
    if (!alertArmed) return false;
    alertArmed = false;
    const active = await sessionService.activeSummary();
    const swapUsed = memory.swapTotalMb - memory.swapFreeMb;
    void notificationService.notify({
      type: 'server.memory_low',
      title: `Mémoire du serveur faible : ${memory.availableMb} Mo disponibles`,
      message: `Seuil : ${threshold} Mo · ${active.active} session(s) en cours · swap utilisé : ${swapUsed} / ${memory.swapTotalMb} Mo`,
      link: '/settings?section=server',
      adminsOnly: true,
      payload: { ...memory, threshold, activeSessions: active.active },
    });
    console.warn(`[health] mémoire disponible ${memory.availableMb} Mo, sous le seuil de ${threshold} Mo`);
    return true;
  },

  /** Surveillance périodique de la mémoire (au démarrage du serveur). */
  startMonitor(): void {
    if (monitor) return;
    monitor = setInterval(() => void this.checkMemory().catch((err) => console.error('[health] surveillance mémoire', err)), MONITOR_INTERVAL_MS);
    monitor.unref();
  },

  stopMonitor(): void {
    if (monitor) clearInterval(monitor);
    monitor = null;
  },

  /** Pour les tests : réarme l'alerte. */
  resetAlert(): void {
    alertArmed = true;
  },
};
