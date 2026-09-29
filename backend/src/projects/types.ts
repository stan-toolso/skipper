export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  gitUrl: string | null;
  gitBranch: string | null;
  /** 'local' : sur le serveur ; 'docker' : conteneur dédié au projet. */
  runner: 'local' | 'docker';
  runnerConfig: Record<string, unknown>;
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
  runner?: 'local' | 'docker' | null;
  runnerConfig?: Record<string, unknown> | null;
}

export interface UpdateProjectInput {
  name?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  runner?: 'local' | 'docker' | null;
  runnerConfig?: Record<string, unknown> | null;
}
