import { pool } from '../db/pool.js';
import { projectPageService } from '../cockpit/projectPages.js';
import { toJson } from '../db/json.js';
import { contextRepository } from '../context/repository.js';
import { contextService } from '../context/service.js';
import { materializeSkills } from '../context/skills.js';
import { envFileService } from '../envFiles/service.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { permissionRuleService } from '../permissions/service.js';
import { slugify } from '../projects/slug.js';
import { projectService } from '../projects/service.js';
import { projectPermissionModes } from '../projects/types.js';
import { normalizeTaskStatuses, type TaskStatusInput } from '../tasks/statuses.js';
import { vaultRepository } from '../vault/repository.js';
import { buildProjectArchive, parseProjectArchive, sanitizeSettings, stripCredentials, type ExportedInstruction, type ExportedTask, type ProjectExport } from './projectArchive.js';

/** Taille maximale d'une archive importée (compressée). */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const iso =(d: Date | string | null): string | null => (d == null ? null : new Date(d).toISOString());

/** Ce que l'import doit reprendre de l'archive. */
export interface ImportOptions {
  context: boolean;
  tasks: boolean;
  settings: boolean;
}

export interface ImportReport {
  foldersCreated: number;
  instructionsCreated: number;
  /** Chemins des instructions déjà présentes dans le projet, laissées telles quelles. */
  instructionsSkipped: string[];
  tasksCreated: number;
  commentsCreated: number;
  settingsUpdated: boolean;
  /** Connexions listées dans l'archive (jamais recréées : leurs secrets n'y sont pas). */
  connections: string[];
}

/** Toutes les données d'un projet à exporter (bibliothèque du projet seulement : pas celles de ses agents). */
/** Agencements partagés du projet, par portée relative, sans les blocs artefacts (identifiants propres à ce serveur). */
async function exportLayouts(projectId: string): Promise<{ scope: string; layout: unknown }[]> {
  const { rows } = await pool.query<{ scope: string; layout: { v: number; blocks: { kind: string }[] } }>('SELECT scope, layout FROM cockpit_layouts WHERE project_id = $1 AND user_id IS NULL AND layout IS NOT NULL', [projectId]);
  return rows.map((r) => ({ scope: r.scope.replace(`project:${projectId}`, 'project').replace(/^project:tasks$/, 'tasks').replace(/^project:page:/, 'page:'), layout: { ...r.layout, blocks: r.layout.blocks.filter((b) => b.kind !== 'artifact') } }));
}

export async function collectProjectExport(projectId: string, now = new Date()): Promise<ProjectExport> {
  const project = await projectService.get(projectId);
  const [tree, versionRows, taskRows, commentRows, attachmentRows, rules, envFiles, items] = await Promise.all([
    contextService.tree(projectId, null),
    pool.query<{ instruction_id: string; version: number; name: string; description: string; content: string; change_note: string | null; author_type: 'human' | 'agent'; created_at: Date }>(
      `SELECT v.instruction_id, v.version, v.name, v.description, v.content, v.change_note, v.author_type, v.created_at
       FROM context_instruction_versions v JOIN context_instructions i ON i.id = v.instruction_id
       WHERE i.project_id = $1 AND i.agent_id IS NULL ORDER BY v.instruction_id, v.version`,
      [projectId],
    ),
    pool.query<{
      id: string; title: string; summary: string | null; description: string; status: ExportedTask['status']; state: string | null; status_tag: string | null; priority: ExportedTask['priority']; tags: string[] | null;
      due_date: string | null; custom_fields: ExportedTask['customFields'] | null; assignee_name: string | null; assignee_email: string | null; reporter_name: string | null;
      reporter_email: string | null; branch: string | null; created_by_type: 'human' | 'agent'; created_at: Date; updated_at: Date; completed_at: Date | null;
      started_at: Date | null; cancelled_at: Date | null;
    }>(`SELECT t.*, to_char(t.due_date, 'YYYY-MM-DD') AS due_date FROM tasks t WHERE t.project_id = $1 ORDER BY t.created_at, t.id`, [projectId]),
    pool.query<{ id: string; task_id: string; parent_id: string | null; author_type: 'human' | 'agent'; author_name: string; body: string; created_at: Date; updated_at: Date }>(
      `SELECT m.*, cv.task_id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN tasks t ON t.id = cv.task_id WHERE t.project_id = $1 ORDER BY m.created_at, m.id`,
      [projectId],
    ),
    pool.query<{ task_id: string; name: string; media_type: string; size: string | number }>(
      `SELECT task_id, name, media_type, size FROM (
         SELECT a.task_id, a.name, a.media_type, a.size, a.created_at FROM task_attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = $1 AND a.comment_id IS NULL
         UNION ALL
         SELECT cv.task_id, a.name, a.media_type, a.size, a.created_at FROM message_attachments a JOIN conversations cv ON cv.id = a.conversation_id JOIN tasks t ON t.id = cv.task_id WHERE t.project_id = $1
       ) x ORDER BY created_at`,
      [projectId],
    ),
    permissionRuleService.list(projectId),
    envFileService.list(projectId),
    vaultRepository.listOwnedByProject(projectId),
  ]);

  const versions = new Map<string, ExportedInstruction['versions']>();
  for (const v of versionRows.rows) {
    const list = versions.get(v.instruction_id) ?? [];
    list.push({ version: v.version, name: v.name, description: v.description, content: v.content, changeNote: v.change_note, authorType: v.author_type, createdAt: iso(v.created_at)! });
    versions.set(v.instruction_id, list);
  }
  const comments = new Map<string, ExportedTask['comments']>();
  for (const c of commentRows.rows) {
    const list = comments.get(c.task_id) ?? [];
    list.push({ ref: c.id, parentRef: c.parent_id, authorType: c.author_type, authorName: c.author_name, body: c.body, createdAt: iso(c.created_at)!, updatedAt: iso(c.updated_at)! });
    comments.set(c.task_id, list);
  }
  const attachments = new Map<string, ExportedTask['attachments']>();
  for (const a of attachmentRows.rows) attachments.set(a.task_id, [...(attachments.get(a.task_id) ?? []), { name: a.name, mediaType: a.media_type, size: Number(a.size) }]);
  const person = (name: string | null, email: string | null) => (name || email ? { name, email } : null);
  const itemNames = new Map(items.map((i) => [i.id, i.name]));

  return {
    exportedAt: now.toISOString(),
    project: {
      name: project.name,
      slug: project.slug,
      description: project.description,
      systemPrompt: project.systemPrompt,
      gitUrl: project.gitHosted || !project.gitUrl ? null : stripCredentials(project.gitUrl),
      gitBranch: project.gitBranch,
      gitHosted: project.gitHosted,
      runnerConfig: project.runnerConfig,
      defaultPermissionMode: project.defaultPermissionMode,
      taskInstructions: project.taskInstructions,
      taskStatuses: project.taskStatusesCustomized ? project.taskStatuses : null,
      permissionRules: rules.map((r) => ({ toolName: r.toolName, ruleContent: r.ruleContent })),
      tabs: await projectPageService.tabs(projectId),
      pages: (await projectPageService.list(projectId)).map((pg) => ({ slug: pg.slug, title: pg.title, icon: pg.icon, position: pg.position })),
      layouts: await exportLayouts(projectId),
      envFiles: envFiles.map((f) => ({
        path: f.path,
        applyOnCreate: f.applyOnCreate,
        keys: envFileService.keys(f).map((k) => ({ key: k.key, vaultRefs: k.refs.map((r) => r.raw) })),
      })),
    },
    context: {
      folders: tree.folders.map((f) => ({ path: f.path, name: f.name })),
      instructions: tree.instructions.map((i) => ({
        path: i.path,
        name: i.name,
        description: i.description,
        content: i.content,
        version: i.version,
        createdAt: iso(i.createdAt)!,
        updatedAt: iso(i.updatedAt)!,
        versions: versions.get(i.id) ?? [],
      })),
    },
    tasks: taskRows.rows.map((t) => ({
      ref: t.id,
      title: t.title,
      summary: t.summary,
      description: t.description,
      status: t.status,
      state: t.state,
      statusTag: t.status_tag,
      priority: t.priority,
      tags: t.tags ?? [],
      dueDate: t.due_date,
      customFields: t.custom_fields ?? [],
      assignee: person(t.assignee_name, t.assignee_email),
      reporter: person(t.reporter_name, t.reporter_email),
      branch: t.branch,
      createdByType: t.created_by_type,
      createdAt: iso(t.created_at)!,
      updatedAt: iso(t.updated_at)!,
      completedAt: iso(t.completed_at),
      startedAt: iso(t.started_at),
      cancelledAt: iso(t.cancelled_at),
      comments: comments.get(t.id) ?? [],
      attachments: attachments.get(t.id) ?? [],
    })),
    connections: items.map((i) => ({
      name: i.name,
      kind: i.kind,
      description: i.description,
      settings: sanitizeSettings(i.settings as unknown as Record<string, unknown>, itemNames),
      readOnly: i.readOnly,
      requireApproval: i.requireApproval,
      envExport: i.envExport,
      commandAllowlist: i.commandAllowlist,
      publicKey: i.publicKey,
    })),
  };
}

export async function exportProjectArchive(projectId: string): Promise<{ filename: string; archive: Buffer }> {
  const data = await collectProjectExport(projectId);
  return { filename: `${data.project.slug || 'projet'}-${data.exportedAt.slice(0, 10)}.tar.gz`, archive: buildProjectArchive(data) };
}

/** Segments de chemin acceptés à l'import : des slugs, comme ceux que Skipper produit. */
function pathSegments(path: unknown): string[] | null {
  if (typeof path !== 'string') return null;
  const parts = path.split('/');
  return parts.length && parts.every((p) => p && slugify(p) === p) ? parts : null;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const TASK_STATUSES = new Set(['todo', 'in_progress', 'done', 'cancelled']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

/**
 * Importe une archive dans un projet existant (en général un projet tout juste créé). Le contexte reproduit la même
 * arborescence, avec l'historique des versions de chaque instruction ; une instruction déjà présente au même chemin
 * est laissée telle quelle. Les tâches sont ajoutées (avec leur fil), sans session ni pièce jointe, et sans prévenir
 * ni déclencher d'agent. Les réglages remplacent ceux du projet. Les connexions ne sont jamais recréées.
 * Le tout dans une transaction : une archive invalide ne laisse rien à moitié importé.
 */
export async function importProjectArchive(projectId: string, archive: Buffer, options: ImportOptions): Promise<ImportReport> {
  const project = await projectService.get(projectId);
  const parsed = parseProjectArchive(archive);
  const report: ImportReport = { foldersCreated: 0, instructionsCreated: 0, instructionsSkipped: [], tasksCreated: 0, commentsCreated: 0, settingsUpdated: false, connections: (parsed.connections ?? []).map((c) => str(c.name)).filter(Boolean) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (options.context && parsed.context) {
      const existing = await contextService.tree(projectId, null);
      const folderIds = new Map(existing.folders.map((f) => [f.path, f.id]));
      const instructionPaths = new Set(existing.instructions.map((i) => i.path));
      const names = new Map(parsed.context.folders.map((f) => [str(f.path), str(f.name)]));
      // Crée un dossier et ses parents manquants ; nom d'origine (accents, majuscules), slug tel quel.
      const ensureFolder = async (parts: string[]): Promise<string | null> => {
        if (!parts.length) return null;
        const path = parts.join('/');
        const known = folderIds.get(path);
        if (known) return known;
        const parentId = await ensureFolder(parts.slice(0, -1));
        const slug = parts[parts.length - 1];
        const name = names.get(path)?.trim() || slug;
        const record = await contextRepository.createFolder(projectId, null, parentId, name, slug, client);
        await contextRepository.addChange({ projectId, agentId: null }, 'folder.create', path, { imported: true }, { type: 'human' }, client);
        folderIds.set(path, record.id);
        report.foldersCreated++;
        return record.id;
      };
      for (const folder of parsed.context.folders) {
        const parts = pathSegments(folder.path);
        if (!parts) throw new AppError(`Archive invalide : chemin de dossier « ${String(folder.path)} »`);
        await ensureFolder(parts);
      }
      for (const instruction of parsed.context.instructions) {
        const parts = pathSegments(instruction.path);
        if (!parts) throw new AppError(`Archive invalide : chemin d'instruction « ${String(instruction.path)} »`);
        const path = parts.join('/');
        if (instructionPaths.has(path) || folderIds.has(path)) {
          report.instructionsSkipped.push(path);
          continue;
        }
        const folderId = await ensureFolder(parts.slice(0, -1));
        const history = (Array.isArray(instruction.versions) ? instruction.versions : [])
          .filter((v) => Number.isInteger(v.version) && v.version > 0)
          .sort((a, b) => a.version - b.version);
        const version = history.length ? history[history.length - 1].version : 1;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO context_instructions (project_id, agent_id, folder_id, name, slug, description, content, version, created_at, updated_at)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), COALESCE($9, now())) RETURNING id`,
          [projectId, folderId, str(instruction.name).trim() || parts[parts.length - 1], parts[parts.length - 1], str(instruction.description), str(instruction.content), version, date(instruction.createdAt), date(instruction.updatedAt)],
        );
        const id = rows[0].id;
        const versions = history.length
          ? history
          : [{ version: 1, name: str(instruction.name), description: str(instruction.description), content: str(instruction.content), changeNote: 'Import', authorType: 'human' as const, createdAt: str(instruction.createdAt) }];
        for (const v of versions) {
          await client.query(
            `INSERT INTO context_instruction_versions (instruction_id, version, name, description, content, change_note, author_type, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))`,
            [id, v.version, str(v.name) || str(instruction.name), str(v.description), str(v.content), typeof v.changeNote === 'string' ? v.changeNote : null, v.authorType === 'agent' ? 'agent' : 'human', date(v.createdAt)],
          );
        }
        await contextRepository.addChange({ projectId, agentId: null }, 'instruction.create', path, { version, imported: true }, { type: 'human' }, client);
        instructionPaths.add(path);
        report.instructionsCreated++;
      }
    }

    if (options.tasks && parsed.tasks) {
      for (const t of parsed.tasks) {
        const title = str(t.title).trim();
        if (!title) continue;
        const status = TASK_STATUSES.has(t.status) ? t.status : 'todo';
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tasks (project_id, title, description, status, priority, created_by_type, due_date, completed_at, custom_fields, assignee_name, assignee_email,
                              reporter_name, reporter_email, status_tag, tags, branch, created_at, updated_at,
                              started_at, cancelled_at, summary, state)
           VALUES ($1, $2, $3, $4::task_status, $5::task_priority, $6, $7::date, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::text[], $16, COALESCE($17, now()), COALESCE($18, now()),
                   $19, $20, $21, $22) RETURNING id`,
          [
            projectId,
            title,
            str(t.description),
            status,
            TASK_PRIORITIES.has(t.priority) ? t.priority : 'medium',
            t.createdByType === 'agent' ? 'agent' : 'human',
            typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : null,
            status === 'done' ? (date(t.completedAt) ?? new Date()) : null,
            toJson(Array.isArray(t.customFields) ? t.customFields.filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string') : []),
            t.assignee?.name ?? null,
            t.assignee?.email?.toLowerCase() ?? null,
            t.reporter?.name ?? null,
            t.reporter?.email?.toLowerCase() ?? null,
            typeof t.statusTag === 'string' && t.statusTag ? t.statusTag : null,
            Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string') : [],
            typeof t.branch === 'string' && t.branch ? t.branch : null,
            date(t.createdAt),
            date(t.updatedAt),
            status === 'in_progress' || status === 'done' || status === 'cancelled' ? (date(t.startedAt) ?? (status === 'cancelled' ? null : (date(t.createdAt) ?? new Date()))) : null,
            status === 'cancelled' ? (date(t.cancelledAt) ?? date(t.updatedAt) ?? new Date()) : null,
            typeof t.summary === 'string' && t.summary.trim() ? t.summary.trim() : null,
            // Statut d'un autre projet : gardé s'il existe ici dans la même catégorie (sinon, statut par défaut ; voir resetStaleTaskStates).
            typeof t.state === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(t.state) ? t.state : null,
          ],
        );
        report.tasksCreated++;
        // Les réponses suivent leur message : les identifiants d'origine sont remplacés au fil de l'insertion.
        const ids = new Map<string, string>();
        const comments = (Array.isArray(t.comments) ? t.comments : []).filter((c) => c && typeof c.body === 'string');
        for (const c of [...comments.filter((c) => !c.parentRef), ...comments.filter((c) => c.parentRef)]) {
          const parentId = c.parentRef ? ids.get(c.parentRef) : null;
          if (c.parentRef && !parentId) continue;
          // Le fil d'une tâche est sa conversation (créée au premier message).
          const { rows: inserted } = await client.query<{ id: string }>(
            `INSERT INTO messages (conversation_id, parent_id, author_type, author_name, body, created_at, updated_at)
             VALUES (task_conversation_id($1), $2, $3, $4, $5, COALESCE($6, now()), COALESCE($7, now())) RETURNING id`,
            [rows[0].id, parentId, c.authorType === 'agent' ? 'agent' : 'human', str(c.authorName, 'Inconnu'), c.body, date(c.createdAt), date(c.updatedAt)],
          );
          if (typeof c.ref === 'string') ids.set(c.ref, inserted[0].id);
          report.commentsCreated++;
        }
        if (comments.length) {
          await client.query('UPDATE conversations c SET last_message_at = (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id) WHERE c.task_id = $1', [rows[0].id]);
        }
      }
    }

    if (options.settings && parsed.project) {
      const p = parsed.project;
      const mode = (projectPermissionModes as readonly string[]).includes(p.defaultPermissionMode) ? p.defaultPermissionMode : project.defaultPermissionMode;
      await client.query(`UPDATE projects SET system_prompt = $2, task_instructions = $3, default_permission_mode = $4, description = COALESCE(NULLIF($5, ''), description), updated_at = now() WHERE id = $1`, [
        projectId,
        str(p.systemPrompt, project.systemPrompt),
        str(p.taskInstructions, project.taskInstructions),
        mode,
        str(p.description),
      ]);
      if (Array.isArray(p.taskStatuses) && p.taskStatuses.length) {
        try {
          const statuses = normalizeTaskStatuses(p.taskStatuses as TaskStatusInput[]);
          await client.query('UPDATE projects SET task_statuses = $2::jsonb WHERE id = $1', [projectId, toJson(statuses)]);
        } catch (err) {
          log.warn(`[exports] statuts des tâches de l'archive ignorés : ${(err as Error).message}`);
        }
      }
      for (const rule of Array.isArray(p.permissionRules) ? p.permissionRules : []) {
        if (typeof rule?.toolName !== 'string' || !rule.toolName) continue;
        await client.query(
          'INSERT INTO project_permission_rules (project_id, tool_name, rule_content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [projectId, rule.toolName, typeof rule.ruleContent === 'string' ? rule.ruleContent : null],
        );
      }
      // Cockpit : onglets, pages personnalisées et agencements partagés (sans écraser une page ou un agencement déjà réglé ici).
      if (Array.isArray(p.pages)) {
        for (const pg of p.pages) {
          if (!pg || typeof pg.slug !== 'string' || typeof pg.title !== 'string') continue;
          await client.query('INSERT INTO project_pages (project_id, slug, title, icon, position) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, slug) DO NOTHING', [projectId, pg.slug, pg.title, typeof pg.icon === 'string' ? pg.icon : null, Number(pg.position) || 0]);
        }
      }
      if (p.tabs && typeof p.tabs === 'object') await client.query('UPDATE projects SET tabs = $2::jsonb WHERE id = $1', [projectId, JSON.stringify({ hidden: Array.isArray(p.tabs.hidden) ? p.tabs.hidden : [], order: Array.isArray(p.tabs.order) ? p.tabs.order : [] })]);
      if (Array.isArray(p.layouts)) {
        for (const l of p.layouts) {
          if (!l || typeof l.scope !== 'string' || !l.layout) continue;
          const scope = l.scope === 'project' ? `project:${projectId}` : l.scope === 'tasks' ? `project:${projectId}:tasks` : l.scope.startsWith('page:') ? `project:${projectId}:page:${l.scope.slice(5)}` : null;
          if (!scope) continue;
          const exists = await client.query('SELECT 1 FROM cockpit_layouts WHERE scope = $1 AND user_id IS NULL', [scope]);
          if (exists.rowCount) continue;
          const inserted = await client.query<{ id: string }>('INSERT INTO cockpit_layouts (scope, project_id, layout, version) VALUES ($1, $2, $3::jsonb, 1) RETURNING id', [scope, projectId, JSON.stringify(l.layout)]);
          await client.query('INSERT INTO cockpit_layout_versions (layout_id, version, layout, note) VALUES ($1, 1, $2::jsonb, $3)', [inserted.rows[0].id, JSON.stringify(l.layout), 'Import d’une archive']);
        }
      }
      report.settingsUpdated = true;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if ((err as { code?: string }).code === '23505') throw new AppError("Import impossible : un dossier ou une instruction de l'archive entre en conflit avec le contexte du projet");
    throw err;
  } finally {
    client.release();
  }
  if (report.foldersCreated || report.instructionsCreated) {
    void materializeSkills(await projectService.get(projectId)).catch((err) => log.error('[exports] génération des skills', err));
  }
  return report;
}
