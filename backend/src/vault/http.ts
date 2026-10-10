import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../errors.js';

/**
 * Garde-fou des requêtes HTTP sortantes faites avec des identifiants du coffre (API HTTP, test des sites) :
 * toutes les adresses auxquelles un nom résout sont vérifiées et la connexion utilise une adresse vérifiée
 * (pas de fenêtre de « DNS rebinding »). Boucle locale, lien local, multidiffusion et plages réservées sont
 * toujours refusées ; les plages privées (RFC 1918, CGNAT, ULA) sauf VAULT_HTTP_ALLOW_PRIVATE=true.
 */

export type AddressClass = 'public' | 'private' | 'forbidden';

const allowPrivate = () => process.env.VAULT_HTTP_ALLOW_PRIVATE === 'true';

function ipv4Class(ip: string): AddressClass {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0) || a >= 224) return 'forbidden';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

export function classifyAddress(ip: string): AddressClass {
  if (net.isIPv4(ip)) return ipv4Class(ip);
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Class(mapped[1]);
  if (lower === '::' || lower === '::1' || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('ff') || lower.startsWith('2001:db8')) return 'forbidden';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
  return 'public';
}

function assertAddressAllowed(host: string, ip: string): void {
  const cls = classifyAddress(ip);
  if (cls === 'forbidden') throw new AppError(`Adresse refusée : ${host} mène à ${ip}, une adresse interne ou réservée`, 'FORBIDDEN');
  if (cls === 'private' && !allowPrivate()) throw new AppError(`Adresse refusée : ${host} mène à ${ip}, une adresse de réseau privé (VAULT_HTTP_ALLOW_PRIVATE=true pour l'autoriser)`, 'FORBIDDEN');
}

/** Vérifie une URL avant toute résolution : protocole, pas d'identifiants, pas de nom interne. */
export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError("L'adresse doit commencer par http:// ou https://");
  if (url.username || url.password) throw new AppError("L'adresse ne doit pas contenir d'identifiants");
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (['metadata', 'metadata.google.internal', 'metadata.goog', 'localhost'].includes(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new AppError(`Adresse refusée : ${host} est une adresse interne`, 'FORBIDDEN');
  }
  if (net.isIP(host)) assertAddressAllowed(host, host);
}

/** Résout toutes les adresses d'un hôte, les vérifie, et renvoie la première. */
export async function guardedLookup(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    assertAddressAllowed(host, host);
    return host;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new AppError(`Hôte ${host} introuvable : ${(err as Error).message}`);
  }
  if (!addresses.length) throw new AppError(`Hôte ${host} introuvable`);
  for (const { address } of addresses) assertAddressAllowed(host, address);
  return addresses[0].address;
}

export interface SafeResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
  truncated: boolean;
  url: string;
}

/**
 * Une requête HTTP, sans suivre les redirections (les identifiants voyageraient avec), corps plafonné.
 * L'hôte est résolu et vérifié ; la connexion vise l'adresse vérifiée (en-tête Host conservé).
 */
export async function safeRequest(url: URL, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string | null; timeoutMs?: number; maxBytes?: number } = {}): Promise<SafeResponse> {
  assertAllowedUrl(url);
  const address = await guardedLookup(url.hostname);
  const timeoutMs = init.timeoutMs ?? 30_000;
  const maxBytes = init.maxBytes ?? 256 * 1024;
  const target = new URL(url.toString());
  // Connexion sur l'adresse vérifiée ; pour https, le nom d'hôte reste nécessaire au certificat (SNI) :
  // Node n'expose pas de résolveur par requête à fetch, on utilise alors l'URL d'origine après vérification.
  const isLiteral = net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.protocol === 'http:' && !isLiteral) target.hostname = net.isIPv6(address) ? `[${address}]` : address;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...init.headers };
    if (target.hostname !== url.hostname) headers.host = url.host;
    const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : new Uint8Array(init.body);
    const res = await fetch(target, { method: init.method ?? 'GET', headers, body, redirect: 'manual', signal: controller.signal });
    const reader = res.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > maxBytes) {
          chunks.push(Buffer.from(value.subarray(0, maxBytes - size)));
          size = maxBytes;
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(Buffer.from(value));
        size += value.length;
      }
    }
    return { status: res.status, statusText: res.statusText, headers: res.headers, body: Buffer.concat(chunks), truncated, url: url.toString() };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new AppError(`Pas de réponse après ${Math.round(timeoutMs / 1000)} s`);
    if (err instanceof AppError) throw err;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new AppError(`Requête impossible : ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GET en suivant au plus cinq redirections, chaque saut vérifié par le garde-fou. */
export async function safeGetFollowing(url: URL, opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {}): Promise<SafeResponse & { redirected: boolean }> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await safeRequest(current, { ...opts, method: 'GET' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && hop < 5) {
      current = new URL(location, current);
      continue;
    }
    return { ...res, redirected: current.toString() !== url.toString(), url: current.toString() };
  }
  throw new AppError('Trop de redirections');
}
