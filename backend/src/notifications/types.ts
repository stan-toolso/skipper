export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  projectId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  /** Réservée aux administrateurs de l'application. */
  adminsOnly: boolean;
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
  adminsOnly?: boolean;
}

/** Notifications visibles par l'utilisateur : celles de ses projets et, pour un administrateur, les notifications réservées. */
export interface NotificationScope {
  projectIds?: string[];
  admin?: boolean;
}
