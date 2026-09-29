import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { CreateSessionInput, Session, SessionActivity, SessionEvent, SessionFilter, SessionStatus } from './types.js';

interface SessionRow {
  id: string;
  project_id: string;
  worktree_id: string | null;
  name: string;
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  prompt: string | null;
  config: Record<string, unknown>;
  external_id: string | null;
  exit_code: number | null;
  error: string | null;
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
    name: row.name,
    provider: row.provider,
    status: row.status,
    activity: row.activity,
    prompt: row.prompt,
    config: row.config ?? {},
    externalId: row.external_id,
    exitCode: row.exit_code,
    error: row.error,
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
  config?: Record<string, unknown>;
  activity?: SessionActivity | null;
  externalId?: string | null;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

const patchColumns: Record<keyof SessionPatch, string> = {
  status: 'status',
  config: 'config',
  activity: 'activity',
  externalId: 'external_id',
  exitCode: 'exit_code',
  error: 'error',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

export const sessionRepository = {
  async create(input: CreateSessionInput): Promise<Session> {
    const { rows } = await pool.query<SessionRow>(
      `INSERT INTO sessions (project_id, worktree_id, name, provider, prompt, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.projectId, input.worktreeId ?? null, input.name, input.provider, input.prompt ?? null, JSON.stringify(input.config ?? {})],
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
        params.push(key === 'config' ? toJson(patch[key]) : patch[key]);
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

  /** Marque comme "interrupted" toute session encore "running" (utilisé au démarrage du serveur). */
  async markRunningAsInterrupted(): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE sessions
       SET status = 'interrupted', activity = NULL, ended_at = now(), updated_at = now(),
           error = COALESCE(error, 'Serveur redémarré pendant l''exécution')
       WHERE status = 'running'`,
    );
    return rowCount ?? 0;
  },

  async addEvent(sessionId: string, type: string, payload: Record<string, unknown> = {}): Promise<SessionEvent> {
    const { rows } = await pool.query<EventRow>(
      `INSERT INTO session_events (session_id, type, payload)
       VALUES ($1, $2, $3) RETURNING *`,
      [sessionId, type, toJson(payload)],
    );
    return toEvent(rows[0]);
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
