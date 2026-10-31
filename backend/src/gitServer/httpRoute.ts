import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthContext, roleFor } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config, forgejoConfigured } from '../config.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import { gitBackupRepository } from './backups.js';
import { forgejoAccounts } from './forgejo.js';
import { gitServer } from './service.js';

/**
 * Routes HTTP du serveur git hébergé (Forgejo) :
 * - GET /api/forge/auth : sous-requête `auth_request` de nginx devant Forgejo. La personne connectée à Skipper (cookie de
 *   session) est transmise à Forgejo par l'en-tête `X-Forge-User` (son compte Forgejo, créé au besoin), que nginx recopie
 *   dans `X-WEBAUTH-USER` (authentification par proxy de Forgejo). Sans session : git et l'API passent sans identité
 *   (ils s'authentifient par jeton), une page web répond 401 et nginx renvoie vers la connexion de Skipper.
 * - POST /api/forge/webhook : webhook d'organisation de Forgejo (signature HMAC) : un push déclenche la sauvegarde en
 *   base, un changement de pull request la synchronisation des PR suivies du projet.
 * - GET /api/repo-backups/<id> : téléchargement d'une sauvegarde (bundle), par le cookie de session.
 */

const BACKUP_ROUTE = /^\/api\/repo-backups\/([0-9a-f-]{36})$/;
const MAX_WEBHOOK_BODY = 5 * 1024 * 1024;

function plain(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(message);
}

/** Requête faite par git ou un client de l'API (authentifiés par jeton), pas par un navigateur. */
export function isMachineRequest(uri: string, headers: IncomingMessage['headers']): boolean {
  if (headers.authorization) return true;
  if (/^git\//i.test(String(headers['user-agent'] ?? ''))) return true;
  const p = uri.split('?')[0];
  return /\/api\/v1(\/|$)/.test(p) || /\.git(\/|$)/.test(p) || /\/info\/(refs|lfs)/.test(p) || /\/(git-upload-pack|git-receive-pack)$/.test(p);
}

async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uri = String(req.headers['x-original-uri'] ?? '');
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (user && forgejoConfigured()) {
    try {
      const username = await forgejoAccounts.ensure(user);
      return plain(res, 200, '', { 'X-Forge-User': username });
    } catch (err) {
      log.error('[forgejo] compte de la personne connectée', err);
      return plain(res, 503, 'Forgejo indisponible');
    }
  }
  if (isMachineRequest(uri, req.headers)) return plain(res, 200, '');
  return plain(res, 401, 'Connexion requise');
}

/** Corps brut d'une requête, borné. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('corps trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Signature d'un webhook Forgejo : HMAC-SHA256 hexadécimal du corps avec le secret partagé. */
export function validWebhookSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(signature.trim().replace(/^sha256=/, ''));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return plain(res, 405, 'Méthode non autorisée');
  const body = await readBody(req, MAX_WEBHOOK_BODY).catch(() => null);
  if (!body) return plain(res, 413, 'Corps trop volumineux');
  const signature = (req.headers['x-forgejo-signature'] ?? req.headers['x-gitea-signature']) as string | undefined;
  if (!validWebhookSignature(body, signature, config.forgejo.webhookSecret)) return plain(res, 401, 'Signature invalide');
  const event = String(req.headers['x-forgejo-event'] ?? req.headers['x-gitea-event'] ?? '');
  let payload: { repository?: { name?: string; owner?: { login?: string; username?: string } } };
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return plain(res, 400, 'JSON attendu');
  }
  const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.username;
  const slug = payload.repository?.name;
  if (!slug || owner?.toLowerCase() !== config.forgejo.org.toLowerCase()) return plain(res, 200, 'ignoré');
  const project = await projectRepository.findBySlug(slug);
  if (!project?.gitHosted) return plain(res, 200, 'ignoré');
  if (event === 'push') gitServer.afterPush(project);
  if (event.startsWith('pull_request')) {
    const { trackedPullRequestService } = await import('../pullRequests/service.js');
    void trackedPullRequestService.sync(project.id, null, { force: true }).catch((err) => log.warn(`[forgejo] synchronisation des PR de ${slug} : ${(err as Error).message}`));
  }
  return plain(res, 200, 'ok');
}

async function handleBackupDownload(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (req.method !== 'GET') return plain(res, 405, 'Méthode non autorisée');
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) return plain(res, 401, 'Connexion requise');
  const content = await gitBackupRepository.content(id);
  if (!content) return plain(res, 404, 'Sauvegarde introuvable');
  if (!(await roleFor(createAuthContext(user), content.projectId))) return plain(res, 403, 'Accès refusé');
  const project = await projectRepository.findById(content.projectId);
  const stamp = content.takenAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': content.bundle.length,
    'Content-Disposition': `attachment; filename="${project?.slug ?? 'depot'}-${stamp}.bundle"`,
    'Cache-Control': 'no-store',
  });
  res.end(content.bundle);
}

export async function handleGitHttpRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  if (url.pathname === '/api/forge/auth') {
    await handleAuth(req, res);
    return true;
  }
  if (url.pathname === '/api/forge/webhook') {
    await handleWebhook(req, res);
    return true;
  }
  const backup = url.pathname.match(BACKUP_ROUTE);
  if (backup) {
    await handleBackupDownload(req, res, backup[1]);
    return true;
  }
  return false;
}
