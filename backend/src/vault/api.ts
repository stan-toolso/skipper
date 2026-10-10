import { AppError } from '../errors.js';
import { assertAllowedUrl, safeRequest } from './http.js';
import type { ApiCredentials, ApiSettings } from './types.js';

/**
 * API HTTP du coffre : l'agent donne un chemin relatif à l'URL de base ; la requête reste sur cette
 * origine et sous ce chemin, l'authentification est ajoutée par le serveur, les redirections ne sont
 * pas suivies, le jeton est masqué dans la réponse.
 */

export const API_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];
const READ_METHODS: ApiMethod[] = ['GET', 'HEAD', 'OPTIONS'];
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const FORBIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'forwarded', 'metadata-flavor', 'x-google-metadata-request']);
const SHOWN_HEADERS = ['content-type', 'location', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'link', 'etag', 'last-modified'];

export interface ApiCall {
  method?: string | null;
  path: string;
  query?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  body?: string | null;
}

/** Valide l'URL de base d'un élément : http(s), sans identifiants ni adresse interne, sans requête ni ancre. */
export function validateBaseUrl(raw: string | null | undefined): string {
  const u = raw?.trim() ?? '';
  if (!u) throw new AppError("L'adresse de l'API est obligatoire");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new AppError(`Adresse invalide : ${u}`);
  }
  assertAllowedUrl(parsed);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** Vérifie la méthode, les en-têtes et le corps d'un appel, selon la politique de l'élément. */
export function validateCall(settings: ApiSettings, readOnly: boolean, call: ApiCall): { method: ApiMethod; headers: Record<string, string>; body: Buffer | null } {
  const method = (call.method ?? 'GET').toUpperCase() as ApiMethod;
  if (!API_METHODS.includes(method)) throw new AppError(`Méthode HTTP inconnue : ${call.method}`);
  if (readOnly && !READ_METHODS.includes(method)) throw new AppError(`Cet élément est en lecture seule : ${method} refusé (seuls GET, HEAD et OPTIONS sont autorisés)`, 'FORBIDDEN');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.headers ?? {})) {
    const name = k.trim().toLowerCase();
    if (FORBIDDEN_HEADERS.has(name) || name.startsWith('x-forwarded-') || (settings.authScheme === 'header' && name === settings.authName?.toLowerCase())) {
      throw new AppError(`L'en-tête ${k} ne peut pas être fixé par l'agent`, 'FORBIDDEN');
    }
    headers[name] = String(v);
  }
  const body = call.body ? Buffer.from(call.body, 'utf8') : null;
  if (body && body.length > MAX_BODY) throw new AppError(`Corps trop volumineux (${Math.round(body.length / 1024)} Ko, 1 Mo maximum)`);
  return { method, headers, body };
}

/** Cible d'un appel : chemin relatif résolu sous l'URL de base, sans en sortir. */
export function resolveTarget(baseUrl: string, path: string, query?: Record<string, string> | null): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const trimmed = path.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) throw new AppError("Donnez un chemin relatif à l'adresse de l'API, pas une URL complète");
  let target: URL;
  try {
    target = new URL(trimmed.replace(/^\/+/, ''), `${base.origin}${basePath}`);
  } catch {
    throw new AppError(`Chemin invalide : ${path}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.pathname);
  } catch {
    throw new AppError('Chemin mal encodé');
  }
  if (target.origin !== base.origin) throw new AppError("La requête doit rester sur l'adresse de l'API", 'FORBIDDEN');
  if (!`${target.pathname}/`.startsWith(basePath) || decoded.split('/').includes('..')) throw new AppError(`La requête doit rester sous ${basePath}`, 'FORBIDDEN');
  for (const [k, v] of Object.entries(query ?? {})) target.searchParams.append(k, String(v));
  return target;
}

/** Masque le secret (brut, encodé pour une URL, et en base64 utilisateur:secret) dans un texte. */
export function redact(text: string, creds: ApiCredentials): string {
  const forms = new Set<string>();
  if (creds.token.length >= 4) {
    forms.add(creds.token);
    forms.add(encodeURIComponent(creds.token));
    if (creds.authScheme === 'basic') forms.add(Buffer.from(`${creds.username ?? ''}:${creds.token}`).toString('base64'));
  }
  let out = text;
  for (const f of forms) out = out.split(f).join('[secret masqué]');
  return out;
}

export interface ApiResult {
  status: number;
  statusText: string;
  durationMs: number;
  text: string;
  url: string;
}

/** Exécute l'appel avec les identifiants de l'élément et rend la réponse pour l'agent. */
export async function execute(creds: ApiCredentials, readOnly: boolean, call: ApiCall): Promise<ApiResult> {
  const { method, headers, body } = validateCall(creds, readOnly, call);
  const target = resolveTarget(creds.baseUrl, call.path, call.query);
  const sent: Record<string, string> = { 'user-agent': 'Skipper (coffre)', accept: 'application/json, text/*;q=0.9, */*;q=0.5', ...headers };
  if (body && !sent['content-type']) sent['content-type'] = 'application/json';
  switch (creds.authScheme) {
    case 'bearer':
      sent.authorization = `Bearer ${creds.token}`;
      break;
    case 'basic':
      sent.authorization = `Basic ${Buffer.from(`${creds.username ?? ''}:${creds.token}`).toString('base64')}`;
      break;
    case 'header':
      sent[creds.authName!.toLowerCase()] = creds.token;
      break;
    case 'query':
      if (target.searchParams.has(creds.authName!)) throw new AppError(`Le paramètre ${creds.authName} est réservé à l'authentification`, 'FORBIDDEN');
      target.searchParams.set(creds.authName!, creds.token);
      break;
  }
  const started = Date.now();
  const res = await safeRequest(target, { method, headers: sent, body, timeoutMs: 60_000, maxBytes: MAX_RESPONSE });
  const shownUrl = new URL(target.toString());
  if (creds.authScheme === 'query') shownUrl.searchParams.delete(creds.authName!);
  const lines = [`${method} ${shownUrl} → HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} · ${Date.now() - started} ms`];
  for (const h of SHOWN_HEADERS) {
    const v = res.headers.get(h);
    if (v) lines.push(`${h}: ${v}`);
  }
  if (res.status >= 300 && res.status < 400) lines.push('(redirection non suivie)');
  lines.push('');
  const type = res.headers.get('content-type') ?? '';
  if (res.body.length === 0) lines.push('(corps vide)');
  else if (/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|problem\+json|ld\+json))/i.test(type) || /\+json|\+xml/i.test(type)) {
    let text = res.body.toString('utf8');
    if (/json/i.test(type)) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* JSON invalide ou tronqué : tel quel */
      }
    }
    lines.push(text);
  } else lines.push(`(${res.body.length} octets de ${type || 'type inconnu'}, non affichés)`);
  if (res.truncated) lines.push(`--- réponse tronquée après ${MAX_RESPONSE} octets : affinez la requête (filtres, pagination) ---`);
  return { status: res.status, statusText: res.statusText, durationMs: Date.now() - started, text: redact(lines.join('\n'), creds), url: shownUrl.toString() };
}

/** Test depuis l'interface : GET de l'URL de base. */
export async function probe(creds: ApiCredentials): Promise<{ detail: string }> {
  const result = await execute(creds, true, { method: 'GET', path: '' });
  const status = `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`;
  if (result.status === 401 || result.status === 403) throw new AppError(`${status} : le jeton est refusé`);
  if (result.status >= 500) throw new AppError(`${status} : l'API est en erreur`);
  if (result.status >= 400) return { detail: `${status} (l'API répond ; la racine n'est pas une ressource)` };
  return { detail: status };
}
