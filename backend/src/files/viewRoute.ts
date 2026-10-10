import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { worktreeService } from '../worktrees/service.js';
import { readRawFile } from './service.js';

/** Types servis d'après l'extension ; tout le reste est un flux binaire. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

/**
 * GET /api/files/view/<projectId>/<worktreeId|->/<chemin…>[?download=1] : fichier brut d'un workspace, pour
 * l'aperçu HTML (dans un bac à sable : CSP `sandbox` sans `allow-same-origin`, la page ne peut ni lire le
 * stockage de l'application ni appeler son API avec le cookie) et le téléchargement. Les liens relatifs d'une
 * page (css, js, images) se résolvent dans le même dossier. Renvoie false hors route.
 */
export async function handleFileViewRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(/^\/api\/files\/view\/([0-9a-f-]{36})\/([0-9a-f-]{36}|-)\/(.*)$/);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const text = (status: number, message: string) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(message);
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) return text(401, 'Connectez-vous à Skipper pour ouvrir ce fichier.'), true;
  const [, projectId, worktreeRaw, rawPath] = match;
  const worktreeId = worktreeRaw === '-' ? null : worktreeRaw;
  try {
    await requireProject(createAuthContext(user), projectId, 'viewer');
    if (worktreeId && (await worktreeService.get(worktreeId)).projectId !== projectId) throw new AppError('Fichier introuvable', 'NOT_FOUND');
    let rel: string;
    try {
      rel = rawPath.split('/').map(decodeURIComponent).join('/');
    } catch {
      throw new AppError('Chemin invalide');
    }
    if (!rel || rel.endsWith('/')) rel = `${rel}index.html`;
    const file = await readRawFile({ projectId, worktreeId }, rel);
    const type = TYPES[path.extname(file.name).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': file.data.length,
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Last-Modified': file.modifiedAt.toUTCString(),
      ...(url.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : file.data);
  } catch (err) {
    if (err instanceof AppError) return text(err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400, err.message), true;
    console.error('[files] aperçu', err);
    text(500, 'Impossible de lire le fichier.');
  }
  return true;
}
