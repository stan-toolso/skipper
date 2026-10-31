import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { FormerWorksession, Attachment, CreateSessionInput, QueuedStart, Session, SessionActivity, SessionCleanup, SessionEvent, SessionFilter, SessionKind, SessionStatus } from './types.js';

interface SessionRow {
  id: string;
  project_id: string;
  worksession_id: string | null;
  kind: SessionKind;
  parent_session_id: string | null;
  owner_id: string | null;
  workflow_run_id: string | null;
  archived_at: Date | null;
  former_worksession: FormerWorksession | null;
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
  resume_digest: string | null;
  cost_usd: string | number | null;
  base_commit: string | null;
  queued_at: Date | null;
  queued_start: QueuedStart | null;
  instance_id: string | null;
  parked_at: Date | null;
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
    worksessionId: row.worksession_id,
    kind: row.kind ?? 'session',
    parentSessionId: row.parent_session_id,
    ownerId: row.owner_id ?? null,
    workflowRunId: row.workflow_run_id ?? null,
    archivedAt: row.archived_at ?? null,
    formerWorksession: row.former_worksession ?? null,
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
    resumeDigest: row.resume_digest ?? null,
    costUsd: Number(row.cost_usd ?? 0),
    baseCommit: row.base_commit ?? null,
    queuedAt: row.queued_at ?? null,
    queuedStart: row.queued_start ?? null,
    createdAt: row.created_at,
    instanceId: row.instance_id ?? null,
    parkedAt: row.parked_at ?? null,
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
  archivedAt?: Date | null;
  ownerId?: string | null;
  cleanup?: SessionCleanup;
  contextTokens?: number | null;
  resumeDigest?: string | null;
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
  instanceId?: string | null;
  parkedAt?: Date | null;
}

const patchColumns: Record<keyof SessionPatch, string> = {
  status: 'status',
  name: 'name',
  archivedAt: 'archived_at',
  ownerId: 'owner_id',
  cleanup: 'cleanup',
  contextTokens: 'context_tokens',
  resumeDigest: 'resume_digest',
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
  instanceId: 'instance_id',
  parkedAt: 'parked_at',
};

export const sessionRepository = {
  async create(input: CreateSessionInput): Promise<Session> {
    const { rows } = await pool.query<SessionRow>(
      `INSERT INTO sessions (project_id, worksession_id, parent_session_id, owner_id, name, provider, prompt, config, workflow_run_id, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [input.projectId, input.worksessionId ?? null, input.parentSessionId ?? null, input.ownerId ?? null, input.name, input.provider, input.prompt ?? null, JSON.stringify(input.config ?? {}), input.workflowRunId ?? null, input.kind ?? 'session'],
    );
    return toSession(rows[0]);
  },

  async findById(id: string): Promise<Session | null> {
    const { rows } = await pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? toSession(rows[0]) : null;
  },

  /** Sessions de ces identifiants (chargement groupé par requête GraphQL), sans ordre garanti. */
  async findByIds(ids: string[]): Promise<Session[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<SessionRow>('SELECT * FROM sessions WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toSession);
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
    if (filter.worksessionId) {
      params.push(filter.worksessionId);
      where.push(`worksession_id = $${params.length}`);
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
    if (filter.ownerId) {
      params.push(filter.ownerId);
      where.push(`owner_id = $${params.length}`);
    }
    if (filter.ids) {
      params.push(filter.ids);
      where.push(`id = ANY($${params.length}::uuid[])`);
    }
    // Les chats (sessions légères d'un espace personnel) ne figurent pas dans les listes de sessions, sauf demande ;
    // une liste par identifiants (sessions d'une tâche) ou par session parente prend tout.
    const kind = filter.kind ?? (filter.ids || filter.parentSessionId ? 'all' : 'session');
    if (kind !== 'all') {
      params.push(kind);
      where.push(`kind = $${params.length}`);
    }
    const archived = filter.archived ?? 'exclude';
    if (archived === 'exclude') where.push('archived_at IS NULL');
    else if (archived === 'only') where.push('archived_at IS NOT NULL');
    if (filter.search?.trim()) {
      params.push(`%${filter.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const s = `$${params.length}`;
      where.push(`(name ILIKE ${s} OR prompt ILIKE ${s} OR EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = sessions.id AND e.type IN ('instruction', 'claude.assistant') AND e.payload::text ILIKE ${s}))`);
    }
    params.push(Math.min(filter.limit ?? 50, 500));
    const limitIdx = params.length;
    params.push(filter.offset ?? 0);
    const offsetIdx = params.length;
    const { rows } = await pool.query<SessionRow>(
      `SELECT * FROM sessions
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${archived === 'only' ? 'archived_at DESC' : 'created_at DESC'}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map(toSession);
  },

  /** Propriétaires distincts des sessions actives des projets donnés. */
  async listOwnerIds(projectIds: string[]): Promise<string[]> {
    const { rows } = await pool.query<{ owner_id: string }>(`SELECT DISTINCT owner_id FROM sessions WHERE owner_id IS NOT NULL AND archived_at IS NULL AND project_id = ANY($1::uuid[])`, [projectIds]);
    return rows.map((r) => r.owner_id);
  },

  /** Archive les sessions actives d'une work session ; renvoie leurs identifiants. */
  /**
   * Avant la suppression d'une work session : ses sessions sont archivées (celles qui l'étaient déjà gardent leur date),
   * gardent le souvenir de la work session, et en sont détachées (la clé étrangère ferait de même, mais sans le souvenir).
   */
  async detachWorksession(worksessionId: string, at: Date, former: FormerWorksession): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE sessions SET worksession_id = NULL, former_worksession = $3::jsonb, archived_at = COALESCE(archived_at, $2), updated_at = now() WHERE worksession_id = $1 RETURNING id`,
      [worksessionId, at, JSON.stringify(former)],
    );
    return rows.map((r) => r.id);
  },

  async archiveByWorksession(worksessionId: string, at: Date): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(`UPDATE sessions SET archived_at = $2, updated_at = now() WHERE worksession_id = $1 AND archived_at IS NULL RETURNING id`, [worksessionId, at]);
    return rows.map((r) => r.id);
  },

  /** Restaure les sessions d'une work session archivées à partir de la date d'archivage de la work session. */
  async unarchiveByWorksession(worksessionId: string, since: Date): Promise<number> {
    const { rowCount } = await pool.query(`UPDATE sessions SET archived_at = NULL, updated_at = now() WHERE worksession_id = $1 AND archived_at IS NOT NULL AND archived_at >= $2`, [worksessionId, since]);
    return rowCount ?? 0;
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
       SET status = 'interrupted', exit_code = NULL, error = NULL, ended_at = now(), updated_at = now(), instance_id = NULL, parked_at = NULL
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [id],
    );
    return rows[0] ? toSession(rows[0]) : null;
  },

  /**
   * Marque comme "interrupted" les sessions encore "running" dont plus aucun processus ne tourne (au démarrage du
   * serveur, après un arrêt brutal qui n'a pas pu les clôturer) : celles qu'aucune instance vivante ne tient
   * (`liveInstanceIds`). Les sessions garées (`parked_at`) restent en attente d'instruction. L'activité est conservée.
   */
  async markRunningAsInterrupted(liveInstanceIds: string[] = []): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(
      `UPDATE sessions
       SET status = 'interrupted', exit_code = NULL, error = NULL, ended_at = now(), updated_at = now(), instance_id = NULL
       WHERE status = 'running' AND parked_at IS NULL AND (instance_id IS NULL OR NOT instance_id = ANY($1::uuid[]))
       RETURNING *`,
      [liveInstanceIds],
    );
    return rows.map(toSession);
  },

  /** Sessions garées depuis avant `before` (fin pour inactivité, comme une session qui attend sans processus). */
  async listParkedBefore(before: Date): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(`SELECT * FROM sessions WHERE status = 'running' AND parked_at IS NOT NULL AND parked_at < $1`, [before]);
    return rows.map(toSession);
  },

  /** Réserve une session garée pour cette instance (une seule instance la relance) ; false si elle ne l'est plus. */
  async claimParked(id: string, instanceId: string): Promise<boolean> {
    const { rowCount } = await pool.query(`UPDATE sessions SET parked_at = NULL, instance_id = $2, updated_at = now() WHERE id = $1 AND status = 'running' AND parked_at IS NOT NULL`, [id, instanceId]);
    return Boolean(rowCount);
  },

  /**
   * Sessions interrompues par un arrêt du serveur au milieu d'un tour (activité 'busy'), depuis
   * `since`, à relancer au démarrage si la reprise automatique est activée.
   */
  async listInterruptedMidTurn(since: Date, limit: number): Promise<Session[]> {
    const { rows } = await pool.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE status = 'interrupted' AND activity = 'busy' AND external_id IS NOT NULL AND archived_at IS NULL AND ended_at >= $1
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

  /** Un événement par son identifiant (événement publié par une autre instance du backend). */
  async findEvent(id: string): Promise<SessionEvent | null> {
    const { rows } = await pool.query<EventRow>('SELECT * FROM session_events WHERE id = $1', [id]);
    return rows[0] ? toEvent(rows[0]) : null;
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
