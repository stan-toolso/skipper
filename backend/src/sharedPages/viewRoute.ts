import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { downloadName, sharedPageService } from './service.js';

const ROUTE = /^\/api\/shared\/([0-9a-f-]{36})$/;

/**
 * GET /api/shared/<id>[?v=N][&download=1] : contenu HTML d'une page partagée, servi dans un bac à sable
 * (CSP `sandbox` sans `allow-same-origin` : origine opaque, la page ne lit ni le stockage de l'application
 * ni son API avec le cookie). Les droits sont revérifiés à chaque chargement. Renvoie false hors route.
 */
export async function handleSharedPageRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end("Connectez-vous à Skipper pour ouvrir cette page.");
    return true;
  }
  try {
    const page = await sharedPageService.getFor(user.id, match[1]);
    const v = url.searchParams.get('v');
    const { html } = await sharedPageService.content(page, v ? Number(v) : null);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(url.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName(page.title))}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (err) {
    const status = err instanceof AppError ? (err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400) : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(status === 500 ? 'Impossible de lire la page.' : (err as Error).message);
  }
  return true;
}
