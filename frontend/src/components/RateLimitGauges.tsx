import { Badge, ProgressBar } from 'react-bootstrap';
import type { ClaudeRateLimits, ClaudeRateLimitWindow } from '../graphql/operations';

export const rateLimitStatusLabels: Record<string, string> = {
  allowed: 'autorisé',
  allowed_warning: 'avertissement',
  rejected: 'refusé',
};

const statusVariant = (status: string) => (status === 'rejected' ? 'danger' : status === 'allowed_warning' ? 'warning' : 'success');
const meterVariant = (u: number) => (u >= 0.9 ? 'danger' : u >= 0.75 ? 'warning' : undefined);

/** Date de réinitialisation lisible : « aujourd'hui à 14:00 », « demain à 9:00 » ou « vendredi 3 octobre à 9:00 ». */
export function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `aujourd'hui à ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `demain à ${time}`;
  return `${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${time}`;
}

const percent = (u: number | null) => (u === null ? '?' : `${Math.round(u * 100)} %`);
const time = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Fenêtre la plus chargée (pour un résumé en une ligne). */
export function busiestWindow(limits: ClaudeRateLimits): ClaudeRateLimitWindow | null {
  return limits.windows.reduce<ClaudeRateLimitWindow | null>((best, w) => (w.utilization !== null && (best?.utilization ?? -1) < w.utilization ? w : best), null);
}

/**
 * Limites d'utilisation de l'abonnement Claude : statut du dernier événement reçu et une jauge par
 * fenêtre (5 h, 7 j, 7 j dépassement inclus...), avec l'heure de réinitialisation.
 */
export default function RateLimitGauges({ limits }: { limits: ClaudeRateLimits | null }) {
  if (!limits) {
    return <div className="text-secondary small">Aucune information reçue : les limites sont rapportées par les sessions (abonnement Claude uniquement, pas en clé API).</div>;
  }
  return (
    <div>
      <div className="d-flex flex-wrap align-items-baseline gap-2 mb-2 small">
        <Badge bg={statusVariant(limits.status)} text={limits.status === 'allowed_warning' ? 'dark' : undefined}>
          {rateLimitStatusLabels[limits.status] ?? limits.status}
        </Badge>
        {limits.status !== 'allowed' && limits.rateLimitLabel && (
          <span>
            fenêtre {limits.rateLimitLabel}
            {limits.resetsAt && <> · réinitialisation {formatReset(limits.resetsAt)}</>}
          </span>
        )}
        <span className="text-secondary ms-auto" title="Dernier événement reçu d'une session">
          relevé {time(limits.updatedAt)}
        </span>
      </div>
      {limits.status === 'rejected' && (
        <div className="small text-danger mb-2">Les tours des sessions sont refusés par Anthropic : changez de modèle ou attendez la réinitialisation.</div>
      )}
      {limits.windows.map((w) => {
        const stale = w.observedAt !== limits.updatedAt;
        return (
          <div key={w.type} className="mb-2">
            <div className="d-flex justify-content-between align-items-baseline small">
              <span>{w.label}</span>
              <span className="fw-semibold">{percent(w.utilization)}</span>
            </div>
            <ProgressBar
              now={Math.min(100, (w.utilization ?? 0) * 100)}
              variant={meterVariant(w.utilization ?? 0)}
              style={{ height: 6 }}
              className="my-1"
              aria-label={`Fenêtre ${w.label} : ${percent(w.utilization)}`}
            />
            <div className="text-secondary" style={{ fontSize: 12 }}>
              {w.resetsAt ? `Réinitialisation ${formatReset(w.resetsAt)}` : 'Réinitialisation inconnue'}
              {stale && ` · relevé ${time(w.observedAt)}`}
            </div>
          </div>
        );
      })}
      {limits.overageStatus && (
        <div className="text-secondary" style={{ fontSize: 12 }}>
          Dépassement payant : {rateLimitStatusLabels[limits.overageStatus] ?? limits.overageStatus}
          {limits.overageDisabledReason && ` (${limits.overageDisabledReason})`}
          {limits.isUsingOverage && ' · en cours d’utilisation'}
        </div>
      )}
    </div>
  );
}
