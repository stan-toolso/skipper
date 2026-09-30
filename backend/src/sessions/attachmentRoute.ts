import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { projectService } from '../projects/service.js';
import { findAttachmentFile } from './attachments.js';
import { sessionRepository } from './repository.js';

const ROUTE = /^\/api\/attachments\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

/** Types servis tels quels au navigateur (aperçu) ; tout le reste est proposé en téléchargement. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return origin === new URL(config.appUrl).origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * GET /api/attachments/<session>/<id> : fichier joint à une instruction, pour le transcript (aperçu des images,
 * téléchargement des autres fichiers). Authentification par le cookie de session ; il faut avoir accès au projet.
 * Renvoie false si l'URL n'est pas une route de pièces jointes.
 */
export async function handleAttachmentRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  // Le front de développement (autre port) charge les aperçus avec le cookie : on l'autorise en CORS comme GraphQL.
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
  const [, sessionId, attachmentId] = match;
  const session = await sessionRepository.findById(sessionId);
  if (!session) {
    res.writeHead(404).end();
    return true;
  }
  try {
    await requireProject(createAuthContext(user), session.projectId, 'viewer');
  } catch {
    res.writeHead(403).end();
    return true;
  }
  const project = await projectService.get(session.projectId);
  const file = await findAttachmentFile(project, sessionId, attachmentId);
  if (!file) {
    res.writeHead(404).end();
    return true;
  }
  // Le type est celui enregistré avec l'instruction (prompt de la session ou événement `instruction`), jamais deviné du nom seul.
  const known = session.promptAttachments.find((a) => a.id === attachmentId) ?? (await sessionRepository.findAttachmentInEvents(sessionId, attachmentId));
  const mediaType = known?.mediaType ?? 'application/octet-stream';
  const disposition = INLINE_TYPES.has(mediaType) ? 'inline' : 'attachment';
  res.writeHead(200, {
    'Content-Type': mediaType.startsWith('text/') ? `${mediaType}; charset=utf-8` : mediaType,
    'Content-Length': file.size,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
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
