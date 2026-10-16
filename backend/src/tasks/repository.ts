import { pool, type Queryable } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Actor } from '../context/types.js';
import type { CreateTaskInput, Task, TaskAttachment, TaskComment, TaskFilter, TaskField, TaskPerson, TaskPriority, TaskStatus, UpdateTaskInput } from './types.js';

interface Row {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  status_tag: string | null;
  tags: string[] | null;
  priority: TaskPriority;
  session_id: string | null;
  branch: string | null;
  created_by_type: 'human' | 'agent';
  created_by_session_id: string | null;
  due_date: string | Date | null;
  custom_fields: TaskField[] | null;
  assignee_name: string | null;
  assignee_email: string | null;
  reporter_name: string | null;
  reporter_email: string | null;
  comment_count: string | number | null;
  attachment_count: string | number | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface CommentRow {
  id: string;
  task_id: string;
  author_type: 'human' | 'agent';
  author_user_id: string | null;
  author_session_id: string | null;
  author_name: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

interface AttachmentRow {
  id: string;
  task_id: string;
  comment_id: string | null;
  name: string;
  media_type: string;
  size: number;
  created_at: Date;
}

const toAttachment = (r: AttachmentRow): TaskAttachment => ({ id: r.id, taskId: r.task_id, commentId: r.comment_id, name: r.name, mediaType: r.media_type, size: Number(r.size), createdAt: r.created_at });

/** Date PostgreSQL rendue AAAA-MM-JJ sans décalage de fuseau (pg renvoie un Date à minuit local). */
function toDateString(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return String(value).slice(0, 10);
}

const person = (name: string | null, email: string | null): TaskPerson | null => (name || email ? { name: name || null, email: email || null } : null);

const toTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  description: r.description,
  status: r.status,
  statusTag: r.status_tag ?? null,
  tags: Array.isArray(r.tags) ? r.tags : [],
  priority: r.priority,
  sessionId: r.session_id,
  branch: r.branch,
  createdByType: r.created_by_type,
  createdBySessionId: r.created_by_session_id,
  dueDate: toDateString(r.due_date),
  customFields: Array.isArray(r.custom_fields) ? r.custom_fields : [],
  assignee: person(r.assignee_name, r.assignee_email),
  reporter: person(r.reporter_name, r.reporter_email),
  commentCount: Number(r.comment_count ?? 0),
  attachmentCount: Number(r.attachment_count ?? 0),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

const toComment = (r: CommentRow): TaskComment => ({
  id: r.id,
  taskId: r.task_id,
  authorType: r.author_type,
  authorUserId: r.author_user_id,
  authorSessionId: r.author_session_id,
  authorName: r.author_name,
  body: r.body,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Colonnes d'une tâche avec le nombre de commentaires. */
const SELECT = `SELECT t.*, (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count, (SELECT count(*) FROM task_attachments a WHERE a.task_id = t.id AND a.comment_id IS NULL) AS attachment_count FROM tasks t`;
/** Tri : urgent d'abord, puis par date de création. */
const ORDER = `ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC`;

/** Motif ILIKE « contient », jokers échappés. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Personne normalisée en colonnes (null, null = retirée). */
function personColumns(p: TaskPerson | null | undefined): [string | null, string | null] {
  return [p?.name ?? null, p?.email ?? null];
}

async function linkSession(db: Queryable, taskId: string, sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  await db.query('INSERT INTO task_sessions (task_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [taskId, sessionId]);
}

export const taskRepository = {
  async create(projectId: string, input: CreateTaskInput & { assignee?: TaskPerson | null; reporter?: TaskPerson | null }, actor: Actor): Promise<Task> {
    const status = input.status ?? 'todo';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, description, status, priority, session_id, created_by_type, created_by_session_id, due_date, completed_at,
                            custom_fields, assignee_name, assignee_email, reporter_name, reporter_email, status_tag, tags)
         VALUES ($1, $2, $3, $4::task_status, $5, $6, $7, $8, $9, CASE WHEN $4::task_status = 'done' THEN now() ELSE NULL END, $10::jsonb, $11, $12, $13, $14, $15, $16::text[]) RETURNING id`,
        [
          projectId,
          input.title,
          input.description ?? '',
          status,
          input.priority ?? 'medium',
          input.sessionId ?? null,
          actor.type,
          actor.sessionId ?? null,
          input.dueDate ?? null,
          toJson(input.customFields ?? []),
          ...personColumns(input.assignee),
          ...personColumns(input.reporter),
          input.statusTag ?? null,
          input.tags ?? [],
        ],
      );
      await linkSession(client, rows[0].id, input.sessionId);
      await linkSession(client, rows[0].id, actor.sessionId);
      await client.query('COMMIT');
      return (await this.findById(rows[0].id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findById(id: string): Promise<Task | null> {
    const { rows } = await pool.query<Row>(`${SELECT} WHERE t.id = $1`, [id]);
    return rows[0] ? toTask(rows[0]) : null;
  },

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) where.push(`t.project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`t.project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    if (filter.status?.length) where.push(`t.status = ANY($${params.push(filter.status)}::task_status[])`);
    if (filter.priority) where.push(`t.priority = $${params.push(filter.priority)}`);
    if (filter.sessionId) where.push(`t.session_id = $${params.push(filter.sessionId)}`);
    if (filter.branch) where.push(`t.branch = $${params.push(filter.branch)}`);
    if (filter.tag) where.push(`EXISTS (SELECT 1 FROM unnest(t.tags) tag WHERE lower(tag) = lower($${params.push(filter.tag)}))`);
    if (filter.assignee) {
      const p = params.push(contains(filter.assignee));
      where.push(`(t.assignee_name ILIKE $${p} OR t.assignee_email ILIKE $${p})`);
    }
    if (filter.reporter) {
      const p = params.push(contains(filter.reporter));
      where.push(`(t.reporter_name ILIKE $${p} OR t.reporter_email ILIKE $${p})`);
    }
    if (filter.assigneeEmail) where.push(`lower(t.assignee_email) = lower($${params.push(filter.assigneeEmail)})`);
    params.push(Math.min(filter.limit ?? 200, 1000));
    const { rows } = await pool.query<Row>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER} LIMIT $${params.length}`, params);
    return rows.map(toTask);
  },

  /** Tâches reliées à une session (historique task_sessions), la plus récemment reliée d'abord. */
  async listForSession(sessionId: string): Promise<Task[]> {
    const { rows } = await pool.query<Row>(`${SELECT} JOIN task_sessions ts ON ts.task_id = t.id WHERE ts.session_id = $1 ORDER BY ts.linked_at DESC`, [sessionId]);
    return rows.map(toTask);
  },

  /** Identifiants des sessions passées par la tâche, les plus récemment reliées d'abord. */
  async sessionIds(taskId: string): Promise<string[]> {
    const { rows } = await pool.query<{ session_id: string }>('SELECT session_id FROM task_sessions WHERE task_id = $1 ORDER BY linked_at DESC', [taskId]);
    return rows.map((r) => r.session_id);
  },

  async update(id: string, input: UpdateTaskInput & { assignee?: TaskPerson | null; reporter?: TaskPerson | null }): Promise<Task | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (input.title != null) sets.push(`title = $${params.push(input.title)}`);
    if (input.description != null) sets.push(`description = $${params.push(input.description)}`);
    if (input.priority != null) sets.push(`priority = $${params.push(input.priority)}`);
    if (input.sessionId !== undefined) sets.push(`session_id = $${params.push(input.sessionId)}`);
    if (input.branch !== undefined) sets.push(`branch = $${params.push(input.branch)}`);
    if (input.dueDate !== undefined) sets.push(`due_date = $${params.push(input.dueDate)}`);
    if (input.customFields != null) sets.push(`custom_fields = $${params.push(toJson(input.customFields))}::jsonb`);
    if (input.statusTag !== undefined) sets.push(`status_tag = $${params.push(input.statusTag)}`);
    if (input.tags != null) sets.push(`tags = $${params.push(input.tags)}::text[]`);
    if (input.assignee !== undefined) {
      const [name, email] = personColumns(input.assignee);
      sets.push(`assignee_name = $${params.push(name)}`, `assignee_email = $${params.push(email)}`);
    }
    if (input.reporter !== undefined) {
      const [name, email] = personColumns(input.reporter);
      sets.push(`reporter_name = $${params.push(name)}`, `reporter_email = $${params.push(email)}`);
    }
    if (input.status != null) {
      sets.push(`status = $${params.push(input.status)}`);
      sets.push(input.status === 'done' ? 'completed_at = COALESCE(completed_at, now())' : 'completed_at = NULL');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);
      if (rowCount) await linkSession(client, id, input.sessionId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.findById(id);
  },

  /** Déplace une tâche dans un autre projet : sa session et sa branche restent à l'ancien projet, elles sont retirées. */
  async move(id: string, projectId: string): Promise<Task | null> {
    const { rowCount } = await pool.query('UPDATE tasks SET project_id = $2, session_id = NULL, branch = NULL, updated_at = now() WHERE id = $1', [id, projectId]);
    return rowCount ? this.findById(id) : null;
  },

  /** Étiquettes distinctes des tâches des projets (les plus utilisées d'abord), pour les suggestions. */
  async tags(projectIds: string[]): Promise<string[]> {
    const { rows } = await pool.query<{ tag: string }>(
      `SELECT min(tag) AS tag FROM tasks, unnest(tags) tag WHERE project_id = ANY($1::uuid[]) GROUP BY lower(tag) ORDER BY count(*) DESC, lower(tag) LIMIT 500`,
      [projectIds],
    );
    return rows.map((r) => r.tag);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Personnes (nom, e-mail) déjà désignées sur les tâches des projets donnés, pour les suggestions. */
  async people(projectIds: string[]): Promise<TaskPerson[]> {
    const { rows } = await pool.query<{ name: string | null; email: string | null }>(
      `SELECT DISTINCT name, email FROM (
         SELECT assignee_name AS name, assignee_email AS email FROM tasks WHERE project_id = ANY($1::uuid[])
         UNION ALL
         SELECT reporter_name, reporter_email FROM tasks WHERE project_id = ANY($1::uuid[])
       ) p WHERE name IS NOT NULL OR email IS NOT NULL ORDER BY email NULLS LAST, name LIMIT 500`,
      [projectIds],
    );
    return rows.map((r) => ({ name: r.name, email: r.email }));
  },

  // ---- Pièces jointes --------------------------------------------------------------------------

  /** Pièces jointes d'une tâche : les siennes (`commentId` null), celles d'un commentaire, ou toutes (`commentId` absent), les plus anciennes d'abord. */
  async listAttachments(taskId: string, commentId?: string | null): Promise<TaskAttachment[]> {
    const scope = commentId === undefined ? '' : commentId === null ? ' AND comment_id IS NULL' : ' AND comment_id = $2';
    const { rows } = await pool.query<AttachmentRow>(`SELECT * FROM task_attachments WHERE task_id = $1${scope} ORDER BY created_at ASC, id ASC`, commentId ? [taskId, commentId] : [taskId]);
    return rows.map(toAttachment);
  },

  async findAttachment(id: string): Promise<TaskAttachment | null> {
    const { rows } = await pool.query<AttachmentRow>('SELECT * FROM task_attachments WHERE id = $1', [id]);
    return rows[0] ? toAttachment(rows[0]) : null;
  },

  async createAttachment(input: Omit<TaskAttachment, 'createdAt'>): Promise<TaskAttachment> {
    const { rows } = await pool.query<AttachmentRow>('INSERT INTO task_attachments (id, task_id, comment_id, name, media_type, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
      input.id,
      input.taskId,
      input.commentId,
      input.name,
      input.mediaType,
      input.size,
    ]);
    await pool.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [input.taskId]);
    return toAttachment(rows[0]);
  },

  async deleteAttachment(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM task_attachments WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Commentaires ----------------------------------------------------------------------------

  async listComments(taskId: string): Promise<TaskComment[]> {
    const { rows } = await pool.query<CommentRow>('SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC, id ASC', [taskId]);
    return rows.map(toComment);
  },

  async findComment(id: string): Promise<TaskComment | null> {
    const { rows } = await pool.query<CommentRow>('SELECT * FROM task_comments WHERE id = $1', [id]);
    return rows[0] ? toComment(rows[0]) : null;
  },

  async addComment(taskId: string, body: string, author: { type: Actor['type']; userId?: string | null; sessionId?: string | null; name: string }): Promise<TaskComment> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<CommentRow>(
        `INSERT INTO task_comments (task_id, author_type, author_user_id, author_session_id, author_name, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [taskId, author.type, author.userId ?? null, author.sessionId ?? null, author.name, body],
      );
      await client.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [taskId]);
      await client.query('COMMIT');
      return toComment(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async updateComment(id: string, body: string): Promise<TaskComment | null> {
    const { rows } = await pool.query<CommentRow>('UPDATE task_comments SET body = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, body]);
    return rows[0] ? toComment(rows[0]) : null;
  },

  async deleteComment(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM task_comments WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
