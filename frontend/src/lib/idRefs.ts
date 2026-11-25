/**
 * Identifiants de tâches et de sessions cités dans un texte (« Tâche 313c1101 (urgente), lancée dans la session
 * 2927a9fc », « tâches 8acd64bd, 07c5ded4 et a146e804 », UUID complet) : repérés pour devenir des liens.
 *
 * Un identifiant court (8 caractères hexadécimaux dont un chiffre, ou plus) n'est reconnu qu'après le mot « tâche »,
 * « task » ou « session » (au singulier ou au pluriel, éventuellement suivi de « d'agent », « id », « n° », « # »…) :
 * seul, il pourrait être un commit. Un UUID complet est toujours reconnu, d'après le mot qui le précède quand il y en
 * a un, sinon sans type (la page `/r/any/<id>` cherche une tâche puis une session).
 */

export type RefKind = 'task' | 'session' | 'any';
export type RefSegment = { text: string } | { text: string; kind: RefKind; id: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = `(?:${UUID}|[0-9a-f]{8,12})`;
/** Mot qui annonce un identifiant, puis ce qui peut le séparer de l'identifiant. */
const KEYWORD = String.raw`(?<![\p{L}\p{N}_])(t[âa]ches?|tasks?|sessions?)(?:\s+d['’]agents?)?(?:\s+(?:id|n°|no|numéro))?[\s:#(«"'\x60]*`;
/** Séparateurs d'une liste d'identifiants après le mot (« 8acd64bd, 07c5ded4 et a146e804 »). */
const LIST_SEP = String.raw`[\x60"»)]*\s*(?:,|;|\/|et|and|ou|or)\s*[\x60"«(]*`;

const idRe = () => new RegExp(`${ID}(?![0-9a-z_-])`, 'iy');
const keywordRe = () => new RegExp(KEYWORD, 'giu');
const sepRe = () => new RegExp(LIST_SEP, 'iy');
const uuidRe = () => new RegExp(`(?<![0-9a-z_-])${UUID}(?![0-9a-z_-])`, 'gi');

const kindOf = (word: string): RefKind => (/^s/i.test(word) ? 'session' : 'task');
/** Un identifiant court doit contenir un chiffre : « session deadbeef » ou « tâche facade » ne sont pas des références. */
const plausible = (id: string) => id.length === 36 || /[0-9]/.test(id);

interface Found {
  start: number;
  end: number;
  kind: RefKind;
  id: string;
}

function findRefs(text: string): Found[] {
  const found: Found[] = [];
  const kw = keywordRe();
  let m: RegExpExecArray | null;
  while ((m = kw.exec(text))) {
    const kind = kindOf(m[1]);
    let pos = m.index + m[0].length;
    for (;;) {
      const id = idRe();
      id.lastIndex = pos;
      const im = id.exec(text);
      if (!im || !plausible(im[0])) break;
      found.push({ start: pos, end: pos + im[0].length, kind, id: im[0].toLowerCase() });
      pos += im[0].length;
      const sep = sepRe();
      sep.lastIndex = pos;
      const sm = sep.exec(text);
      if (!sm) break;
      pos += sm[0].length;
    }
    if (pos > kw.lastIndex) kw.lastIndex = pos;
  }
  // UUID complets cités sans mot qui les annonce.
  const uu = uuidRe();
  while ((m = uu.exec(text))) {
    const start = m.index;
    if (!found.some((f) => start < f.end && start + m![0].length > f.start)) found.push({ start, end: start + m[0].length, kind: 'any', id: m[0].toLowerCase() });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Découpe un texte en morceaux de texte et en références (identifiant de tâche ou de session). */
export function splitRefs(text: string): RefSegment[] {
  const refs = findRefs(text);
  if (!refs.length) return [{ text }];
  const out: RefSegment[] = [];
  let pos = 0;
  for (const r of refs) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start) });
    out.push({ text: text.slice(r.start, r.end), kind: r.kind, id: r.id });
    pos = r.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

/**
 * Lien d'une référence : la page de la tâche ou de la session quand l'identifiant est complet et son type connu,
 * sinon la page de résolution `/r/<type>/<début de l'identifiant>`.
 */
export function refUrl(kind: RefKind, id: string): string {
  if (id.length === 36 && kind === 'task') return `/tasks/${id}`;
  if (id.length === 36 && kind === 'session') return `/sessions/${id}`;
  return `/r/${kind}/${id}`;
}

/** Fin d'un texte qui annonce un identifiant (« … la tâche », « session : ») : pour un identifiant écrit en `code` juste après. */
export function trailingKeyword(text: string): RefKind | null {
  const m = new RegExp(`${KEYWORD}$`, 'iu').exec(text);
  return m ? kindOf(m[1]) : null;
}

/** Contenu d'un `code` qui est un identifiant à lui seul (court plausible, ou UUID). */
export function bareId(text: string): string | null {
  const t = text.trim();
  return new RegExp(`^${ID}$`, 'i').test(t) && plausible(t) ? t.toLowerCase() : null;
}
