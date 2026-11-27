import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { artifactDataService } from './dataService.js';
import { embedStyle, parseEmbedRegion, parseEmbedTheme } from '../cockpit/embedTheme.js';
import { liveSources } from '../cockpit/liveSources.js';
import { projectService } from '../projects/service.js';
import { INJECT_MAX_BYTES, injectCommentScript, injectDataScript, injectEmbed, injectSlidesScript } from './inject.js';
import { sharedPageRepository } from './repository.js';
import { userRepository } from '../users/repository.js';
import { downloadName, sharedPageService } from './service.js';

const ROUTE = /^\/api\/shared\/([0-9a-f-]{36})$/;
const INFO_ROUTE = /^\/api\/shared\/([0-9a-f-]{36})\/info$/;

/**
 * GET /api/shared/<id>/info : titre, type et auteur d'une page publique, lus sans connexion par la page publique du
 * frontend (pages/PublicSharedPage.tsx). 404 pour toute autre page (son existence n'est pas révélée).
 */
async function handleInfo(id: string, res: ServerResponse): Promise<void> {
  const page = await sharedPageService.getPublic(id);
  if (!page) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const owner = await userRepository.findById(page.ownerId).catch(() => null);
  const body = { id: page.id, title: page.title, description: page.description, kind: page.kind, version: page.version, updatedAt: page.updatedAt.toISOString(), ownerName: owner?.name ?? null };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

/** Paramètres d'un bloc (JSON dans l'URL) : un objet, 4 Ko au plus ; sinon vide. */
function parseParams(raw: string | null): Record<string, unknown> {
  if (!raw || raw.length > 4096) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * GET /api/shared/<id>[?v=N][&download=1] : contenu HTML d'une page partagée, servi dans un bac à sable
 * (CSP `sandbox` sans `allow-same-origin` : origine opaque, la page ne lit ni le stockage de l'application
 * ni son API avec le cookie). Les droits sont revérifiés à chaque chargement. Renvoie false hors route.
 * Hors téléchargement (`download=1`) et sauf `raw=1`, le script des commentaires ancrés est injecté dans la page
 * (voir `inject.ts`) : il dialogue avec l'application par postMessage pour pointer un élément et placer les repères.
 * Artefact de données : les données de ses sources sont injectées en tête de la page (`window.Skipper`), téléchargement
 * compris (la page reste lisible hors de Skipper, avec les données du moment) ; l'ouverture est notée (`viewed_at`),
 * ce qui garde le rafraîchissement automatique en marche. Artefact de diapositives : le lecteur est injecté (mode
 * `thumb=1` pour l'aperçu réduit, `print=1` pour l'export PDF : toutes les diapositives puis impression), sauf au
 * téléchargement et avec `raw=1` (le fichier HTML tel que publié).
 * Page publique (`publicAccess`) : servie aussi sans connexion, sans commentaires, mode bloc ni sources graphql vivantes
 * (lues aux droits de la personne qui regarde). GET /api/shared/<id>/info en donne le titre et le type, pour la page
 * publique du frontend.
 */
export async function handleSharedPageRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  const info = url.pathname.match(INFO_ROUTE);
  if (info && req.method === 'GET') {
    await handleInfo(info[1], res).catch(() => res.writeHead(500).end());
    return true;
  }
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
  try {
    // Sans connexion : seulement une page publique (sinon on invite à se connecter, sans révéler si elle existe).
    const page = user ? await sharedPageService.getFor(user.id, match[1]) : await sharedPageService.getPublic(match[1]);
    if (!page) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Connectez-vous à Skipper pour ouvrir cette page.');
      return true;
    }
    const v = url.searchParams.get('v');
    const content = await sharedPageService.content(page, v ? Number(v) : null);
    const download = url.searchParams.get('download') === '1';
    const raw = download || url.searchParams.get('raw') === '1' || content.html.length > INJECT_MAX_BYTES;
    let html = content.html;
    // Type de la version servie (une republication peut l'avoir changé) ; celui de l'artefact si elle ne l'a pas gardé.
    const kind = content.version === page.version ? page.kind : ((await sharedPageRepository.version(page.id, content.version))?.kind ?? page.kind);
    // Bloc de tableau de bord et commentaires : réservés aux personnes connectées.
    const embed = Boolean(user) && !raw && url.searchParams.get('embed') === '1';
    const blockParams = embed ? parseParams(url.searchParams.get('params')) : {};
    const project = page.projectId ? await projectService.get(page.projectId).catch(() => null) : null;
    if (kind === 'data' && content.html.length <= INJECT_MAX_BYTES && url.searchParams.get('raw') !== '1') {
      const sources = await artifactDataService.sourcesAt(page, content.version, true);
      // Sources graphql : exécutées maintenant, aux droits de la personne qui regarde (jamais gardées en base).
      const live = new Map<string, Awaited<ReturnType<typeof liveSources.run>>>();
      for (const s of sources) {
        if (s.kind !== 'graphql' || s.status === 'inactive') continue;
        // Lecteur anonyme d'une page publique : une source vivante se lit avec les droits de qui regarde, donc rien.
        if (!user) {
          live.set(s.name, { data: null, status: 'error', error: 'Connectez-vous à Skipper pour voir ces données.', durationMs: 0 });
          continue;
        }
        live.set(s.name, await liveSources.run(s, user, { project: project ? { id: project.id, name: project.name } : null, viewer: { id: user.id, name: user.name }, params: blockParams }, content.version));
      }
      const data = Object.fromEntries(sources.map((s) => [s.name, live.has(s.name) ? live.get(s.name)!.data : s.data]));
      const meta = {
        refreshedAt: page.dataRefreshedAt?.toISOString() ?? null,
        sources: sources.map((s) => {
          const l = live.get(s.name);
          return l
            ? { name: s.name, kind: s.kind, status: l.status, error: l.error, rowCount: null, refreshedAt: new Date().toISOString(), live: true }
            : { name: s.name, kind: s.kind, status: s.status, error: s.error, rowCount: s.rowCount, refreshedAt: s.refreshedAt?.toISOString() ?? null };
        }),
      };
      html = Buffer.from(injectDataScript(html.toString('utf8'), { data, meta }), 'utf8');
      // Aperçu réduit de la galerie (`thumb=1`) : pas une lecture, le rafraîchissement automatique n'en tient pas compte.
      if (!download && url.searchParams.get('thumb') !== '1') void sharedPageRepository.touchViewed(page.id).catch(() => undefined);
    }
    if (!raw && kind === 'slides') {
      const mode = url.searchParams.get('print') === '1' ? 'print' : url.searchParams.get('thumb') === '1' ? 'thumb' : 'view';
      html = Buffer.from(injectSlidesScript(html.toString('utf8'), mode), 'utf8');
    }
    // Bloc d'un tableau de bord (`embed=1`) : style du thème, contexte du bloc et script d'intégration ; pas de commentaires
    // (on commente depuis la page entière). Les paramètres du bloc arrivent en JSON (`params`), bornés.
    if (embed) {
      const theme = parseEmbedTheme(url.searchParams.get('theme'));
      const context = {
        scope: (url.searchParams.get('scope') ?? '').slice(0, 120),
        region: parseEmbedRegion(url.searchParams.get('region')),
        params: blockParams,
        viewer: { id: user!.id, name: user!.name },
        project: project ? { id: project.id, name: project.name } : null,
        artifact: { id: page.id, version: content.version, kind },
        theme,
      };
      html = Buffer.from(injectEmbed(html.toString('utf8'), { style: embedStyle(theme), context }), 'utf8');
    } else if (!raw && user) html = Buffer.from(injectCommentScript(html.toString('utf8')), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(download ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName(page.title))}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (err) {
    const status = err instanceof AppError ? (err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400) : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(status === 500 ? 'Impossible de lire la page.' : (err as Error).message);
  }
  return true;
}
