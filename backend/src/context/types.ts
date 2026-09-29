export type AuthorType = 'human' | 'agent';

/** Qui effectue une opération sur le contexte : un humain via l'interface, ou un agent via une session. */
export interface Actor {
  type: AuthorType;
  sessionId?: string | null;
}

export interface ContextFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  slug: string;
  /** Chemin de slugs depuis la racine, ex. "api/auth". */
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextInstruction {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  slug: string;
  /** Chemin de slugs, ex. "api/auth/regles-jwt". */
  path: string;
  description: string;
  content: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextInstructionVersion {
  id: string;
  instructionId: string;
  version: number;
  name: string;
  description: string;
  content: string;
  changeNote: string | null;
  authorType: AuthorType;
  authorSessionId: string | null;
  createdAt: Date;
}

export type ContextChangeKind =
  | 'folder.create'
  | 'folder.rename'
  | 'folder.move'
  | 'folder.delete'
  | 'instruction.create'
  | 'instruction.update'
  | 'instruction.move'
  | 'instruction.delete'
  | 'instruction.restore'
  | 'project.update';

export interface ContextChange {
  id: string;
  projectId: string;
  kind: ContextChangeKind;
  path: string;
  details: Record<string, unknown>;
  authorType: AuthorType;
  authorSessionId: string | null;
  createdAt: Date;
}

/** Arborescence complète d'un projet, à plat (chemins calculés). */
export interface ContextTree {
  folders: ContextFolder[];
  instructions: ContextInstruction[];
}
