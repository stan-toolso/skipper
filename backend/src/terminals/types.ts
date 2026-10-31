export type TerminalStatus = 'running' | 'closed';

export interface TerminalRecord {
  id: string;
  projectId: string;
  worksessionId: string | null;
  /** Utilisateur qui a ouvert le terminal : seul lui le voit et s'y attache (null : terminal d'avant cette version). */
  createdById: string | null;
  name: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: Date;
  closedAt: Date | null;
  /** Instance du backend qui tient le shell (déploiement bleu/vert), null : aucune. Interne, hors GraphQL. */
  instanceId?: string | null;
}
