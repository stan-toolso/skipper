import { z } from 'zod';
import { placeholders, render, resolve } from './template.js';
import { compareValues, isEmptyValue, truthy } from './expressions.js';

/**
 * Condition d'un nœud « condition », construite visuellement dans l'éditeur : des groupes de règles liées
 * par « toutes » (et) ou « l'une » (ou), chaque règle testant une valeur de l'exécution
 * (`nodes.review.json.approved`, `input.env`…) contre un texte qui peut contenir des `{{…}}`. Les
 * comparaisons sont celles du langage de formules (expressions.ts) : souples, nombres comparés
 * numériquement, texte sans tenir compte de la casse. Fonctions pures, testées.
 */

export type ConditionOperator = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'matches' | 'isEmpty' | 'isNotEmpty' | 'isTrue' | 'isFalse' | 'greaterThan' | 'atLeast' | 'lessThan' | 'atMost';

export const CONDITION_OPERATORS: ConditionOperator[] = ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'greaterThan', 'atLeast', 'lessThan', 'atMost'];

/** Opérateurs qui testent la valeur seule (sans texte de comparaison). */
export const UNARY_OPERATORS: ConditionOperator[] = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'];

export interface ConditionRule {
  kind: 'rule';
  /** Valeur testée : un chemin du contexte de l'exécution, ex. `nodes.review.json.approved`. */
  path: string;
  operator: ConditionOperator;
  /** Ce à quoi elle est comparée : texte, nombre, ou modèle (`{{nodes.plan.json.limit}}`). */
  value?: string;
}

export interface ConditionGroup {
  kind: 'group';
  /** `all` : chaque élément doit tenir (et) ; `any` : un seul suffit (ou). */
  match: 'all' | 'any';
  items: (ConditionRule | ConditionGroup)[];
}

/** Imbrication permise sous le groupe racine. */
export const MAX_CONDITION_DEPTH = 3;
const MAX_CONDITION_ITEMS = 50;

const ruleSchema = z.object({
  kind: z.literal('rule'),
  path: z.string().max(500),
  operator: z.enum(CONDITION_OPERATORS as [ConditionOperator, ...ConditionOperator[]]),
  value: z.string().max(2000).optional(),
});
type ItemInput = z.infer<typeof ruleSchema> | { kind: 'group'; match: 'all' | 'any'; items: ItemInput[] };
const groupSchema: z.ZodType<{ kind: 'group'; match: 'all' | 'any'; items: ItemInput[] }> = z.lazy(() => z.object({ kind: z.literal('group'), match: z.enum(['all', 'any']), items: z.array(z.union([ruleSchema, groupSchema])).max(MAX_CONDITION_ITEMS) }));
export const conditionSchema = groupSchema;

const countRules = (g: ConditionGroup): number => g.items.reduce((n, i) => n + (i.kind === 'group' ? countRules(i) : 1), 0);

/** Problèmes d'une condition, pour la validation du workflow (vide quand elle peut s'exécuter). */
export function conditionProblems(group: ConditionGroup, depth = 0): string[] {
  if (depth === 0 && countRules(group) === 0) return ['Ajoutez une règle à la condition'];
  if (depth > MAX_CONDITION_DEPTH) return ['La condition imbrique trop de groupes'];
  const out: string[] = [];
  if (depth > 0 && group.items.length === 0) out.push('Un groupe de la condition est vide');
  for (const item of group.items) {
    if (item.kind === 'group') {
      out.push(...conditionProblems(item, depth + 1));
      continue;
    }
    if (!item.path.trim()) out.push("Une règle de la condition ne dit pas quelle valeur elle teste");
    if (item.operator === 'matches' && item.value && !placeholders(item.value).length) {
      try {
        new RegExp(item.value);
      } catch {
        out.push(`Expression régulière invalide dans la condition : ${item.value}`);
      }
    }
  }
  return [...new Set(out)];
}

/** Chemins lus par une condition : les valeurs testées et les emplacements des textes de comparaison. */
export function conditionPaths(group: ConditionGroup): string[] {
  const out = new Set<string>();
  const walk = (g: ConditionGroup) => {
    for (const item of g.items) {
      if (item.kind === 'group') walk(item);
      else {
        if (item.path.trim()) out.add(item.path.trim());
        for (const p of placeholders(item.value ?? '')) out.add(p);
      }
    }
  };
  walk(group);
  return [...out];
}

/** Le texte de comparaison : un emplacement seul garde le type de sa valeur (une liste pour `contains`). */
function operand(template: string, context: unknown): unknown {
  const lone = template.trim().match(/^\{\{\s*([^{}|]+?)\s*\}\}$/);
  return lone ? resolve(context, lone[1]) : render(template, context);
}

const COMPARISONS: Partial<Record<ConditionOperator, string>> = { is: '==', isNot: '!=', contains: 'contains', startsWith: 'startswith', endsWith: 'endswith', matches: 'matches', greaterThan: '>', atLeast: '>=', lessThan: '<', atMost: '<=' };

function ruleHolds(rule: ConditionRule, context: unknown): boolean {
  const actual = resolve(context, rule.path.trim());
  switch (rule.operator) {
    case 'isEmpty':
      return isEmptyValue(actual);
    case 'isNotEmpty':
      return !isEmptyValue(actual);
    case 'isTrue':
      return truthy(actual);
    case 'isFalse':
      return !truthy(actual);
    case 'notContains':
      return !compareValues('contains', actual, operand(rule.value ?? '', context));
    default:
      return compareValues(COMPARISONS[rule.operator]!, actual, operand(rule.value ?? '', context));
  }
}

/** La condition tient-elle dans le contexte de l'exécution ? Un groupe vide tient. */
export function conditionHolds(group: ConditionGroup, context: unknown): boolean {
  const results = group.items.map((item) => (item.kind === 'group' ? conditionHolds(item, context) : ruleHolds(item, context)));
  return group.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

const OPERATOR_WORDS: Record<ConditionOperator, string> = {
  is: 'est',
  isNot: "n'est pas",
  contains: 'contient',
  notContains: 'ne contient pas',
  startsWith: 'commence par',
  endsWith: 'finit par',
  matches: 'correspond à',
  isEmpty: 'est vide',
  isNotEmpty: "n'est pas vide",
  isTrue: 'est vrai',
  isFalse: 'est faux',
  greaterThan: '>',
  atLeast: '>=',
  lessThan: '<',
  atMost: '<=',
};

/** Forme lisible d'une condition, pour le journal de l'exécution. */
export function describeCondition(group: ConditionGroup): string {
  const parts = group.items.map((item) => (item.kind === 'group' ? `(${describeCondition(item)})` : [item.path, OPERATOR_WORDS[item.operator], UNARY_OPERATORS.includes(item.operator) ? '' : `"${item.value ?? ''}"`].filter(Boolean).join(' ')));
  return parts.join(group.match === 'all' ? ' et ' : ' ou ');
}
