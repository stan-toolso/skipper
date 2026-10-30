import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';

/**
 * Rendu Markdown des textes produits par les agents (réponses, questions, motifs de demande) :
 * GFM (tableaux, listes de tâches, barré), liens ouverts dans un nouvel onglet, pas de HTML brut.
 * Le style est défini par `.cc-md` dans terminal.css : compact, dans la teinte du transcript. `base` remplace cette
 * classe de base par une autre feuille de style (ex. `ctx-md`, typographie de document des instructions du contexte).
 * Mémoïsé : l'analyse Markdown coûte cher et le texte d'un message ne change jamais une fois journalisé.
 *
 * Un lien `mention:<kind>:<id>` (produit par `withMentionLinks` du fil des tâches) est rendu comme une mention :
 * pastille pour une personne, lien vers la session pour une session d'agent.
 */
function Markdown({ text, className, base = 'cc-md' }: { text: string; className?: string; base?: string }) {
  return (
    <div className={`${base}${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ref: _ref, href, children, ...props }) => {
            const mention = href?.startsWith('mention:') ? href.slice('mention:'.length).split(':') : null;
            if (mention) {
              const [kind, ...rest] = mention;
              const id = rest.join(':');
              return kind === 'session' ? (
                <Link to={`/sessions/${id}`} className="task-mention task-mention-session" title="Session d'agent mentionnée">
                  {children}
                </Link>
              ) : (
                <span className="task-mention" title="Personne mentionnée">
                  {children}
                </span>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);

/** Remplace dans un texte Markdown chaque mention (son fragment `text`) par un lien `mention:` que `Markdown` rend en pastille. */
export function withMentionLinks(body: string, mentions: { kind: string; id: string; label: string; text: string }[]): string {
  let out = body;
  for (const m of mentions) {
    if (!m.text) continue;
    const escaped = m.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_\\]])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
    out = out.replace(re, (_, pre: string) => `${pre}[@${m.label.replace(/[[\]]/g, '')}](mention:${m.kind}:${m.id})`);
  }
  return out;
}
