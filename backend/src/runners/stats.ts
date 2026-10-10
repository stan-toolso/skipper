import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseClaudeProcesses } from '../health/processes.js';

const execFileAsync = promisify(execFile);
const MB = 1024 * 1024;

/** Variable d'environnement posée sur le CLI de chaque session : relie un processus du conteneur à sa session. */
export const SESSION_ENV = 'SKIPPER_SESSION_ID';

export interface ContainerProcess {
  pid: number;
  rssMb: number;
  elapsedSeconds: number;
  /** Session Skipper du processus (absente : CLI lancé à la main dans un terminal). */
  sessionId: string | null;
  /** Mémoire des autres processus de la session (commandes lancées par l'agent : tsc, npm, vite…). */
  childrenRssMb: number;
  cwd: string | null;
}

export interface ContainerStats {
  sampledAt: Date;
  memoryUsedMb: number;
  /** Limite cgroup ; null si illimitée. */
  memoryLimitMb: number | null;
  /** Pourcentage de la limite (null sans limite). */
  memoryPercent: number | null;
  swapUsedMb: number | null;
  /** Utilisation CPU en pourcentage d'un cœur (200 % = deux cœurs pleins). */
  cpuPercent: number | null;
  /** Limite CPU en nombre de cœurs ; null si illimitée. */
  cpuLimit: number | null;
  /** Processus tués par le noyau faute de mémoire depuis la création du conteneur (memory.events, oom_kill). */
  oomKills: number;
  claudeProcesses: ContainerProcess[];
}

/**
 * Exécuté dans le conteneur (cgroup v2, espace de noms cgroup privé : /sys/fs/cgroup est celui du conteneur).
 * Deux lectures de cpu.stat à 0,5 s d'écart pour le CPU, puis les processus et, pour ceux qui portent la
 * variable de session, la session et le dossier courant.
 */
const STATS_SCRIPT = `cg=/sys/fs/cgroup
u1=$(sed -n 's/^usage_usec //p' $cg/cpu.stat 2>/dev/null); t1=$(date +%s%N)
sleep 0.5
u2=$(sed -n 's/^usage_usec //p' $cg/cpu.stat 2>/dev/null); t2=$(date +%s%N)
echo "cpu $u1 $t1 $u2 $t2"
echo "memory.current $(cat $cg/memory.current 2>/dev/null)"
echo "memory.max $(cat $cg/memory.max 2>/dev/null)"
echo "inactive_file $(sed -n 's/^inactive_file //p' $cg/memory.stat 2>/dev/null)"
echo "memory.swap.current $(cat $cg/memory.swap.current 2>/dev/null)"
echo "cpu.max $(cat $cg/cpu.max 2>/dev/null)"
echo "oom_kill $(sed -n 's/^oom_kill //p' $cg/memory.events 2>/dev/null)"
for d in /proc/[0-9]*; do
  s=$(tr '\\0' '\\n' 2>/dev/null < $d/environ | sed -n 's/^${SESSION_ENV}=//p')
  [ -n "$s" ] && echo "session \${d#/proc/} $s $(readlink $d/cwd 2>/dev/null)"
done
echo "ps"
ps -eo pid=,rss=,etimes=,args=`;

const int = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

/** Analyse la sortie de STATS_SCRIPT. */
export function parseContainerStats(output: string, sampledAt = new Date()): ContainerStats {
  const [head, ps = ''] = output.split(/^ps$/m);
  const values = new Map<string, string[]>();
  const sessions = new Map<number, { sessionId: string; cwd: string | null }>();
  for (const line of head.split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (!key) continue;
    if (key === 'session') {
      const pid = Number(rest[0]);
      if (Number.isFinite(pid) && rest[1]) sessions.set(pid, { sessionId: rest[1], cwd: rest.slice(2).join(' ') || null });
    } else values.set(key, rest);
  }
  const get = (key: string) => values.get(key)?.[0];
  // Comme `docker stats` : le cache de fichiers inactif, récupérable par le noyau avant tout OOM, n'est pas compté.
  const current = int(get('memory.current')) ?? 0;
  const used = Math.max(0, current - (int(get('inactive_file')) ?? 0));
  const max = get('memory.max') === 'max' ? null : int(get('memory.max'));
  const swap = int(get('memory.swap.current'));
  const [u1, t1, u2, t2] = (values.get('cpu') ?? []).map(Number);
  const cpuPercent = [u1, t1, u2, t2].every(Number.isFinite) && t2 > t1 ? Math.round(((u2 - u1) * 1000 * 100) / (t2 - t1)) : null;
  const [quota, period] = values.get('cpu.max') ?? [];
  const cpuLimit = quota && quota !== 'max' && Number(period) > 0 ? Math.round((Number(quota) / Number(period)) * 100) / 100 : null;

  // Mémoire de tous les processus du conteneur, pour rattacher les commandes de l'agent à sa session.
  const rssByPid = new Map<number, number>();
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) rssByPid.set(Number(m[1]), Number(m[2]));
  }
  const claude = parseClaudeProcesses(ps);
  const claudePids = new Set(claude.map((p) => p.pid));
  const claudeProcesses = claude.map((p): ContainerProcess => {
    const link = sessions.get(p.pid);
    let childrenKb = 0;
    if (link) {
      for (const [pid, s] of sessions) if (s.sessionId === link.sessionId && !claudePids.has(pid)) childrenKb += rssByPid.get(pid) ?? 0;
    }
    return { ...p, sessionId: link?.sessionId ?? null, childrenRssMb: Math.round(childrenKb / 1024), cwd: link?.cwd ?? null };
  });

  return {
    sampledAt,
    memoryUsedMb: Math.round(used / MB),
    memoryLimitMb: max === null ? null : Math.round(max / MB),
    memoryPercent: max ? Math.round((used / max) * 1000) / 10 : null,
    swapUsedMb: swap === null ? null : Math.round(swap / MB),
    cpuPercent,
    cpuLimit,
    oomKills: int(get('oom_kill')) ?? 0,
    claudeProcesses: claudeProcesses.sort((a, b) => b.rssMb - a.rssMb),
  };
}

/** Mesures récentes par conteneur : la carte de la page projet (plusieurs onglets) et la surveillance se les partagent. */
const CACHE_MS = 4000;
const cache = new Map<string, { at: number; value: Promise<ContainerStats | null> }>();

/** Mesure un conteneur en marche ; null s'il ne répond pas (arrêté, Docker indisponible). */
export function readContainerStats(containerName: string): Promise<ContainerStats | null> {
  const hit = cache.get(containerName);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = execFileAsync('docker', ['exec', containerName, 'sh', '-c', STATS_SCRIPT], { maxBuffer: 4 * MB, timeout: 10_000 })
    .then((r) => parseContainerStats(r.stdout))
    .catch(() => null);
  cache.set(containerName, { at: Date.now(), value });
  return value;
}

/** Oublie la dernière mesure (pour relire juste après la fin d'une session). */
export function invalidateContainerStats(containerName: string): void {
  cache.delete(containerName);
}

/** `docker inspect` : le processus principal du conteneur a-t-il été tué faute de mémoire ? */
export async function containerOomKilled(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.State.OOMKilled}}', containerName], { timeout: 10_000 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Taille Docker (« 2g », « 768m », « 1.5g ») en octets ; null si illisible. Sert à recalculer le swap
 * autorisé quand la limite est modifiée à chaud.
 */
export function parseDockerSize(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmg])?b?\s*$/i.exec(value);
  if (!m) return null;
  const unit = { b: 1, k: 1024, m: MB, g: 1024 * MB }[(m[2] ?? 'b').toLowerCase() as 'b' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * unit);
}
