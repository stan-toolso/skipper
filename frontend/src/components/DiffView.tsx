/** Rendu d'un diff unifié : entêtes, hunks, lignes ajoutées et supprimées colorées. */
export default function DiffView({ text, binary }: { text: string; binary?: boolean }) {
  if (binary) return <div className="diff-empty">Fichier binaire : pas de diff affichable.</div>;
  if (!text.trim()) return <div className="diff-empty">Aucune différence.</div>;
  return (
    <pre className="diff-view">
      {text.split('\n').map((line, i) => {
        let cls = '';
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-file';
        else if (line.startsWith('@@')) cls = 'diff-hunk';
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('commit ') || line.startsWith('Author:') || line.startsWith('Date:')) cls = 'diff-meta';
        else if (line.startsWith('+')) cls = 'diff-add';
        else if (line.startsWith('-')) cls = 'diff-del';
        else if (line.startsWith('\\')) cls = 'diff-meta';
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
