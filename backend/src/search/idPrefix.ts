/**
 * Requête qui ressemble à un identifiant (UUID complet ou son début, au moins 6 caractères hexadécimaux dont un
 * chiffre, ex. « 313c1101 ») : renvoie le préfixe à chercher en minuscules, sinon null.
 */
export function idPrefixOf(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!/^[0-9a-f]{6,8}(?:-[0-9a-f-]{0,28})?$/.test(q) || !/[0-9]/.test(q) || q.length > 36) return null;
  return q;
}
