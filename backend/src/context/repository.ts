import { pool, type Queryable } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Actor, ContextChange, ContextChangeKind, ContextFolder, ContextInstruction, ContextInstructionVersion } from './types.js';

interface FolderRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}
interface InstructionRow {
  id: string;
  project_id: string;
  folder_id: string | null;
  name: string;
  slug: string;
  description: string;
  content: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface VersionRow {
  id: string;
  instruction_id: string;
  version: number;
  name: string;
  description: string;
  content: string;
  change_note: string | null;
  author_type: 'human' | 'agent';
  author_session_id: string | null;
  created_at: Date;
}
interface ChangeRow {
  id: string;
  project_id: string;
  kind: ContextChangeKind;
  path: string;
  details: Record<string, unknown>;
  author_type: 'human' | 'agent';
  author_session_id: string | null;
  created_at: Date;
}

/** Lignes brutes, sans chemin : le service calcule `path` à partir de l'arborescence. */
export type FolderRecord = Omit<ContextFolder, 'path'>;
export type InstructionRecord = Omit<ContextInstruction, 'path'>;

const toFolder = (r: FolderRow): FolderRecord => ({
  id: r.id,
  projectId: r.project_id,
  parentId: r.parent_id,
  name: r.name,
  slug: r.slug,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toInstruction = (r: InstructionRow): InstructionRecord => ({
  id: r.id,
  projectId: r.project_id,
  folderId: r.folder_id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  content: r.content,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toVersion = (r: VersionRow): ContextInstructionVersion => ({
  id: String(r.id),
  instructionId: r.instruction_id,
  version: r.version,
  name: r.name,
  description: r.description,
  content: r.content,
  changeNote: r.change_note,
  authorType: r.author_type,
  authorSessionId: r.author_session_id,
  createdAt: r.created_at,
});
const toChange = (r: ChangeRow): ContextChange => ({
  id: String(r.id),
  projectId: r.project_id,
  kind: r.kind,
  path: r.path,
  details: r.details ?? {},
  authorType: r.author_type,
  authorSessionId: r.author_session_id,
  createdAt: r.created_at,
});

export const contextRepository = {
  // --- Dossiers ---
  async listFolders(projectId: string, db: Queryable = pool): Promise<FolderRecord[]> {
    const { rows } = await db.query<FolderRow>('SELECT * FROM context_folders WHERE project_id = $1 ORDER BY name', [projectId]);
    return rows.map(toFolder);
  },
  async findFolder(id: string, db: Queryable = pool): Promise<FolderRecord | null> {
    const { rows } = await db.query<FolderRow>('SELECT * FROM context_folders WHERE id = $1', [id]);
    return rows[0] ? toFolder(rows[0]) : null;
  },
  async createFolder(projectId: string, parentId: string | null, name: string, slug: string, db: Queryable = pool): Promise<FolderRecord> {
    const { rows } = await db.query<FolderRow>(
      'INSERT INTO context_folders (project_id, parent_id, name, slug) VALUES ($1, $2, $3, $4) RETURNING *',
      [projectId, parentId, name, slug],
    );
    return toFolder(rows[0]);
  },
  async updateFolder(id: string, patch: { name?: string; slug?: string; parentId?: string | null }, db: Queryable = pool): Promise<FolderRecord | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (patch.name !== undefined) sets.push(`name = $${params.push(patch.name)}`);
    if (patch.slug !== undefined) sets.push(`slug = $${params.push(patch.slug)}`);
    if (patch.parentId !== undefined) sets.push(`parent_id = $${params.push(patch.parentId)}`);
    const { rows } = await db.query<FolderRow>(`UPDATE context_folders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toFolder(rows[0]) : null;
  },
  async deleteFolder(id: string, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM context_folders WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // --- Instructions ---
  async listInstructions(projectId: string, db: Queryable = pool): Promise<InstructionRecord[]> {
    const { rows } = await db.query<InstructionRow>('SELECT * FROM context_instructions WHERE project_id = $1 ORDER BY name', [projectId]);
    return rows.map(toInstruction);
  },
  async findInstruction(id: string, db: Queryable = pool): Promise<InstructionRecord | null> {
    const { rows } = await db.query<InstructionRow>('SELECT * FROM context_instructions WHERE id = $1', [id]);
    return rows[0] ? toInstruction(rows[0]) : null;
  },
  async searchInstructions(projectId: string, query: string, db: Queryable = pool): Promise<InstructionRecord[]> {
    const { rows } = await db.query<InstructionRow>(
      `SELECT * FROM context_instructions
       WHERE project_id = $1 AND (name ILIKE $2 OR description ILIKE $2 OR content ILIKE $2)
       ORDER BY name LIMIT 50`,
      [projectId, `%${query}%`],
    );
    return rows.map(toInstruction);
  },
  async createInstruction(
    input: { projectId: string; folderId: string | null; name: string; slug: string; description: string; content: string },
    db: Queryable = pool,
  ): Promise<InstructionRecord> {
    const { rows } = await db.query<InstructionRow>(
      `INSERT INTO context_instructions (project_id, folder_id, name, slug, description, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [input.projectId, input.folderId, input.name, input.slug, input.description, input.content],
    );
    return toInstruction(rows[0]);
  },
  async updateInstruction(
    id: string,
    patch: { name?: string; slug?: string; description?: string; content?: string; folderId?: string | null; version?: number },
    db: Queryable = pool,
  ): Promise<InstructionRecord | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (patch.name !== undefined) sets.push(`name = $${params.push(patch.name)}`);
    if (patch.slug !== undefined) sets.push(`slug = $${params.push(patch.slug)}`);
    if (patch.description !== undefined) sets.push(`description = $${params.push(patch.description)}`);
    if (patch.content !== undefined) sets.push(`content = $${params.push(patch.content)}`);
    if (patch.folderId !== undefined) sets.push(`folder_id = $${params.push(patch.folderId)}`);
    if (patch.version !== undefined) sets.push(`version = $${params.push(patch.version)}`);
    const { rows } = await db.query<InstructionRow>(`UPDATE context_instructions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toInstruction(rows[0]) : null;
  },
  async deleteInstruction(id: string, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM context_instructions WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // --- Versions ---
  async addVersion(instruction: InstructionRecord, changeNote: string | null, actor: Actor, db: Queryable = pool): Promise<ContextInstructionVersion> {
    const { rows } = await db.query<VersionRow>(
      `INSERT INTO context_instruction_versions (instruction_id, version, name, description, content, change_note, author_type, author_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [instruction.id, instruction.version, instruction.name, instruction.description, instruction.content, changeNote, actor.type, actor.sessionId ?? null],
    );
    return toVersion(rows[0]);
  },
  async listVersions(instructionId: string, db: Queryable = pool): Promise<ContextInstructionVersion[]> {
    const { rows } = await db.query<VersionRow>('SELECT * FROM context_instruction_versions WHERE instruction_id = $1 ORDER BY version DESC', [instructionId]);
    return rows.map(toVersion);
  },
  async findVersion(instructionId: string, version: number, db: Queryable = pool): Promise<ContextInstructionVersion | null> {
    const { rows } = await db.query<VersionRow>('SELECT * FROM context_instruction_versions WHERE instruction_id = $1 AND version = $2', [instructionId, version]);
    return rows[0] ? toVersion(rows[0]) : null;
  },

  // --- Journal ---
  async addChange(projectId: string, kind: ContextChangeKind, path: string, details: Record<string, unknown>, actor: Actor, db: Queryable = pool): Promise<ContextChange> {
    const { rows } = await db.query<ChangeRow>(
      `INSERT INTO context_changes (project_id, kind, path, details, author_type, author_session_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [projectId, kind, path, toJson(details), actor.type, actor.sessionId ?? null],
    );
    return toChange(rows[0]);
  },
  async listChanges(projectId: string, limit = 100, db: Queryable = pool): Promise<ContextChange[]> {
    const { rows } = await db.query<ChangeRow>('SELECT * FROM context_changes WHERE project_id = $1 ORDER BY id DESC LIMIT $2', [projectId, Math.min(limit, 500)]);
    return rows.map(toChange);
  },
};
