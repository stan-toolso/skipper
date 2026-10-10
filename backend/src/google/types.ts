import type { GoogleAccess } from '../vault/types.js';

export type { GoogleAccess };
export { GOOGLE_ACCESSES } from '../vault/types.js';

/**
 * Compte Google tel que les outils des agents le voient : un élément `google` du coffre (personnel ou
 * d'un projet) avec ses accès Gmail et Drive. Le jeton de rafraîchissement reste dans le coffre.
 */
export interface GoogleAccount {
  /** Identifiant de l'élément du coffre. */
  id: string;
  name: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  googleSub: string;
  gmailAccess: GoogleAccess;
  driveAccess: GoogleAccess;
  scopes: string[];
  requireApproval: boolean;
}

/** Accès demandés au moment de relier le compte. */
export interface GoogleAccessRequest {
  gmail: GoogleAccess;
  drive: GoogleAccess;
}
