import path from 'node:path';
import { AppError } from '../errors.js';

/**
 * Modèles des fichiers d'environnement : texte libre où `{{vault:élément.champ}}` désigne une valeur du coffre,
 * remplacée à l'écriture dans le dossier de travail. Pour un fichier dotenv (`.env`, `.env.local`, `x.env`), les
 * clés se lisent et s'ajoutent ligne à ligne (`CLÉ=valeur`, `export CLÉ=valeur` accepté). Fonctions pures.
 */

/** Référence au coffre : nom d'élément (minuscules, chiffres, `-`, `_`) et clé du champ. */
const REF_RE = /\{\{\s*vault:([a-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*\}\}/g;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

export const PATH_MAX = 200;
export const CONTENT_MAX = 256 * 1024;

export interface VaultRef {
  item: string;
  field: string;
  /** Texte exact de la référence dans le modèle. */
  raw: string;
}

export const vaultRef = (item: string, field: string) => `{{vault:${item}.${field}}}`;

/** Références au coffre d'un modèle, dans l'ordre, sans doublon. */
export function references(content: string): VaultRef[] {
  const out: VaultRef[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(REF_RE)) {
    const key = `${m[1]}.${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ item: m[1], field: m[2], raw: m[0] });
  }
  return out;
}

/** Fichier au format dotenv d'après son nom : `.env`, `.env.*`, `*.env`. */
export function isDotenv(filePath: string): boolean {
  const base = path.posix.basename(filePath);
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

/**
 * Chemin relatif au dossier de travail, normalisé : ni absolu, ni `..`, ni `.git`, ni caractère de contrôle.
 * Le confinement réel (liens symboliques) est vérifié à l'écriture.
 */
export function normalizePath(raw: string): string {
  const cleaned = path.posix.normalize((raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, ''));
  if (!cleaned || cleaned === '.' || cleaned.endsWith('/')) throw new AppError('Chemin du fichier obligatoire (ex. « .env », « backend/.env »)');
  if (cleaned.startsWith('/')) throw new AppError('Le chemin doit être relatif au dossier de travail');
  if (cleaned.length > PATH_MAX) throw new AppError(`Chemin trop long (${PATH_MAX} caractères au plus)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(cleaned)) throw new AppError('Le chemin contient un caractère invalide');
  const segments = cleaned.split('/');
  if (segments.some((s) => s === '..')) throw new AppError('Le chemin ne peut pas sortir du dossier de travail');
  if (segments.some((s) => s === '.git')) throw new AppError('Le dossier .git est réservé');
  return cleaned;
}

/** Valeur dotenv : brute si elle ne contient rien de spécial, sinon entre guillemets doubles avec échappements. */
export function quoteDotenv(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** Valeur d'une ligne dotenv telle que l'écrit le modèle : guillemets retirés, commentaire de fin retiré si non citée. */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  const hash = v.search(/\s#/);
  return hash >= 0 ? v.slice(0, hash).trim() : v;
}

export interface DotenvEntry {
  key: string;
  /** Valeur du modèle (références au coffre non résolues). */
  value: string;
  /** Références au coffre de cette valeur. */
  refs: VaultRef[];
}

/** Clés d'un fichier dotenv, dans l'ordre ; la dernière définition d'une clé l'emporte (comme dotenv). */
export function parseDotenv(content: string): DotenvEntry[] {
  const byKey = new Map<string, DotenvEntry>();
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const value = unquote(m[2]);
    byKey.delete(m[1]);
    byKey.set(m[1], { key: m[1], value, refs: references(value) });
  }
  return [...byKey.values()];
}

export function validateKey(key: string): string {
  const k = (key ?? '').trim();
  if (!KEY_RE.test(k) || k.length > 200) throw new AppError(`Clé invalide : « ${key} » (lettres, chiffres, _ . -, sans commencer par un chiffre)`);
  return k;
}

/**
 * Ajoute ou remplace une clé dans un texte dotenv : la dernière ligne qui la définit est réécrite (les précédentes,
 * masquées par elle, sont retirées), sinon une ligne est ajoutée à la fin. Une valeur qui n'est qu'une référence au
 * coffre est écrite telle quelle (elle sera citée au rendu).
 */
export function setDotenvKey(content: string, key: string, value: string): string {
  const k = validateKey(key);
  const line = `${k}=${isSingleRef(value) ? value.trim() : quoteDotenv(value)}`;
  const lines = content === '' ? [] : content.split('\n');
  const hits = lines.map((l, i) => (LINE_RE.exec(l.replace(/\r$/, ''))?.[1] === k ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) {
    if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line);
    else lines.push(line, '');
    return lines.join('\n');
  }
  const last = hits[hits.length - 1];
  lines[last] = line;
  return lines.filter((_, i) => !hits.slice(0, -1).includes(i)).join('\n');
}

/** Retire une clé (toutes ses définitions) d'un texte dotenv ; renvoie null si elle n'y était pas. */
export function unsetDotenvKey(content: string, key: string): string | null {
  const k = validateKey(key);
  const lines = content.split('\n');
  const kept = lines.filter((l) => LINE_RE.exec(l.replace(/\r$/, ''))?.[1] !== k);
  return kept.length === lines.length ? null : kept.join('\n');
}

const isSingleRef = (value: string) => {
  const v = value.trim();
  const refs = [...v.matchAll(REF_RE)];
  return refs.length === 1 && refs[0][0] === v;
};

/**
 * Rend un modèle : chaque référence est remplacée par `resolve(item, field)`. Dans un fichier dotenv, une valeur
 * faite d'une seule référence non citée (`CLÉ={{vault:x.y}}`) est citée si besoin, pour qu'un mot de passe avec
 * espaces, `#` ou guillemets reste une seule valeur.
 */
export function render(content: string, dotenv: boolean, resolve: (item: string, field: string) => string): string {
  const sub = (s: string) => s.replace(REF_RE, (_, item: string, field: string) => resolve(item, field));
  if (!dotenv) return sub(content);
  return content
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(\{\{[^}]*\}\})(\s*)(\r?)$/.exec(line);
      if (m && isSingleRef(m[2])) return `${m[1]}${quoteDotenv(sub(m[2]))}${m[4]}`;
      return sub(line);
    })
    .join('\n');
}
