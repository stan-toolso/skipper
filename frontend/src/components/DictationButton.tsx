import { useDictation } from '../lib/dictation';
import './dictation.css';

/**
 * Bouton micro d'une zone de saisie : la parole est transcrite au fil de l'eau à la suite du texte (voir lib/dictation).
 * Rien n'est affiché quand le navigateur ne sait pas reconnaître la parole (Firefox).
 */
export default function DictationButton({ value, onChange, disabled, className = 'cc-attach' }: { value: string; onChange: (text: string) => void; disabled?: boolean; className?: string }) {
  const d = useDictation(() => value, onChange);
  if (!d.supported) return null;
  const title = d.error ?? (d.listening ? 'Arrêter la dictée' : 'Dicter (parlez, le texte s’écrit tout seul)');
  return (
    <button
      type="button"
      className={`${className} cc-dictate${d.listening ? ' listening' : ''}${d.error ? ' failed' : ''}`}
      title={title}
      aria-label={d.listening ? 'Arrêter la dictée' : 'Dicter'}
      aria-pressed={d.listening}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        d.toggle();
      }}
    >
      <i className={`bi ${d.listening ? 'bi-mic-fill' : d.error ? 'bi-mic-mute' : 'bi-mic'}`} />
    </button>
  );
}
