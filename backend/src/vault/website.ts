import { AppError } from '../errors.js';
import { safeGetFollowing } from './http.js';
import type { VaultField } from './types.js';

/**
 * Sites web et secrets : validation des champs, nommage des variables, liaison au site, test HTTP.
 *
 * Un site web n'a pas de client dédié : c'est le navigateur headless des agents qui s'y connecte. L'agent
 * clique un champ du formulaire puis appelle `browser_fill` ; le serveur saisit la valeur à sa place, sur
 * le site de l'élément seulement, sans jamais la lui montrer.
 */

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function validateFieldKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (!KEY_RE.test(k)) throw new AppError(`Clé de champ invalide « ${key} » : lettres minuscules, chiffres et soulignés, 40 caractères maximum (ex. "username", "otp_secret")`);
  return k;
}

export function validateUrl(url: string | null | undefined): string {
  const u = url?.trim() ?? '';
  if (!u) throw new AppError("L'adresse du site est obligatoire");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new AppError(`Adresse invalide : ${u}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AppError("L'adresse du site doit commencer par http:// ou https://");
  return parsed.toString();
}

/**
 * Nom de variable d'un champ, commun au navigateur et au shell : NOM_DE_LA_CONNEXION_CLE en majuscules
 * (ex. connexion "admin-site", champ "password" → ADMIN_SITE_PASSWORD).
 */
export function variableName(connectionName: string, key: string): string {
  return `${connectionName}_${key}`.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

/** Hôte affiché pour un site (sans chemin ni identifiants). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Le site de l'élément autorise-t-il une saisie sur cette page ? Même hôte (ou sous-domaine), jamais https → http. */
export function siteAllows(itemUrl: string, pageOrigin: string): boolean {
  let site: URL;
  let page: URL;
  try {
    site = new URL(itemUrl);
    page = new URL(pageOrigin);
  } catch {
    return false;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  if (site.protocol === 'https:' && page.protocol !== 'https:') return false;
  const siteHost = site.hostname.toLowerCase();
  const pageHost = page.hostname.toLowerCase();
  if (pageHost === siteHost) return page.port === site.port;
  return pageHost.endsWith(`.${siteHost}`);
}

/** Résumé d'un champ pour les agents : valeur d'un champ public, clé d'un secret. */
export function describeField(f: VaultField): string {
  return f.secret ? `${f.key} (secret, saisi avec browser_fill)` : `${f.key} = ${JSON.stringify(f.value ?? '')}`;
}

/**
 * Test depuis l'interface : le site répond en HTTP. On ne tente pas de se connecter (les formulaires
 * de connexion sont tous différents) ; l'agent le fera avec le navigateur.
 */
export async function probe(url: string): Promise<{ detail: string }> {
  const res = await safeGetFollowing(new URL(url), { timeoutMs: 15_000, maxBytes: 200_000, headers: { 'user-agent': 'Skipper (test du coffre)', accept: 'text/html,*/*' } });
  const parts = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`];
  if (res.redirected) parts.push(`redirigé vers ${res.url}`);
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(res.body.toString('utf8'))?.[1]?.trim();
    if (title) parts.push(`« ${title.replace(/\s+/g, ' ').slice(0, 120)} »`);
  }
  if (res.status >= 400) throw new AppError(parts.join(' · '));
  return { detail: parts.join(' · ') };
}
