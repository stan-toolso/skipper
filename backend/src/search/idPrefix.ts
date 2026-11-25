/**
 * Requête qui ressemble à un identifiant (UUID complet ou son début, au moins 6 caractères hexadécimaux dont un
 * chiffre, ex. « 313c1101 ») : renvoie le préfixe à chercher en minuscules, sinon null.
 */
export function idPrefixOf(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!/^[0-9a-f]{6,8}(?:-[0-9a-f-]{0,28})?$/.test(q) || !/[0-9]/.test(q) || q.length > 36) return null;
  return q;
}

/**
 * Bornes d'UUID couvrant un début d'identifiant (« 313c1101 » → 313c1101-0000-… et 313c1101-ffff-…) : pour chercher
 * par l'index de la clé primaire plutôt qu'avec `id::text LIKE`.
 */
export function uuidRange(prefix: string): [string, string] {
  const hex = prefix.replace(/-/g, '').toLowerCase();
  const fmt = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  return [fmt(hex.padEnd(32, '0')), fmt(hex.padEnd(32, 'f'))];
}

/** Début d'identifiant cité seul dans un texte (8 à 12 caractères hexadécimaux, dont un chiffre), sinon null. */
export function shortRefOf(text: string): string | null {
  const t = text.trim().toLowerCase();
  return /^[0-9a-f]{8,12}$/.test(t) && /[0-9]/.test(t) ? t : null;
}
