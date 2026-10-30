import { formatSize, isImageType, taskAttachmentUrl, type AttachmentRef } from '../lib/attachments';

/**
 * Fichiers joints à une tâche ou à un commentaire : vignette pour les images, lien de téléchargement pour le reste.
 * Avec `onToggleRemove`, chaque fichier peut être marqué à retirer (édition) ; `removed` liste ceux qui le sont.
 */
export default function TaskAttachments({ taskId, attachments, removed = [], onToggleRemove }: { taskId: string; attachments: AttachmentRef[]; removed?: string[]; onToggleRemove?: (id: string) => void }) {
  if (!attachments.length) return null;
  return (
    <div className="cc-attachments task-attachments">
      {attachments.map((a) => {
        const url = taskAttachmentUrl(taskId, a.id);
        const gone = removed.includes(a.id);
        return (
          <span key={a.id} className={`cc-chip${gone ? ' opacity-50 text-decoration-line-through' : ''}`} title={`${a.name} · ${a.mediaType} · ${formatSize(a.size)}`}>
            <a href={url} target="_blank" rel="noreferrer" className="d-inline-flex align-items-center gap-1 text-reset text-decoration-none">
              {isImageType(a.mediaType) ? <img src={url} alt="" loading="lazy" /> : <i className="bi bi-file-earmark" />}
              <span className="cc-chip-name">{a.name}</span>
              <span className="cc-chip-size">{formatSize(a.size)}</span>
            </a>
            {onToggleRemove && (
              <button type="button" aria-label={gone ? `Garder ${a.name}` : `Retirer ${a.name}`} title={gone ? 'Garder' : 'Retirer'} onClick={() => onToggleRemove(a.id)}>
                <i className={`bi ${gone ? 'bi-arrow-counterclockwise' : 'bi-x'}`} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
