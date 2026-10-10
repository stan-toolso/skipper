import { Form } from 'react-bootstrap';
import type { InputVariable } from '../../graphql/automation';

/** Un champ par variable déclarée ; `values` contient les saisies (chaîne vide = non renseignée). */
export default function InputsForm({ variables, values, onChange, idPrefix = 'in' }: { variables: InputVariable[]; values: Record<string, string>; onChange: (values: Record<string, string>) => void; idPrefix?: string }) {
  if (!variables.length) return <div className="text-secondary small">Aucune variable à renseigner.</div>;
  return (
    <>
      {variables.map((v) => (
        <Form.Group className="mb-2" key={v.key} controlId={`${idPrefix}-${v.key}`}>
          <Form.Label className="mb-1">
            {v.label || v.key}
            {v.required && v.defaultValue === null && ' *'} <code className="small text-secondary">{v.key}</code>
          </Form.Label>
          <Form.Control as="textarea" rows={values[v.key]?.includes('\n') ? 3 : 1} value={values[v.key] ?? ''} onChange={(e) => onChange({ ...values, [v.key]: e.target.value })} placeholder={v.defaultValue ?? ''} />
          {v.description && <Form.Text>{v.description}</Form.Text>}
        </Form.Group>
      ))}
    </>
  );
}

/** Valeurs à envoyer : les saisies non vides, les autres laissées au défaut du backend. */
export function inputsPayload(values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== '') out[k] = v;
  return out;
}

/** Valeurs initiales d'un formulaire : celles enregistrées, en chaînes. */
export function inputsFromRecord(record: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record ?? {})) out[k] = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

/** Variables obligatoires sans valeur ni défaut. */
export function missingInputs(variables: InputVariable[], values: Record<string, string>): string[] {
  return variables.filter((v) => v.required && v.defaultValue === null && !(values[v.key] ?? '').trim()).map((v) => v.label || v.key);
}
