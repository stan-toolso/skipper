import type { TaskMention } from './types.js';

/**
 * Quelqu'un que l'on peut mentionner dans le fil d'une tâche : un membre du projet (`@Nom`, `@e-mail`) ou une session
 * d'agent du projet (`@session:<id>`, `@session:<8 premiers caractères>`, ou `@<nom de la session>`). Les alias sont
 * les textes acceptés après le `@`, comparés sans tenir compte de la casse ni des accents ; le plus long l'emporte.
 */
export interface Mentionable {
  kind: TaskMention['kind'];
  id: string;
  label: string;
  /** Texte secondaire montré dans les suggestions (e-mail, état de la session). */
  detail: string | null;
  /** Texte canonique à insérer dans un message pour mentionner cette personne ou session. */
  text: string;
  aliases: string[];
}

/** Un caractère comparable : minuscule, sans accent (un caractère composé qui ne se simplifie pas reste tel quel). */
const foldChar = (ch: string): string => {
  const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return Array.from(f).length === 1 ? f : ch.toLowerCase();
};

/** Texte comparable : minuscules, sans accents, espaces réduits. */
export const fold = (s: string): string => Array.from(s.trim().replace(/\s+/g, ' ')).map(foldChar).join('');

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Membre du projet mentionnable par son nom ou son e-mail. */
export function userMentionable(u: { id: string; name: string; email: string }): Mentionable {
  const name = u.name.trim();
  return { kind: 'user', id: u.id, label: name || u.email, detail: name ? u.email : null, text: `@${name || u.email}`, aliases: [name, u.email].filter(Boolean) };
}

/** Session d'agent mentionnable par son identifiant (complet ou court) ou par son nom. */
export function sessionMentionable(s: { id: string; name: string; status?: string | null }): Mentionable {
  return {
    kind: 'session',
    id: s.id,
    label: s.name,
    detail: s.status ? `session · ${s.status}` : 'session',
    text: `@session:${s.id.slice(0, 8)}`,
    aliases: [`session:${s.id}`, `session:${s.id.slice(0, 8)}`, s.name],
  };
}

/**
 * Mentions d'un texte : à chaque `@` en début de mot, l'alias le plus long qui suit (puis une fin de mot) désigne
 * une personne ou une session. Un `@` collé à un mot (adresse e-mail écrite dans le texte) n'en est pas une. Chaque
 * cible n'est gardée qu'une fois, dans l'ordre d'apparition, avec le fragment de texte qui la porte.
 */
export function findMentions(body: string, candidates: Mentionable[]): TaskMention[] {
  const chars = Array.from(body);
  const comparable = chars.map(foldChar);
  const aliases = candidates
    .flatMap((c) => c.aliases.map((alias) => ({ alias: Array.from(fold(alias)), c })))
    .filter((a) => a.alias.length > 0)
    .sort((a, b) => b.alias.length - a.alias.length);
  const out: TaskMention[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '@' || isWordChar(chars[i - 1])) continue;
    for (const { alias, c } of aliases) {
      if (!alias.every((ch, k) => comparable[i + 1 + k] === ch)) continue;
      if (isWordChar(comparable[i + 1 + alias.length])) continue;
      const key = `${c.kind}:${c.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: c.kind, id: c.id, label: c.label, text: chars.slice(i, i + 1 + alias.length).join('') });
      }
      i += alias.length;
      break;
    }
  }
  return out;
}

/** Remplace dans un texte chaque mention (son fragment `text`) par `render(m)`. */
export function replaceMentions(body: string, mentions: TaskMention[], render: (m: TaskMention) => string): string {
  let out = body;
  for (const m of mentions) {
    if (!m.text) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${m.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu');
    out = out.replace(re, (_, pre: string) => `${pre}${render(m)}`);
  }
  return out;
}
