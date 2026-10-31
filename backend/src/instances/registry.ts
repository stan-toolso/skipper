import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { log } from '../log.js';

/**
 * Registre des instances du backend (table `backend_instances`). Pendant une mise à jour bleu/vert, deux instances
 * tournent sur la cellule : l'ancienne se vide (drainage) pendant que la nouvelle reçoit le trafic. Chaque instance
 * s'inscrit au démarrage, bat toutes les cinq secondes et se retire à l'arrêt. Une instance est vivante tant que son
 * battement a moins de trente secondes et que son processus existe (toutes les instances d'une cellule sont sur la
 * même machine) : ce que tenait une instance morte (sessions, terminaux, demandes) est repris par les autres.
 *
 * Les instances vivantes autres que celle-ci (« pairs ») sont gardées en mémoire, rafraîchies à chaque battement et
 * à chaque message du bus d'une instance inconnue : tant qu'il n'y en a aucune (cas normal, une seule instance), rien
 * n'est routé ni diffusé entre instances.
 */

export const HEARTBEAT_MS = 5_000;
/** Au-delà, une instance qui ne bat plus est morte. */
export const LIVE_WINDOW_S = 30;

export interface InstanceInfo {
  id: string;
  port: number;
  pid: number;
  label: string;
  token: string;
  draining: boolean;
}

interface Row {
  id: string;
  port: number;
  pid: number;
  label: string;
  token: string;
  draining_since: Date | null;
}

const toInfo = (r: Row): InstanceInfo => ({ id: r.id, port: r.port, pid: r.pid, label: r.label, token: r.token, draining: r.draining_since !== null });

const self = { id: randomUUID(), token: randomBytes(24).toString('hex') };
let peers = new Map<string, InstanceInfo>();
let registered = false;
let port = 0;
let draining = false;
let timer: NodeJS.Timeout | null = null;

/** Le processus existe-t-il encore ? (même machine ; EPERM : il existe, sous un autre utilisateur.) */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Instances vivantes d'après la base (battement récent, processus présent), celle-ci comprise. */
async function loadLive(): Promise<InstanceInfo[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id, port, pid, label, token, draining_since FROM backend_instances WHERE heartbeat_at > now() - $1::int * interval '1 second'`,
    [LIVE_WINDOW_S],
  );
  return rows.map(toInfo).filter((i) => i.id === self.id || processAlive(i.pid));
}

function setPeers(live: InstanceInfo[]): void {
  peers = new Map(live.filter((i) => i.id !== self.id).map((i) => [i.id, i]));
}

export const instanceRegistry = {
  /** Identifiant de cette instance (posé sur les sessions et terminaux qu'elle tient). */
  id: self.id,
  /** Jeton attendu des appels internes adressés à cette instance. */
  token: self.token,

  isSelf: (id: string | null | undefined) => id === self.id,
  get draining(): boolean {
    return draining;
  },
  /** D'autres instances vivantes sont connues : il faut router et diffuser entre instances. */
  hasPeers: () => peers.size > 0,
  peers: () => [...peers.values()],

  /** Inscription au démarrage (avant de reprendre quoi que ce soit), puis battement périodique. */
  async register(listenPort: number): Promise<void> {
    port = listenPort;
    await pool.query(`INSERT INTO backend_instances (id, port, pid, label, token) VALUES ($1, $2, $3, $4, $5)`, [self.id, port, process.pid, config.instanceLabel, self.token]);
    registered = true;
    setPeers(await loadLive());
    timer = setInterval(() => void this.heartbeat().catch((err) => log.error('[instances] battement', err)), HEARTBEAT_MS);
    timer.unref();
  },

  async heartbeat(): Promise<void> {
    if (!registered) return;
    // Ligne disparue (purgée par une autre instance après une longue pause du processus) : réinscription.
    const { rowCount } = await pool.query(`UPDATE backend_instances SET heartbeat_at = now() WHERE id = $1`, [self.id]);
    if (!rowCount) {
      await pool.query(`INSERT INTO backend_instances (id, port, pid, label, token, draining_since) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [
        self.id,
        port,
        process.pid,
        config.instanceLabel,
        self.token,
        draining ? new Date() : null,
      ]);
    }
    setPeers(await loadLive());
  },

  /** Relit les instances vivantes (message du bus d'une instance inconnue, ou avant une décision). */
  async refresh(): Promise<InstanceInfo[]> {
    const live = await loadLive();
    setPeers(live);
    return live;
  },

  /** Identifiants des instances vivantes, celle-ci comprise (reprise de ce que tenaient les autres). */
  async liveIds(): Promise<string[]> {
    const ids = (await this.refresh()).map((i) => i.id);
    return ids.includes(self.id) ? ids : [...ids, self.id];
  },

  /**
   * Autre instance vivante qui tient cette ressource (`instanceId` lu sur la session ou le terminal), null si c'est
   * celle-ci, si personne ne la tient ou si l'instance est morte. Sans pair connu, aucune requête.
   */
  async holder(instanceId: string | null | undefined): Promise<InstanceInfo | null> {
    if (!instanceId || instanceId === self.id || !peers.size) return null;
    const known = peers.get(instanceId);
    if (known) return known;
    return (await this.refresh()).find((i) => i.id === instanceId && i.id !== self.id) ?? null;
  },

  /** Instance vivante qui ne se vide pas (destinataire de ce qu'une instance en drainage ne fait plus elle-même). */
  async activePeer(): Promise<InstanceInfo | null> {
    return (await this.refresh()).find((i) => i.id !== self.id && !i.draining) ?? null;
  },

  /** Début du drainage : visible des autres instances (et du script de déploiement). */
  async setDraining(): Promise<void> {
    draining = true;
    if (registered) await pool.query(`UPDATE backend_instances SET draining_since = now() WHERE id = $1`, [self.id]);
  },

  /** Arrêt : la ligne est retirée, ce que l'instance tenait n'est plus à elle. */
  async unregister(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    if (!registered) return;
    registered = false;
    await pool.query(`DELETE FROM backend_instances WHERE id = $1`, [self.id]);
  },

  /**
   * Sessions et terminaux d'un projet tenus par une autre instance vivante (déploiement bleu/vert) : son conteneur est utilisé
   * même si rien n'y tourne pour celle-ci. Sans pair connu : 0, sans requête.
   */
  async remoteActivity(projectId: string): Promise<number> {
    if (!peers.size) return 0;
    const { rows } = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM sessions WHERE project_id = $1 AND status = 'running' AND instance_id = ANY($2::uuid[]))
            + (SELECT count(*) FROM terminals WHERE project_id = $1 AND status = 'running' AND instance_id = ANY($2::uuid[])) AS n`,
      [projectId, [...peers.keys()]],
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Lignes d'instances mortes depuis longtemps (arrêt brutal), gardées un jour pour le diagnostic. */
  async prune(): Promise<number> {
    const { rowCount } = await pool.query(`DELETE FROM backend_instances WHERE heartbeat_at < now() - interval '1 day'`);
    return rowCount ?? 0;
  },
};
