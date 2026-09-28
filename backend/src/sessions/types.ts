export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export interface Session {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  status: SessionStatus;
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
  name: string;
  provider: string;
  prompt?: string | null;
  config?: Record<string, unknown> | null;
}

export interface SessionFilter {
  projectId?: string;
  status?: SessionStatus;
  provider?: string;
  limit?: number;
  offset?: number;
}
