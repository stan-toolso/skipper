export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
/** Pour une session en cours : l'agent travaille ('busy') ou attend des instructions ('idle'). */
export type SessionActivity = 'busy' | 'idle';

export interface Session {
  id: string;
  projectId: string;
  worktreeId: string | null;
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

export interface CreateSessionInput {
  projectId: string;
  worktreeId?: string | null;
  name: string;
  provider: string;
  prompt?: string | null;
  config?: Record<string, unknown> | null;
}

export interface SessionFilter {
  projectId?: string;
  worktreeId?: string;
  status?: SessionStatus;
  provider?: string;
  limit?: number;
  offset?: number;
}
