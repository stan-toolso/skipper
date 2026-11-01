import type { SessionCleanup } from '../sessions/types.js';

/** Planification d'une session : l'instruction est envoyée à chaque échéance de l'expression cron. */
export interface SessionSchedule {
  sessionId: string;
  /** Nom de la planification (« Revue quotidienne Curso ») ; null : celui de la session. */
  name: string | null;
  /** Cinq champs : minute heure jour mois jour-de-semaine (ou alias @daily, @hourly...). */
  cron: string;
  /** Fuseau IANA dans lequel l'expression est interprétée. */
  timezone: string;
  /** Instruction envoyée à la session à chaque exécution. */
  prompt: string;
  enabled: boolean;
  /** Terminer la session à la fin de chaque exécution (sinon elle reste ouverte aux instructions). */
  endAfterRun: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Compte rendu texte de la dernière exécution (gardé pour compatibilité ; l'historique est dans `ScheduleRun`). */
  lastResult: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionScheduleInput {
  /** Nom de la planification (vide : celui de la session). Absent : inchangé. */
  name?: string | null;
  cron: string;
  timezone?: string | null;
  prompt: string;
  enabled?: boolean | null;
  endAfterRun?: boolean | null;
  /** Réglage de nettoyage de la session, enregistré en même temps (null ou absent : inchangé). */
  cleanup?: SessionCleanup | null;
}

/** Ce qui a déclenché une exécution : l'échéance, ou « Exécuter maintenant ». */
export type ScheduleRunTrigger = 'schedule' | 'manual';

/**
 * Issue d'une exécution. `blocked` : l'agent n'a pas pu faire son travail faute d'autorisation (outil refusé,
 * demande restée sans réponse) ; `timeout` : toujours au travail après le délai d'attente ; `skipped` : échéance
 * ignorée (agent occupé, budget, maintenance) ; `missed` : échéance passée pendant un arrêt du serveur.
 */
export type ScheduleRunStatus = 'running' | 'done' | 'blocked' | 'failed' | 'timeout' | 'skipped' | 'missed';

export interface ScheduleRun {
  id: string;
  sessionId: string;
  trigger: ScheduleRunTrigger;
  triggeredBy: string | null;
  status: ScheduleRunStatus;
  scheduledFor: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  costUsd: number | null;
  durationMs: number | null;
  message: string | null;
  /** Début de la dernière réponse de l'agent pendant l'exécution. */
  answer: string | null;
  startEventId: string | null;
}

/** Planification et session, pour la liste des planifications. */
export interface ScheduleWithSession extends SessionSchedule {
  projectId: string;
}
