export type RequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired';

/** Une demande d'intervention humaine émise par un agent pendant une session. */
export interface HumanRequest {
  id: string;
  sessionId: string;
  /** 'permission' (autoriser un outil), 'question' (choix / texte), 'input' (libre), ou tout autre type. */
  type: string;
  status: RequestStatus;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  createdAt: Date;
  answeredAt: Date | null;
}

export interface CreateRequestInput {
  type: string;
  title: string;
  message?: string | null;
  payload?: Record<string, unknown>;
}

/** Réponse d'une demande de type 'permission'. */
export interface PermissionResponse {
  decision: 'allow' | 'deny';
  /** Si true, les suggestions de règles du SDK sont appliquées pour ne plus redemander pendant la session. */
  always?: boolean;
  /** 'project' : les règles suggérées sont mémorisées pour le projet (toutes ses sessions futures) en plus de la session courante. */
  scope?: 'session' | 'project';
  message?: string;
}

/** Réponse d'une demande de type 'question' : texte de la question -> réponse. */
export interface QuestionResponse {
  answers: Record<string, string>;
}
