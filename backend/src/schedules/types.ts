/** Planification d'une session : l'instruction est envoyée à chaque échéance de l'expression cron. */
export interface SessionSchedule {
  sessionId: string;
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
  /** Compte rendu de la dernière exécution : terminée (coût, durée), ignorée (raison) ou en erreur. */
  lastResult: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionScheduleInput {
  cron: string;
  timezone?: string | null;
  prompt: string;
  enabled?: boolean | null;
  endAfterRun?: boolean | null;
}
