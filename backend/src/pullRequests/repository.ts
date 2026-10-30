import { pool } from '../db/pool.js';
import type { CreateTrackedPullRequestInput, PullRequestActor, TrackedPullRequest, TrackedPullRequestFilter, TrackedPullRequestStatus, UpdateTrackedPullRequestInput } from './types.js';

interface Row {
  id: string;
  project_id: string;
  task_id: string | null;
  number: number;
  url: string;
  title: string;
  head_branch: string;
  base_branch: string;
  status: TrackedPullRequestStatus;
  is_draft: boolean;
  checks_state: string | null;
  review_decision: string | null;
  mergeable: string | null;
  synced_at: Date | null;
  merge_sha: string | null;
  note: string;
  created_by_type: 'human' | 'agent' | 'system';
  created_by_user_id: string | null;
  created_by_session_id: string | null;
  opened_at: Date;
  merged_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toPr = (r: Row): TrackedPullRequest => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  number: r.number,
  url: r.url,
  title: r.title,
  headBranch: r.head_branch,
  baseBranch: r.base_branch,
  status: r.status,
  isDraft: r.is_draft,
  checksState: r.checks_state,
  reviewDecision: r.review_decision,
  mergeable: r.mergeable,
  syncedAt: r.synced_at,
  mergeSha: r.merge_sha,
  note: r.note,
  createdByType: r.created_by_type,
  createdByUserId: r.created_by_user_id,
  createdBySessionId: r.created_by_session_id,
  openedAt: r.opened_at,
  mergedAt: r.merged_at,
  closedAt: r.closed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Condition SQL d'une étape (voir stageOf) : la même logique, pour filtrer en base. */
const STAGE_SQL: Record<string, string> = {
  draft: `(status = 'open' AND is_draft)`,
  to_merge: `(status = 'open' AND NOT is_draft)`,
  merged: `(status = 'merged')`,
  cancelled: `(status = 'closed')`,
};

/** Ordre des listes : ce qui attend une action d'abord (ouvertes), puis les fusionnées, puis les plus récentes. */
const ORDER = `ORDER BY CASE WHEN status = 'open' THEN 0 WHEN status = 'merged' THEN 1 ELSE 2 END, opened_at DESC, number DESC`;

export const pullRequestRepository = {
  async create(projectId: string, input: CreateTrackedPullRequestInput, actor: PullRequestActor): Promise<TrackedPullRequest> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO pull_requests (project_id, task_id, number, url, title, head_branch, base_branch, status, is_draft, checks_state, review_decision, mergeable, synced_at,
                                  note, created_by_type, created_by_user_id, created_by_session_id, opened_at, merged_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $10::text IS NULL AND $11::text IS NULL AND $12::text IS NULL THEN NULL ELSE now() END,
               $13, $14, $15, $16, COALESCE($17, now()), $18, $19)
       RETURNING *`,
      [
        projectId,
        input.taskId ?? null,
        input.number,
        input.url,
        input.title,
        input.headBranch,
        input.baseBranch ?? '',
        input.status ?? 'open',
        Boolean(input.isDraft),
        input.checksState ?? null,
        input.reviewDecision ?? null,
        input.mergeable ?? null,
        input.note ?? '',
        actor.type,
        actor.userId ?? null,
        actor.sessionId ?? null,
        input.openedAt ?? null,
        input.mergedAt ?? null,
        input.closedAt ?? null,
      ],
    );
    return toPr(rows[0]);
  },

  async findById(id: string): Promise<TrackedPullRequest | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM pull_requests WHERE id = $1', [id]);
    return rows[0] ? toPr(rows[0]) : null;
  },

  async findByNumber(projectId: string, number: number): Promise<TrackedPullRequest | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM pull_requests WHERE project_id = $1 AND number = $2', [projectId, number]);
    return rows[0] ? toPr(rows[0]) : null;
  },

  async list(filter: TrackedPullRequestFilter = {}): Promise<TrackedPullRequest[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    if (filter.taskId) where.push(`task_id = $${params.push(filter.taskId)}`);
    if (filter.status?.length) where.push(`status = ANY($${params.push(filter.status)}::text[])`);
    if (filter.stage?.length) where.push(`(${filter.stage.map((s) => STAGE_SQL[s] ?? 'false').join(' OR ')})`);
    if (filter.number != null) where.push(`number = $${params.push(filter.number)}`);
    if (filter.headBranch) where.push(`head_branch = $${params.push(filter.headBranch)}`);
    params.push(Math.min(filter.limit ?? 200, 1000));
    const { rows } = await pool.query<Row>(`SELECT * FROM pull_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER} LIMIT $${params.length}`, params);
    return rows.map(toPr);
  },

  /** Nombre de PR « à traiter » pour des projets : ouvertes (à fusionner, brouillons compris). */
  async countPending(projectIds: string[]): Promise<{ open: number }> {
    if (!projectIds.length) return { open: 0 };
    const { rows } = await pool.query<{ open: string }>(
      `SELECT count(*)::text AS open FROM pull_requests WHERE project_id = ANY($1::uuid[]) AND status = 'open'`,
      [projectIds],
    );
    return { open: Number(rows[0]?.open ?? 0) };
  },

  async update(id: string, input: UpdateTrackedPullRequestInput): Promise<TrackedPullRequest | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (input.taskId !== undefined) sets.push(`task_id = $${params.push(input.taskId)}`);
    if (input.title != null) sets.push(`title = $${params.push(input.title)}`);
    if (input.baseBranch != null) sets.push(`base_branch = $${params.push(input.baseBranch)}`);
    if (input.isDraft != null) sets.push(`is_draft = $${params.push(input.isDraft)}`);
    if (input.checksState !== undefined) sets.push(`checks_state = $${params.push(input.checksState)}`);
    if (input.reviewDecision !== undefined) sets.push(`review_decision = $${params.push(input.reviewDecision)}`);
    if (input.mergeable !== undefined) sets.push(`mergeable = $${params.push(input.mergeable)}`);
    if (input.syncedAt !== undefined) sets.push(`synced_at = $${params.push(input.syncedAt)}`);
    if (input.mergeSha !== undefined) sets.push(`merge_sha = $${params.push(input.mergeSha)}`);
    if (input.note != null) sets.push(`note = $${params.push(input.note)}`);
    if (input.mergedAt !== undefined) sets.push(`merged_at = $${params.push(input.mergedAt)}`);
    if (input.closedAt !== undefined) sets.push(`closed_at = $${params.push(input.closedAt)}`);
    if (input.status != null) {
      sets.push(`status = $${params.push(input.status)}`);
      if (input.status === 'merged' && input.mergedAt === undefined) sets.push('merged_at = COALESCE(merged_at, now())');
      if (input.status === 'closed' && input.closedAt === undefined) sets.push('closed_at = COALESCE(closed_at, now())');
      // Rouverte : les traces de fusion et de fermeture sont effacées, sauf celles que l'appelant fournit lui-même
      // (recordGithub passe mergedAt / closedAt / mergeSha de GitHub, souvent null) : une colonne ne s'assigne qu'une fois.
      if (input.status === 'open') {
        if (input.mergedAt === undefined) sets.push('merged_at = NULL');
        if (input.closedAt === undefined) sets.push('closed_at = NULL');
        if (input.mergeSha === undefined) sets.push('merge_sha = NULL');
      }
    }
    const { rows } = await pool.query<Row>(`UPDATE pull_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toPr(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM pull_requests WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
