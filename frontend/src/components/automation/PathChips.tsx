/** Chemins insérables dans un modèle ({{…}}) : un clic appelle `onPick` avec l'emplacement à insérer. */
export default function PathChips({ paths, onPick }: { paths: { path: string; hint: string }[]; onPick: (placeholder: string) => void }) {
  if (!paths.length) return null;
  return (
    <div className="auto-paths mt-1">
      {paths.map((p) => (
        <button type="button" key={p.path} className="auto-path" title={p.hint} onClick={() => onPick(`{{${p.path}}}`)}>
          {p.path}
        </button>
      ))}
    </div>
  );
}

/** Insère `text` à la position du curseur d'un champ (ou à la fin). */
export function insertAtCursor(el: HTMLTextAreaElement | HTMLInputElement | null, value: string, text: string): string {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  return value.slice(0, start) + text + value.slice(end);
}
