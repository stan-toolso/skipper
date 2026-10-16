/** Longueur maximale du libellé d'une work session (même règle que le serveur). */
export const LABEL_MAX = 100;

/** Même règle que le serveur (projects/slug.ts) : le nom de dossier réellement utilisé. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Nom de branche git dérivé d'un nom libre (barres obliques gardées : « feature/contact » reste une branche). */
export function branchFromName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
}

/**
 * Noms d'une work session dérivés de ce dont elle parle (la consigne tapée dans le lanceur) : le libellé est
 * la première ligne, le dossier (et la branche) un slug de ses premiers mots. Miroir de `worksessions/names.ts`
 * côté serveur, qui fixe les noms définitifs (uniques dans le projet).
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

const NOUNS = ['loutre', 'comete', 'erable', 'faucon', 'phare', 'braise', 'prairie', 'galet', 'sommet', 'saule', 'canyon', 'lanterne'];
const ADJECTIVES = ['agile', 'calme', 'vive', 'brave', 'sereine', 'futee', 'douce', 'noble', 'rapide', 'solaire', 'claire', 'fidele'];

/** Nom proposé pour une work session créée sans dire à quoi elle sert, ex. « loutre-agile ». */
export function suggestWorksessionName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(NOUNS)}-${pick(ADJECTIVES)}`;
}
