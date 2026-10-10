import type { RunStatus, RunTrigger, WorkflowNodeType } from '../graphql/automation';

/** Libellés et couleurs des statuts d'exécution (agents et workflows). */
export const runStatusLabels: Record<RunStatus, { label: string; bg: string; text?: string }> = {
  QUEUED: { label: "En file d'attente", bg: 'info', text: 'dark' },
  PENDING: { label: 'En attente', bg: 'secondary' },
  RUNNING: { label: 'En cours', bg: 'primary' },
  SUCCEEDED: { label: 'Réussie', bg: 'success' },
  FAILED: { label: 'Échouée', bg: 'danger' },
  CANCELLED: { label: 'Annulée', bg: 'secondary' },
};

export const runTriggerLabels: Record<RunTrigger, string> = {
  MANUAL: 'à la main',
  SCHEDULE: 'planifiée',
  WORKFLOW: 'par un workflow',
  TEST: 'test',
  EVENT: 'par un événement',
};

export const isRunActive = (status: RunStatus): boolean => status === 'QUEUED' || status === 'PENDING' || status === 'RUNNING';

/** Statut d'un nœud dans une exécution de workflow. */
export const nodeStatusLabels: Record<string, string> = {
  pending: 'En attente',
  running: 'En cours',
  succeeded: 'Réussi',
  failed: 'Échoué',
  skipped: 'Passé',
  cancelled: 'Annulé',
};

/** Types de nœuds d'un workflow : libellé, icône et aide (palette de l'éditeur). */
export const nodeTypeInfo: Record<WorkflowNodeType, { label: string; icon: string; hint: string }> = {
  trigger: { label: 'Déclencheur', icon: 'bi-play-circle', hint: 'Le départ : lancé à la main, par planification, ou par une tâche créée.' },
  agent: { label: 'Agent', icon: 'bi-robot', hint: 'Exécute un agent du projet avec des entrées remplies par des modèles.' },
  task: { label: 'Tâche', icon: 'bi-check2-square', hint: 'Confie une tâche existante à une session dédiée.' },
  session: { label: 'Session', icon: 'bi-chat-dots', hint: 'Ouvre une session avec une instruction.' },
  createTask: { label: 'Créer une tâche', icon: 'bi-plus-square', hint: 'Crée une tâche dans le projet.' },
  condition: { label: 'Condition', icon: 'bi-signpost-split', hint: 'Oriente vers la branche « oui » ou « non ».' },
  end: { label: 'Fin', icon: 'bi-flag', hint: "Termine l'exécution et en fixe la sortie." },
};

/** Libellé d'un fournisseur d'agent : appel direct ou type de session. */
export function providerLabel(provider: string, providers: { type: string; label: string }[] = []): string {
  if (provider === 'llm') return 'Modèle (appel direct)';
  return providers.find((p) => p.type === provider)?.label ?? provider;
}

export const fmtDateTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Durée d'une exécution, d'après ses dates quand la durée n'est pas enregistrée. */
export function runDurationMs(run: { durationMs?: number | null; startedAt: string | null; finishedAt: string | null }): number | null {
  if (run.durationMs != null) return run.durationMs;
  if (run.startedAt) return (run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime();
  return null;
}

/** Forme lisible d'une valeur JSON (sortie de nœud, entrées...). */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Motif des clés de variables (identique au backend). */
export const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
