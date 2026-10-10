import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES, type Task } from '../tasks/types.js';

/**
 * Filtre d'un déclencheur « tâche créée », construit visuellement : des groupes de conditions liées par
 * « toutes » (et) ou « l'une » (ou), chaque condition testant un champ de la tâche. Fonctions pures,
 * testées. Les comparaisons de texte ignorent la casse et les espaces autour. Une personne (responsable,
 * rapporteur) se reconnaît à son nom ou à son e-mail : un test positif passe si l'un correspond, un test
 * négatif si aucun ne correspond.
 */

export type TaskFilterField = 'title' | 'description' | 'priority' | 'status' | 'createdBy' | 'dueDate' | 'assignee' | 'reporter' | 'customField';
export type TaskFilterOperator = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'matches' | 'isEmpty' | 'isNotEmpty' | 'anyOf' | 'noneOf' | 'atLeast' | 'atMost' | 'before' | 'after';

export interface TaskFilterRule {
  kind: 'rule';
  field: TaskFilterField;
  /** customField : clé du champ personnalisé (sans tenir compte de la casse). */
  key?: string;
  operator: TaskFilterOperator;
  /** Opérateurs de texte, dates, bornes de priorité. */
  value?: string;
  /** anyOf / noneOf. */
  values?: string[];
}

export interface TaskFilterGroup {
  kind: 'group';
  match: 'all' | 'any';
  items: (TaskFilterRule | TaskFilterGroup)[];
}

const TEXT_OPERATORS: TaskFilterOperator[] = ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'isEmpty', 'isNotEmpty'];
const CHOICE_OPERATORS: TaskFilterOperator[] = ['anyOf', 'noneOf'];

/** Opérateurs acceptés par chaque champ, et les valeurs des champs à liste fixe. */
export const TASK_FILTER_FIELDS: Record<TaskFilterField, { operators: TaskFilterOperator[]; choices?: readonly string[] }> = {
  title: { operators: TEXT_OPERATORS },
  description: { operators: TEXT_OPERATORS },
  customField: { operators: TEXT_OPERATORS },
  priority: { operators: [...CHOICE_OPERATORS, 'atLeast', 'atMost'], choices: TASK_PRIORITIES },
  status: { operators: CHOICE_OPERATORS, choices: TASK_STATUSES },
  createdBy: { operators: CHOICE_OPERATORS, choices: ['human', 'agent'] },
  dueDate: { operators: ['is', 'before', 'after', 'isEmpty', 'isNotEmpty'] },
  assignee: { operators: TEXT_OPERATORS },
  reporter: { operators: TEXT_OPERATORS },
};

/** Imbrication permise sous le groupe racine. */
export const MAX_FILTER_DEPTH = 3;
const MAX_FILTER_ITEMS = 50;

const ruleSchema = z.object({
  kind: z.literal('rule'),
  field: z.enum(Object.keys(TASK_FILTER_FIELDS) as [TaskFilterField, ...TaskFilterField[]]),
  key: z.string().max(100).optional(),
  operator: z.string(),
  value: z.string().max(2000).optional(),
  values: z.array(z.string().max(100)).max(20).optional(),
});
type ItemInput = z.infer<typeof ruleSchema> | { kind: 'group'; match: 'all' | 'any'; items: ItemInput[] };
const groupSchema: z.ZodType<{ kind: 'group'; match: 'all' | 'any'; items: ItemInput[] }> = z.lazy(() => z.object({ kind: z.literal('group'), match: z.enum(['all', 'any']), items: z.array(z.union([ruleSchema, groupSchema])).max(MAX_FILTER_ITEMS) }));
export const taskFilterSchema = groupSchema;

/** Problèmes d'un filtre, pour l'éditeur et la validation du workflow (vide quand il peut s'exécuter). */
export function taskFilterProblems(filter: TaskFilterGroup, depth = 0): string[] {
  const out: string[] = [];
  if (depth > MAX_FILTER_DEPTH) return ['Le filtre imbrique trop de groupes'];
  if (depth > 0 && filter.items.length === 0) out.push('Un groupe du filtre est vide');
  for (const item of filter.items) {
    if (item.kind === 'group') {
      out.push(...taskFilterProblems(item, depth + 1));
      continue;
    }
    const spec = TASK_FILTER_FIELDS[item.field];
    if (!spec.operators.includes(item.operator as TaskFilterOperator)) {
      out.push(`Le filtre ne peut pas tester « ${item.field} » avec « ${item.operator} »`);
      continue;
    }
    if (item.field === 'customField' && !item.key?.trim()) out.push('Une condition du filtre teste un champ personnalisé sans sa clé');
    if (item.operator === 'anyOf' || item.operator === 'noneOf') {
      if (!item.values?.length) out.push(`Une condition sur « ${item.field} » du filtre n'a aucune valeur choisie`);
      else if (spec.choices && item.values.some((v) => !spec.choices!.includes(v))) out.push(`Une condition sur « ${item.field} » du filtre a une valeur inconnue`);
    } else if (item.operator === 'atLeast' || item.operator === 'atMost') {
      if (!spec.choices?.includes(item.value ?? '')) out.push("Une condition de priorité du filtre n'a pas de priorité");
    } else if (item.operator !== 'isEmpty' && item.operator !== 'isNotEmpty') {
      if (!item.value?.trim()) out.push(`Une condition sur « ${item.field === 'customField' ? (item.key ?? 'champ personnalisé') : item.field} » du filtre n'a pas de valeur`);
      else if (item.operator === 'matches') {
        try {
          new RegExp(item.value);
        } catch {
          out.push(`Expression régulière invalide dans le filtre : ${item.value}`);
        }
      } else if (item.field === 'dueDate' && !/^\d{4}-\d{2}-\d{2}$/.test(item.value.trim())) out.push("Une condition d'échéance du filtre attend une date AAAA-MM-JJ");
    }
  }
  return out;
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** Valeurs testées par une règle : une par champ, le nom et l'e-mail d'une personne (aucune si absente). */
function fieldValues(rule: TaskFilterRule, task: Task): string[] {
  switch (rule.field) {
    case 'title':
      return [task.title];
    case 'description':
      return [task.description];
    case 'priority':
      return [task.priority];
    case 'status':
      return [task.status];
    case 'createdBy':
      return [task.createdByType];
    case 'dueDate':
      return [task.dueDate ?? ''];
    case 'assignee':
    case 'reporter': {
      const person = task[rule.field];
      return [person?.name ?? '', person?.email ?? ''].filter((v) => v.trim() !== '');
    }
    case 'customField':
      return [task.customFields.find((f) => norm(f.key) === norm(rule.key))?.value ?? ''];
  }
}

/** Opérateurs qui passent quand aucune valeur ne passe leur forme positive. */
const NEGATIONS: Partial<Record<TaskFilterOperator, TaskFilterOperator>> = { isNot: 'is', notContains: 'contains', noneOf: 'anyOf', isNotEmpty: 'isEmpty' };

function ruleMatches(rule: TaskFilterRule, task: Task): boolean {
  const values = fieldValues(rule, task);
  if (!values.length) values.push('');
  const positive = NEGATIONS[rule.operator];
  if (positive) return !values.some((v) => valueMatches(positive, rule, v));
  if (rule.operator === 'isEmpty') return values.every((v) => valueMatches('isEmpty', rule, v));
  return values.some((v) => valueMatches(rule.operator, rule, v));
}

function valueMatches(operator: TaskFilterOperator, rule: TaskFilterRule, raw: string): boolean {
  const actual = norm(raw);
  const expected = norm(rule.value);
  switch (operator) {
    case 'is':
      return actual === expected;
    case 'isNot':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'notContains':
      return !actual.includes(expected);
    case 'startsWith':
      return actual.startsWith(expected);
    case 'endsWith':
      return actual.endsWith(expected);
    case 'matches':
      try {
        return new RegExp(rule.value ?? '', 'i').test(raw);
      } catch {
        return false;
      }
    case 'isEmpty':
      return actual === '';
    case 'isNotEmpty':
      return actual !== '';
    case 'anyOf':
      return (rule.values ?? []).some((v) => norm(v) === actual);
    case 'noneOf':
      return !(rule.values ?? []).some((v) => norm(v) === actual);
    case 'atLeast':
    case 'atMost': {
      const rank = TASK_PRIORITIES.indexOf(actual as Task['priority']);
      const bound = TASK_PRIORITIES.indexOf(expected as Task['priority']);
      if (rank < 0 || bound < 0) return false;
      return operator === 'atLeast' ? rank >= bound : rank <= bound;
    }
    case 'before':
      return actual !== '' && actual < expected;
    case 'after':
      return actual !== '' && actual > expected;
  }
}

/** La tâche passe-t-elle le filtre ? Un groupe vide accepte toute tâche. */
export function taskMatches(filter: TaskFilterGroup, task: Task): boolean {
  if (!filter.items.length) return true;
  const results = filter.items.map((item) => (item.kind === 'group' ? taskMatches(item, task) : ruleMatches(item, task)));
  return filter.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}
