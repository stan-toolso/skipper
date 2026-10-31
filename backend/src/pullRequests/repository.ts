import { pool } from '../db/pool.js';
import type { CreateTrackedPullRequestInput, PullRequestActor, TrackedPullRequest, TrackedPullRequestFilter, TrackedPullRequestStatus, UpdateTrackedPullRequestInput } from './types.js';

interface Row {
  id: string;
  project_id: string;
  task_id: string | null;
  repo: string;
  number: number | null;
  url: string;
  title: string;
  head_branch: string;
  base_branch: string;
  status: TrackedPullRequestStatus;
  is_draft: boolean;
  worksession_id: string | null;
  local_commits: number | null;
  local_changes: number | null;
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
  repo: r.repo,
  number: r.number,
  url: r.url,
  title: r.title,
  headBranch: r.head_branch,
  baseBranch: r.base_branch,
  status: r.status,
  isDraft: r.is_draft,
  worksessionId: r.worksession_id,
  localCommits: r.local_commits,
  localChanges: r.local_changes,
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
  pending: `(status = 'pending')`,
  draft: `(status = 'open' AND is_draft)`,
  to_merge: `(status = 'open' AND NOT is_draft)`,
  merged: `(status = 'merged')`,
  cancelled: `(status = 'closed')`,
};

/** Ordre des listes : ce qui attend une action d'abord (à fusionner, en préparation), puis les fusionnées, puis les plus récentes. */
const ORDER = `ORDER BY CASE WHEN status = 'open' THEN 0 WHEN status = 'pending' THEN 1 WHEN status = 'merged' THEN 2 ELSE 3 END, opened_at DESC, number DESC NULLS LAST`;

export const pullRequestRepository = {
  async create(projectId: string, input: CreateTrackedPullRequestInput, actor: PullRequestActor): Promise<TrackedPullRequest> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO pull_requests (project_id, task_id, number, url, title, head_branch, base_branch, status, is_draft, checks_state, review_decision, mergeable, synced_at,
                                  note, created_by_type, created_by_user_id, created_by_session_id, opened_at, merged_at, closed_at, repo, worksession_id, local_commits, local_changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $10::text IS NULL AND $11::text IS NULL AND $12::text IS NULL THEN NULL ELSE now() END,
               $13, $14, $15, $16, COALESCE($17, now()), $18, $19, $20, $21, $22, $23)
       RETURNING *`,
      [
        projectId,
        input.taskId ?? null,
        input.number,
        input.url,
        input.title,
        input.headBranch,
        input.baseBranch ?? '',
        input.status ?? (input.number == null ? 'pending' : 'open'),
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
        input.repo ?? '',
        input.worksessionId ?? null,
        input.localCommits ?? null,
        input.localChanges ?? null,
      ],
    );
    return toPr(rows[0]);
  },

  async findById(id: string): Promise<TrackedPullRequest | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM pull_requests WHERE id = $1', [id]);
    return rows[0] ? toPr(rows[0]) : null;
  },

  /**
   * PR suivie d'un projet par son numéro dans un dépôt « owner/name » (casse ignorée). Sans dépôt précisé : celle du
   * dépôt du projet (`projectRepo`) de préférence, sinon la seule PR de ce numéro, tous dépôts confondus.
   */
  async findByNumber(projectId: string, number: number, repo?: string | null, projectRepo?: string | null): Promise<TrackedPullRequest | null> {
    if (repo != null) {
      const { rows } = await pool.query<Row>('SELECT * FROM pull_requests WHERE project_id = $1 AND number = $2 AND lower(repo) = lower($3)', [projectId, number, repo]);
      return rows[0] ? toPr(rows[0]) : null;
    }
    const { rows } = await pool.query<Row>('SELECT * FROM pull_requests WHERE project_id = $1 AND number = $2 ORDER BY (lower(repo) = lower($3)) DESC, created_at', [projectId, number, projectRepo ?? '']);
    if (rows.length > 1 && !rows.some((r) => r.repo.toLowerCase() === (projectRepo ?? '').toLowerCase())) return null;
    return rows[0] ? toPr(rows[0]) : null;
  },

  /** PR en préparation d'une work session, s'il y en a une. */
  async findPendingByWorksession(worksessionId: string): Promise<TrackedPullRequest | null> {
    const { rows } = await pool.query<Row>(`SELECT * FROM pull_requests WHERE worksession_id = $1 AND status = 'pending'`, [worksessionId]);
    return rows[0] ? toPr(rows[0]) : null;
  },

  /**
   * PR suivie de chaque work session (sidebar) : celle qui la désigne (`worksession_id`) ou qui porte sa branche dans
   * son projet, la plus avancée d'abord (ordre `ORDER` : ouverte, en préparation, fusionnée, fermée). Clé : la work session.
   */
  async findForWorksessions(keys: { id: string; projectId: string; branch: string }[]): Promise<Map<string, TrackedPullRequest>> {
    const found = new Map<string, TrackedPullRequest>();
    if (!keys.length) return found;
    const { rows } = await pool.query<Row>(`SELECT * FROM pull_requests WHERE worksession_id = ANY($1::uuid[]) OR (project_id = ANY($2::uuid[]) AND head_branch = ANY($3::text[])) ${ORDER}`, [
      keys.map((k) => k.id),
      [...new Set(keys.map((k) => k.projectId))],
      [...new Set(keys.map((k) => k.branch))],
    ]);
    const prs = rows.map(toPr);
    for (const k of keys) {
      const pr = prs.find((p) => p.worksessionId === k.id || (p.projectId === k.projectId && p.headBranch === k.branch));
      if (pr) found.set(k.id, pr);
    }
    return found;
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
    if (filter.repo != null) where.push(`lower(repo) = lower($${params.push(filter.repo)})`);
    if (filter.headBranch) where.push(`head_branch = $${params.push(filter.headBranch)}`);
    if (filter.worksessionId) where.push(`worksession_id = $${params.push(filter.worksessionId)}`);
    params.push(Math.min(filter.limit ?? 200, 1000));
    const { rows } = await pool.query<Row>(`SELECT * FROM pull_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER} LIMIT $${params.length}`, params);
    return rows.map(toPr);
  },

  /**
   * Projets git à synchroniser en fond : ceux qui ont une PR suivie ouverte ou en préparation, ou une work session
   * active (une PR en préparation peut y naître). Pour chacun, le membre dont le compte GitHub servira à lire le dépôt :
   * l'auteur de la PR ouverte la plus récente s'il a un compte, sinon un administrateur, sinon un autre membre ; null
   * si personne n'a de compte (seul le travail local des branches est alors relu).
   */
  async syncTargets(): Promise<Array<{ projectId: string; userId: string | null }>> {
    const { rows } = await pool.query<{ project_id: string; user_id: string | null }>(
      `SELECT p.id AS project_id,
              (SELECT m.user_id FROM project_members m
               WHERE m.project_id = p.id AND EXISTS (SELECT 1 FROM user_github_accounts a WHERE a.user_id = m.user_id)
               ORDER BY m.user_id = (SELECT pr.created_by_user_id FROM pull_requests pr
                                     WHERE pr.project_id = p.id AND pr.status = 'open' AND pr.created_by_user_id IS NOT NULL
                                     ORDER BY pr.opened_at DESC NULLS LAST LIMIT 1) DESC NULLS LAST,
                        m.role = 'admin' DESC, m.created_at
               LIMIT 1) AS user_id
       FROM projects p
       WHERE p.git_url IS NOT NULL AND p.git_url <> ''
         AND (EXISTS (SELECT 1 FROM pull_requests pr WHERE pr.project_id = p.id AND pr.status IN ('open', 'pending'))
              OR EXISTS (SELECT 1 FROM worksessions w WHERE w.project_id = p.id AND w.archived_at IS NULL))`,
    );
    return rows.map((r) => ({ projectId: r.project_id, userId: r.user_id }));
  },

  /** Nombre de PR « à traiter » pour des projets : ouvertes (à fusionner, brouillons compris) et en préparation. */
  async countPending(projectIds: string[]): Promise<{ open: number; pending: number }> {
    if (!projectIds.length) return { open: 0, pending: 0 };
    const { rows } = await pool.query<{ open: string; pending: string }>(
      `SELECT count(*) FILTER (WHERE status = 'open')::text AS open, count(*) FILTER (WHERE status = 'pending')::text AS pending
       FROM pull_requests WHERE project_id = ANY($1::uuid[])`,
      [projectIds],
    );
    return { open: Number(rows[0]?.open ?? 0), pending: Number(rows[0]?.pending ?? 0) };
  },

  async update(id: string, input: UpdateTrackedPullRequestInput): Promise<TrackedPullRequest | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (input.taskId !== undefined) sets.push(`task_id = $${params.push(input.taskId)}`);
    if (input.number !== undefined) sets.push(`number = $${params.push(input.number)}`);
    if (input.url != null) sets.push(`url = $${params.push(input.url)}`);
    if (input.repo != null) sets.push(`repo = $${params.push(input.repo)}`);
    if (input.title != null) sets.push(`title = $${params.push(input.title)}`);
    if (input.headBranch != null) sets.push(`head_branch = $${params.push(input.headBranch)}`);
    if (input.baseBranch != null) sets.push(`base_branch = $${params.push(input.baseBranch)}`);
    if (input.isDraft != null) sets.push(`is_draft = $${params.push(input.isDraft)}`);
    if (input.worksessionId !== undefined) sets.push(`worksession_id = $${params.push(input.worksessionId)}`);
    if (input.localCommits !== undefined) sets.push(`local_commits = $${params.push(input.localCommits)}`);
    if (input.localChanges !== undefined) sets.push(`local_changes = $${params.push(input.localChanges)}`);
    if (input.checksState !== undefined) sets.push(`checks_state = $${params.push(input.checksState)}`);
    if (input.reviewDecision !== undefined) sets.push(`review_decision = $${params.push(input.reviewDecision)}`);
    if (input.mergeable !== undefined) sets.push(`mergeable = $${params.push(input.mergeable)}`);
    if (input.syncedAt !== undefined) sets.push(`synced_at = $${params.push(input.syncedAt)}`);
    if (input.mergeSha !== undefined) sets.push(`merge_sha = $${params.push(input.mergeSha)}`);
    if (input.note != null) sets.push(`note = $${params.push(input.note)}`);
    if (input.openedAt != null) sets.push(`opened_at = $${params.push(input.openedAt)}`);
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
