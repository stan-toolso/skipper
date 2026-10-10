import { Button, Form } from 'react-bootstrap';
import type { ConditionGroup, ConditionOperator, ConditionRule } from '../../../graphql/automation';

const OPERATORS: { value: ConditionOperator; label: string; unary?: boolean }[] = [
  { value: 'is', label: 'est' },
  { value: 'isNot', label: "n'est pas" },
  { value: 'contains', label: 'contient' },
  { value: 'notContains', label: 'ne contient pas' },
  { value: 'startsWith', label: 'commence par' },
  { value: 'endsWith', label: 'finit par' },
  { value: 'matches', label: 'correspond à (regex)' },
  { value: 'greaterThan', label: '>' },
  { value: 'atLeast', label: '>=' },
  { value: 'lessThan', label: '<' },
  { value: 'atMost', label: '<=' },
  { value: 'isEmpty', label: 'est vide', unary: true },
  { value: 'isNotEmpty', label: "n'est pas vide", unary: true },
  { value: 'isTrue', label: 'est vrai', unary: true },
  { value: 'isFalse', label: 'est faux', unary: true },
];
const isUnary = (op: ConditionOperator) => OPERATORS.find((o) => o.value === op)?.unary ?? false;
export const MAX_DEPTH = 3;

interface Props {
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
  /** Chemins proposés pour la valeur testée. */
  paths?: string[];
  depth?: number;
  onRemove?: () => void;
}

/** Éditeur visuel d'une condition : groupe « toutes / au moins une », règles, sous-groupes (profondeur limitée). */
export default function RuleGroupEditor({ group, onChange, paths = [], depth = 0, onRemove }: Props) {
  const setItem = (i: number, item: ConditionRule | ConditionGroup) => onChange({ ...group, items: group.items.map((it, j) => (j === i ? item : it)) });
  const removeItem = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  const listId = `wf-paths-${depth}`;
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
      {paths.length > 0 && (
        <datalist id={listId}>
          {paths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      )}
      <div className="wf-rules">
        {group.items.map((item, i) =>
          item.kind === 'group' ? (
            <RuleGroupEditor key={i} group={item} onChange={(g) => setItem(i, g)} paths={paths} depth={depth + 1} onRemove={() => removeItem(i)} />
          ) : (
            <div key={i} className={`wf-rule${isUnary(item.operator) ? ' unary' : ''}`}>
              <Form.Control size="sm" list={listId} value={item.path} onChange={(e) => setItem(i, { ...item, path: e.target.value })} placeholder="nodes.review.json.approved" className="font-monospace" />
              <Form.Select size="sm" value={item.operator} onChange={(e) => setItem(i, { ...item, operator: e.target.value as ConditionOperator })}>
                {OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Form.Select>
              {!isUnary(item.operator) && <Form.Control size="sm" value={item.value ?? ''} onChange={(e) => setItem(i, { ...item, value: e.target.value })} placeholder="valeur ou {{…}}" />}
              <button type="button" className="auto-icon-btn" title="Retirer" onClick={() => removeItem(i)}>
                <i className="bi bi-x-lg" />
              </button>
            </div>
          ),
        )}
        <div className="d-flex gap-2">
          <Button size="sm" variant="outline-secondary" onClick={() => onChange({ ...group, items: [...group.items, { kind: 'rule', path: '', operator: 'is', value: '' }] })}>
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
