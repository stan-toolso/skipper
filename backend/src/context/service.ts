import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { slugify } from '../projects/service.js';
import { contextRepository, type FolderRecord, type InstructionRecord } from './repository.js';
import { materializeSkills } from './skills.js';
import type { Actor, ContextChange, ContextFolder, ContextInstruction, ContextInstructionVersion, ContextTree } from './types.js';

export const HUMAN: Actor = { type: 'human' };

function toSlug(name: string): string {
  const slug = slugify(name);
  if (!slug) throw new AppError(`Nom invalide : "${name}"`);
  return slug;
}

/** Normalise un chemin de slugs : "API/Auth/Règles JWT" -> "api/auth/regles-jwt". */
export function normalizePath(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toSlug);
}

function computePaths(folders: FolderRecord[], instructions: InstructionRecord[]): ContextTree {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string>();
  const folderPath = (id: string | null): string => {
    if (!id) return '';
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f) return '';
    const parent = folderPath(f.parentId);
    const p = parent ? `${parent}/${f.slug}` : f.slug;
    cache.set(id, p);
    return p;
  };
  const join = (folderId: string | null, slug: string) => {
    const parent = folderPath(folderId);
    return parent ? `${parent}/${slug}` : slug;
  };
  return {
    folders: folders.map((f) => ({ ...f, path: folderPath(f.id) })).sort((a, b) => a.path.localeCompare(b.path)),
    instructions: instructions.map((i) => ({ ...i, path: join(i.folderId, i.slug) })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Après chaque modification, les skills du projet sont régénérés (tâche de fond, sans bloquer). */
function refreshSkills(projectId: string): void {
  void projectService
    .get(projectId)
    .then((project) => materializeSkills(project))
    .catch((err) => console.error('[context] génération des skills', err));
}

export type ResolvedPath = { kind: 'folder'; folder: ContextFolder } | { kind: 'instruction'; instruction: ContextInstruction } | { kind: 'root' } | null;

export const contextService = {
  async tree(projectId: string): Promise<ContextTree> {
    const [folders, instructions] = await Promise.all([contextRepository.listFolders(projectId), contextRepository.listInstructions(projectId)]);
    return computePaths(folders, instructions);
  },

  async getFolder(id: string): Promise<ContextFolder> {
    const record = await contextRepository.findFolder(id);
    if (!record) throw new NotFoundError('Dossier introuvable');
    const tree = await this.tree(record.projectId);
    return tree.folders.find((f) => f.id === id)!;
  },

  async getInstruction(id: string): Promise<ContextInstruction> {
    const record = await contextRepository.findInstruction(id);
    if (!record) throw new NotFoundError('Instruction introuvable');
    const tree = await this.tree(record.projectId);
    return tree.instructions.find((i) => i.id === id)!;
  },

  /** Résout un chemin de slugs vers un dossier ou une instruction du projet. */
  async resolve(projectId: string, path: string): Promise<ResolvedPath> {
    const parts = normalizePath(path);
    if (parts.length === 0) return { kind: 'root' };
    const tree = await this.tree(projectId);
    const p = parts.join('/');
    const instruction = tree.instructions.find((i) => i.path === p);
    if (instruction) return { kind: 'instruction', instruction };
    const folder = tree.folders.find((f) => f.path === p);
    if (folder) return { kind: 'folder', folder };
    return null;
  },

  // --- Dossiers ---

  async createFolder(projectId: string, input: { parentId?: string | null; name: string }, actor: Actor): Promise<ContextFolder> {
    await projectService.get(projectId);
    const slug = toSlug(input.name);
    if (input.parentId) {
      const parent = await contextRepository.findFolder(input.parentId);
      if (!parent || parent.projectId !== projectId) throw new NotFoundError('Dossier parent introuvable');
    }
    let record: FolderRecord;
    try {
      record = await contextRepository.createFolder(projectId, input.parentId ?? null, input.name.trim(), slug);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un dossier "${slug}" existe déjà à cet emplacement`);
      throw err;
    }
    const folder = await this.getFolder(record.id);
    await contextRepository.addChange(projectId, 'folder.create', folder.path, {}, actor);
    refreshSkills(projectId);
    return folder;
  },

  /** Crée les dossiers manquants le long d'un chemin et renvoie le dossier final (null = racine). */
  async ensureFolderPath(projectId: string, path: string, actor: Actor): Promise<ContextFolder | null> {
    const parts = normalizePath(path);
    let parent: ContextFolder | null = null;
    for (const part of parts) {
      const tree: ContextTree = await this.tree(projectId);
      const targetPath: string = parent ? `${parent.path}/${part}` : part;
      const existing: ContextFolder | undefined = tree.folders.find((f) => f.path === targetPath);
      const parentId: string | null = parent ? parent.id : null;
      parent = existing ?? (await this.createFolder(projectId, { parentId, name: part }, actor));
    }
    return parent;
  },

  async renameFolder(id: string, name: string, actor: Actor): Promise<ContextFolder> {
    const before = await this.getFolder(id);
    const slug = toSlug(name);
    try {
      await contextRepository.updateFolder(id, { name: name.trim(), slug });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un dossier "${slug}" existe déjà à cet emplacement`);
      throw err;
    }
    const after = await this.getFolder(id);
    await contextRepository.addChange(before.projectId, 'folder.rename', after.path, { from: before.path }, actor);
    refreshSkills(before.projectId);
    return after;
  },

  async moveFolder(id: string, parentId: string | null, actor: Actor): Promise<ContextFolder> {
    const before = await this.getFolder(id);
    if (parentId) {
      const target = await this.getFolder(parentId);
      if (target.projectId !== before.projectId) throw new AppError('Le dossier cible appartient à un autre projet');
      if (target.id === id || target.path.startsWith(`${before.path}/`)) throw new AppError('Impossible de déplacer un dossier dans lui-même');
    }
    try {
      await contextRepository.updateFolder(id, { parentId });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un dossier "${before.slug}" existe déjà dans la destination`);
      throw err;
    }
    const after = await this.getFolder(id);
    await contextRepository.addChange(before.projectId, 'folder.move', after.path, { from: before.path }, actor);
    refreshSkills(before.projectId);
    return after;
  },

  async deleteFolder(id: string, actor: Actor): Promise<boolean> {
    const folder = await this.getFolder(id);
    const tree = await this.tree(folder.projectId);
    const removed = tree.instructions.filter((i) => i.path.startsWith(`${folder.path}/`)).map((i) => i.path);
    const ok = await contextRepository.deleteFolder(id);
    await contextRepository.addChange(folder.projectId, 'folder.delete', folder.path, { instructions: removed }, actor);
    refreshSkills(folder.projectId);
    return ok;
  },

  // --- Instructions ---

  async createInstruction(
    projectId: string,
    input: { folderId?: string | null; name: string; description?: string | null; content?: string | null; changeNote?: string | null },
    actor: Actor,
  ): Promise<ContextInstruction> {
    await projectService.get(projectId);
    const slug = toSlug(input.name);
    if (input.folderId) {
      const folder = await contextRepository.findFolder(input.folderId);
      if (!folder || folder.projectId !== projectId) throw new NotFoundError('Dossier introuvable');
    }
    const client = await pool.connect();
    let record: InstructionRecord;
    try {
      await client.query('BEGIN');
      record = await contextRepository.createInstruction(
        { projectId, folderId: input.folderId ?? null, name: input.name.trim(), slug, description: (input.description ?? '').trim(), content: input.content ?? '' },
        client,
      );
      await contextRepository.addVersion(record, input.changeNote ?? 'Création', actor, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') throw new AppError(`Une instruction "${slug}" existe déjà à cet emplacement`);
      throw err;
    } finally {
      client.release();
    }
    const instruction = await this.getInstruction(record.id);
    await contextRepository.addChange(projectId, 'instruction.create', instruction.path, { version: 1 }, actor);
    refreshSkills(projectId);
    return instruction;
  },

  /** Crée ou met à jour l'instruction désignée par un chemin (les dossiers manquants sont créés). */
  async writeInstructionAtPath(
    projectId: string,
    path: string,
    input: { content: string; description?: string | null; changeNote?: string | null },
    actor: Actor,
  ): Promise<{ instruction: ContextInstruction; created: boolean }> {
    const parts = normalizePath(path);
    if (parts.length === 0) throw new AppError('Chemin vide');
    const resolved = await this.resolve(projectId, path);
    if (resolved?.kind === 'folder') throw new AppError(`"${resolved.folder.path}" est un dossier`);
    if (resolved?.kind === 'instruction') {
      const instruction = await this.updateInstruction(resolved.instruction.id, { content: input.content, description: input.description ?? undefined, changeNote: input.changeNote }, actor);
      return { instruction, created: false };
    }
    const name = path.split('/').map((s) => s.trim()).filter(Boolean).pop()!;
    const folder = await this.ensureFolderPath(projectId, parts.slice(0, -1).join('/'), actor);
    const instruction = await this.createInstruction(projectId, { folderId: folder?.id ?? null, name, description: input.description, content: input.content, changeNote: input.changeNote }, actor);
    return { instruction, created: true };
  },

  async updateInstruction(
    id: string,
    input: { name?: string | null; description?: string | null; content?: string | null; folderId?: string | null; changeNote?: string | null },
    actor: Actor,
  ): Promise<ContextInstruction> {
    const before = await this.getInstruction(id);
    const patch: { name?: string; slug?: string; description?: string; content?: string; folderId?: string | null; version?: number } = {};
    if (input.name != null && input.name.trim() !== before.name) {
      patch.name = input.name.trim();
      patch.slug = toSlug(input.name);
    }
    if (input.description != null && input.description.trim() !== before.description) patch.description = input.description.trim();
    if (input.content != null && input.content !== before.content) patch.content = input.content;
    const moved = input.folderId !== undefined && input.folderId !== before.folderId;
    if (moved) {
      if (input.folderId) {
        const folder = await contextRepository.findFolder(input.folderId);
        if (!folder || folder.projectId !== before.projectId) throw new NotFoundError('Dossier cible introuvable');
      }
      patch.folderId = input.folderId ?? null;
    }
    const contentChanged = patch.name !== undefined || patch.description !== undefined || patch.content !== undefined;
    if (!contentChanged && !moved) return before;
    if (contentChanged) patch.version = before.version + 1;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const record = await contextRepository.updateInstruction(id, patch, client);
      if (!record) throw new NotFoundError('Instruction introuvable');
      if (contentChanged) await contextRepository.addVersion(record, input.changeNote ?? null, actor, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') throw new AppError('Une instruction du même nom existe déjà à cet emplacement');
      throw err;
    } finally {
      client.release();
    }
    const after = await this.getInstruction(id);
    if (moved) await contextRepository.addChange(before.projectId, 'instruction.move', after.path, { from: before.path }, actor);
    if (contentChanged) {
      await contextRepository.addChange(before.projectId, 'instruction.update', after.path, { version: after.version, changeNote: input.changeNote ?? null, renamedFrom: patch.name ? before.path : undefined }, actor);
    }
    refreshSkills(before.projectId);
    return after;
  },

  async deleteInstruction(id: string, actor: Actor): Promise<boolean> {
    const instruction = await this.getInstruction(id);
    const ok = await contextRepository.deleteInstruction(id);
    await contextRepository.addChange(instruction.projectId, 'instruction.delete', instruction.path, { version: instruction.version }, actor);
    refreshSkills(instruction.projectId);
    return ok;
  },

  versions: (instructionId: string): Promise<ContextInstructionVersion[]> => contextRepository.listVersions(instructionId),

  /** Restaure le contenu d'une ancienne version : crée une nouvelle version (l'historique reste intact). */
  async restoreVersion(id: string, version: number, actor: Actor): Promise<ContextInstruction> {
    const target = await contextRepository.findVersion(id, version);
    if (!target) throw new NotFoundError(`Version ${version} introuvable`);
    const restored = await this.updateInstruction(
      id,
      { name: target.name, description: target.description, content: target.content, changeNote: `Restauration de la version ${version}` },
      actor,
    );
    await contextRepository.addChange(restored.projectId, 'instruction.restore', restored.path, { restoredVersion: version, version: restored.version }, actor);
    return restored;
  },

  async search(projectId: string, query: string): Promise<ContextInstruction[]> {
    const q = query.trim();
    if (!q) return [];
    const [records, tree] = await Promise.all([contextRepository.searchInstructions(projectId, q), this.tree(projectId)]);
    const ids = new Set(records.map((r) => r.id));
    return tree.instructions.filter((i) => ids.has(i.id));
  },

  changes: (projectId: string, limit?: number): Promise<ContextChange[]> => contextRepository.listChanges(projectId, limit),

  /** Résumé textuel de l'arborescence, injecté dans le prompt système des agents. */
  async promptSummary(projectId: string): Promise<string> {
    const tree = await this.tree(projectId);
    if (tree.folders.length === 0 && tree.instructions.length === 0) {
      return "Ce projet dispose d'une bibliothèque de contexte (vide pour l'instant). Utilise les outils du serveur MCP `context` pour y ranger des instructions durables (conventions, décisions, procédures) dans des dossiers.";
    }
    const lines = tree.instructions.map((i) => `- ${i.path}${i.description ? ` — ${i.description}` : ''} (v${i.version})`);
    return [
      "Ce projet dispose d'une bibliothèque de contexte : des instructions rangées en dossiers, consultables et modifiables avec les outils du serveur MCP `context` (tree, read, search, write, create_folder, move, delete, history). Chaque instruction est aussi disponible comme skill `context:<chemin>`. Consulte les instructions pertinentes avant d'agir, et enregistre-y les décisions et conventions durables.",
      'Instructions disponibles :',
      ...lines,
    ].join('\n');
  },
};
