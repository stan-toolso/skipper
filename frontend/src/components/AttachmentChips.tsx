import { useRef } from 'react';
import { formatSize, type PendingAttachment } from '../lib/attachments';

interface Props {
  items: PendingAttachment[];
  onAdd: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
  /** Affiche le bouton « Joindre » même sans fichier (formulaire) ; sinon seules les puces apparaissent. */
  showButton?: boolean;
  error?: string | null;
}

/** Fichiers en attente d'envoi avec une instruction : puces avec aperçu et retrait, bouton de sélection. */
export default function AttachmentChips({ items, onAdd, onRemove, disabled, showButton = true, error }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (!items.length && !showButton && !error) return null;
  return (
    <div className="cc-attachments">
      {items.map((item) => (
        <span key={item.id} className="cc-chip" title={`${item.name} · ${item.mediaType} · ${formatSize(item.size)}`}>
          {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <i className="bi bi-file-earmark" />}
          <span className="cc-chip-name">{item.name}</span>
          <span className="cc-chip-size">{formatSize(item.size)}</span>
          <button type="button" aria-label={`Retirer ${item.name}`} title="Retirer" disabled={disabled} onClick={() => onRemove(item.id)}>
            <i className="bi bi-x" />
          </button>
        </span>
      ))}
      {showButton && (
        <button type="button" className="cc-attach-btn" disabled={disabled} onClick={() => inputRef.current?.click()} title="Joindre des fichiers (ou collez une image, ou déposez des fichiers dans la consigne)">
          <i className="bi bi-paperclip" /> Joindre des fichiers
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onAdd(e.target.files);
          e.target.value = '';
        }}
      />
      {error && <span className="cc-attachments-error">{error}</span>}
    </div>
  );
}
