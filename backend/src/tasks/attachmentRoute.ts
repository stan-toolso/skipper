import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { isAllowedOrigin } from '../origin.js';
import { taskAttachmentFile } from './attachments.js';
import { taskRepository } from './repository.js';

const ROUTE = /^\/api\/task-attachments\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

/** Types servis tels quels au navigateur (aperçu) ; tout le reste est proposé en téléchargement. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);


/**
 * GET /api/task-attachments/<tâche>/<id> : fichier joint à une tâche ou à l'un de ses commentaires (aperçu des
 * images, téléchargement). Authentification par le cookie de session ; il faut avoir accès au projet de la tâche.
 * Renvoie false si l'URL n'est pas cette route.
 */
export async function handleTaskAttachmentRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) {
    res.writeHead(401).end();
    return true;
  }
  const [, taskId, attachmentId] = match;
  const task = await taskRepository.findById(taskId);
  const attachment = task ? await taskRepository.findAttachment(attachmentId) : null;
  if (!task || !attachment || attachment.taskId !== task.id) {
    res.writeHead(404).end();
    return true;
  }
  try {
    await requireProject(createAuthContext(user), task.projectId, 'viewer');
  } catch {
    res.writeHead(403).end();
    return true;
  }
  const file = await taskAttachmentFile(attachment);
  if (!file) {
    res.writeHead(404).end();
    return true;
  }
  // Le type est celui enregistré, jamais deviné du nom seul.
  const mediaType = attachment.mediaType || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mediaType.startsWith('text/') ? `${mediaType}; charset=utf-8` : mediaType,
    'Content-Length': file.size,
    'Content-Disposition': `${INLINE_TYPES.has(mediaType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
  return true;
}
