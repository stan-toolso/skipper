import { bareId, refUrl, splitKnown, splitRefs, trailingKeyword, type KnownRefs, type RefKind, type RefSegment } from './idRefs';

/**
 * Plugin remark : les identifiants de tâches et de sessions cités dans le texte (voir `idRefs`) deviennent des liens
 * internes. Couvre le texte courant (« la session 2927a9fc ») et un identifiant écrit en `code` juste après le mot
 * (« la tâche `313c1101` »). Avec `known` (identifiants résolus par le serveur), un identifiant court cité seul ou en
 * `code` devient aussi un lien, direct vers la tâche ou la session. Rien n'est touché dans les liens existants ni dans
 * les blocs de code.
 */

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function transform(parent: Node, known: KnownRefs | null): void {
  /** Lien d'une référence : direct quand le serveur a reconnu l'identifiant. */
  const link = (kind: RefKind, id: string, child: Node): Node => {
    const full = known?.get(id);
    return { type: 'link', url: full ? refUrl(full.kind, full.id) : refUrl(kind, id), children: [child] };
  };
  const children = parent.children;
  if (!children) return;
  const out: Node[] = [];
  /** Type annoncé par ce qui précède (« tâches `a`, `b` »), pour les identifiants en `code`. */
  let pending: RefKind | null = null;
  for (const node of children) {
    if (node.type === 'text' && node.value) {
      const segments: RefSegment[] = splitRefs(node.value).flatMap((s) => ('kind' in s ? [s] : splitKnown(s.text, known)));
      for (const s of segments) out.push('kind' in s ? link(s.kind, s.id, { type: 'text', value: s.text }) : { type: 'text', value: s.text });
      const last = segments[segments.length - 1];
      pending = 'kind' in last ? null : (trailingKeyword(last.text) ?? (pending && /^[\s,;/]*(?:et|and|ou|or)?[\s,;/]*$/i.test(last.text) ? pending : null));
      continue;
    }
    if (node.type === 'inlineCode' && node.value) {
      const id = bareId(node.value);
      const kind = id ? (pending ?? known?.get(id)?.kind ?? (id.length === 36 ? 'any' : null)) : null;
      if (id && kind) {
        out.push(link(kind, id, node));
        continue;
      }
      pending = null;
      out.push(node);
      continue;
    }
    pending = null;
    if (node.type !== 'link' && node.type !== 'linkReference' && node.type !== 'code' && node.type !== 'html') transform(node, known);
    out.push(node);
  }
  parent.children = out;
}

export default function remarkRefs(options?: { known?: KnownRefs | null }) {
  return (tree: Node) => transform(tree, options?.known ?? null);
}
