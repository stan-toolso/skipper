import { bareId, refUrl, splitRefs, trailingKeyword, type RefKind } from './idRefs';

/**
 * Plugin remark : les identifiants de tâches et de sessions cités dans le texte (voir `idRefs`) deviennent des liens
 * internes. Couvre le texte courant (« la session 2927a9fc ») et un identifiant écrit en `code` juste après le mot
 * (« la tâche `313c1101` »). Rien n'est touché dans les liens existants ni dans les blocs de code.
 */

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const link = (kind: RefKind, id: string, child: Node): Node => ({ type: 'link', url: refUrl(kind, id), children: [child] });

function transform(parent: Node): void {
  const children = parent.children;
  if (!children) return;
  const out: Node[] = [];
  /** Type annoncé par ce qui précède (« tâches `a`, `b` »), pour les identifiants en `code`. */
  let pending: RefKind | null = null;
  for (const node of children) {
    if (node.type === 'text' && node.value) {
      const segments = splitRefs(node.value);
      for (const s of segments) out.push('kind' in s ? link(s.kind, s.id, { type: 'text', value: s.text }) : { type: 'text', value: s.text });
      const last = segments[segments.length - 1];
      pending = 'kind' in last ? null : (trailingKeyword(last.text) ?? (pending && /^[\s,;/]*(?:et|and|ou|or)?[\s,;/]*$/i.test(last.text) ? pending : null));
      continue;
    }
    if (node.type === 'inlineCode' && node.value) {
      const id = bareId(node.value);
      const kind = id ? (pending ?? (id.length === 36 ? 'any' : null)) : null;
      if (id && kind) {
        out.push(link(kind, id, node));
        continue;
      }
      pending = null;
      out.push(node);
      continue;
    }
    pending = null;
    if (node.type !== 'link' && node.type !== 'linkReference' && node.type !== 'code' && node.type !== 'html') transform(node);
    out.push(node);
  }
  parent.children = out;
}

export default function remarkRefs() {
  return (tree: Node) => transform(tree);
}
