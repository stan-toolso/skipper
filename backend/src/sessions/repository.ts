import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Attachment, CreateSessionInput, QueuedStart, Session, SessionActivity, SessionCleanup, SessionEvent, SessionFilter, SessionStatus } from './types.js';

interface SessionRow {
  id: string;
  project_id: string;
  worktree_id: string | null;
  parent_session_id: string | null;
  name: string;
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  prompt: string | null;
  prompt_attachments: Attachment[] | null;
  config: Record<string, unknown>;
  external_id: string | null;
  exit_code: number | null;
  error: string | null;
  cleanup: SessionCleanup | null;
  context_tokens: number | null;
  cost_usd: string | number | null;
  base_commit: string | null;
  queued_at: Date | null;
  queued_start: QueuedStart | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    activity: row.activity,
    prompt: row.prompt,
    promptAttachments: row.prompt_attachments ?? [],
    config: row.config ?? {},
    externalId: row.external_id,
    exitCode: row.exit_code,
    error: row.error,
    cleanup: row.cleanup ?? {},
    contextTokens: row.context_tokens,
    costUsd: Number(row.cost_usd ?? 0),
    baseCommit: row.base_commit ?? null,
    queuedAt: row.queued_at ?? null,
    queuedStart: row.queued_start ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toEvent(row: EventRow): SessionEvent {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    type: row.type,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

export interface SessionPatch {
  status?: SessionStatus;
  name?: string;
  cleanup?: SessionCleanup;
  contextTokens?: number | null;
  baseCommit?: string | null;
  promptAttachments?: Attachment[];
  config?: Record<string, unknown>;
  activity?: SessionActivity | null;
  externalId?: string | null;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  queuedAt?: Date | null;
  queuedStart?: QueuedStart | null;
}

const patchColumns: Record<keyof SessionPatch, string> = {
  status: 'status',
  name: 'name',
  cleanup: 'cleanup',
  contextTokens: 'context_tokens',
  baseCommit: 'base_commit',
  promptAttachments: 'prompt_attachments',
  config: 'config',
  activity: 'activity',
  externalId: 'external_id',
  exitCode: 'exit_code',
  error: 'error',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  queuedAt: 'queued_at',
  queuedStart: 'queued_start',
};

export const sessionRepository = {
  async create(input: CreateSessionInput): Promise<Session> {
    const { rows } = await pool.query<SessionRow>(
      `INSERT INTO sessions (project_id, worktree_id, parent_session_id, name, provider, prompt, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.projectId, input.worktreeId ?? null, input.parentSessionId ?? null, input.name, input.provider, input.prompt ?? null, JSON.stringify(input.config ?? {})],
    );
    return toSession(rows[0]);
  },

  async findById(id: string): Promise<Session | null> {
    const { rows } = await pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? toSession(rows[0]) : null;
  },

  async list(filter: SessionFilter = {}): Promise<Session[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) {
      params.push(filter.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (filter.projectIds) {
      params.push(filter.projectIds);
      where.push(`project_id = ANY($${params.length}::uuid[])`);
    }
    if (filter.worktreeId) {
      params.push(filter.worktreeId);
      where.push(`worktree_id = $${params.length}`);
    }
    if (filter.parentSessionId) {
      params.push(filter.parentSessionId);
      where.push(`parent_session_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.provider) {
      params.push(filter.provider);
      where.push(`provider = $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 50, 200));
    const limitIdx = params.length;
    params.push(filter.offset ?? 0);
    const offsetIdx = params.length;
    const { rows } = await pool.query<SessionRow>(
      `SELECT * FROM sessions
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map(toSession);
  },

  async update(id: string, patch: SessionPatch): Promise<Session | null> {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(patchColumns) as [keyof SessionPatch, string][]) {
      if (patch[key] !== undefined) {
        // Les colonnes jsonb reçoivent du JSON sérialisé (pg transformerait un tableau JS en tableau PostgreSQL) ; toJson retire les \u0000.
        params.push(key === 'promptAttachments' || key === 'config' || key === 'cleanup' || key === 'queuedStart' ? (patch[key] === null ? null : toJson(patch[key])) : patch[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const { rows } = await pool.query<SessionRow>(
      `UPDATE sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? toSession(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /**
   * Passe une session "running" à "interrupted" (arrêt du serveur). Ce n'est pas une erreur : ni
   * code de sortie ni message d'erreur. L'activité est conservée pour savoir si un tour était en
   * cours ('busy') ou si l'agent attendait des instructions ('idle'). Renvoie null si la session
   * n'était plus "running" (déjà arrêtée ou déjà interrompue).
   */
  async markInterrupted(id: string): Promise<Session | null> {
    const { rows } = await pool.query<SessionRow>(
      `UPDATE sessions
       SET status = 'interrupted', exit_code = NULL, error = NULL, ended_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [id],
    );
    return rows[0] ? toSession(rows[0]) : null;
  },

  /**
   * Marque comme "interrupted" toute session encore "running" (utilisé au démarrage du serveur,
   * après un arrêt brutal qui n'a pas pu les clôturer). L'activité est conservée, comme ci-dessus.
   */
  async markRunningAsInterrupted(): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(
      `UPDATE sessions
       SET status = 'interrupted', exit_code = NULL, error = NULL, ended_at = now(), updated_at = now()
       WHERE status = 'running'
       RETURNING *`,
    );
    return rows.map(toSession);
  },

  /**
   * Sessions interrompues par un arrêt du serveur au milieu d'un tour (activité 'busy'), depuis
   * `since`, à relancer au démarrage si la reprise automatique est activée.
   */
  async listInterruptedMidTurn(since: Date, limit: number): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE status = 'interrupted' AND activity = 'busy' AND external_id IS NOT NULL AND ended_at >= $1
       ORDER BY ended_at DESC
       LIMIT $2`,
      [since, limit],
    );
    return rows.map(toSession);
  },

  /** Sessions en file d'attente, dans l'ordre d'arrivée. */
  async listQueued(): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(`SELECT * FROM sessions WHERE status = 'queued' ORDER BY queued_at ASC NULLS LAST, created_at ASC`);
    return rows.map(toSession);
  },

  /** Rang (à partir de 1) d'une session dans la file d'attente, null si elle n'y est pas. */
  async queuePosition(id: string): Promise<number | null> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions q, sessions s
       WHERE s.id = $1 AND s.status = 'queued' AND q.status = 'queued'
         AND (q.queued_at, q.created_at, q.id) <= (s.queued_at, s.created_at, s.id)`,
      [id],
    );
    const n = Number(rows[0]?.n ?? 0);
    return n > 0 ? n : null;
  },

  /** Activité des sessions données (comptage des sessions actives avant un redémarrage). */
  async countByActivity(ids: string[]): Promise<{ busy: number; idle: number }> {
    if (!ids.length) return { busy: 0, idle: 0 };
    const { rows } = await pool.query<{ busy: string; idle: string }>(
      `SELECT count(*) FILTER (WHERE activity = 'busy')::text AS busy,
              count(*) FILTER (WHERE activity IS DISTINCT FROM 'busy')::text AS idle
       FROM sessions WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return { busy: Number(rows[0].busy), idle: Number(rows[0].idle) };
  },

  async addEvent(sessionId: string, type: string, payload: Record<string, unknown> = {}): Promise<SessionEvent> {
    const { rows } = await pool.query<EventRow>(
      `INSERT INTO session_events (session_id, type, payload)
       VALUES ($1, $2, $3) RETURNING *`,
      [sessionId, type, toJson(payload)],
    );
    return toEvent(rows[0]);
  },

  /** Métadonnées d'un fichier joint à une instruction envoyée en cours de session (événement `instruction`). */
  async findAttachmentInEvents(sessionId: string, attachmentId: string): Promise<Omit<Attachment, 'path'> | null> {
    const { rows } = await pool.query<EventRow>(
      `SELECT * FROM session_events WHERE session_id = $1 AND type = 'instruction' AND payload->'attachments' @> $2::jsonb ORDER BY id DESC LIMIT 1`,
      [sessionId, JSON.stringify([{ id: attachmentId }])],
    );
    const attachments = (rows[0]?.payload.attachments as Array<Omit<Attachment, 'path'>> | undefined) ?? [];
    return attachments.find((a) => a.id === attachmentId) ?? null;
  },

  /** Supprime les événements plus vieux que `before` ; renvoie le nombre supprimé. */
  async deleteEventsBefore(sessionId: string, before: Date): Promise<number> {
    const { rowCount } = await pool.query('DELETE FROM session_events WHERE session_id = $1 AND created_at < $2', [sessionId, before]);
    return rowCount ?? 0;
  },

  /** Sessions dont le nettoyage prévoit une durée de rétention du transcript. */
  async listWithRetention(): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(`SELECT * FROM sessions WHERE (cleanup->>'retentionDays') IS NOT NULL`);
    return rows.map(toSession);
  },

  /** Dernier événement d'un des types donnés (ex. le dernier résultat d'un tour). */
  async findLastEvent(sessionId: string, types: string[]): Promise<SessionEvent | null> {
    const { rows } = await pool.query<EventRow>(`SELECT * FROM session_events WHERE session_id = $1 AND type = ANY($2::text[]) ORDER BY id DESC LIMIT 1`, [sessionId, types]);
    return rows[0] ? toEvent(rows[0]) : null;
  },

  async listEvents(sessionId: string, opts: { after?: string; limit?: number } = {}): Promise<SessionEvent[]> {
    const params: unknown[] = [sessionId];
    let where = 'session_id = $1';
    if (opts.after) {
      params.push(opts.after);
      where += ` AND id > $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 500, 2000));
    const { rows } = await pool.query<EventRow>(
      `SELECT * FROM session_events WHERE ${where} ORDER BY id ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toEvent);
  },
};
