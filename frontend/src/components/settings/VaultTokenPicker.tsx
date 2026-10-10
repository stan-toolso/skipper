import { useQuery } from '@apollo/client';
import { Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { VAULT_ITEMS, type VaultItem } from '../../graphql/vault';

interface Props {
  /** Service du jeton applicatif attendu (claude, anthropic, github, openai…). */
  service: string;
  value: string | null;
  onChange: (itemId: string | null) => void;
  /** Propose « Aucun » (défaut : oui). */
  allowNone?: boolean;
  label?: string;
  disabled?: boolean;
  size?: 'sm';
  /** Texte de l'option vide. */
  noneLabel?: string;
}

/** Choix d'un jeton applicatif du coffre pour un service donné ; les valeurs des jetons ne quittent jamais le coffre. */
export default function VaultTokenPicker({ service, value, onChange, allowNone = true, label, disabled, size, noneLabel = 'Aucun' }: Props) {
  const { data, loading } = useQuery<{ vaultItems: VaultItem[] }>(VAULT_ITEMS, { variables: { kind: 'token' }, fetchPolicy: 'cache-and-network' });
  const items = (data?.vaultItems ?? []).filter((i) => i.token?.service === service);
  // Un élément référencé mais absent de la liste (plus utilisable) reste visible pour pouvoir le remplacer.
  const orphan = value && !items.some((i) => i.id === value);
  return (
    <Form.Group>
      {label && <Form.Label className="small mb-1">{label}</Form.Label>}
      <Form.Select size={size} value={value ?? ''} disabled={disabled || (loading && !data)} onChange={(e) => onChange(e.target.value || null)}>
        {(allowNone || !value) && <option value="">{noneLabel}</option>}
        {orphan && <option value={value}>(élément inaccessible)</option>}
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
            {i.token?.account ? ` (${i.token.account})` : ''}
            {i.ownerProject ? ` · projet ${i.ownerProject.name}` : ''}
          </option>
        ))}
      </Form.Select>
      <Form.Text className="text-secondary">
        {items.length === 0 && data ? 'Aucun jeton de ce service dans votre coffre. ' : ''}
        <Link to="/vault">Ajouter un jeton dans le coffre</Link>
      </Form.Text>
    </Form.Group>
  );
}
