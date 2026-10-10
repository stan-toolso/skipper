import { resolve } from '../agents/template.js';

/**
 * Formules de condition des workflows : un petit langage booléen sûr, évalué contre le contexte de
 * l'exécution (aucune évaluation JavaScript). Grammaire :
 *
 *   expr     := or
 *   or       := and ( ('or' | '||') and )*
 *   and      := not ( ('and' | '&&') not )*
 *   not      := ('not' | '!') not | compare
 *   compare  := value ( op value | 'is' 'not'? 'empty' )?
 *   op       := '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'matches' | 'startsWith' | 'endsWith' | 'in'
 *   value    := '(' expr ')' | chaîne | nombre | 'true' | 'false' | 'null' | chemin
 *   chemin   := identifiant ('.' identifiant)*          ex. nodes.review.json.approved, input.env
 *
 * Les comparaisons sont souples : les nombres se comparent numériquement, le reste comme du texte
 * (`"true" == true`). Un chemin nu est vrai quand il est non vide et ni false ni 0. `matches` prend une expression régulière.
 */

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type Token = { type: 'string' | 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'end'; value: string; pos: number };

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<', '&&', '||', '!'];
const KEYWORDS = new Set(['and', 'or', 'not', 'contains', 'matches', 'startswith', 'endswith', 'in', 'is', 'empty', 'true', 'false', 'null']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: ch === '(' ? 'lparen' : 'rparen', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\' && j + 1 < source.length) {
          value += source[j + 1];
          j += 2;
        } else value += source[j++];
      }
      if (j >= source.length) throw new ExpressionError('Chaîne non terminée', i);
      tokens.push({ type: 'string', value, pos: i });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i });
      i += op.length;
      continue;
    }
    const num = source.slice(i).match(/^-?\d+(\.\d+)?/);
    if (num && !/[a-zA-Z_]/.test(source[i + num[0].length] ?? '')) {
      tokens.push({ type: 'number', value: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const ident = source.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*/);
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0], pos: i });
      i += ident[0].length;
      continue;
    }
    throw new ExpressionError(`Caractère inattendu « ${ch} »`, i);
  }
  tokens.push({ type: 'end', value: '', pos: source.length });
  return tokens;
}

/** Arbre syntaxique d'une expression (lu aussi par conditions.ts pour convertir une formule en condition visuelle). */
export type ExpressionNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'path'; path: string }
  | { kind: 'not'; operand: ExpressionNode }
  | { kind: 'and' | 'or'; left: ExpressionNode; right: ExpressionNode }
  | { kind: 'compare'; op: string; left: ExpressionNode; right: ExpressionNode }
  | { kind: 'empty'; operand: ExpressionNode; negate: boolean };

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.i];
  }
  private next(): Token {
    return this.tokens[this.i++];
  }
  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value.toLowerCase() === word;
  }
  private isOp(op: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.value === op;
  }

  parse(): ExpressionNode {
    const node = this.or();
    if (this.peek().type !== 'end') throw new ExpressionError(`« ${this.peek().value} » inattendu`, this.peek().pos);
    return node;
  }

  private or(): ExpressionNode {
    let left = this.and();
    while (this.isKeyword('or') || this.isOp('||')) {
      this.next();
      left = { kind: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): ExpressionNode {
    let left = this.not();
    while (this.isKeyword('and') || this.isOp('&&')) {
      this.next();
      left = { kind: 'and', left, right: this.not() };
    }
    return left;
  }

  private not(): ExpressionNode {
    if (this.isKeyword('not') || this.isOp('!')) {
      this.next();
      return { kind: 'not', operand: this.not() };
    }
    return this.compare();
  }

  private compare(): ExpressionNode {
    const left = this.value();
    const t = this.peek();
    if (t.type === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(t.value)) {
      this.next();
      return { kind: 'compare', op: t.value, left, right: this.value() };
    }
    if (t.type === 'ident') {
      const word = t.value.toLowerCase();
      if (['contains', 'matches', 'startswith', 'endswith', 'in'].includes(word)) {
        this.next();
        return { kind: 'compare', op: word, left, right: this.value() };
      }
      if (word === 'is') {
        this.next();
        let negate = false;
        if (this.isKeyword('not')) {
          this.next();
          negate = true;
        }
        if (!this.isKeyword('empty')) throw new ExpressionError('« empty » attendu après « is »', this.peek().pos);
        this.next();
        return { kind: 'empty', operand: left, negate };
      }
    }
    return left;
  }

  private value(): ExpressionNode {
    const t = this.next();
    switch (t.type) {
      case 'lparen': {
        const inner = this.or();
        if (this.peek().type !== 'rparen') throw new ExpressionError('« ) » manquante', this.peek().pos);
        this.next();
        return inner;
      }
      case 'string':
        return { kind: 'literal', value: t.value };
      case 'number':
        return { kind: 'literal', value: Number(t.value) };
      case 'ident': {
        const word = t.value.toLowerCase();
        if (word === 'true') return { kind: 'literal', value: true };
        if (word === 'false') return { kind: 'literal', value: false };
        if (word === 'null') return { kind: 'literal', value: null };
        if (KEYWORDS.has(word)) throw new ExpressionError(`Mot-clé « ${t.value} » inattendu`, t.pos);
        return { kind: 'path', path: t.value };
      }
      default:
        throw new ExpressionError(t.type === 'end' ? "Fin d'expression inattendue" : `« ${t.value} » inattendu`, t.pos);
    }
  }
}

/** Analyse une expression ; lève ExpressionError si elle est invalide. */
export function parseExpression(source: string): ExpressionNode {
  if (!source.trim()) throw new ExpressionError('Expression vide', 0);
  return new Parser(tokenize(source)).parse();
}

export const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Vérité d'une valeur dans une condition : non vide, ni false, ni 0, ni « false ». */
export function truthy(v: unknown): boolean {
  if (isEmptyValue(v)) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !['false', '0', 'no', 'non', 'off'].includes(v.trim().toLowerCase());
  return true;
}

const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
};

function looseEquals(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null && typeof a !== 'boolean' && typeof b !== 'boolean') return na === nb;
  return asText(a).trim().toLowerCase() === asText(b).trim().toLowerCase();
}

/** Applique un opérateur de comparaison du langage (`==`, `contains`, `startswith`…) à deux valeurs. */
export function compareValues(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case '==':
      return looseEquals(a, b);
    case '!=':
      return !looseEquals(a, b);
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const na = asNumber(a);
      const nb = asNumber(b);
      const [x, y] = na !== null && nb !== null ? [na, nb] : [asText(a), asText(b)];
      return op === '>' ? x > y : op === '>=' ? x >= y : op === '<' ? x < y : x <= y;
    }
    case 'contains':
      if (Array.isArray(a)) return a.some((item) => looseEquals(item, b));
      return asText(a).toLowerCase().includes(asText(b).toLowerCase());
    case 'in':
      if (Array.isArray(b)) return b.some((item) => looseEquals(item, a));
      return asText(b).toLowerCase().includes(asText(a).toLowerCase());
    case 'startswith':
      return asText(a).toLowerCase().startsWith(asText(b).toLowerCase());
    case 'endswith':
      return asText(a).toLowerCase().endsWith(asText(b).toLowerCase());
    case 'matches':
      try {
        return new RegExp(asText(b), 'i').test(asText(a));
      } catch {
        throw new ExpressionError(`Expression régulière invalide : ${asText(b)}`, 0);
      }
    default:
      throw new ExpressionError(`Opérateur inconnu ${op}`, 0);
  }
}

function evaluateNode(node: ExpressionNode, context: unknown): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return resolve(context, node.path);
    case 'not':
      return !truthy(evaluateNode(node.operand, context));
    case 'and':
      return truthy(evaluateNode(node.left, context)) && truthy(evaluateNode(node.right, context));
    case 'or':
      return truthy(evaluateNode(node.left, context)) || truthy(evaluateNode(node.right, context));
    case 'empty': {
      const empty = isEmptyValue(evaluateNode(node.operand, context));
      return node.negate ? !empty : empty;
    }
    case 'compare':
      return compareValues(node.op, evaluateNode(node.left, context), evaluateNode(node.right, context));
  }
}

/** Évalue une condition contre le contexte de l'exécution. Lève ExpressionError si l'expression est invalide. */
export function evaluateCondition(source: string, context: unknown): boolean {
  return truthy(evaluateNode(parseExpression(source), context));
}

/** Chemins référencés par une expression (aides de l'éditeur et validation). */
export function expressionPaths(source: string): string[] {
  const out: string[] = [];
  const walk = (node: ExpressionNode) => {
    switch (node.kind) {
      case 'path':
        if (!out.includes(node.path)) out.push(node.path);
        break;
      case 'not':
      case 'empty':
        walk(node.operand);
        break;
      case 'and':
      case 'or':
      case 'compare':
        walk(node.left);
        walk(node.right);
        break;
      default:
    }
  };
  walk(parseExpression(source));
  return out;
}
