export type TerminalStatus = 'running' | 'closed';

export interface TerminalRecord {
  id: string;
  projectId: string;
  name: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: Date;
  closedAt: Date | null;
}
