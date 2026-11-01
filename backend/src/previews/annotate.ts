import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthContext, requireProject } from '../auth/access.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { userRepository } from '../users/repository.js';
import type { PreviewRow } from './repository.js';

/**
 * Annotations sur l'aperçu (« je pointe, l'agent corrige ») : le proxy injecte dans chaque page HTML de l'aperçu un
 * petit script (`annotate-client.js`) qui ajoute un bouton « Annoter ». La personne clique sur un ou plusieurs éléments
 * de la page, écrit (ou dicte) ce qu'elle veut changer, et l'ensemble part comme une instruction à la session de la
 * branche, que le serveur de développement recharge ensuite tout seul. Le script parle au proxy par des chemins réservés
 * sous `/__skipper/`, avec le cookie d'accès de l'aperçu : rien à configurer dans l'application.
 */

export const ANNOTATE_SCRIPT_PATH = '/__skipper/annoter.js';
const SESSION_PATH = '/__skipper/session';
const ANNOTATIONS_PATH = '/__skipper/annotations';
/** En-tête exigé sur l'envoi : un formulaire d'un autre site ne peut pas le poser sans requête préalable CORS (refusée). */
const CSRF_HEADER = 'x-skipper-annotation';

const LIMITS = { annotations: 20, comment: 4000, selector: 500, text: 300, html: 2000, url: 2000, body: 256 * 1024 };
/** Page HTML plus grosse que ça : relayée telle quelle, sans script. */
export const INJECT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Le script, en ASCII seulement (accents et symboles échappés en \uXXXX) : il s'exécute correctement même dans une page
 * sans encodage déclaré, que le navigateur lirait en Latin-1.
 */
export const asciiOnly = (js: string) => js.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
let clientScript: string | null = null;
function client(): string {
  clientScript ??= asciiOnly(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'annotate-client.js'), 'utf8'));
  return clientScript;
}

/**
 * Faut-il injecter le script dans la réponse ? Seulement pour le chargement d'une page (navigation ou cadre de l'onglet
 * « Aperçu »), pas pour les modules, images ou appels d'API de l'application.
 */
export function wantsInjection(req: Pick<IncomingMessage, 'method' | 'headers'>): boolean {
  if (req.method !== 'GET') return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document' || dest === 'iframe';
  return String(req.headers.accept ?? '').includes('text/html');
}

/** Ajoute la balise du script à une page HTML (avant `</head>`, sinon avant `</body>`, sinon à la fin). */
export function injectScript(html: string): string {
  if (html.includes(ANNOTATE_SCRIPT_PATH)) return html;
  const tag = `<script src="${ANNOTATE_SCRIPT_PATH}" defer></script>`;
  for (const close of [/<\/head\s*>/i, /<\/body\s*>/i]) {
    const m = close.exec(html);
    if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
  }
  return html + tag;
}

/** Un élément pointé et ce qu'il faut en faire, tel qu'envoyé par le script. */
export interface Annotation {
  comment: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  /** Position dans la fenêtre au moment du clic (pixels CSS). */
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface AnnotationBatch {
  /** Chemin de la page (avec la requête), son titre, la taille de la fenêtre. */
  page: string;
  title: string;
  viewport: { width: number; height: number } | null;
  /** Remarque générale, sans élément pointé. */
  note: string;
  annotations: Annotation[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

/** Lit et borne le corps envoyé par le script ; null s'il ne contient rien d'exploitable. */
export function parseBatch(body: unknown): AnnotationBatch | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b.annotations) ? b.annotations.slice(0, LIMITS.annotations) : [];
  const annotations: Annotation[] = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => {
      const r = a.rect as Record<string, unknown> | null | undefined;
      return {
        comment: str(a.comment, LIMITS.comment).trim(),
        selector: str(a.selector, LIMITS.selector),
        tag: str(a.tag, 40).toLowerCase(),
        text: str(a.text, LIMITS.text).replace(/\s+/g, ' ').trim(),
        html: str(a.html, LIMITS.html),
        rect: r && typeof r === 'object' ? { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) } : null,
      };
    })
    .filter((a) => a.selector && a.comment);
  const note = str(b.note, LIMITS.comment).trim();
  if (!annotations.length && !note) return null;
  const v = b.viewport as Record<string, unknown> | null | undefined;
  return {
    page: str(b.page, LIMITS.url) || '/',
    title: str(b.title, 200).trim(),
    viewport: v && typeof v === 'object' ? { width: num(v.width), height: num(v.height) } : null,
    note,
    annotations,
  };
}

const fence = (s: string) => (s.includes('```') ? s.replace(/```/g, '``​`') : s);

/** Instruction envoyée à l'agent : où, quoi, et comment vérifier. */
export function formatInstruction(batch: AnnotationBatch, author: string): string {
  const n = batch.annotations.length;
  const lines: string[] = [];
  lines.push(`Retours de ${author} sur l'aperçu de cette branche (${n ? `${n} élément${n > 1 ? 's' : ''} annoté${n > 1 ? 's' : ''} dans la page` : 'remarque générale'}).`);
  const where = [`Page : ${batch.page}`];
  if (batch.title) where.push(`titre « ${batch.title} »`);
  if (batch.viewport) where.push(`fenêtre ${batch.viewport.width}×${batch.viewport.height} px${batch.viewport.width < 700 ? ' (téléphone)' : ''}`);
  lines.push(where.join(', '));
  if (batch.note) lines.push('', `Remarque générale : ${batch.note}`);
  batch.annotations.forEach((a, i) => {
    lines.push('', `${i + 1}. ${a.comment}`);
    const desc = [`sélecteur \`${a.selector}\``];
    if (a.text) desc.push(`texte « ${a.text} »`);
    if (a.rect) desc.push(`position ${a.rect.x},${a.rect.y} taille ${a.rect.width}×${a.rect.height}`);
    lines.push(`   Élément <${a.tag || '?'}> : ${desc.join(', ')}`);
    if (a.html) lines.push('   ```html', ...fence(a.html).split('\n').map((l) => `   ${l}`), '   ```');
  });
  lines.push(
    '',
    "Retrouve dans le code ce qui produit ces éléments et fais les changements demandés. Le serveur de développement de l'aperçu recharge la page tout seul : vérifie le résultat avec les outils `preview` (capture de la page, au format mobile si la fenêtre était celle d'un téléphone) avant de répondre, puis résume en une ou deux phrases ce que tu as changé.",
  );
  return lines.join('\n');
}

/** Session qui reçoit les annotations : la plus récente de la branche (hors relecture), non archivée. */
export async function targetSession(worksessionId: string): Promise<Session | null> {
  const sessions = await sessionRepository.list({ worksessionId, limit: 20 });
  return sessions.find((s) => !(s.config as { review?: unknown } | null)?.review) ?? null;
}

/** La personne peut-elle donner des instructions dans ce projet (membre) ? */
async function canInstruct(userId: string, projectId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (!user) return false;
  return requireProject(createAuthContext(user), projectId, 'member').then(() => true, () => false);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const sessionUrl = (id: string) => `${config.appUrl}/sessions/${id}`;
const sessionState = (s: Session) => ({ id: s.id, name: s.name, status: s.status, activity: s.activity, url: sessionUrl(s.id) });

/**
 * Chemins du script d'annotation sur le sous-domaine d'un aperçu (accès déjà vérifié par le proxy) ; false si le chemin
 * n'en est pas un (la requête part alors vers le serveur de développement).
 */
export async function handleAnnotateRoute(req: IncomingMessage, res: ServerResponse, preview: PreviewRow, userId: string): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://apercu').pathname;
  if (pathname === ANNOTATE_SCRIPT_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(client());
    return true;
  }
  if (pathname === SESSION_PATH) {
    if (req.method !== 'GET') return json(res, 405, { error: 'Méthode non autorisée' }), true;
    const [session, allowed] = await Promise.all([targetSession(preview.worksessionId), canInstruct(userId, preview.projectId)]);
    json(res, 200, { canAnnotate: allowed && !!session, session: session ? sessionState(session) : null });
    return true;
  }
  if (pathname === ANNOTATIONS_PATH) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée' }), true;
    if (req.headers[CSRF_HEADER] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 400, { error: 'Requête refusée' }), true;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Origine refusée' }), true;
    if (!(await canInstruct(userId, preview.projectId))) return json(res, 403, { error: 'Seuls les membres du projet peuvent donner des instructions à la session.' }), true;
    const raw = await readBody(req, LIMITS.body);
    let batch: AnnotationBatch | null = null;
    try {
      batch = raw ? parseBatch(JSON.parse(raw)) : null;
    } catch {
      batch = null;
    }
    if (!batch) return json(res, 400, { error: 'Annotation vide : pointez un élément et écrivez ce qu’il faut changer.' }), true;
    const session = await targetSession(preview.worksessionId);
    if (!session) return json(res, 409, { error: "Aucune session sur cette branche : ouvrez-en une dans Skipper pour lui envoyer vos annotations." }), true;
    const user = await userRepository.findById(userId);
    try {
      const sent = await sessionService.sendMessage(session.id, formatInstruction(batch, user?.name || user?.email || 'un membre du projet'));
      log.info(`[previews] ${batch.annotations.length} annotation(s) envoyée(s) à la session ${session.id} par ${userId}`);
      json(res, 200, { session: sessionState(sent) });
    } catch (err) {
      json(res, 409, { error: (err as Error).message });
    }
    return true;
  }
  return false;
}
