import { Linkified } from './TaskBadges';

/**
 * Résumé d'une tâche (une ou deux phrases sur son objet), montré avant la description pour être lu et compris
 * d'un coup d'œil. Rien quand la tâche n'en a pas.
 */
export default function TaskSummary({ summary, className = '' }: { summary: string | null | undefined; className?: string }) {
  if (!summary?.trim()) return null;
  return (
    <div className={`task-summary ${className}`.trim()}>
      <div className="task-summary-label">Résumé</div>
      <div className="task-summary-text">
        <Linkified text={summary} />
      </div>
    </div>
  );
}
