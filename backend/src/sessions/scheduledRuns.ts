/**
 * Sessions dont l'exécution en cours a été lancée par leur planification. L'ordonnanceur émet sa propre
 * notification de fin (avec le coût) : la notification générique de fin de session est alors omise.
 */
export const scheduledRuns = new Set<string>();
