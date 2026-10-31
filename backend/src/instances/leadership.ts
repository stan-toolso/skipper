import pg from 'pg';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Tâches périodiques uniques : planificateur des sessions et des workflows, synchronisation des pull requests,
 * sauvegardes git, surveillance mémoire, reprise des sessions orphelines... Une seule instance du backend les fait
 * tourner : celle qui tient le verrou consultatif PostgreSQL (`pg_try_advisory_lock`, lié à une connexion dédiée).
 * Les autres retentent toutes les cinq secondes ; une instance en drainage le relâche (`release`), la nouvelle le
 * prend au passage suivant. Si la connexion tombe, le verrou est perdu : les tâches s'arrêtent et la tentative reprend.
 */

/** Clé du verrou (deux entiers : espace « skipper », objet « tâches périodiques »). */
const LOCK = [0x5c1, 1] as const;
const RETRY_MS = 5_000;

export interface LeaderJob {
  name: string;
  start: () => void | Promise<void>;
  stop: () => void;
}

let client: pg.Client | null = null;
let leader = false;
let released = false;
let timer: NodeJS.Timeout | null = null;
let jobs: LeaderJob[] = [];

function stopJobs(): void {
  for (const job of [...jobs].reverse()) {
    try {
      job.stop();
    } catch (err) {
      log.error(`[instances] arrêt de ${job.name}`, err);
    }
  }
}

async function startJobs(): Promise<void> {
  for (const job of jobs) {
    try {
      await job.start();
    } catch (err) {
      log.error(`[instances] démarrage de ${job.name}`, err);
    }
  }
}

function lost(c: pg.Client, reason: string): void {
  if (client !== c) return;
  client = null;
  c.removeAllListeners();
  c.on('error', () => undefined);
  void c.end().catch(() => undefined);
  if (leader) {
    leader = false;
    log.warn(`[instances] verrou des tâches périodiques perdu (${reason}) : tâches arrêtées`);
    stopJobs();
  }
}

async function attempt(): Promise<void> {
  if (released || leader) return;
  let c = client;
  if (!c) {
    c = new pg.Client({ connectionString: config.databaseUrl });
    const self = c;
    c.on('error', (err) => lost(self, err.message));
    c.on('end', () => lost(self, 'connexion fermée'));
    client = c;
    try {
      await c.connect();
    } catch (err) {
      lost(c, (err as Error).message);
      return;
    }
  }
  const { rows } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [...LOCK]);
  if (!rows[0]?.ok || released) return;
  leader = true;
  log.info('[instances] verrou des tâches périodiques pris : planificateurs et tâches de fond démarrés ici');
  await startJobs();
}

export const leadership = {
  get isLeader(): boolean {
    return leader;
  },

  /** Tente de prendre le verrou maintenant, puis toutes les cinq secondes tant qu'une autre instance le tient. */
  async start(leaderJobs: LeaderJob[]): Promise<void> {
    jobs = leaderJobs;
    released = false;
    await attempt().catch((err) => log.warn(`[instances] verrou des tâches périodiques : ${(err as Error).message}`));
    timer = setInterval(() => void attempt().catch((err) => log.warn(`[instances] verrou des tâches périodiques : ${(err as Error).message}`)), RETRY_MS);
    timer.unref();
  },

  /** Drainage ou arrêt : tâches arrêtées, verrou relâché pour l'instance qui prend la suite. */
  async release(): Promise<void> {
    released = true;
    if (timer) clearInterval(timer);
    timer = null;
    const c = client;
    client = null;
    if (leader) {
      leader = false;
      stopJobs();
      log.info('[instances] verrou des tâches périodiques relâché');
    }
    if (c) {
      c.removeAllListeners();
      c.on('error', () => undefined);
      await c.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  },
};
