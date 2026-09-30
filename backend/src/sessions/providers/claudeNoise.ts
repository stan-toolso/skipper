import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Sous-types de messages `system` du SDK sans intérêt pour l'historique : compteurs et états intermédiaires
 * émis en continu, que le transcript n'affiche pas. Les journaliser coûte une écriture en base chacun,
 * gonfle `session_events` et ralentit l'ouverture des sessions.
 * Restent journalisés : `init`, `status`, `compact_boundary`, `api_retry`, `task_started` et
 * `task_notification` (début et fin des commandes et sous-agents en arrière-plan), et tout sous-type inconnu.
 */
export const NOISY_SYSTEM_SUBTYPES = new Set(['thinking_tokens', 'task_progress', 'task_updated', 'background_tasks_changed', 'vcs_state_changed']);

/** Types de messages du SDK jamais journalisés (`tool_progress` : temps écoulé d'un outil en cours, plusieurs par seconde). */
export const NOISY_MESSAGE_TYPES = new Set(['tool_progress']);

/** Vrai si le message du SDK ne doit pas être enregistré dans le journal de la session. */
export function isNoise(message: SDKMessage): boolean {
  if (NOISY_MESSAGE_TYPES.has(message.type)) return true;
  const subtype = (message as { subtype?: unknown }).subtype;
  return message.type === 'system' && typeof subtype === 'string' && NOISY_SYSTEM_SUBTYPES.has(subtype);
}
