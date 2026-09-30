/**
 * Sérialise une valeur pour une colonne `json` / `jsonb`.
 *
 * PostgreSQL refuse un JSON contenant le caractère NUL (`\u0000`) : « unsupported Unicode escape
 * sequence ». Or la sortie d'un outil (fichier binaire lu par l'agent, `perl` sur un exécutable...)
 * peut en contenir et arrive telle quelle dans les événements de session, les demandes ou les
 * notifications. On retire ces caractères de toutes les chaînes plutôt que de perdre l'événement
 * et faire échouer la session.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' && v.includes('\u0000') ? v.replace(/\u0000/g, '') : v));
}
