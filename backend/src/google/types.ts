/** Niveau d'accès accordé aux agents sur un service Google du compte relié au projet. */
export type GoogleAccess = 'none' | 'read' | 'write';
export const GOOGLE_ACCESSES: GoogleAccess[] = ['none', 'read', 'write'];

/** Compte Google relié à un projet (plusieurs possibles, un même compte Google une seule fois par projet). */
export interface GoogleAccount {
  id: string;
  projectId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  googleSub: string;
  gmailAccess: GoogleAccess;
  driveAccess: GoogleAccess;
  /** Portées OAuth effectivement accordées par Google. */
  scopes: string[];
  /** Jeton de rafraîchissement chiffré, tel qu'en base. */
  refreshToken: string;
  connectedById: string | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Accès demandés au moment de relier le compte. */
export interface GoogleAccessRequest {
  gmail: GoogleAccess;
  drive: GoogleAccess;
}

export interface GoogleAccountCheckResult {
  ok: boolean;
  error: string | null;
  /** Ce que Google a répondu (adresse, quota Drive...). */
  detail: string | null;
}
