import { Button, Form } from 'react-bootstrap';
import type { TaskFilterField, TaskFilterGroup, TaskFilterOperator, TaskFilterRule } from '../../../graphql/automation';

const TEXT_OPS: TaskFilterOperator[] = ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'isEmpty', 'isNotEmpty'];
const CHOICE_OPS: TaskFilterOperator[] = ['anyOf', 'noneOf'];

/** Champs filtrables d'une tâche, leurs opérateurs et leurs valeurs fixes (miroir du backend). */
const FIELDS: Record<TaskFilterField, { label: string; operators: TaskFilterOperator[]; choices?: { value: string; label: string }[] }> = {
  title: { label: 'Titre', operators: TEXT_OPS },
  description: { label: 'Description', operators: TEXT_OPS },
  priority: {
    label: 'Priorité',
    operators: [...CHOICE_OPS, 'atLeast', 'atMost'],
    choices: [
      { value: 'low', label: 'basse' },
      { value: 'medium', label: 'moyenne' },
      { value: 'high', label: 'haute' },
      { value: 'urgent', label: 'urgente' },
    ],
  },
  status: {
    label: 'Statut',
    operators: CHOICE_OPS,
    choices: [
      { value: 'todo', label: 'à faire' },
      { value: 'in_progress', label: 'en cours' },
      { value: 'done', label: 'terminée' },
      { value: 'cancelled', label: 'annulée' },
    ],
  },
  createdBy: {
    label: 'Créée par',
    operators: CHOICE_OPS,
    choices: [
      { value: 'human', label: 'une personne' },
      { value: 'agent', label: 'un agent' },
    ],
  },
  dueDate: { label: 'Échéance', operators: ['is', 'before', 'after', 'isEmpty', 'isNotEmpty'] },
  assignee: { label: 'Responsable', operators: TEXT_OPS },
  reporter: { label: 'Rapporteur', operators: TEXT_OPS },
  customField: { label: 'Champ personnalisé', operators: TEXT_OPS },
};

const OP_LABELS: Record<TaskFilterOperator, string> = {
  is: 'est',
  isNot: "n'est pas",
  contains: 'contient',
  notContains: 'ne contient pas',
  startsWith: 'commence par',
  endsWith: 'finit par',
  matches: 'correspond à (regex)',
  isEmpty: 'est vide',
  isNotEmpty: "n'est pas vide",
  anyOf: 'parmi',
  noneOf: 'hors de',
  atLeast: 'au moins',
  atMost: 'au plus',
  before: 'avant le',
  after: 'après le',
};
const NO_VALUE: TaskFilterOperator[] = ['isEmpty', 'isNotEmpty'];
const MAX_DEPTH = 3;

function RuleRow({ rule, id, onChange, onRemove }: { rule: TaskFilterRule; id: string; onChange: (r: TaskFilterRule) => void; onRemove: () => void }) {
  const field = FIELDS[rule.field];
  const multi = rule.operator === 'anyOf' || rule.operator === 'noneOf';
  const changeField = (f: TaskFilterField) => onChange({ kind: 'rule', field: f, operator: FIELDS[f].operators[0], value: '', values: [], key: f === 'customField' ? rule.key : undefined });
  return (
    <div className="d-flex flex-column gap-1 border-bottom pb-1">
      <div className="d-flex gap-1 align-items-center">
        <Form.Select size="sm" value={rule.field} onChange={(e) => changeField(e.target.value as TaskFilterField)}>
          {(Object.keys(FIELDS) as TaskFilterField[]).map((f) => (
            <option key={f} value={f}>
              {FIELDS[f].label}
            </option>
          ))}
        </Form.Select>
        {rule.field === 'customField' && <Form.Control size="sm" value={rule.key ?? ''} onChange={(e) => onChange({ ...rule, key: e.target.value })} placeholder="clé du champ" />}
        <Form.Select size="sm" value={rule.operator} onChange={(e) => onChange({ ...rule, operator: e.target.value as TaskFilterOperator })}>
          {field.operators.map((o) => (
            <option key={o} value={o}>
              {OP_LABELS[o]}
            </option>
          ))}
        </Form.Select>
        <button type="button" className="auto-icon-btn" title="Retirer" onClick={onRemove}>
          <i className="bi bi-x-lg" />
        </button>
      </div>
      {!NO_VALUE.includes(rule.operator) &&
        (multi && field.choices ? (
          <div className="d-flex flex-wrap gap-2 ps-1">
            {field.choices.map((c) => (
              <Form.Check
                key={c.value}
                inline
                type="checkbox"
                id={`${id}-${c.value}`}
                label={c.label}
                checked={(rule.values ?? []).includes(c.value)}
                onChange={(e) => onChange({ ...rule, values: e.target.checked ? [...(rule.values ?? []), c.value] : (rule.values ?? []).filter((v) => v !== c.value) })}
              />
            ))}
          </div>
        ) : field.choices ? (
          <Form.Select size="sm" value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">Choisir…</option>
            {field.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Form.Select>
        ) : (
          <Form.Control size="sm" type={rule.field === 'dueDate' ? 'date' : 'text'} value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })} placeholder="valeur" />
        ))}
    </div>
  );
}

/** Éditeur visuel du filtre d'un déclencheur « tâche créée » : la tâche doit remplir ces règles. */
export default function TaskFilterEditor({ group, onChange, depth = 0, onRemove }: { group: TaskFilterGroup; onChange: (g: TaskFilterGroup) => void; depth?: number; onRemove?: () => void }) {
  const setItem = (i: number, item: TaskFilterRule | TaskFilterGroup) => onChange({ ...group, items: group.items.map((it, j) => (j === i ? item : it)) });
  const removeItem = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  return (
    <div className={depth ? 'wf-rules' : ''}>
      <div className="wf-group-head">
        <Form.Select size="sm" style={{ width: 'auto' }} value={group.match} onChange={(e) => onChange({ ...group, match: e.target.value as 'all' | 'any' })}>
          <option value="all">Toutes ces règles (et)</option>
          <option value="any">Au moins une (ou)</option>
        </Form.Select>
        {onRemove && (
          <button type="button" className="auto-icon-btn ms-auto" title="Retirer ce groupe" onClick={onRemove}>
            <i className="bi bi-x-lg" />
          </button>
        )}
      </div>
      <div className="wf-rules">
        {group.items.map((item, i) =>
          item.kind === 'group' ? <TaskFilterEditor key={i} group={item} onChange={(g) => setItem(i, g)} depth={depth + 1} onRemove={() => removeItem(i)} /> : <RuleRow key={i} id={`tf-${depth}-${i}`} rule={item} onChange={(r) => setItem(i, r)} onRemove={() => removeItem(i)} />,
        )}
        <div className="d-flex gap-2">
          <Button size="sm" variant="outline-secondary" onClick={() => onChange({ ...group, items: [...group.items, { kind: 'rule', field: 'title', operator: 'contains', value: '' }] })}>
            <i className="bi bi-plus-lg me-1" /> Règle
          </Button>
          {depth < MAX_DEPTH && (
            <Button size="sm" variant="outline-secondary" onClick={() => onChange({ ...group, items: [...group.items, { kind: 'group', match: 'any', items: [] }] })}>
              <i className="bi bi-plus-lg me-1" /> Groupe
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
