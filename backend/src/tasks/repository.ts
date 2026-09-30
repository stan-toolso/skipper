import { pool } from '../db/pool.js';
import type { Actor } from '../context/types.js';
import type { CreateTaskInput, Task, TaskFilter, TaskPriority, TaskStatus, UpdateTaskInput } from './types.js';

interface Row {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  session_id: string | null;
  branch: string | null;
  created_by_type: 'human' | 'agent';
  created_by_session_id: string | null;
  due_date: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const toTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  sessionId: r.session_id,
  branch: r.branch,
  createdByType: r.created_by_type,
  createdBySessionId: r.created_by_session_id,
  dueDate: r.due_date ? String(r.due_date).slice(0, 10) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

/** Tri : urgent d'abord, puis par date de création. */
const ORDER = `ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC`;

export const taskRepository = {
  async create(projectId: string, input: CreateTaskInput, actor: Actor): Promise<Task> {
    const status = input.status ?? 'todo';
    const { rows } = await pool.query<Row>(
      `INSERT INTO tasks (project_id, title, description, status, priority, session_id, created_by_type, created_by_session_id, due_date, completed_at)
       VALUES ($1, $2, $3, $4::task_status, $5, $6, $7, $8, $9, CASE WHEN $4::task_status = 'done' THEN now() ELSE NULL END) RETURNING *`,
      [projectId, input.title, input.description ?? '', status, input.priority ?? 'medium', input.sessionId ?? null, actor.type, actor.sessionId ?? null, input.dueDate ?? null],
    );
    return toTask(rows[0]);
  },

  async findById(id: string): Promise<Task | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM tasks WHERE id = $1', [id]);
    return rows[0] ? toTask(rows[0]) : null;
  },

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    if (filter.status?.length) where.push(`status = ANY($${params.push(filter.status)}::task_status[])`);
    if (filter.priority) where.push(`priority = $${params.push(filter.priority)}`);
    if (filter.sessionId) where.push(`session_id = $${params.push(filter.sessionId)}`);
    params.push(Math.min(filter.limit ?? 200, 1000));
    const { rows } = await pool.query<Row>(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER} LIMIT $${params.length}`, params);
    return rows.map(toTask);
  },

  async update(id: string, input: UpdateTaskInput): Promise<Task | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (input.title != null) sets.push(`title = $${params.push(input.title)}`);
    if (input.description != null) sets.push(`description = $${params.push(input.description)}`);
    if (input.priority != null) sets.push(`priority = $${params.push(input.priority)}`);
    if (input.sessionId !== undefined) sets.push(`session_id = $${params.push(input.sessionId)}`);
    if (input.branch !== undefined) sets.push(`branch = $${params.push(input.branch)}`);
    if (input.dueDate !== undefined) sets.push(`due_date = $${params.push(input.dueDate)}`);
    if (input.status != null) {
      sets.push(`status = $${params.push(input.status)}`);
      sets.push(input.status === 'done' ? 'completed_at = COALESCE(completed_at, now())' : 'completed_at = NULL');
    }
    const { rows } = await pool.query<Row>(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toTask(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
