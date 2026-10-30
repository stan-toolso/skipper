import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Rendu Markdown des textes produits par les agents (réponses, questions, motifs de demande) :
 * GFM (tableaux, listes de tâches, barré), liens ouverts dans un nouvel onglet, pas de HTML brut.
 * Le style est défini par `.cc-md` dans terminal.css : compact, dans la teinte du transcript. `base` remplace cette
 * classe de base par une autre feuille de style (ex. `ctx-md`, typographie de document des instructions du contexte).
 */
export default function Markdown({ text, className, base = 'cc-md' }: { text: string; className?: string; base?: string }) {
  return (
    <div className={`${base}${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ref: _ref, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
