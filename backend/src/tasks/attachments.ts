import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { decodeAttachments, formatSize, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, normalizeMediaType } from '../sessions/attachments.js';
import type { AttachmentInput } from '../sessions/types.js';
import { taskRepository } from './repository.js';
import type { TaskAttachment } from './types.js';

/**
 * Fichiers joints à une tâche ou à l'un de ses commentaires (captures d'écran collées dans la description, un
 * journal, un document) : vérifiés comme ceux d'une instruction (nombre, tailles), le contenu sur le disque du
 * serveur sous la tâche (indépendant du projet : une tâche déplacée garde ses fichiers), les métadonnées dans
 * `task_attachments`.
 */

/** Types d'image transmis aux agents comme blocs image (lisibles par l'API Claude). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Au-delà, une image est nommée mais pas montrée à l'agent (limite d'un bloc image de l'API). */
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

export const isImageType = (mediaType: string): boolean => IMAGE_TYPES.has(mediaType);

/** `nom (image/png, 34 Ko)`. */
export const describeAttachment = (a: Pick<TaskAttachment, 'name' | 'mediaType' | 'size'>): string => `${a.name} (${a.mediaType}, ${formatSize(a.size)})`;

/** Dossier des fichiers joints aux tâches, à part des projets. */
export const taskAttachmentsRoot = (): string => path.join(config.workspacesRoot, '.task-attachments');
const taskDir = (taskId: string) => path.join(taskAttachmentsRoot(), taskId);
const attachmentDir = (taskId: string, id: string) => path.join(taskDir(taskId), id);

/** Chemin du fichier d'une pièce jointe (le nom est déjà assaini à l'enregistrement). */
export const attachmentPath = (a: Pick<TaskAttachment, 'taskId' | 'id' | 'name'>): string => path.join(attachmentDir(a.taskId, a.id), a.name);

/**
 * Vérifie un lot de fichiers avant toute écriture (nombre en comptant ceux déjà là, tailles, encodage) : un lot
 * refusé ne laisse rien derrière lui. `removedIds` : fichiers sur le point de partir.
 */
export async function validateTaskAttachments(taskId: string, commentId: string | null, inputs: AttachmentInput[] | null | undefined, removedIds: string[] | null | undefined = null): Promise<void> {
  if (!inputs?.length) return;
  const existing = taskId ? (await taskRepository.listAttachments(taskId, commentId)).filter((a) => !removedIds?.includes(a.id)) : [];
  if (existing.length + inputs.length > MAX_ATTACHMENTS) throw new AppError(`Au plus ${MAX_ATTACHMENTS} fichiers par ${commentId ? 'commentaire' : 'tâche'}`);
  decodeAttachments(inputs, commentId ? 'commentaire' : 'tâche');
}

/** Vérifie, enregistre et inscrit les fichiers d'une tâche ou d'un commentaire. Tout ou rien : en cas d'échec, ce qui a été écrit est retiré. */
export async function storeTaskAttachments(taskId: string, commentId: string | null, inputs: AttachmentInput[] | null | undefined): Promise<TaskAttachment[]> {
  if (!inputs?.length) return [];
  await validateTaskAttachments(taskId, commentId, inputs);
  const stored: TaskAttachment[] = [];
  let pending: string | null = null;
  try {
    for (const { input, name, bytes } of decodeAttachments(inputs, commentId ? 'commentaire' : 'tâche')) {
      const id = randomUUID();
      pending = id;
      await mkdir(attachmentDir(taskId, id), { recursive: true });
      await writeFile(path.join(attachmentDir(taskId, id), name), bytes);
      stored.push(await taskRepository.createAttachment({ id, taskId, commentId, name, mediaType: normalizeMediaType(input.mediaType, name), size: bytes.length }));
      pending = null;
    }
  } catch (err) {
    for (const id of [...stored.map((a) => a.id), ...(pending ? [pending] : [])]) {
      await taskRepository.deleteAttachment(id).catch(() => undefined);
      await rm(attachmentDir(taskId, id), { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
  return stored;
}

/** Retire des pièces jointes d'une tâche (les siennes, ou celles d'un commentaire) : lignes et fichiers. Les identifiants inconnus sont ignorés. */
export async function removeTaskAttachments(taskId: string, commentId: string | null, ids: string[] | null | undefined): Promise<TaskAttachment[]> {
  if (!ids?.length) return [];
  const removable = (await taskRepository.listAttachments(taskId, commentId)).filter((a) => ids.includes(a.id));
  for (const a of removable) {
    await taskRepository.deleteAttachment(a.id);
    await rm(attachmentDir(taskId, a.id), { recursive: true, force: true });
  }
  return removable;
}

/** Retire les fichiers de pièces jointes déjà effacées en base (commentaire supprimé : ses lignes partent en cascade). */
export async function removeAttachmentFiles(attachments: TaskAttachment[]): Promise<void> {
  for (const a of attachments) await rm(attachmentDir(a.taskId, a.id), { recursive: true, force: true }).catch(() => undefined);
}

/** Retire tous les fichiers d'une tâche (à sa suppression : les lignes partent avec elle, pas les fichiers). */
export const removeAllTaskAttachments = (taskId: string): Promise<void> => rm(taskDir(taskId), { recursive: true, force: true });

/** Fichier d'une pièce jointe (route de téléchargement), ou null s'il a disparu. */
export async function taskAttachmentFile(a: TaskAttachment): Promise<{ path: string; size: number } | null> {
  try {
    const info = await stat(attachmentPath(a));
    return info.isFile() ? { path: attachmentPath(a), size: info.size } : null;
  } catch {
    return null;
  }
}

const readBytes = (a: TaskAttachment): Promise<Buffer | null> => readFile(attachmentPath(a)).catch(() => null);

/** Les pièces jointes qui tiennent dans une instruction (limites des sessions : nombre, taille d'un fichier, total), dans l'ordre ; les autres à part, pour les nommer. Pur. */
export function fitInInstruction<T extends Pick<TaskAttachment, 'size'>>(attachments: T[]): { kept: T[]; leftOut: T[] } {
  const kept: T[] = [];
  const leftOut: T[] = [];
  let total = 0;
  for (const a of attachments) {
    if (kept.length < MAX_ATTACHMENTS && a.size <= MAX_ATTACHMENT_BYTES && total + a.size <= MAX_TOTAL_ATTACHMENT_BYTES) {
      kept.push(a);
      total += a.size;
    } else leftOut.push(a);
  }
  return { kept, leftOut };
}

/** Les pièces jointes comme fichiers d'une instruction (base64) : la session qui reçoit la tâche les reçoit comme une personne joint des fichiers. Un fichier disparu est ignoré. */
export async function asInstructionAttachments(attachments: TaskAttachment[]): Promise<AttachmentInput[]> {
  const out: AttachmentInput[] = [];
  for (const a of attachments) {
    const bytes = await readBytes(a);
    if (bytes) out.push({ name: a.name, mediaType: a.mediaType, data: bytes.toString('base64') });
  }
  return out;
}

/** Bloc de contenu d'une réponse d'outil MCP. */
export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Les images parmi les pièces jointes, en blocs image d'une réponse d'outil MCP (`tasks.get`) : l'agent voit les captures. */
export async function imageBlocks(attachments: TaskAttachment[]): Promise<McpContent[]> {
  const blocks: McpContent[] = [];
  for (const a of attachments) {
    if (!shownToAgent(a)) continue;
    const bytes = await readBytes(a);
    if (bytes) blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: a.mediaType });
  }
  return blocks;
}

/** Une image jointe est montrée à l'agent (bloc image) ou seulement nommée. */
export const shownToAgent = (a: Pick<TaskAttachment, 'mediaType' | 'size'>): boolean => isImageType(a.mediaType) && a.size <= MAX_AGENT_IMAGE_BYTES;

/** Comment les fichiers d'une tâche parviennent à l'agent qui lit son texte. */
export type AttachmentDelivery = 'instruction' | 'tool' | 'none';

const attachmentNote = (a: TaskAttachment, attached: AttachmentDelivery): string => {
  if (attached === 'instruction') return ' — joint à cette instruction';
  if (attached === 'tool') return shownToAgent(a) ? ' — montré ci-dessous' : '';
  return '';
};

/** Bloc « Fichiers joints : » d'une tâche ou d'un commentaire, une ligne par fichier ; rien sans fichier. */
export const describeAttachments = (attachments: TaskAttachment[], attached: AttachmentDelivery): string[] =>
  attachments.length ? ['Fichiers joints :', ...attachments.map((a) => `- ${describeAttachment(a)}${attachmentNote(a, attached)}`)] : [];
