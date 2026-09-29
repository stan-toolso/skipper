import { AppError } from '../errors.js';
import type { Connection, WebsiteField } from './types.js';

/**
 * Sites web : validation des champs, nommage des variables, fichier de secrets du navigateur, test HTTP.
 *
 * Une connexion « site web » n'a pas de client dédié : c'est le navigateur headless des agents
 * (Playwright MCP) qui se connecte au site. Son option `--secrets` charge un fichier dotenv ; quand
 * l'agent tape le nom d'une variable dans un champ (`browser_type`, `browser_fill_form`), Playwright
 * saisit la valeur à sa place et la masque dans ses réponses et journaux.
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
 * Nom de variable d'un champ pour le navigateur : NOM_DE_LA_CONNEXION_CLE en majuscules
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

/**
 * Fichier dotenv pour `--secrets` : une ligne NOM=valeur par secret. Le parseur dotenv de Playwright ne
 * déséchappe rien dans une valeur entre apostrophes, mais convertit `\n` entre guillemets : on choisit
 * donc le délimiteur que la valeur ne contient pas, sans jamais l'altérer.
 */
export function renderSecretsFile(secrets: Record<string, string>): string {
  const lines = ['# Généré par Skipper pour la durée de la session : secrets des sites web du projet.'];
  for (const [name, value] of Object.entries(secrets)) lines.push(`${name}=${quoteDotenv(name, value)}`);
  return `${lines.join('\n')}\n`;
}

function quoteDotenv(name: string, value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new AppError(`Le secret ${name} contient à la fois des apostrophes, des guillemets et des accents graves : le navigateur ne peut pas le recevoir. Changez-le.`);
}

/** Résumé d'un champ pour les agents : valeur d'un champ public, nom de variable d'un secret. */
export function describeField(c: Pick<Connection, 'name'>, f: WebsiteField): string {
  const name = variableName(c.name, f.key);
  return f.secret ? `${f.key} (secret, variable ${name})` : `${f.key} = ${JSON.stringify(f.value ?? '')}`;
}

/**
 * Test depuis l'interface : le site répond en HTTP. On ne tente pas de se connecter (les formulaires
 * de connexion sont tous différents) ; l'agent le fera avec le navigateur.
 */
export async function probe(url: string): Promise<{ detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'Skipper (test de connexion)', accept: 'text/html,*/*' } });
    const parts = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`];
    if (res.url && res.url !== url) parts.push(`redirigé vers ${res.url}`);
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      const html = (await res.text()).slice(0, 200_000);
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
      if (title) parts.push(`« ${title.replace(/\s+/g, ' ').slice(0, 120)} »`);
    }
    if (res.status >= 400) throw new AppError(parts.join(' · '));
    return { detail: parts.join(' · ') };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as Error).name === 'AbortError') throw new AppError('Le site ne répond pas (délai de 15 s dépassé)');
    const cause = (err as { cause?: { message?: string; code?: string } }).cause;
    throw new AppError(`Site injoignable : ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
