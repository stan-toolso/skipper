export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  projectId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotifyInput {
  type: string;
  title: string;
  message?: string | null;
  link?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
}
