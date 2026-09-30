import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.js';
import { googleAccountService } from './service.js';

/** Client Google Drive minimal (API REST v3) au nom d'un compte Google relié à un projet. */

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents,owners(emailAddress),shared';
const SHARED = 'supportsAllDrives=true';
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

export type ConvertTarget = 'document' | 'spreadsheet' | 'presentation';
const convertMime: Record<ConvertTarget, string> = { document: GOOGLE_DOC, spreadsheet: GOOGLE_SHEET, presentation: GOOGLE_SLIDES };

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  parents: string[];
  owners: string[];
  shared: boolean;
}

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  owners?: Array<{ emailAddress?: string }>;
  shared?: boolean;
}

const toFile = (f: RawFile): DriveFile => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  size: f.size ?? null,
  modifiedTime: f.modifiedTime ?? null,
  webViewLink: f.webViewLink ?? null,
  parents: f.parents ?? [],
  owners: (f.owners ?? []).map((o) => o.emailAddress ?? '').filter(Boolean),
  shared: Boolean(f.shared),
});

/** Échappement d'une valeur dans une requête `q` de Drive. */
const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const kindLabel = (mime: string) =>
  mime === GOOGLE_DOC ? 'Doc' : mime === GOOGLE_SHEET ? 'Sheet' : mime === GOOGLE_SLIDES ? 'Slides' : mime === GOOGLE_FOLDER ? 'dossier' : mime.replace(/^application\/vnd\.google-apps\./, 'google-');

export interface SearchInput {
  query?: string;
  folderId?: string;
  mimeType?: string;
  maxResults: number;
}

export async function search(accountId: string, input: SearchInput): Promise<DriveFile[]> {
  const clauses = ['trashed = false'];
  if (input.query?.trim()) clauses.push(`(name contains '${q(input.query.trim())}' or fullText contains '${q(input.query.trim())}')`);
  if (input.folderId) clauses.push(`'${q(input.folderId)}' in parents`);
  if (input.mimeType) clauses.push(`mimeType = '${q(input.mimeType)}'`);
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    pageSize: String(input.maxResults),
    fields: `files(${FIELDS})`,
    orderBy: input.query?.trim() ? 'modifiedTime desc' : 'folder,name',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    corpora: 'allDrives',
  });
  const res = await googleAccountService.json<{ files?: RawFile[] }>(accountId, `${BASE}/files?${params}`);
  return (res.files ?? []).map(toFile);
}

export async function metadata(accountId: string, fileId: string): Promise<DriveFile> {
  return toFile(await googleAccountService.json<RawFile>(accountId, `${BASE}/files/${encodeURIComponent(fileId)}?fields=${FIELDS}&${SHARED}`));
}

const isTextMime = (mime: string) => /^text\//.test(mime) || /(json|xml|yaml|x-sh|javascript|typescript|csv|markdown|x-python)/.test(mime);

/**
 * Contenu lisible d'un fichier : Docs et Slides en texte brut, Sheets en CSV, dossiers listés,
 * fichiers texte téléchargés (2 Mo au plus) ; les binaires sont à récupérer avec `download`.
 */
export async function readContent(accountId: string, fileId: string): Promise<{ file: DriveFile; content: string; truncated: boolean; note: string | null }> {
  const file = await metadata(accountId, fileId);
  const id = encodeURIComponent(file.id);
  let content: string;
  let note: string | null = null;
  if (file.mimeType === GOOGLE_FOLDER) {
    const children = await search(accountId, { folderId: file.id, maxResults: 200 });
    content = children.length ? children.map(describe).join('\n') : '(dossier vide)';
    note = 'contenu du dossier';
  } else if (file.mimeType === GOOGLE_DOC || file.mimeType === GOOGLE_SLIDES || file.mimeType === GOOGLE_SHEET) {
    const mime = file.mimeType === GOOGLE_SHEET ? 'text/csv' : 'text/plain';
    const res = await googleAccountService.raw(accountId, `${BASE}/files/${id}/export?mimeType=${encodeURIComponent(mime)}`);
    content = await res.text();
    if (file.mimeType === GOOGLE_SHEET) note = 'première feuille seulement (export CSV)';
  } else if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new AppError(`Ce type de fichier Google (${kindLabel(file.mimeType)}) n'a pas de contenu textuel exportable`);
  } else {
    if (Number(file.size ?? 0) > MAX_READ_BYTES) throw new AppError(`Fichier trop volumineux pour être lu directement (${file.size} octets) : utilise drive_download`);
    if (!isTextMime(file.mimeType)) throw new AppError(`Fichier binaire (${file.mimeType}) : utilise drive_download pour le récupérer dans le dossier de travail`);
    const res = await googleAccountService.raw(accountId, `${BASE}/files/${id}?alt=media&${SHARED}`);
    content = await res.text();
  }
  return { file, content: content.slice(0, MAX_TEXT_CHARS), truncated: content.length > MAX_TEXT_CHARS, note };
}

const exportFormats: Record<string, { mime: string; ext: string }> = {
  pdf: { mime: 'application/pdf', ext: '.pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  txt: { mime: 'text/plain', ext: '.txt' },
  csv: { mime: 'text/csv', ext: '.csv' },
  md: { mime: 'text/markdown', ext: '.md' },
  html: { mime: 'text/html', ext: '.html' },
};
const defaultExport: Record<string, string> = { [GOOGLE_DOC]: 'docx', [GOOGLE_SHEET]: 'xlsx', [GOOGLE_SLIDES]: 'pptx' };

/** Télécharge un fichier (ou exporte un document Google) vers un chemin local déjà résolu. */
export async function download(accountId: string, fileId: string, localPath: string, format?: string): Promise<{ file: DriveFile; localPath: string; bytes: number }> {
  const file = await metadata(accountId, fileId);
  const id = encodeURIComponent(file.id);
  let url: string;
  let target = localPath;
  if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    const key = format ?? defaultExport[file.mimeType];
    const fmt = key ? exportFormats[key] : undefined;
    if (!fmt) throw new AppError(`Format d'export inconnu ou non applicable : ${format ?? file.mimeType} (formats : ${Object.keys(exportFormats).join(', ')})`);
    url = `${BASE}/files/${id}/export?mimeType=${encodeURIComponent(fmt.mime)}`;
    if (!path.extname(target)) target += fmt.ext;
  } else {
    url = `${BASE}/files/${id}?alt=media&${SHARED}`;
  }
  const res = await googleAccountService.raw(accountId, url);
  if (!res.body) throw new AppError('Réponse vide de Google');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(target));
  return { file, localPath: target, bytes };
}

const extMime: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (file: string) => extMime[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * Envoi en deux temps (« resumable ») : la session d'envoi reçoit les métadonnées, puis le contenu.
 * `fileId` remplace le contenu d'un fichier existant au lieu d'en créer un.
 */
async function uploadBytes(accountId: string, meta: { name?: string; parents?: string[]; mimeType?: string }, body: Buffer, contentType: string, fileId?: string): Promise<DriveFile> {
  const target = fileId ? `${UPLOAD}/files/${encodeURIComponent(fileId)}` : `${UPLOAD}/files`;
  const init = await googleAccountService.raw(accountId, `${target}?uploadType=resumable&${SHARED}&fields=${FIELDS}`, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': contentType, 'x-upload-content-length': String(body.length) },
    body: JSON.stringify(meta),
  });
  const location = init.headers.get('location');
  if (!location) throw new AppError("Google n'a pas ouvert de session d'envoi");
  const res = await googleAccountService.raw(accountId, location, { method: 'PUT', headers: { 'content-type': contentType, 'content-length': String(body.length) }, body: new Uint8Array(body) });
  return toFile((await res.json()) as RawFile);
}

/** Dépose un fichier local sur le Drive, éventuellement converti en Doc / Sheet / Slides. */
export async function upload(accountId: string, localPath: string, opts: { name?: string; folderId?: string; convertTo?: ConvertTarget }): Promise<DriveFile> {
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) throw new AppError(`Fichier local introuvable : ${localPath}`);
  if (info.size > 100 * 1024 * 1024) throw new AppError('Fichier trop volumineux (100 Mo maximum)');
  const body = await readFile(localPath);
  const meta: { name: string; parents?: string[]; mimeType?: string } = { name: opts.name?.trim() || path.basename(localPath) };
  if (opts.folderId) meta.parents = [opts.folderId];
  if (opts.convertTo) meta.mimeType = convertMime[opts.convertTo];
  return uploadBytes(accountId, meta, body, mimeOf(localPath));
}

export type WriteKind = 'document' | 'spreadsheet' | 'text';

/** Crée (ou remplace si `fileId`) un Google Doc depuis du Markdown, un Sheet depuis du CSV, ou un fichier texte. */
export async function write(accountId: string, input: { name: string; content: string; kind: WriteKind; folderId?: string; fileId?: string }): Promise<{ file: DriveFile; replaced: boolean }> {
  const contentType = input.kind === 'document' ? 'text/markdown' : input.kind === 'spreadsheet' ? 'text/csv' : 'text/plain';
  const body = Buffer.from(input.content, 'utf8');
  if (input.fileId) {
    const existing = await metadata(accountId, input.fileId);
    const meta: { name?: string; mimeType?: string } = { name: input.name.trim() || existing.name };
    if (existing.mimeType.startsWith('application/vnd.google-apps.')) meta.mimeType = existing.mimeType;
    return { file: await uploadBytes(accountId, meta, body, contentType, existing.id), replaced: true };
  }
  const meta: { name: string; parents?: string[]; mimeType?: string } = { name: input.name.trim() };
  if (!meta.name) throw new AppError('Nom du fichier obligatoire');
  if (input.folderId) meta.parents = [input.folderId];
  if (input.kind === 'document') meta.mimeType = GOOGLE_DOC;
  if (input.kind === 'spreadsheet') meta.mimeType = GOOGLE_SHEET;
  return { file: await uploadBytes(accountId, meta, body, contentType), replaced: false };
}

export function describe(f: DriveFile): string {
  const size = f.size ? ` · ${Number(f.size) > 1_000_000 ? `${(Number(f.size) / 1_000_000).toFixed(1)} Mo` : `${Math.ceil(Number(f.size) / 1000)} Ko`}` : '';
  return `- [${f.id}] ${f.name} · ${kindLabel(f.mimeType)}${size}${f.modifiedTime ? ` · modifié le ${f.modifiedTime.slice(0, 10)}` : ''}${f.owners.length ? ` · ${f.owners[0]}` : ''}${f.webViewLink ? `\n  ${f.webViewLink}` : ''}`;
}
