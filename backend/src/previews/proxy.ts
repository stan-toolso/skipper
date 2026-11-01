import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import { runner } from '../runners/index.js';
import { userRepository } from '../users/repository.js';
import { handleAnnotateRoute, INJECT_MAX_BYTES, injectScript, wantsInjection } from './annotate.js';
import { labelFromHost, parsePreviewTemplate, safeNext } from './hosts.js';
import { previewRepository, type PreviewRow } from './repository.js';
import { ACCESS_COOKIE, ACCESS_PATH, ACCESS_TTL_MS, previewService } from './service.js';

/**
 * Proxy des aperçus : toute requête dont l'hôte est `<nom>.<domaine des aperçus>` (PREVIEW_URL) est relayée au serveur
 * de développement de la work session, dans le conteneur du projet (adresse IP du conteneur, port de l'aperçu), y
 * compris les WebSockets (rechargement à chaud). L'accès se fait par un lien à usage unique (`/__skipper/acces?t=…`,
 * donné par l'API à un membre du projet) échangé contre un cookie propre au sous-domaine ; les droits sont revérifiés
 * régulièrement. Toutes les instances savent servir n'importe quel aperçu (état en base et sur disque).
 */

const template = () => parsePreviewTemplate(config.previewUrl);
const secure = () => config.previewUrl.startsWith('https://');

/** Accès vérifiés récemment (jeton → aperçu, personne, échéance de revérification). */
const accessCache = new Map<string, { worksessionId: string; userId: string; until: number }>();
const ACCESS_RECHECK_MS = 60_000;

function cookieHeader(token: string): string {
  // Le cadre de l'aperçu est dans la page de Skipper : SameSite=None (Secure) pour qu'il reçoive le cookie même si les
  // deux domaines ne sont pas du même site ; Lax en HTTP local, où None est refusé.
  const attrs = ['Path=/', 'HttpOnly', secure() ? 'SameSite=None; Secure' : 'SameSite=Lax', `Max-Age=${Math.floor(ACCESS_TTL_MS / 1000)}`];
  return `${ACCESS_COOKIE}=${token}; ${attrs.join('; ')}`;
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#333;line-height:1.5}h1{font-size:1.2rem}a{color:#0b6bcb}</style></head>
<body><h1>${title}</h1><p>${body}</p><p><a href="${config.appUrl}" target="_top">Ouvrir Skipper</a></p></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
}

/** La personne peut-elle voir les aperçus de ce projet ? (lecteur au moins) */
async function allowed(userId: string, projectId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (!user) return false;
  return requireProject(createAuthContext(user), projectId, 'viewer').then(() => true, () => false);
}

/** Personne à qui le cookie donne accès à cet aperçu, ou null. */
async function checkAccess(token: string | null, preview: PreviewRow): Promise<string | null> {
  if (!token) return null;
  const cached = accessCache.get(token);
  if (cached && cached.until > Date.now()) return cached.worksessionId === preview.worksessionId ? cached.userId : null;
  const found = await previewRepository.findAccess(token);
  if (!found || found.worksessionId !== preview.worksessionId || !(await allowed(found.userId, preview.projectId))) {
    accessCache.delete(token);
    return null;
  }
  if (accessCache.size > 5000) accessCache.clear();
  accessCache.set(token, { worksessionId: found.worksessionId, userId: found.userId, until: Math.min(Date.now() + ACCESS_RECHECK_MS, found.expiresAt.getTime()) });
  return found.userId;
}

/** En-tête Cookie sans le cookie d'accès de Skipper (le code de l'application n'a pas à le voir). */
function stripAccessCookie(header: string | undefined): string | undefined {
  if (!header) return header;
  const kept = header.split(';').map((c) => c.trim()).filter((c) => c && !c.startsWith(`${ACCESS_COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}

/** Adresse du serveur de développement de l'aperçu (IP du conteneur, port), ou null si le conteneur ne tourne pas. */
async function upstreamOf(preview: PreviewRow): Promise<{ host: string; port: number } | null> {
  const project = await projectService.get(preview.projectId).catch(() => null);
  if (!project) return null;
  const host = await runner.containerAddress(project);
  return host ? { host, port: preview.port } : null;
}

/**
 * En-têtes transmis : l'hôte devient `localhost:<port>` (les serveurs de développement — Vite, webpack — refusent les
 * noms d'hôte inconnus), le nom public part dans X-Forwarded-Host.
 */
function forwardHeaders(req: IncomingMessage, port: number, inject = false): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  // Page où injecter le script d'annotation : demandée sans compression (et sans cache conditionnel, qui renverrait un
  // 304 sans corps), pour pouvoir la modifier.
  if (inject) {
    headers['accept-encoding'] = 'identity';
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  headers.host = `localhost:${port}`;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = secure() ? 'https' : 'http';
  const cookie = stripAccessCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  return headers;
}

const NOT_RUNNING = "Le serveur de développement de cette branche ne répond pas. Lancez l'aperçu (ou relancez-le) depuis l'onglet « Aperçu » de la session dans Skipper ; il peut aussi être encore en train de démarrer : rechargez dans quelques secondes.";

/** Prend en charge une requête HTTP adressée à un aperçu ; false si l'hôte n'en est pas un. */
export async function handlePreviewRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const t = template();
  const label = t ? labelFromHost(t, req.headers.host) : null;
  if (!label) return false;
  const preview = await previewRepository.findByLabel(label);
  if (!preview) {
    page(res, 404, 'Aperçu introuvable', "Cet aperçu n'existe pas ou a été supprimé avec sa session.");
    return true;
  }
  const url = new URL(req.url ?? '/', 'http://apercu');
  if (url.pathname === ACCESS_PATH) {
    const grant = url.searchParams.get('t');
    const used = grant ? await previewRepository.useGrant(grant) : null;
    if (!used || used.worksessionId !== preview.worksessionId || !(await allowed(used.userId, preview.projectId))) {
      page(res, 403, 'Lien expiré', "Ce lien d'aperçu a déjà servi ou a expiré. Rouvrez l'aperçu depuis Skipper (ou générez un nouveau QR code).");
      return true;
    }
    const token = randomBytes(32).toString('base64url');
    await previewRepository.createToken(token, 'access', preview.worksessionId, used.userId, ACCESS_TTL_MS);
    res.writeHead(302, { Location: safeNext(url.searchParams.get('next')), 'Set-Cookie': cookieHeader(token), 'Cache-Control': 'no-store' }).end();
    return true;
  }
  const userId = await checkAccess(readCookie(req.headers.cookie, ACCESS_COOKIE), preview);
  if (!userId) {
    // Lien ouvert directement (donné par un agent, collé dans un message) : on passe par Skipper, qui reconnaît la personne
    // à son cookie de connexion et revient avec un lien d'accès. Seulement pour une navigation de premier niveau (le cookie
    // posé ensuite est alors celui du site visité) : dans un cadre, un cookie tiers refusé ferait boucler la redirection.
    if (req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document') {
      res.writeHead(302, { Location: openUrl(preview.worksessionId, url.pathname + url.search), 'Cache-Control': 'no-store' }).end();
      return true;
    }
    page(res, 401, 'Accès réservé', "Cet aperçu est réservé aux membres du projet. Ouvrez-le depuis la session dans Skipper (onglet « Aperçu »).");
    return true;
  }
  if (await handleAnnotateRoute(req, res, preview, userId)) return true;
  const upstream = await upstreamOf(preview);
  if (!upstream) {
    page(res, 502, 'Aperçu arrêté', NOT_RUNNING);
    return true;
  }
  const inject = wantsInjection(req);
  await new Promise<void>((resolve) => {
    const proxied = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers: forwardHeaders(req, upstream.port, inject) }, (up) => {
      if (inject && isPlainHtml(up)) {
        injectInto(up, res).catch(() => res.destroy()).finally(resolve);
        return;
      }
      // En-têtes bruts (liste à plat) : Set-Cookie multiples et casse préservés.
      res.writeHead(up.statusCode ?? 502, up.rawHeaders);
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', () => resolve());
    });
    proxied.on('error', () => {
      if (!res.headersSent) page(res, 502, 'Aperçu arrêté', NOT_RUNNING);
      else res.destroy();
      resolve();
    });
    req.pipe(proxied);
    res.on('close', () => {
      proxied.destroy();
      resolve();
    });
  });
  return true;
}

/** Réponse HTML non compressée, où l'on peut ajouter le script d'annotation. */
function isPlainHtml(up: IncomingMessage): boolean {
  const encoding = String(up.headers['content-encoding'] ?? 'identity').toLowerCase();
  const length = Number(up.headers['content-length'] ?? 0);
  return (up.statusCode ?? 0) === 200 && String(up.headers['content-type'] ?? '').toLowerCase().startsWith('text/html') && encoding === 'identity' && length <= INJECT_MAX_BYTES;
}

/** Relaie une page HTML en y ajoutant le script d'annotation (voir annotate.ts) ; trop grosse, elle part telle quelle. */
async function injectInto(up: IncomingMessage, res: ServerResponse): Promise<void> {
  // En-têtes de l'application, sauf ceux que la modification du corps rend faux (longueur, empreinte).
  const headers = (extra: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < up.rawHeaders.length; i += 2) {
      const name = up.rawHeaders[i].toLowerCase();
      if (name !== 'content-length' && name !== 'etag' && name !== 'transfer-encoding') out.push(up.rawHeaders[i], up.rawHeaders[i + 1]);
    }
    return [...out, ...extra];
  };
  const chunks: Buffer[] = [];
  let size = 0;
  let streaming = false;
  for await (const chunk of up) {
    const buf = chunk as Buffer;
    if (streaming) {
      res.write(buf);
      continue;
    }
    chunks.push(buf);
    size += buf.length;
    if (size > INJECT_MAX_BYTES) {
      streaming = true;
      res.writeHead(up.statusCode ?? 200, headers([]));
      res.write(Buffer.concat(chunks));
    }
  }
  if (!streaming) {
    const body = Buffer.from(injectScript(Buffer.concat(chunks).toString('utf8')), 'utf8');
    res.writeHead(up.statusCode ?? 200, headers(['Content-Length', String(body.length)]));
    res.write(body);
  }
  res.end();
}

/** Route de Skipper qui ouvre un aperçu à une personne connectée (voir `handlePreviewOpenRoute`). */
const OPEN_ROUTE = /^\/api\/previews\/([0-9a-f-]{36})\/open$/;
export const openUrl = (worksessionId: string, next = '/') => {
  const n = safeNext(next);
  return `${config.apiUrl}/api/previews/${worksessionId}/open${n === '/' ? '' : `?next=${encodeURIComponent(n)}`}`;
};

/**
 * GET /api/previews/<work session>/open[?next=/chemin] (domaine de Skipper) : la personne connectée et membre du projet
 * (lecteur suffit) est renvoyée vers l'aperçu avec un lien d'accès à usage unique ; sans connexion, vers la connexion
 * Google, qui revient ici. C'est par là que passe le lien public d'un aperçu ouvert hors de l'onglet « Aperçu ».
 */
export async function handlePreviewOpenRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(OPEN_ROUTE);
  if (!match) return false;
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return true;
  }
  const preview = await previewRepository.find(match[1]);
  if (!preview || !previewService.enabled()) {
    page(res, 404, 'Aperçu introuvable', "Cet aperçu n'existe pas, a été supprimé avec sa session, ou les aperçus ne sont pas activés sur ce serveur.");
    return true;
  }
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) {
    const here = `${url.pathname}${url.search}`;
    if (new URL(config.apiUrl).origin === new URL(config.appUrl).origin) {
      res.writeHead(302, { Location: `${config.apiUrl}/auth/google?next=${encodeURIComponent(here)}`, 'Cache-Control': 'no-store' }).end();
    } else page(res, 401, 'Connexion requise', "Connectez-vous à Skipper, puis rouvrez ce lien (ou ouvrez l'aperçu depuis l'onglet « Aperçu » de la session).");
    return true;
  }
  if (!(await allowed(user.id, preview.projectId))) {
    page(res, 403, 'Accès réservé', 'Cet aperçu est réservé aux membres du projet.');
    return true;
  }
  const location = await previewService.accessUrl(preview.worksessionId, user.id, safeNext(url.searchParams.get('next')));
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }).end();
  return true;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Demande d'upgrade WebSocket adressée à un aperçu (rechargement à chaud de Vite, Next…) : relayée telle quelle au
 * serveur de développement, après vérification du cookie d'accès. Renvoie false si l'hôte n'est pas un aperçu (la
 * demande suit alors le chemin habituel, avec son contrôle d'origine).
 */
export function previewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const t = template();
  const label = t ? labelFromHost(t, req.headers.host) : null;
  if (!label) return false;
  void (async () => {
    const preview = await previewRepository.findByLabel(label);
    if (!preview) return reject(socket, 404, 'Not Found');
    if (!(await checkAccess(readCookie(req.headers.cookie, ACCESS_COOKIE), preview))) return reject(socket, 401, 'Unauthorized');
    const upstream = await upstreamOf(preview);
    if (!upstream) return reject(socket, 502, 'Bad Gateway');
    const headers = forwardHeaders(req, upstream.port);
    const conn = net.connect(upstream.port, upstream.host, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        for (const value of Array.isArray(v) ? v : [String(v)]) raw += `${k}: ${value}\r\n`;
      }
      conn.write(`${raw}\r\n`);
      if (head.length) conn.write(head);
      socket.pipe(conn).pipe(socket);
    });
    conn.on('error', () => socket.destroy());
    socket.on('error', () => conn.destroy());
    socket.on('close', () => conn.destroy());
    conn.on('close', () => socket.destroy());
  })().catch((err) => {
    log.warn(`[previews] WebSocket refusé sur ${label} : ${(err as Error).message}`);
    reject(socket, 500, 'Internal Server Error');
  });
  return true;
}
