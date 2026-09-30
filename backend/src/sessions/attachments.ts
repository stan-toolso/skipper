import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import type { Attachment, AttachmentInput } from './types.js';

/** Nombre maximal de fichiers par instruction. */
export const MAX_ATTACHMENTS = 10;
/** Taille maximale d'un fichier (octets). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Taille maximale de l'ensemble des fichiers d'une instruction : nginx accepte 20 Mo par requête, base64 compris. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/** Au-delà, une image n'est plus transmise au modèle comme bloc image (limite de l'API), seulement comme fichier. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Au-delà, un PDF n'est plus transmis au modèle comme document, seulement comme fichier. */
const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** Dossier des pièces jointes d'un projet, à côté de son workspace (monté tel quel dans le conteneur du runner docker). */
export function attachmentsRoot(project: Pick<Project, 'slug'>): string {
  return path.join(config.workspacesRoot, `${project.slug}.attachments`);
}

function sessionDir(project: Pick<Project, 'slug'>, sessionId: string): string {
  return path.join(attachmentsRoot(project), sessionId);
}

/** Nom de fichier sûr : pas de chemin, pas de caractères de contrôle, longueur bornée, jamais vide. */
function safeName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const cleaned = base.replace(/^\.+/, '') || 'fichier';
  return cleaned.length > 120 ? `${cleaned.slice(0, 100)}${path.extname(cleaned).slice(0, 20)}` : cleaned;
}

function normalizeMediaType(raw: string, name: string): string {
  const type = raw.trim().toLowerCase().split(';')[0];
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return type;
  const ext = path.extname(name).toLowerCase();
  const byExt: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv' };
  return byExt[ext] ?? 'application/octet-stream';
}

function decode(input: AttachmentInput): Buffer {
  const data = input.data.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) throw new AppError(`Le contenu de « ${input.name} » n'est pas du base64`);
  return Buffer.from(data, 'base64');
}

/**
 * Enregistre les fichiers joints à une instruction sur le disque du serveur et renvoie leurs métadonnées
 * (à conserver dans la session ou l'événement `instruction`). Chaque fichier a son propre dossier, nommé par
 * un identifiant, pour garder le nom d'origine sans collision.
 */
export async function storeAttachments(project: Pick<Project, 'slug'>, sessionId: string, inputs: AttachmentInput[] | null | undefined): Promise<Attachment[]> {
  if (!inputs?.length) return [];
  if (inputs.length > MAX_ATTACHMENTS) throw new AppError(`Au plus ${MAX_ATTACHMENTS} fichiers par instruction`);
  const decoded = inputs.map((input) => ({ input, name: safeName(input.name), bytes: decode(input) }));
  let total = 0;
  for (const { name, bytes } of decoded) {
    if (!bytes.length) throw new AppError(`Le fichier « ${name} » est vide`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AppError(`Le fichier « ${name} » dépasse ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} Mo`);
    total += bytes.length;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new AppError(`Les fichiers joints dépassent ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} Mo au total`);

  const stored: Attachment[] = [];
  for (const { input, name, bytes } of decoded) {
    const id = randomUUID();
    const dir = path.join(sessionDir(project, sessionId), id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, bytes);
    stored.push({ id, name, mediaType: normalizeMediaType(input.mediaType, name), size: bytes.length, path: file });
  }
  return stored;
}

/** Fichier d'une pièce jointe (pour la route de téléchargement), ou null s'il n'existe pas. */
export async function findAttachmentFile(project: Pick<Project, 'slug'>, sessionId: string, attachmentId: string): Promise<{ path: string; name: string; size: number } | null> {
  if (!/^[0-9a-f-]{36}$/.test(attachmentId) || !/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const dir = path.join(sessionDir(project, sessionId), attachmentId);
  try {
    const [name] = await readdir(dir);
    if (!name) return null;
    const file = path.join(dir, name);
    const info = await stat(file);
    return info.isFile() ? { path: file, name, size: info.size } : null;
  } catch {
    return null;
  }
}

/** Supprime les fichiers joints d'une session (à la suppression de celle-ci). */
export async function removeSessionAttachments(project: Pick<Project, 'slug'>, sessionId: string): Promise<void> {
  await rm(sessionDir(project, sessionId), { recursive: true, force: true });
}

/** Métadonnées exposées à l'interface et journalisées dans les événements (sans le chemin serveur). */
export function publicAttachment(a: Attachment): Omit<Attachment, 'path'> {
  return { id: a.id, name: a.name, mediaType: a.mediaType, size: a.size };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/**
 * Texte ajouté à l'instruction pour décrire les fichiers joints : chemin sur disque (lisible par l'agent,
 * y compris dans un conteneur, où le dossier est monté au même chemin), type et taille.
 */
export function attachmentsNote(attachments: Attachment[]): string {
  if (!attachments.length) return '';
  const lines = attachments.map((a) => `- ${a.name} (${a.mediaType}, ${formatSize(a.size)}) : ${a.path}`);
  return `Fichiers joints à cette instruction (lisibles avec l'outil Read ; les images et PDF sont aussi transmis ci-dessous) :\n${lines.join('\n')}`;
}

/** Bloc de contenu de l'API Messages : image ou document PDF encodé en base64. */
export type InlineBlock =
  | { type: 'image'; source: { type: 'base64'; media_type: ImageType; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

/** Blocs image / document à joindre au message pour que le modèle voie directement les images et les PDF. */
export async function inlineBlocks(attachments: Attachment[]): Promise<InlineBlock[]> {
  const blocks: InlineBlock[] = [];
  for (const a of attachments) {
    if ((IMAGE_TYPES as readonly string[]).includes(a.mediaType) && a.size <= MAX_INLINE_IMAGE_BYTES) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType as ImageType, data: (await readFile(a.path)).toString('base64') } });
    } else if (a.mediaType === 'application/pdf' && a.size <= MAX_INLINE_PDF_BYTES) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: (await readFile(a.path)).toString('base64') }, title: a.name });
    }
  }
  return blocks;
}
