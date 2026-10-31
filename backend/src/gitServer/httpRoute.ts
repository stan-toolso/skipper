import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiKeyService } from '../apiKeys/service.js';
import { createAuthContext, roleFor } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import type { Project } from '../projects/types.js';
import type { ProjectRole } from '../users/types.js';
import { userService } from '../users/service.js';
import { gitBackupRepository } from './backups.js';
import { gitServerRoot } from './paths.js';
import { gitServer } from './service.js';
import { GIT_TOKEN_PREFIX, gitTokenService } from './tokens.js';

/**
 * Smart HTTP des dépôts hébergés : /api/git/<slug>.git/{info/refs,git-upload-pack,git-receive-pack,HEAD}, servi par
 * `git http-backend` (CGI) sur le dossier des dépôts nus. Authentification HTTP basic dont le mot de passe est un jeton
 * d'accès git de la personne (`tokens.ts`) ou une clé d'API du projet ; le rôle sur le projet décide : lecteur → clone
 * et fetch, membre et administrateur → push. Un push reçu déclenche la sauvegarde en base.
 * GET /api/git/<slug>.git/backup[?id=…] : téléchargement d'une sauvegarde (bundle), par le cookie de session.
 */

const ROUTE = /^\/api\/git\/([a-z0-9][a-z0-9-]{0,63})\.git(\/.*)?$/;
const CGI_PATHS = new Set(['/info/refs', '/git-upload-pack', '/git-receive-pack', '/HEAD']);

type Actor = { role: ProjectRole | null; remoteUser: string } | null;

function unauthorized(res: ServerResponse, message: string): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Skipper git"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function plain(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/** Qui agit, d'après l'en-tête Authorization : jeton git (mot de passe ou nom d'utilisateur), clé d'API du projet, ou Bearer. */
async function authenticate(req: IncomingMessage, project: Project): Promise<Actor> {
  const header = req.headers.authorization ?? '';
  const candidates: string[] = [];
  if (/^basic /i.test(header)) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (pass) candidates.push(pass);
    if (user) candidates.push(user);
  } else if (/^bearer /i.test(header)) {
    candidates.push(header.slice(7).trim());
  }
  for (const secret of candidates) {
    if (secret.startsWith(GIT_TOKEN_PREFIX)) {
      const auth = await gitTokenService.authenticate(secret);
      if (!auth) continue;
      const user = await userService.get(auth.userId).catch(() => null);
      if (!user) continue;
      return { role: await roleFor(createAuthContext(user), project.id), remoteUser: user.email };
    }
    const key = await apiKeyService.authenticate(secret);
    if (key) return { role: key.projectId === project.id ? 'member' : null, remoteUser: `api-key:${key.name}` };
  }
  return null;
}

/** Lance `git http-backend` en CGI : la requête lui est transmise, sa réponse (en-têtes CGI puis corps) est relayée. */
function runHttpBackend(req: IncomingMessage, res: ServerResponse, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', ['http-backend'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let head = Buffer.alloc(0);
    let headersDone = false;
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (!headersDone && !res.headersSent) res.writeHead(code === 0 ? 200 : 500);
      res.end();
      resolve(code);
    };
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.stdout.on('data', (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf('\r\n\r\n');
      let sepLength = 4;
      if (end < 0) {
        end = head.indexOf('\n\n');
        sepLength = 2;
      }
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 200;
        else headers[name] = value;
      }
      headers['Cache-Control'] ??= 'no-cache, max-age=0, must-revalidate';
      res.writeHead(status, headers);
      headersDone = true;
      const rest = head.subarray(end + sepLength);
      head = Buffer.alloc(0);
      child.stdout.removeAllListeners('data');
      if (rest.length) res.write(rest);
      child.stdout.pipe(res, { end: false });
    });
    child.on('error', (err) => {
      log.error('[git-server] http-backend', err);
      finish(1);
    });
    child.on('close', (code) => {
      if (code !== 0 || stderr.includes('fatal')) log.warn(`[git-server] http-backend ${env.PATH_INFO} (code ${code}) : ${stderr.trim()}`);
      finish(code ?? 1);
    });
    // Client parti : le processus ne doit pas survivre à la requête.
    res.on('close', () => {
      if (!settled) child.kill();
    });
    req.pipe(child.stdin);
  });
}

export async function handleGitHttpRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  const [, slug, sub = '/'] = match;
  const project = await projectRepository.findBySlug(slug);
  if (!project || !project.gitHosted) {
    plain(res, 404, 'Dépôt introuvable');
    return true;
  }

  if (sub === '/backup') {
    if (req.method !== 'GET') {
      plain(res, 405, 'Méthode non autorisée');
      return true;
    }
    const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
    const role = user ? await roleFor(createAuthContext(user), project.id) : null;
    if (!role) {
      plain(res, user ? 403 : 401, user ? 'Accès refusé' : 'Connexion requise');
      return true;
    }
    const id = url.searchParams.get('id') ?? (await gitBackupRepository.latest(project.id))?.id;
    const content = id ? await gitBackupRepository.content(id) : null;
    if (!content || content.projectId !== project.id) {
      plain(res, 404, 'Aucune sauvegarde');
      return true;
    }
    const stamp = content.takenAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.bundle.length, 'Content-Disposition': `attachment; filename="${slug}-${stamp}.bundle"`, 'Cache-Control': 'no-store' });
    res.end(content.bundle);
    return true;
  }

  if (!CGI_PATHS.has(sub)) {
    plain(res, 404, 'Seul le protocole smart HTTP est servi');
    return true;
  }
  const service = url.searchParams.get('service');
  const writing = sub === '/git-receive-pack' || service === 'git-receive-pack';
  const actor = await authenticate(req, project);
  if (!actor) {
    unauthorized(res, "Authentification requise : mot de passe = jeton d'accès git (page Dépôt du projet) ou clé d'API du projet");
    return true;
  }
  if (!actor.role) {
    plain(res, 403, "Vous n'êtes pas membre de ce projet");
    return true;
  }
  if (writing && actor.role === 'viewer') {
    plain(res, 403, 'Lecture seule : votre rôle sur ce projet ne permet pas de pousser');
    return true;
  }
  await gitServer.ensure(project);

  const env: Record<string, string> = {
    GIT_PROJECT_ROOT: gitServerRoot(),
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${slug}.git${sub}`,
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method ?? 'GET',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    REMOTE_USER: actor.remoteUser,
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
    SERVER_PROTOCOL: 'HTTP/1.1',
    GATEWAY_INTERFACE: 'CGI/1.1',
  };
  if (req.headers['content-length']) env.CONTENT_LENGTH = String(req.headers['content-length']);
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
  if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol']);
  if (req.headers['user-agent']) env.HTTP_USER_AGENT = String(req.headers['user-agent']);
  const code = await runHttpBackend(req, res, env);
  if (code === 0 && sub === '/git-receive-pack' && req.method === 'POST') gitServer.afterPush(project);
  return true;
}
