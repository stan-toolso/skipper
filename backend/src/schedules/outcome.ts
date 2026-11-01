import { resultError } from '../sessions/providers/claudeResult.js';
import type { ScheduleRunStatus } from './types.js';

/** Ce que l'agent a fait pendant une exécution, lu dans les événements qui suivent son événement `schedule`. */
export interface RunSummary {
  cost: number;
  durationMs: number | null;
  error: string | null;
  /** Outils dont l'appel a été refusé (mode « Ne jamais me demander », refus d'une demande), sans doublon. */
  denied: string[];
  /** Dernière réponse de l'agent (résultat du dernier tour réussi). */
  answer: string | null;
}

/** Nom lisible d'un outil : `mcp__vault__sql_query` → `vault.sql_query`. */
export function toolLabel(name: string): string {
  const parts = name.split('__');
  return parts[0] === 'mcp' && parts.length >= 3 ? `${parts[1]}.${parts.slice(2).join('__')}` : name;
}

export function summarizeEvents(events: { type: string; payload: Record<string, unknown> }[]): RunSummary {
  let cost = 0;
  let durationMs: number | null = null;
  let error: string | null = null;
  let answer: string | null = null;
  const denied = new Set<string>();
  for (const e of events) {
    if (e.type === 'usage' && typeof e.payload.deltaUsd === 'number') cost += e.payload.deltaUsd;
    if (e.type === 'claude.result') {
      if (typeof e.payload.duration_ms === 'number') durationMs = (durationMs ?? 0) + e.payload.duration_ms;
      error = resultError(e.payload) ?? error;
      if (!e.payload.is_error && typeof e.payload.result === 'string' && e.payload.result.trim()) answer = e.payload.result.trim();
      const denials = e.payload.permission_denials;
      if (Array.isArray(denials)) {
        for (const d of denials) {
          const name = d && typeof d === 'object' ? (d as { tool_name?: unknown }).tool_name : null;
          if (typeof name === 'string' && name) denied.add(toolLabel(name));
        }
      }
    }
    if (e.type === 'status' && e.payload.status === 'failed' && typeof e.payload.error === 'string') error = e.payload.error;
  }
  return { cost, durationMs, error, denied: [...denied], answer };
}

/**
 * Issue d'une exécution terminée (ou abandonnée au délai d'attente). Une erreur l'emporte ; un outil refusé
 * ou une demande sans réponse rend l'exécution « bloquée » : l'agent a répondu, mais n'a pas pu faire son
 * travail, et rien ne doit le présenter comme une réussite.
 */
export function runOutcome(summary: RunSummary, state: { stillBusy: boolean; pendingRequest: string | null }): { status: ScheduleRunStatus; message: string | null } {
  if (summary.error) return { status: 'failed', message: summary.error };
  if (state.pendingRequest) return { status: 'blocked', message: `En attente d'une réponse : ${state.pendingRequest}` };
  if (summary.denied.length) return { status: 'blocked', message: `Autorisation refusée : ${summary.denied.join(', ')}` };
  if (state.stillBusy) return { status: 'timeout', message: "Toujours au travail après le délai d'attente" };
  return { status: 'done', message: null };
}

export const RUN_STATUS_LABELS: Record<ScheduleRunStatus, string> = {
  running: 'En cours',
  done: 'Terminée',
  blocked: 'Bloquée',
  failed: 'En erreur',
  timeout: 'Délai dépassé',
  skipped: 'Ignorée',
  missed: 'Manquée',
};
