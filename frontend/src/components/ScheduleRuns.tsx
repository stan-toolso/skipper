import { useState } from 'react';
import type { ScheduleRun } from '../graphql/operations';
import { formatCost, formatDuration } from '../lib/humanize';
import { isRunProblem, scheduleRunStatus } from '../lib/schedules';
import './schedules.css';

const when = (iso: string) => new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Issue d'une exécution : pictogramme et libellé colorés. */
export function RunStatus({ run }: { run: Pick<ScheduleRun, 'status'> }) {
  const s = scheduleRunStatus[run.status];
  return (
    <span className={`sch-status ${s.cls}`} title={s.hint}>
      <i className={`bi ${s.icon}`} />
      {s.label}
    </span>
  );
}

/** Les dernières exécutions en pastilles, de la plus ancienne à la plus récente (à droite). */
export function RunDots({ runs, count = 10 }: { runs: ScheduleRun[]; count?: number }) {
  const shown = runs.slice(0, count).reverse();
  const empty = Math.max(0, count - shown.length);
  return (
    <span className="sch-dots" aria-label="Dernières exécutions">
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className="sch-dot empty" />
      ))}
      {shown.map((r) => (
        <span key={r.id} className={`sch-dot ${scheduleRunStatus[r.status].cls}`} title={`${when(r.startedAt)} · ${scheduleRunStatus[r.status].label}${r.message ? ` · ${r.message}` : ''}`} />
      ))}
    </span>
  );
}

/** Historique des exécutions : quand, comment, issue, durée, coût, raison, et la réponse de l'agent à déplier. */
export function RunHistory({ runs, empty = 'Aucune exécution pour l’instant.' }: { runs: ScheduleRun[]; empty?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!runs.length) return <div className="text-secondary small fst-italic">{empty}</div>;
  return (
    <ul className="sch-runs">
      {runs.map((r) => {
        const meta = [
          r.trigger === 'MANUAL' ? `à la main${r.triggeredBy ? ` par ${r.triggeredBy.name}` : ''}` : r.scheduledFor && Math.abs(new Date(r.scheduledFor).getTime() - new Date(r.startedAt).getTime()) > 120_000 ? `échéance du ${when(r.scheduledFor)}` : null,
          r.durationMs !== null ? formatDuration(r.durationMs) : null,
          r.costUsd !== null && r.costUsd > 0 ? formatCost(r.costUsd) : null,
        ].filter(Boolean);
        return (
          <li key={r.id} className={`sch-run${isRunProblem(r.status) ? ' problem' : ''}`}>
            <div className="sch-run-head">
              <RunStatus run={r} />
              <span className="sch-run-when">{when(r.scheduledFor && r.status === 'MISSED' ? r.scheduledFor : r.startedAt)}</span>
              {meta.length > 0 && <span className="sch-run-meta">{meta.join(' · ')}</span>}
              {r.answer && (
                <button type="button" className="sch-link ms-auto" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? 'Masquer la réponse' : 'Voir la réponse'}
                </button>
              )}
            </div>
            {r.message && <div className="sch-run-message">{r.message}</div>}
            {open === r.id && r.answer && <div className="sch-run-answer">{r.answer}</div>}
          </li>
        );
      })}
    </ul>
  );
}
