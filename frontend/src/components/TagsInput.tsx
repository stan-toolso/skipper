import { useState } from 'react';
import { Form } from 'react-bootstrap';

/**
 * Saisie d'étiquettes : puces retirables et un champ libre (Entrée ou virgule ajoute l'étiquette, Retour arrière sur
 * un champ vide retire la dernière), avec les étiquettes déjà employées en suggestions.
 */
export default function TagsInput({ value, onChange, suggestions = [], id }: { value: string[]; onChange: (tags: string[]) => void; suggestions?: string[]; id: string }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const tag = raw.replace(/\s+/g, ' ').trim();
    if (!tag) return;
    if (!value.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
    setDraft('');
  };
  const listId = `${id}-suggestions`;
  return (
    <div className="form-control form-control-sm d-flex flex-wrap gap-1 align-items-center" style={{ minHeight: 31 }}>
      {value.map((tag) => (
        <span key={tag} className="task-tag">
          {tag}
          <button type="button" className="btn btn-link p-0 ms-1 text-secondary" style={{ fontSize: 10, lineHeight: 1 }} aria-label={`Retirer ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}>
            <i className="bi bi-x-lg" />
          </button>
        </span>
      ))}
      <Form.Control
        id={id}
        size="sm"
        plaintext
        className="flex-grow-1 p-0 border-0"
        style={{ minWidth: 100, outline: 'none' }}
        list={listId}
        value={draft}
        placeholder={value.length ? '' : 'Ajouter une étiquette…'}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(',')) add(v.slice(0, -1));
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => add(draft)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !value.some((t) => t.toLowerCase() === s.toLowerCase()))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}
