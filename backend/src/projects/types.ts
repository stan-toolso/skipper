import type { SessionCleanup } from '../sessions/types.js';
import type { TaskModels } from './models.js';
import type { TaskStatusDefinition, TaskStatusInput } from '../tasks/statuses.js';

/** Modes d'autorisation proposés comme réglage par défaut d'un projet (voir le provider Claude). */
export const projectPermissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
export type ProjectPermissionMode = (typeof projectPermissionModes)[number];

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  /** Adresse du dépôt ; pour un projet hébergé, l'URL de clone du dépôt servi par Skipper (dérivée, jamais stockée). */
  gitUrl: string | null;
  gitBranch: string | null;
  /** Dépôt hébergé par Skipper (dépôt nu sur le serveur, sauvegardé en base) plutôt que distant. */
  gitHosted: boolean;
  /** Réglages du conteneur Docker du projet : { image, memory, cpus, browser }. */
  runnerConfig: Record<string, unknown>;
  /** Mode d'autorisation des nouvelles sessions qui n'en précisent pas (sessions de tâches notamment). */
  defaultPermissionMode: ProjectPermissionMode;
  /**
   * Limite de contexte des nouvelles sessions qui n'en choisissent pas (sessions de tâches, lancées par un agent) et
   * présélectionnée au lancement : compacter ou repartir d'une conversation neuve au-delà d'un seuil. Null : aucune.
   */
  defaultContextCleanup: SessionCleanup | null;
  /**
   * Modèle Claude des nouvelles sessions qui n'en choisissent pas (planifications, sessions de tâches, lancées par un
   * agent sans modèle) ; null : le modèle par défaut du propriétaire. Ignoré s'il n'est pas autorisé pour le propriétaire.
   */
  defaultModel: string | null;
  /** Modèle des sessions de tâches selon la priorité de la tâche, prioritaire sur `defaultModel` ; null : aucun. */
  taskModels: TaskModels | null;
  /** Consignes ajoutées à l'instruction de toute session qui réalise une tâche du projet, après le texte de la tâche (vide : aucune). */
  taskInstructions: string;
  /** Statuts des tâches du projet, dans l'ordre d'affichage (les statuts par défaut s'il n'en a pas choisi, voir tasks/statuses.ts). */
  taskStatuses: TaskStatusDefinition[];
  /** Le projet a choisi ses statuts (sinon : ceux par défaut, qui suivent les évolutions de Skipper). */
  taskStatusesCustomized: boolean;
  /** Espace personnel : la personne à qui il appartient (jamais partagé) ; null pour un projet ordinaire. */
  personalOwnerId: string | null;
  /** Budget mensuel du projet en USD (au-delà : plus de session ni de tour, voir projects/budget.ts) ; null : aucun. */
  monthlyBudgetUsd: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  name: string;
  slug?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  /** Héberger le dépôt chez Skipper (exclusif d'une adresse de dépôt distant). */
  gitHosted?: boolean | null;
  runnerConfig?: Record<string, unknown> | null;
  defaultPermissionMode?: string | null;
  defaultContextCleanup?: SessionCleanup | null;
  defaultModel?: string | null;
  taskModels?: TaskModels | null;
  taskInstructions?: string | null;
  /** Espace personnel de cette personne (voir personal/service.ts). */
  personalOwnerId?: string | null;
}

/** Un projet est-il l'espace personnel d'une personne ? */
export const isPersonalProject = (project: Pick<Project, 'personalOwnerId'>): boolean => Boolean(project.personalOwnerId);

export interface UpdateProjectInput {
  name?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  /** Passer à true héberge le dépôt chez Skipper (dossier existant importé) ; revenir à false n'est pas possible. */
  gitHosted?: boolean | null;
  runnerConfig?: Record<string, unknown> | null;
  defaultPermissionMode?: string | null;
  /** Null (ou objet vide) : aucune limite. */
  defaultContextCleanup?: SessionCleanup | null;
  /** Null ou vide : aucun. */
  defaultModel?: string | null;
  /** Null ou objet vide : aucun. */
  taskModels?: TaskModels | null;
  taskInstructions?: string | null;
  /** Statuts des tâches (liste complète, dans l'ordre) ; null ou vide : les statuts par défaut. */
  taskStatuses?: TaskStatusInput[] | TaskStatusDefinition[] | null;
  /** Budget mensuel en USD ; null ou 0 : aucun. Modifié par la mutation setProjectBudget (pas par updateProject). */
  monthlyBudgetUsd?: number | null;
}
