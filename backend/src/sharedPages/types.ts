/** Page HTML publiée par une personne ou un agent, servie à /shared/<id>, privée par défaut. */
export interface SharedPage {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  /** Visible par quiconque est connecté et a le lien. */
  linkAccess: boolean;
  /** Numéro de la dernière version. */
  version: number;
  projectId: string | null;
  sessionId: string | null;
  sourcePath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedPageVersion {
  pageId: string;
  version: number;
  size: number;
  createdById: string | null;
  sessionId: string | null;
  createdAt: Date;
}

export interface SharedPageMember {
  pageId: string;
  userId: string;
  addedById: string | null;
  createdAt: Date;
}

export interface PublishInput {
  ownerId: string;
  title: string;
  description?: string | null;
  html: Buffer;
  /** Nouvelle version d'une page existante. */
  pageId?: string | null;
  linkAccess?: boolean | null;
  projectId?: string | null;
  sessionId?: string | null;
  sourcePath?: string | null;
}
