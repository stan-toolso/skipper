import { pool } from '../db/pool.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import type { Project } from '../projects/types.js';
import { runner } from './index.js';
import { SESSION_ENV } from './stats.js';

/**
 * Arrêt des processus laissés par les sessions terminées.
 *
 * Un agent lance parfois un serveur en arrière-plan (`nohup node index.js &`, `python3 -m http.server`, une base de
 * test) : rattaché à `docker-init` à la fin de sa commande, il survit à la session (19 jours pour l'un d'eux le 25/11).
 * Chaque processus lancé par le CLI d'une session hérite de `SKIPPER_SESSION_ID` ; les aperçus et Chromium lancés
 * par le backend ne l'ont pas. Toutes les deux minutes, l'instance meneuse arrête (TERM, puis KILL après 5 s) les
 * processus d'une session terminée depuis plus de GRACE_MS, ou supprimée. Une session en cours, en file, garée ou
 * interrompue (redémarrage du serveur, reprise automatique) garde les siens.
 *
 * Sortie de secours : un processus lancé avec `SKIPPER_KEEP_ALIVE=1` dans son environnement (service partagé entre
 * les sessions du projet, comme une base de test réutilisée par toutes les CI) est épargné, ainsi que ses enfants.
 */

export const KEEP_ALIVE_ENV = 'SKIPPER_KEEP_ALIVE';
const INTERVAL_MS = 2 * 60_000;
/** Délai après la fin d'une session : une relance (« Redémarrer », message pendant la fin) repart avant. */
export const GRACE_MS = 2 * 60_000;
/** Statuts d'une session finie : ses processus n'ont plus de raison de tourner. */
const ENDED = new Set(['completed', 'stopped', 'failed']);

export interface SessionProcess {
  pid: number;
  sessionId: string;
  keepAlive: boolean;
  command: string;
}

export interface SessionState {
  status: string;
  endedAt: Date | null;
}

/** Liste, dans le conteneur, des processus qui portent la variable de session : `<pid> <session> <0|1> <commande>`. */
export const LIST_SCRIPT = `for d in /proc/[0-9]*; do
  e=$(tr '\\0' '\\n' 2>/dev/null < $d/environ) || continue
  s=$(printf '%s\\n' "$e" | sed -n 's/^${SESSION_ENV}=//p')
  [ -n "$s" ] || continue
  k=$(printf '%s\\n' "$e" | grep -c '^${KEEP_ALIVE_ENV}=1$')
  echo "\${d#/proc/} $s $k $(tr '\\0' ' ' 2>/dev/null < $d/cmdline | cut -c1-200)"
done`;

/** TERM, puis KILL des survivants après 5 s (les pid en arguments). */
export const KILL_SCRIPT = `kill -TERM "$@" 2>/dev/null
i=0
while [ $i -lt 50 ]; do
  alive=
  for p in "$@"; do [ -n "$(ps -o stat= -p "$p" 2>/dev/null | grep -v '^Z')" ] && alive=1; done
  [ -z "$alive" ] && exit 0
  sleep 0.1; i=$((i + 1))
done
kill -KILL "$@" 2>/dev/null
exit 0`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSessionProcesses(output: string): SessionProcess[] {
  const out: SessionProcess[] = [];
  for (const line of output.split('\n')) {
    const m = /^(\d+) (\S+) (\d+) ?(.*)$/.exec(line.trim());
    if (!m || !UUID.test(m[2])) continue;
    const pid = Number(m[1]);
    if (pid <= 1) continue;
    out.push({ pid, sessionId: m[2], keepAlive: m[3] !== '0', command: m[4].trim() });
  }
  return out;
}

/** Processus à arrêter : session supprimée, ou finie depuis plus de GRACE_MS ; jamais ceux marqués à garder. */
export function processesToStop(processes: SessionProcess[], sessions: Map<string, SessionState>, now = Date.now()): SessionProcess[] {
  return processes.filter((p) => {
    if (p.keepAlive) return false;
    const s = sessions.get(p.sessionId);
    if (!s) return true;
    if (!ENDED.has(s.status)) return false;
    return s.endedAt !== null && now - s.endedAt.getTime() > GRACE_MS;
  });
}

async function sessionStates(ids: string[]): Promise<Map<string, SessionState>> {
  const { rows } = await pool.query<{ id: string; status: string; ended_at: Date | null }>('SELECT id, status::text AS status, ended_at FROM sessions WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map((r) => [r.id, { status: r.status, endedAt: r.ended_at }]));
}

async function sweepProject(project: Project): Promise<number> {
  // Sans démarrer le conteneur : arrêté, il n'a aucun processus.
  const { stdout, code } = await runner.exec(project, ['sh', '-c', LIST_SCRIPT], { timeoutSeconds: 30 });
  if (code !== 0 && !stdout) return 0;
  const processes = parseSessionProcesses(stdout);
  if (!processes.length) return 0;
  const sessions = await sessionStates([...new Set(processes.map((p) => p.sessionId))]);
  const stale = processesToStop(processes, sessions);
  if (!stale.length) return 0;
  for (const p of stale) {
    const s = sessions.get(p.sessionId);
    log.info(`[processus] ${project.slug} : arrêt de ${p.pid} (session ${p.sessionId.slice(0, 8)} ${s ? s.status : 'supprimée'}) : ${p.command.slice(0, 120)}`);
  }
  await runner.exec(project, ['sh', '-c', KILL_SCRIPT, 'sh', ...stale.map((p) => String(p.pid))], { timeoutSeconds: 30 });
  return stale.length;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export const sessionProcessSweep = {
  async sweep(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      let total = 0;
      for (const project of await projectRepository.list()) {
        total += await sweepProject(project).catch((err) => {
          log.warn(`[processus] ${project.slug} : ${(err as Error).message}`);
          return 0;
        });
      }
      return total;
    } finally {
      running = false;
    }
  },

  start(): void {
    if (timer) return;
    timer = setInterval(() => void this.sweep().catch((err) => log.error('[processus] arrêt des processus des sessions terminées', err)), INTERVAL_MS);
    timer.unref();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
