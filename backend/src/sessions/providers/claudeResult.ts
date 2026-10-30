/**
 * Lecture du message `result` qui clôt chaque tour de Claude Code (journalisé comme événement `claude.result`).
 *
 * Depuis le CLI 2.1.300, un tour interrompu par l'humain (bouton « Interrompre », touche Échap) se termine par
 * un résultat `error_during_execution` avec `is_error: true`, `terminal_reason: 'aborted_streaming'` et un
 * diagnostic interne dans `errors` (`[ede_diagnostic] result_type=user …`). Ce n'est pas une panne : l'agent
 * attend simplement la prochaine instruction. Les consommateurs du résultat (fin de flux du provider, compte
 * rendu d'une exécution d'agent ou d'une planification, transcript) doivent donc distinguer une interruption
 * d'une vraie erreur.
 */

/** Raisons de fin de tour qui traduisent une interruption demandée (pendant l'appel au modèle ou pendant les outils). */
export const INTERRUPTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools']);

/** Texte affiché à la place du diagnostic interne du CLI pour un tour interrompu. */
export const INTERRUPTED_LABEL = 'Tour interrompu';

type ResultLike = { is_error?: unknown; subtype?: unknown; errors?: unknown; result?: unknown; terminal_reason?: unknown };

/** Vrai si le tour s'est arrêté parce qu'on l'a interrompu. */
export function isInterruptedResult(payload: ResultLike): boolean {
  return typeof payload.terminal_reason === 'string' && INTERRUPTED_TERMINAL_REASONS.has(payload.terminal_reason);
}

/**
 * Message d'erreur d'un résultat, ou null si le tour s'est bien terminé.
 * Un tour interrompu est signalé par `INTERRUPTED_LABEL` (sans le diagnostic interne) quand `interruptedIsError`
 * est vrai — cas d'une exécution d'agent ou d'une planification, dont le travail n'est pas allé au bout — et
 * n'est pas une erreur sinon.
 */
export function resultError(payload: ResultLike, { interruptedIsError = true } = {}): string | null {
  if (isInterruptedResult(payload)) return interruptedIsError ? INTERRUPTED_LABEL : null;
  if (!payload.is_error) return null;
  const errors = Array.isArray(payload.errors) ? payload.errors.filter((e): e is string => typeof e === 'string' && e.length > 0) : [];
  if (payload.subtype === 'success') return typeof payload.result === 'string' && payload.result ? payload.result : 'erreur';
  const subtype = typeof payload.subtype === 'string' ? payload.subtype : 'erreur';
  return errors.length ? `${subtype} : ${errors.join(' ; ')}` : subtype;
}

/**
 * Vrai pour un tour vide que le CLI ouvre de lui-même sur une notification de tâche de fond, sans appeler le
 * modèle (`origin.kind: 'task-notification'`, `num_turns: 0`). Cas observé le 30/10/2026 (CLI 2.1.314) : à la
 * reprise d'une session après un redémarrage, le CLI signale d'abord la commande de fond tuée avec l'ancien
 * processus (« Background shell command didn't finish before the previous session ended ») et clôt ce tour par
 * un `result` vide, puis seulement traite l'instruction envoyée. Ce résultat ne clôt donc pas le tour de
 * l'instruction : la session doit rester « au travail ».
 */
export function isEmptyNotificationResult(payload: ResultLike & { origin?: unknown; num_turns?: unknown }): boolean {
  const origin = payload.origin as { kind?: unknown } | null | undefined;
  return origin?.kind === 'task-notification' && payload.num_turns === 0;
}
