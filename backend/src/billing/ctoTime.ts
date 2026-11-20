import { pool } from '../db/pool.js';
import { log } from '../log.js';

/**
 * Suivi automatique du temps CTO, pour la facturation de la cellule.
 *
 * Une personne au profil CTO (`users.is_cto`) qui intervient sur une session (instruction, lancement, arrêt, réponse
 * à une demande…) ou sur une conversation (message d'un canal ou du fil d'une tâche, réaction) inscrit la tranche de
 * 10 minutes en cours (`cto_activity_slots`), si elle ne l'est pas déjà : une tranche ne compte qu'une fois par
 * personne, quel que soit le nombre d'interventions. Chaque fin de journée, `consolidate` range les tranches des jours
 * passés en saisies `cto_time_entries` de source « auto » (une par personne, jour et projet), facturées comme les
 * saisies manuelles ; le relevé du mois compte en plus, comme provisoires, les tranches pas encore consolidées.
 *
 * Les jours sont ceux du fuseau du processus Node, comme le relevé (`billing/service.ts`).
 */

export const SLOT_MINUTES = 10;
const SLOT_MS = SLOT_MINUTES * 60_000;
/** Heures que vaut une tranche. */
export const SLOT_HOURS = SLOT_MINUTES / 60;

/** Début de la tranche de 10 minutes qui contient `at`. */
export const slotStart = (at: Date): Date => new Date(Math.floor(at.getTime() / SLOT_MS) * SLOT_MS);

export type CtoTargetType = 'session' | 'request' | 'task' | 'conversation' | 'message' | 'project';

/** Projet d'une cible (null : espace personnel, ou cible introuvable). */
const PROJECT_OF: Record<CtoTargetType, string> = {
  project: 'SELECT id AS project_id, personal_owner_id FROM projects WHERE id = $1',
  session: 'SELECT p.id AS project_id, p.personal_owner_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = $1',
  request: 'SELECT p.id AS project_id, p.personal_owner_id FROM requests r JOIN sessions s ON s.id = r.session_id JOIN projects p ON p.id = s.project_id WHERE r.id = $1',
  task: 'SELECT p.id AS project_id, p.personal_owner_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1',
  conversation: 'SELECT p.id AS project_id, p.personal_owner_id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1',
  message: 'SELECT p.id AS project_id, p.personal_owner_id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN projects p ON p.id = c.project_id WHERE m.id = $1',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tranches déjà inscrites par ce processus (`<personne>:<tranche>`) : la plupart des interventions d'une tranche ne
 * touchent pas la base. Vidée à chaque nouvelle tranche ; la clé primaire garde l'unicité entre instances.
 */
const seen = new Set<string>();
let seenSlot = 0;

export interface CtoIntervention {
  /** Mutation ou geste qui compte (`sendSessionMessage`, `postMessage`…). */
  action: string;
  targetType: CtoTargetType;
  targetId: string | null | undefined;
}

/** Utilisateur tel que le connaît le contexte GraphQL (seuls ces champs servent). */
interface Person {
  id: string;
  kind?: string;
  isCto?: boolean;
}

export const ctoTimeService = {
  /**
   * Inscrit la tranche en cours pour `user` s'il est CTO et qu'elle ne l'est pas encore. Ne lève jamais : un échec
   * du suivi ne doit pas faire échouer l'intervention elle-même.
   */
  async record(user: Person | null | undefined, intervention: CtoIntervention, now = new Date()): Promise<boolean> {
    if (!user?.isCto || user.kind === 'agent') return false;
    const start = slotStart(now);
    if (start.getTime() !== seenSlot) {
      seen.clear();
      seenSlot = start.getTime();
    }
    const key = `${user.id}:${start.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      const targetId = intervention.targetId && UUID.test(intervention.targetId) ? intervention.targetId : null;
      let projectId: string | null = null;
      if (targetId) {
        const { rows } = await pool.query<{ project_id: string; personal_owner_id: string | null }>(PROJECT_OF[intervention.targetType], [targetId]);
        // L'espace personnel n'est pas un projet facturé : la tranche compte, sans projet.
        projectId = rows[0] && !rows[0].personal_owner_id ? rows[0].project_id : null;
      }
      const { rowCount } = await pool.query(
        `INSERT INTO cto_activity_slots (user_id, slot_start, project_id, target_type, target_id, action)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, slot_start) DO NOTHING`,
        [user.id, start, projectId, intervention.targetType, targetId, intervention.action],
      );
      return (rowCount ?? 0) > 0;
    } catch (err) {
      seen.delete(key);
      log.warn(`[billing] temps CTO non inscrit (${intervention.action}) : ${(err as Error).message}`);
      return false;
    }
  },

  /**
   * Consolidation de fin de journée : les tranches des jours antérieurs à `now` (fuseau du serveur) deviennent des
   * saisies `cto_time_entries` « auto », une par personne, jour et projet. Idempotente : chaque tranche n'est
   * consolidée qu'une fois (`consolidated_at`), dans la même transaction que ses saisies. Renvoie le nombre de saisies.
   */
  async consolidate(now = new Date()): Promise<number> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ day: string; user_id: string; project_id: string | null; slots: number }>(
        `WITH done AS (
           UPDATE cto_activity_slots SET consolidated_at = now()
            WHERE consolidated_at IS NULL AND slot_start < $1
            RETURNING user_id, slot_start, project_id
         )
         SELECT to_char(slot_start AT TIME ZONE $2, 'YYYY-MM-DD') AS day, user_id, project_id, count(*)::int AS slots
           FROM done GROUP BY 1, 2, 3 ORDER BY 1, 2`,
        [todayStart, timeZone],
      );
      for (const r of rows) {
        await client.query(
          `INSERT INTO cto_time_entries (day, hours, project_id, description, created_by, user_id, source, slots)
           VALUES ($1, $2, $3, $4, $5, $5, 'auto', $6)`,
          [r.day, Math.min(24, Math.round(r.slots * SLOT_HOURS * 100) / 100), r.project_id, describeSlots(r.slots), r.user_id, r.slots],
        );
      }
      await client.query('COMMIT');
      if (rows.length) log.info(`[billing] temps CTO consolidé : ${rows.length} saisie(s)`);
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },

  timer: null as NodeJS.Timeout | null,

  /** Tâche de l'instance meneuse : consolide au démarrage puis toutes les heures (la première heure de chaque jour range la veille). */
  start(): void {
    const run = () => void this.consolidate().catch((err) => log.warn(`[billing] consolidation du temps CTO : ${(err as Error).message}`));
    run();
    this.timer = setInterval(run, 60 * 60_000);
    this.timer.unref();
  },

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },
};

/** Description d'une saisie consolidée. */
export const describeSlots = (slots: number): string => `Suivi automatique : ${slots} tranche${slots > 1 ? 's' : ''} de ${SLOT_MINUTES} min (sessions et conversations)`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Resolver = (parent: any, args: any, ctx: any, info?: any) => unknown;
type Args = Record<string, any>;

/** Mutations GraphQL qui comptent comme une intervention du CTO : cible et argument qui porte son identifiant. */
export const CTO_TRACKED: Record<string, { target: CtoTargetType; id: (args: Args) => string | null | undefined }> = {
  // Sessions : lancer, piloter, répondre.
  createSession: { target: 'project', id: (a) => a.input?.projectId },
  createChat: { target: 'session', id: () => null },
  sendSessionMessage: { target: 'session', id: (a) => a.id },
  startSession: { target: 'session', id: (a) => a.id },
  stopSession: { target: 'session', id: (a) => a.id },
  endSession: { target: 'session', id: (a) => a.id },
  interruptSession: { target: 'session', id: (a) => a.id },
  resumeSession: { target: 'session', id: (a) => a.id },
  restartSession: { target: 'session', id: (a) => a.id },
  relaunchSession: { target: 'session', id: (a) => a.id },
  takeOverSession: { target: 'session', id: (a) => a.id },
  handBackSession: { target: 'session', id: (a) => a.id },
  updateSessionConfig: { target: 'session', id: (a) => a.id },
  answerRequest: { target: 'request', id: (a) => a.id },
  provideSecrets: { target: 'request', id: (a) => a.requestId },
  startTaskSession: { target: 'task', id: (a) => a.id },
  resumeTaskSession: { target: 'task', id: (a) => a.id },
  // Conversations : canaux et fils des tâches.
  postMessage: { target: 'conversation', id: (a) => a.conversationId },
  updateMessage: { target: 'message', id: (a) => a.id },
  toggleMessageReaction: { target: 'message', id: (a) => a.messageId },
  addTaskComment: { target: 'task', id: (a) => a.taskId },
  updateTaskComment: { target: 'message', id: (a) => a.id },
  toggleTaskReaction: { target: 'task', id: (a) => a.taskId },
};

/**
 * Enveloppe les résolveurs de mutation de `CTO_TRACKED` : une mutation réussie d'un CTO inscrit la tranche en cours.
 * L'inscription ne retarde pas la réponse (elle part sans être attendue) et ne la fait jamais échouer.
 */
export function withCtoTime<T extends Record<string, Resolver>>(mutations: T): T {
  const wrapped: Record<string, Resolver> = { ...mutations };
  for (const [name, spec] of Object.entries(CTO_TRACKED)) {
    const resolve = mutations[name];
    if (!resolve) continue;
    wrapped[name] = async (parent, args, ctx, info) => {
      const result = await resolve(parent, args, ctx, info);
      const user = ctx?.user as Person | null | undefined;
      if (user?.isCto) void ctoTimeService.record(user, { action: name, targetType: spec.target, targetId: spec.id(args ?? {}) });
      return result;
    };
  }
  return wrapped as T;
}
