/** Modes d'autorisation proposés comme réglage par défaut d'un projet (voir le provider Claude). */
export const projectPermissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
export type ProjectPermissionMode = (typeof projectPermissionModes)[number];

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  gitUrl: string | null;
  gitBranch: string | null;
  /** Réglages du conteneur Docker du projet : { image, memory, cpus, browser }. */
  runnerConfig: Record<string, unknown>;
  /** Mode d'autorisation des nouvelles sessions qui n'en précisent pas (sessions de tâches notamment). */
  defaultPermissionMode: ProjectPermissionMode;
  /** Consignes ajoutées à l'instruction de toute session qui réalise une tâche du projet, après le texte de la tâche (vide : aucune). */
  taskInstructions: string;
  /** Espace personnel : la personne à qui il appartient (jamais partagé) ; null pour un projet ordinaire. */
  personalOwnerId: string | null;
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
  runnerConfig?: Record<string, unknown> | null;
  defaultPermissionMode?: string | null;
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
  runnerConfig?: Record<string, unknown> | null;
  defaultPermissionMode?: string | null;
  taskInstructions?: string | null;
}
