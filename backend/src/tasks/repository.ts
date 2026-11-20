import { pool, type Queryable } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Actor } from '../context/types.js';
import { conversationRepository } from '../conversations/repository.js';
import type { Message, MessageAttachment, MessageReaction } from '../conversations/types.js';
import type { CreateTaskInput, Task, TaskAttachment, TaskComment, TaskFilter, TaskField, TaskMention, TaskPerson, TaskPriority, TaskReaction, TaskStatus, UpdateTaskInput } from './types.js';

interface Row {
  id: string;
  project_id: string;
  title: string;
  summary: string | null;
  description: string;
  status: TaskStatus;
  status_tag: string | null;
  tags: string[] | null;
  priority: TaskPriority;
  session_id: string | null;
  session_ids: string[] | null;
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
  depends_on_ids: string[] | null;
  blocked_by_ids: string[] | null;
  dependent_ids: string[] | null;
  auto_start_when_unblocked: boolean | null;
  auto_start_by_id: string | null;
  stalled_since?: Date | null;
  waiting_since?: Date | null;
  wake_at?: Date | null;
  wake_note?: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  started_at: Date | null;
  cancelled_at: Date | null;
}

/** Un message de la conversation d'une tâche vu comme un commentaire de la tâche (façade). */
const commentOf = (m: Message, taskId: string): TaskComment => ({
  id: m.id,
  taskId,
  parentId: m.parentId,
  authorType: m.authorType,
  authorUserId: m.authorUserId,
  authorSessionId: m.authorSessionId,
  authorName: m.authorName,
  body: m.body,
  mentions: m.mentions,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/** Une réaction de la conversation d'une tâche vue comme une réaction de la tâche (`commentId` null : sur la tâche elle-même). */
const reactionOf = (r: MessageReaction, taskId: string): TaskReaction => ({
  id: r.id,
  taskId,
  commentId: r.messageId,
  emoji: r.emoji,
  actorType: r.actorType,
  userId: r.userId,
  sessionId: r.sessionId,
  actorName: r.actorName,
  createdAt: r.createdAt,
});

/** Un fichier d'un message de la conversation d'une tâche vu comme un fichier de commentaire. */
const commentAttachmentOf = (a: MessageAttachment, taskId: string): TaskAttachment => ({ id: a.id, taskId, commentId: a.messageId, name: a.name, mediaType: a.mediaType, size: a.size, createdAt: a.createdAt });

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
  summary: r.summary || null,
  description: r.description,
  status: r.status,
  statusTag: r.status_tag ?? null,
  tags: Array.isArray(r.tags) ? r.tags : [],
  priority: r.priority,
  sessionId: r.session_id,
  sessionIds: r.session_ids ?? [],
  branch: r.branch,
  createdByType: r.created_by_type,
  createdBySessionId: r.created_by_session_id,
  dueDate: toDateString(r.due_date),
  customFields: Array.isArray(r.custom_fields) ? r.custom_fields : [],
  assignee: person(r.assignee_name, r.assignee_email),
  reporter: person(r.reporter_name, r.reporter_email),
  commentCount: Number(r.comment_count ?? 0),
  attachmentCount: Number(r.attachment_count ?? 0),
  dependsOnIds: r.depends_on_ids ?? [],
  blockedByIds: r.blocked_by_ids ?? [],
  dependentIds: r.dependent_ids ?? [],
  autoStartWhenUnblocked: Boolean(r.auto_start_when_unblocked),
  autoStartById: r.auto_start_by_id ?? null,
  stalledSince: r.stalled_since ?? null,
  waitingSince: r.waiting_since ?? null,
  wakeAt: r.wake_at ?? null,
  wakeNote: r.wake_note ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  startedAt: r.started_at ?? null,
  cancelledAt: r.cancelled_at ?? null,
});

/** Statuts d'une session qui travaille encore (ou va travailler) : elle tient la tâche. */
export const ACTIVE_SESSION_STATUSES = ['pending', 'queued', 'running'] as const;

/** Durée d'une attente implicite (étiquette d'état ou compte rendu d'agent, sans date de réveil) avant le retour dans « À traiter ». */
export const IMPLICIT_WAIT_DAYS = 7;

/**
 * Tâche en cours sans agent au travail (jointure latérale sur l'alias `t`, colonnes `att.stalled_since` et
 * `att.waiting_since`) : des sessions en ont la charge mais aucune ne tourne plus (terminée, arrêtée, en erreur,
 * interrompue), et aucune pull request n'est ouverte (la suite est alors la fusion, pas l'agent). Deux cas :
 *
 * - « agent arrêté » (`stalled_since`, à traiter) : la dernière session en charge s'est arrêtée en erreur ou a été
 *   interrompue ; ou la date de réveil posée est passée ; ou l'agent est parti sans rien dire (ni étiquette d'état, ni
 *   compte rendu dans le fil) ; ou l'attente implicite dure depuis plus de IMPLICIT_WAIT_DAYS jours ;
 * - « en attente » (`waiting_since`, pas à traiter) : l'agent s'est arrêté proprement en posant une date de réveil
 *   future (`wake_at`), ou en laissant une étiquette d'état ou un compte rendu d'une session dans le fil depuis sa prise
 *   en charge (un agent de passage, une exécution planifiée qui rend compte, comptent aussi).
 *
 * Les deux valent la fin la plus récente des sessions en charge (le réveil, s'il est passé et plus récent).
 */
export const ATTENTION_JOIN = `LEFT JOIN LATERAL (
  SELECT CASE WHEN x.kind = 'stalled' THEN x.since END AS stalled_since, CASE WHEN x.kind = 'waiting' THEN x.since END AS waiting_since
    FROM (
      SELECT CASE
               WHEN c.last_status IN ('failed', 'interrupted') THEN 'stalled'
               WHEN t.wake_at IS NOT NULL THEN CASE WHEN t.wake_at > now() THEN 'waiting' ELSE 'stalled' END
               WHEN (t.status_tag IS NOT NULL OR c.last_note >= c.charge_start)
                    AND GREATEST(c.ended, c.last_note) > now() - interval '${IMPLICIT_WAIT_DAYS} days' THEN 'waiting'
               ELSE 'stalled'
             END AS kind,
             CASE WHEN t.wake_at IS NOT NULL AND t.wake_at <= now() THEN GREATEST(c.ended, t.wake_at) ELSE c.ended END AS since
        FROM (
          SELECT max(COALESCE(s.ended_at, s.updated_at)) AS ended,
                 (array_agg(s.status::text ORDER BY COALESCE(s.ended_at, s.updated_at) DESC))[1] AS last_status,
                 max(ts.in_charge_since) AS charge_start,
                 (SELECT max(m.created_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                   WHERE cv.task_id = t.id AND m.author_session_id IS NOT NULL) AS last_note
            FROM task_sessions ts JOIN sessions s ON s.id = ts.session_id
           WHERE ts.task_id = t.id AND ts.in_charge_since IS NOT NULL
          HAVING bool_and(s.status NOT IN (${ACTIVE_SESSION_STATUSES.map((x) => `'${x}'`).join(', ')}))
        ) c
    ) x
   WHERE t.status = 'in_progress' AND NOT EXISTS (SELECT 1 FROM pull_requests pr WHERE pr.task_id = t.id AND pr.status = 'open')
) att ON true`;

/** Colonnes d'une tâche avec le nombre de messages de son fil (conversation de la tâche). */
const SELECT = `SELECT t.*, (SELECT count(*) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.task_id = t.id) AS comment_count,
  (SELECT array_agg(ts.session_id ORDER BY ts.in_charge_since DESC) FROM task_sessions ts WHERE ts.task_id = t.id AND ts.in_charge_since IS NOT NULL) AS session_ids, (SELECT count(*) FROM task_attachments a WHERE a.task_id = t.id AND a.comment_id IS NULL) AS attachment_count,
  (SELECT array_agg(d.depends_on_task_id ORDER BY d.created_at, d.depends_on_task_id) FROM task_dependencies d WHERE d.task_id = t.id) AS depends_on_ids,
  (SELECT array_agg(d.depends_on_task_id ORDER BY d.created_at, d.depends_on_task_id) FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND dt.status <> 'done') AS blocked_by_ids,
  (SELECT array_agg(d.task_id ORDER BY d.created_at, d.task_id) FROM task_dependencies d WHERE d.depends_on_task_id = t.id) AS dependent_ids,
  att.stalled_since, att.waiting_since FROM tasks t ${ATTENTION_JOIN}`;
/** Tri : urgent d'abord, puis par date de création. */
const ORDER = `ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC`;

/** Motif ILIKE « contient », jokers échappés. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Personne normalisée en colonnes (null, null = retirée). */
function personColumns(p: TaskPerson | null | undefined): [string | null, string | null] {
  return [p?.name ?? null, p?.email ?? null];
}

/** Note le passage d'une session par la tâche (historique), sans lui en donner la charge. */
async function linkSession(db: Queryable, taskId: string, sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  await db.query('INSERT INTO task_sessions (task_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [taskId, sessionId]);
}

/**
 * La session prend la charge de la tâche (en plus des sessions déjà en charge). Une tâche sans branche reçoit celle du
 * dossier de travail de la session : c'est par la branche que la sidebar et la PR en préparation retrouvent la tâche
 * (une tâche créée « en cours » par l'agent, ou prise par claim, restait sinon invisible sur sa session).
 */
async function takeCharge(db: Queryable, taskId: string, sessionId: string): Promise<void> {
  await db.query(
    `INSERT INTO task_sessions (task_id, session_id, in_charge_since) VALUES ($1, $2, now())
     ON CONFLICT (task_id, session_id) DO UPDATE SET in_charge_since = COALESCE(task_sessions.in_charge_since, now())`,
    [taskId, sessionId],
  );
  await db.query(
    `UPDATE tasks t SET branch = w.branch FROM sessions s JOIN worksessions w ON w.id = s.worksession_id
     WHERE t.id = $1 AND s.id = $2 AND t.branch IS NULL AND w.project_id = t.project_id`,
    [taskId, sessionId],
  );
}

/** Des sessions cessent d'être en charge (toutes si `sessionIds` est null) ; leur passage reste dans l'historique. */
async function releaseCharge(db: Queryable, taskId: string, sessionIds: string[] | null): Promise<void> {
  if (sessionIds && sessionIds.length === 0) return;
  await db.query(`UPDATE task_sessions SET in_charge_since = NULL WHERE task_id = $1${sessionIds ? ' AND session_id = ANY($2::uuid[])' : ''}`, sessionIds ? [taskId, sessionIds] : [taskId]);
}

/** Remplace les dépendances de la tâche (identifiants déjà validés par le service : même projet, sans cycle). */
async function setDependencies(db: Queryable, taskId: string, dependsOn: string[]): Promise<void> {
  await db.query('DELETE FROM task_dependencies WHERE task_id = $1 AND NOT (depends_on_task_id = ANY($2::uuid[]))', [taskId, dependsOn]);
  if (dependsOn.length) {
    await db.query('INSERT INTO task_dependencies (task_id, depends_on_task_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING', [taskId, dependsOn]);
  }
}

/** tasks.session_id = la plus récente des sessions en charge. */
async function syncPrimarySession(db: Queryable, taskId: string): Promise<void> {
  await db.query('UPDATE tasks SET session_id = (SELECT session_id FROM task_sessions WHERE task_id = $1 AND in_charge_since IS NOT NULL ORDER BY in_charge_since DESC LIMIT 1) WHERE id = $1', [taskId]);
}

/**
 * Dates de cycle tenues à chaque changement de statut (vue pilotage : cycle time, flux cumulé). started_at garde le
 * premier passage en cours (une terminée sans passer par en cours démarre à sa fin) et s'efface au retour à « à faire » ;
 * completed_at et cancelled_at ne valent que dans leur statut. Les COALESCE laissent un statut répété sans effet.
 */
export function statusDateSets(status: TaskStatus): string[] {
  const sets: string[] = [];
  if (status === 'todo') sets.push('started_at = NULL');
  else if (status !== 'cancelled') sets.push('started_at = COALESCE(started_at, now())');
  return [
    ...sets,
    status === 'done' ? 'completed_at = COALESCE(completed_at, now())' : 'completed_at = NULL',
    status === 'cancelled' ? 'cancelled_at = COALESCE(cancelled_at, now())' : 'cancelled_at = NULL',
  ];
}

export const taskRepository = {
  async create(projectId: string, input: CreateTaskInput & { assignee?: TaskPerson | null; reporter?: TaskPerson | null }, actor: Actor): Promise<Task> {
    const status = input.status ?? 'todo';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, description, status, priority, session_id, created_by_type, created_by_session_id, due_date, completed_at,
                            custom_fields, assignee_name, assignee_email, reporter_name, reporter_email, status_tag, tags, auto_start_when_unblocked, auto_start_by_id,
                            started_at, cancelled_at, summary)
         VALUES ($1, $2, $3, $4::task_status, $5, $6, $7, $8, $9, CASE WHEN $4::task_status = 'done' THEN now() ELSE NULL END, $10::jsonb, $11, $12, $13, $14, $15, $16::text[], $17, $18,
                 CASE WHEN $4::task_status IN ('in_progress', 'done') THEN now() ELSE NULL END, CASE WHEN $4::task_status = 'cancelled' THEN now() ELSE NULL END, $19) RETURNING id`,
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
          Boolean(input.autoStartWhenUnblocked),
          input.autoStartWhenUnblocked ? (input.autoStartById ?? null) : null,
          input.summary?.trim() || null,
        ],
      );
      if (input.dependsOn?.length) await setDependencies(client, rows[0].id, input.dependsOn);
      if (input.sessionId) await takeCharge(client, rows[0].id, input.sessionId);
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

  /** Tâches de ces identifiants (chargement groupé par requête GraphQL), sans ordre garanti. */
  async findByIds(ids: string[]): Promise<Task[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<Row>(`${SELECT} WHERE t.id = ANY($1::uuid[])`, [ids]);
    return rows.map(toTask);
  },

  /**
   * Tâche de chaque branche demandée (clé : projet et branche, voir `branchKey` dans graphql/loaders.ts), avec la
   * règle de `taskService.forBranch` : la première non annulée dans l'ordre habituel, sinon la première.
   */
  /** Tâche d'une branche par (projet, branche) : voir pickTaskPerBranch. */
  async findForBranches(keys: { projectId: string; branch: string }[]): Promise<Map<string, Task>> {
    const found = new Map<string, Task>();
    if (!keys.length) return found;
    const { rows } = await pool.query<Row>(`${SELECT} WHERE t.project_id = ANY($1::uuid[]) AND t.branch = ANY($2::text[]) ${ORDER}`, [
      [...new Set(keys.map((k) => k.projectId))],
      [...new Set(keys.map((k) => k.branch))],
    ]);
    return pickTaskPerBranch(rows.map(toTask));
  },

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) where.push(`t.project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`t.project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    if (filter.status?.length) where.push(`t.status = ANY($${params.push(filter.status)}::task_status[])`);
    if (filter.priority) where.push(`t.priority = $${params.push(filter.priority)}`);
    if (filter.sessionId) where.push(`EXISTS (SELECT 1 FROM task_sessions ts WHERE ts.task_id = t.id AND ts.session_id = $${params.push(filter.sessionId)} AND ts.in_charge_since IS NOT NULL)`);
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
    if (filter.stalled) where.push('att.stalled_since IS NOT NULL');
    if (filter.waiting) where.push('att.waiting_since IS NOT NULL');
    if (filter.closedSince) where.push(`(t.status IN ('todo', 'in_progress') OR COALESCE(t.completed_at, t.cancelled_at, t.updated_at) >= $${params.push(filter.closedSince)})`);
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
    if (input.summary !== undefined) sets.push(`summary = $${params.push(input.summary?.trim() || null)}`);
    if (input.description != null) sets.push(`description = $${params.push(input.description)}`);
    if (input.priority != null) sets.push(`priority = $${params.push(input.priority)}`);
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
    if (input.autoStartWhenUnblocked != null) {
      sets.push(`auto_start_when_unblocked = $${params.push(input.autoStartWhenUnblocked)}`);
      sets.push(`auto_start_by_id = $${params.push(input.autoStartWhenUnblocked ? (input.autoStartById ?? null) : null)}`);
    }
    if (input.wakeAt !== undefined) {
      // Une nouvelle date de réveil sera traitée à son tour (woken_at oublié) ; sans date, la note n'a plus d'objet.
      sets.push(`wake_at = $${params.push(input.wakeAt)}`, 'woken_at = NULL');
      if (input.wakeAt === null && input.wakeNote === undefined) sets.push('wake_note = NULL');
    }
    if (input.wakeNote !== undefined) sets.push(`wake_note = $${params.push(input.wakeNote)}`);
    if (input.status != null) {
      sets.push(`status = $${params.push(input.status)}`);
      sets.push(...statusDateSets(input.status));
      // L'attente ne vaut que pour une tâche en cours : elle tombe quand la tâche change de statut.
      if (input.status !== 'in_progress' && input.wakeAt === undefined) sets.push('wake_at = NULL', 'wake_note = NULL', 'woken_at = NULL');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);
      if (rowCount) {
        if (input.dependsOn != null) await setDependencies(client, id, input.dependsOn);
        if (input.sessionId === null) await releaseCharge(client, id, null);
        else if (input.sessionId) await takeCharge(client, id, input.sessionId);
        if (input.releaseSessionIds?.length) await releaseCharge(client, id, input.releaseSessionIds.filter((s) => s !== input.sessionId));
        if (input.sessionId !== undefined || input.releaseSessionIds?.length) await syncPrimarySession(client, id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.findById(id);
  },

  /** Déplace une tâche dans un autre projet : ses sessions en charge et sa branche restent à l'ancien projet, elles sont retirées. */
  async move(id: string, projectId: string): Promise<Task | null> {
    const { rowCount } = await pool.query('UPDATE tasks SET project_id = $2, session_id = NULL, branch = NULL, updated_at = now() WHERE id = $1', [id, projectId]);
    if (rowCount) {
      await releaseCharge(pool, id, null);
      // Les dépendances ne franchissent pas les projets.
      await pool.query('DELETE FROM task_dependencies WHERE task_id = $1 OR depends_on_task_id = $1', [id]);
      // Le fil suit la tâche.
      await conversationRepository.moveTaskConversation(id, projectId);
    }
    return rowCount ? this.findById(id) : null;
  },

  /** Toutes les dépendances entre tâches du projet (arêtes « task dépend de dependsOn »), pour la détection des cycles. */
  async dependencyEdges(projectId: string): Promise<{ taskId: string; dependsOnId: string }[]> {
    const { rows } = await pool.query<{ task_id: string; depends_on_task_id: string }>(
      'SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = $1',
      [projectId],
    );
    return rows.map((r) => ({ taskId: r.task_id, dependsOnId: r.depends_on_task_id }));
  },

  /**
   * Consomme l'option « lancer automatiquement quand débloquée » d'une tâche encore à faire : un seul appelant l'obtient
   * (deux dépendances terminées en même temps ne lancent pas deux sessions). Renvoie la personne qui l'avait armée
   * (`armed` faux : option absente, déjà consommée ou tâche plus à faire).
   */
  async consumeAutoStart(id: string): Promise<{ armed: boolean; byId: string | null }> {
    const { rows } = await pool.query<{ auto_start_by_id: string | null }>(
      `UPDATE tasks SET auto_start_when_unblocked = false, updated_at = now() WHERE id = $1 AND auto_start_when_unblocked AND status = 'todo' RETURNING auto_start_by_id`,
      [id],
    );
    return rows[0] ? { armed: true, byId: rows[0].auto_start_by_id } : { armed: false, byId: null };
  },

  /**
   * Réveils échus (tâches en cours dont la date de réveil est passée et pas encore traitée) : marqués traités d'un
   * coup, pour qu'un seul appelant réveille chaque tâche (bleu/vert, tours qui se chevauchent).
   */
  async claimDueWakes(limit = 20): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE tasks SET woken_at = now() WHERE id IN (
         SELECT id FROM tasks WHERE status = 'in_progress' AND wake_at IS NOT NULL AND wake_at <= now() AND (woken_at IS NULL OR woken_at < wake_at)
          ORDER BY wake_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [limit],
    );
    return rows.map((r) => r.id);
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
  // Les fichiers de la tâche elle-même sont dans `task_attachments` (comment_id null) ; ceux des messages de son fil
  // dans `message_attachments` (conversation de la tâche). Les deux restent sur le disque sous la tâche
  // (tasks/attachments.ts). Les lignes de `task_attachments` qui ont un comment_id sont des copies d'avant la
  // migration 20261103T1222, ignorées.

  /** Pièces jointes d'une tâche : les siennes (`commentId` null), celles d'un commentaire, ou toutes (`commentId` absent), les plus anciennes d'abord. */
  async listAttachments(taskId: string, commentId?: string | null): Promise<TaskAttachment[]> {
    const own = async () => (await pool.query<AttachmentRow>('SELECT * FROM task_attachments WHERE task_id = $1 AND comment_id IS NULL ORDER BY created_at ASC, id ASC', [taskId])).rows.map(toAttachment);
    const ofComments = async (messageId: string | null) => {
      const { rows } = await pool.query<{ id: string; conversation_id: string; message_id: string; name: string; media_type: string; size: number | string; created_at: Date }>(
        `SELECT a.* FROM message_attachments a JOIN conversations c ON c.id = a.conversation_id WHERE c.task_id = $1${messageId ? ' AND a.message_id = $2' : ''} ORDER BY a.created_at ASC, a.id ASC`,
        messageId ? [taskId, messageId] : [taskId],
      );
      return rows.map((r) => commentAttachmentOf({ id: r.id, conversationId: r.conversation_id, messageId: r.message_id, name: r.name, mediaType: r.media_type, size: Number(r.size), createdAt: r.created_at }, taskId));
    };
    if (commentId === null) return own();
    if (commentId) return ofComments(commentId);
    const all = [...(await own()), ...(await ofComments(null))];
    return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  },

  async findAttachment(id: string): Promise<TaskAttachment | null> {
    const { rows } = await pool.query<AttachmentRow>('SELECT * FROM task_attachments WHERE id = $1 AND comment_id IS NULL', [id]);
    if (rows[0]) return toAttachment(rows[0]);
    const a = await conversationRepository.findAttachment(id);
    const c = a ? await conversationRepository.findById(a.conversationId) : null;
    return a && c?.taskId ? commentAttachmentOf(a, c.taskId) : null;
  },

  async createAttachment(input: Omit<TaskAttachment, 'createdAt'>): Promise<TaskAttachment> {
    await pool.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [input.taskId]);
    if (input.commentId) {
      const c = await conversationRepository.ensureForTask(input.taskId);
      if (!c) throw new Error(`Tâche ${input.taskId} introuvable`);
      const a = await conversationRepository.createAttachment({ id: input.id, conversationId: c.id, messageId: input.commentId, name: input.name, mediaType: input.mediaType, size: input.size });
      return commentAttachmentOf(a, input.taskId);
    }
    const { rows } = await pool.query<AttachmentRow>('INSERT INTO task_attachments (id, task_id, comment_id, name, media_type, size) VALUES ($1, $2, NULL, $3, $4, $5) RETURNING *', [
      input.id,
      input.taskId,
      input.name,
      input.mediaType,
      input.size,
    ]);
    return toAttachment(rows[0]);
  },

  async deleteAttachment(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM task_attachments WHERE id = $1 AND comment_id IS NULL', [id]);
    return (rowCount ?? 0) > 0 || conversationRepository.deleteAttachment(id);
  },

  // ---- Commentaires : messages de la conversation de la tâche ------------------------------------

  async listComments(taskId: string): Promise<TaskComment[]> {
    const c = await conversationRepository.findByTask(taskId);
    return c ? (await conversationRepository.listAllMessages(c.id)).map((m) => commentOf(m, taskId)) : [];
  },

  async findComment(id: string): Promise<TaskComment | null> {
    const m = await conversationRepository.findMessage(id);
    const c = m ? await conversationRepository.findById(m.conversationId) : null;
    return m && c?.taskId ? commentOf(m, c.taskId) : null;
  },

  async addComment(
    taskId: string,
    body: string,
    author: { type: Actor['type']; userId?: string | null; sessionId?: string | null; name: string },
    opts: { parentId?: string | null; mentions?: TaskMention[] } = {},
  ): Promise<TaskComment> {
    const c = await conversationRepository.ensureForTask(taskId);
    if (!c) throw new Error(`Tâche ${taskId} introuvable`);
    const m = await conversationRepository.addMessage(c.id, body, author, opts);
    await pool.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [taskId]);
    return commentOf(m, taskId);
  },

  async updateComment(id: string, body: string, mentions?: TaskMention[]): Promise<TaskComment | null> {
    const current = await this.findComment(id);
    if (!current) return null;
    const m = await conversationRepository.updateMessage(id, body, mentions);
    return m ? commentOf(m, current.taskId) : null;
  },

  async deleteComment(id: string): Promise<boolean> {
    return (await this.findComment(id)) ? conversationRepository.deleteMessage(id) : false;
  },

  /** Relie une session à la tâche (historique task_sessions ; sans effet si elle l'est déjà). */
  linkSession: (taskId: string, sessionId: string) => linkSession(pool, taskId, sessionId),

  // ---- Réactions : celles de la conversation de la tâche -----------------------------------------

  /** Toutes les réactions d'une tâche (sur ses messages et sur elle-même), les plus anciennes d'abord. */
  async listReactions(taskId: string): Promise<TaskReaction[]> {
    const c = await conversationRepository.findByTask(taskId);
    return c ? (await conversationRepository.listConversationReactions(c.id)).map((r) => reactionOf(r, taskId)) : [];
  },

  /**
   * Pose la réaction si l'acteur ne l'a pas encore, la retire sinon. Renvoie la réaction (posée ou retirée) et
   * ce qui s'est passé.
   */
  async toggleReaction(taskId: string, commentId: string | null, emoji: string, actor: { type: Actor['type']; userId?: string | null; sessionId?: string | null; name: string }): Promise<{ reaction: TaskReaction; added: boolean }> {
    const c = await conversationRepository.ensureForTask(taskId);
    if (!c) throw new Error(`Tâche ${taskId} introuvable`);
    const { reaction, added } = await conversationRepository.toggleReaction({ conversationId: c.id, messageId: commentId }, emoji, actor);
    return { reaction: reactionOf(reaction, taskId), added };
  },

  // ---- Mentions --------------------------------------------------------------------------------

  /** Membres du projet (nom, e-mail) et sessions d'agent non archivées du projet : ce que l'on peut mentionner. */
  async mentionCandidates(projectId: string): Promise<{ users: { id: string; name: string; email: string; kind: string }[]; sessions: { id: string; name: string; status: string }[] }> {
    const [users, sessions] = await Promise.all([
      pool.query<{ id: string; name: string; email: string; kind: string }>('SELECT u.id, u.name, u.email, u.kind FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY (u.kind = \'agent\') DESC, u.name ASC', [projectId]),
      pool.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM sessions WHERE project_id = $1 AND archived_at IS NULL AND kind = 'session' ORDER BY (status = 'running') DESC, created_at DESC LIMIT 200`,
        [projectId],
      ),
    ]);
    return { users: users.rows, sessions: sessions.rows };
  },
};

/**
 * Une tâche par (projet, branche) quand plusieurs portent la même branche : une tâche non annulée plutôt
 * qu'une annulée, puis la plus récente. Un nom de branche se réutilise une fois l'ancienne branche fusionnée
 * et supprimée (dossier de travail nommé d'après le même lien collé, par exemple) : la tâche d'avant, déjà
 * livrée, ne doit pas masquer celle du travail en cours (PR #253 affichée « livrée » à cause de la #150).
 */
export function pickTaskPerBranch(tasks: Task[]): Map<string, Task> {
  const found = new Map<string, Task>();
  for (const task of tasks) {
    if (!task.branch) continue;
    const key = `${task.projectId}\u0000${task.branch}`;
    const current = found.get(key);
    const better =
      !current ||
      (current.status === 'cancelled' && task.status !== 'cancelled') ||
      ((current.status === 'cancelled') === (task.status === 'cancelled') && new Date(task.createdAt).getTime() > new Date(current.createdAt).getTime());
    if (better) found.set(key, task);
  }
  return found;
}
