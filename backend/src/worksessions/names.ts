import { slugify } from '../projects/slug.js';

/** Longueur maximale du libellé d'une work session. */
export const LABEL_MAX = 100;

/** `base`, ou `base-2`, `base-3`… quand une work session de la liste le porte déjà. */
export function uniqueName(worksessions: { name: string }[], base: string): string {
  const taken = new Set(worksessions.map((w) => w.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60)}-${i}`;
  return name;
}

/**
 * Noms d'une work session dérivés de ce dont elle parle (première consigne de sa session, titre d'une
 * tâche) : le libellé est la première ligne, le dossier (et la branche) un slug de ses premiers mots.
 * Pur : le frontend en a le miroir (`frontend/src/lib/worksessions.ts`).
 */
export function namesFromText(text: string, prefix = ''): { label: string; name: string } {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
  const words = slugify(line).split('-').filter(Boolean);
  let slug = '';
  for (const w of words) {
    if (slug && (slug.length + 1 + w.length > 40 || slug.split('-').length >= 6)) break;
    slug = slug ? `${slug}-${w}` : w.slice(0, 40);
  }
  return { label: line, name: `${prefix}${slug || 'travail'}` };
}
