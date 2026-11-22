import type { TaskStatus, TaskStatusDefinition } from '../graphql/operations';

/**
 * Statuts des tâches d'un projet (Project.taskStatuses) : chacun est rangé dans une catégorie (TaskStatus) qui porte son
 * sens. Côté serveur : backend/src/tasks/statuses.ts.
 */
export const TASK_CATEGORIES: { value: TaskStatus; label: string }[] = [
  { value: 'TODO', label: 'À faire' },
  { value: 'IN_PROGRESS', label: 'En cours' },
  { value: 'DONE', label: 'Terminée' },
  { value: 'CANCELLED', label: 'Annulée' },
];

/** Statuts par défaut (projet sans statuts chargés : vue de plusieurs projets, cache incomplet). */
export const DEFAULT_TASK_STATUSES: TaskStatusDefinition[] = [
  { key: 'triage', label: 'À trier', category: 'TODO', description: null, attention: true, isDefault: false },
  { key: 'todo', label: 'À faire', category: 'TODO', description: null, attention: false, isDefault: true },
  { key: 'in_progress', label: 'En cours', category: 'IN_PROGRESS', description: null, attention: false, isDefault: true },
  { key: 'review', label: 'À valider', category: 'IN_PROGRESS', description: null, attention: true, isDefault: false },
  { key: 'done', label: 'Terminée', category: 'DONE', description: null, attention: false, isDefault: true },
  { key: 'cancelled', label: 'Annulée', category: 'CANCELLED', description: null, attention: false, isDefault: true },
];

/** Statut par défaut d'une catégorie. */
export function defaultStatusOf(statuses: TaskStatusDefinition[], category: TaskStatus): TaskStatusDefinition | undefined {
  return statuses.find((s) => s.category === category && s.isDefault) ?? statuses.find((s) => s.category === category);
}

/** Libellé en minuscule initiale (« à valider »), pour une phrase ou un motif. */
export const lowerFirst = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
