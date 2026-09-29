import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Rendu Markdown des textes produits par les agents (réponses, questions, motifs de demande) :
 * GFM (tableaux, listes de tâches, barré), liens ouverts dans un nouvel onglet, pas de HTML brut.
 * Le style est défini par `.cc-md` dans terminal.css : compact, dans la teinte du transcript.
 */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`cc-md${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
