import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/** Gabarit d'adresse des aperçus (`PREVIEW_URL`), décomposé. */
export interface PreviewUrlTemplate {
  protocol: 'http:' | 'https:';
  /** Suffixe du nom d'hôte, après le nom de l'aperçu : `.apercu.skipper.toolso.io`. */
  suffix: string;
  /** Port explicite (`:4000`), ou ''. */
  port: string;
}

/** Lit `https://*.apercu.exemple.fr` ; null si vide ou mal formé (le `*` doit être le premier composant du nom). */
export function parsePreviewTemplate(raw: string): PreviewUrlTemplate | null {
  const m = raw.trim().match(/^(https?):\/\/\*((?:\.[a-z0-9-]+)+)(:\d+)?\/?$/i);
  if (!m) return null;
  return { protocol: `${m[1].toLowerCase()}:` as 'http:' | 'https:', suffix: m[2].toLowerCase(), port: m[3] ?? '' };
}

/** Adresse publique d'un aperçu (sans chemin). */
export const previewOrigin = (t: PreviewUrlTemplate, label: string) => `${t.protocol}//${label}${t.suffix}${t.port}`;

/** Nom de l'aperçu d'après l'en-tête Host (port ignoré), ou null si l'hôte n'est pas un aperçu. */
export function labelFromHost(t: PreviewUrlTemplate, host: string | undefined): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  if (!name.endsWith(t.suffix)) return null;
  const label = name.slice(0, -t.suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

/**
 * Nom d'un nouvel aperçu (composant DNS de 63 caractères au plus) : le dossier de la work session et le projet, lisibles,
 * suivis d'un suffixe aléatoire qui le rend imprévisible et unique (`ma-branche-skipper-3f9a1c`).
 */
export function newHostLabel(worksessionName: string, projectSlug: string): string {
  const clean = (s: string, max: number) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
  const parts = [clean(worksessionName, 32), clean(projectSlug, 20), randomBytes(3).toString('hex')].filter(Boolean);
  return parts.join('-');
}

/** Ports internes au conteneur réservés aux aperçus (un par work session du projet). */
export const PREVIEW_PORT_MIN = 41000;
export const PREVIEW_PORT_MAX = 41999;

/** Plus petit port libre de la plage, ou null si elle est pleine. */
export function freePort(used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let p = PREVIEW_PORT_MIN; p <= PREVIEW_PORT_MAX; p++) if (!taken.has(p)) return p;
  return null;
}

/** Chemin de redirection après l'accès : un chemin local seulement (jamais `//autre-site` ni une URL absolue). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/** Aperçus activés sur ce serveur : PREVIEW_URL renseignée et bien formée. */
export const previewsEnabled = (): boolean => parsePreviewTemplate(config.previewUrl) !== null;
