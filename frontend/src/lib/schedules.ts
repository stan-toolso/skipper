import type { ScheduleRunStatus } from '../graphql/operations';

/** Libellé, couleur (variable de thème) et pictogramme de l'issue d'une exécution planifiée. */
export const scheduleRunStatus: Record<ScheduleRunStatus, { label: string; cls: string; icon: string; hint: string }> = {
  RUNNING: { label: 'En cours', cls: 'running', icon: 'bi-arrow-repeat', hint: "L'agent travaille" },
  DONE: { label: 'Terminée', cls: 'done', icon: 'bi-check-circle-fill', hint: 'Terminée sans erreur ni refus' },
  BLOCKED: { label: 'Bloquée', cls: 'blocked', icon: 'bi-shield-exclamation', hint: "Un outil a été refusé ou une demande est restée sans réponse : l'agent n'a pas pu faire son travail" },
  FAILED: { label: 'En erreur', cls: 'failed', icon: 'bi-x-circle-fill', hint: "L'exécution s'est arrêtée sur une erreur" },
  TIMEOUT: { label: 'Délai dépassé', cls: 'failed', icon: 'bi-hourglass-bottom', hint: "Toujours au travail après le délai d'attente" },
  SKIPPED: { label: 'Ignorée', cls: 'skipped', icon: 'bi-skip-forward-fill', hint: "Échéance ignorée (agent au travail, budget, maintenance…)" },
  MISSED: { label: 'Manquée', cls: 'skipped', icon: 'bi-dash-circle', hint: 'Serveur arrêté à l’échéance, non rattrapée' },
};

/** Exécution qui demande l'attention (le compte rendu « terminée » d'hier ne suffit pas à rassurer). */
export const isRunProblem = (status: ScheduleRunStatus): boolean => status === 'BLOCKED' || status === 'FAILED' || status === 'TIMEOUT';

/** « dans 3 h », « dans 2 j », « dans 5 min » : délai jusqu'à une échéance. */
export function timeUntil(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 60_000) return 'imminente';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `dans ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `dans ${h} h`;
  return `dans ${Math.round(h / 24)} j`;
}
