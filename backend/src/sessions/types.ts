export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
/** Pour une session en cours : l'agent travaille ('busy') ou attend des instructions ('idle'). */
export type SessionActivity = 'busy' | 'idle';

export interface Session {
  id: string;
  projectId: string;
  worktreeId: string | null;
  /** Session d'agent qui a lancé celle-ci (outil `sessions.create`), null pour une session lancée par un humain. */
  parentSessionId: string | null;
  name: string;
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  prompt: string | null;
  config: Record<string, unknown>;
  externalId: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Worktree à créer en même temps que la session, qui s'y exécutera. */
export interface NewWorktreeInput {
  branch: string;
  name?: string | null;
  baseRef?: string | null;
}

export interface CreateSessionInput {
  projectId: string;
  worktreeId?: string | null;
  /** Crée d'abord ce worktree et y lance la session (exclusif avec worktreeId). */
  newWorktree?: NewWorktreeInput | null;
  parentSessionId?: string | null;
  name: string;
  provider: string;
  prompt?: string | null;
  config?: Record<string, unknown> | null;
}

export interface SessionFilter {
  projectId?: string;
  /** Restreint aux projets listés (projets accessibles à l'utilisateur). */
  projectIds?: string[];
  worktreeId?: string;
  parentSessionId?: string;
  status?: SessionStatus;
  provider?: string;
  limit?: number;
  offset?: number;
}
