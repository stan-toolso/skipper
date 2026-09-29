export type ProjectRole = 'admin' | 'member' | 'viewer';

/** Ordre des rôles : un rôle donne tous les droits des rôles inférieurs. */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, admin: 2 };

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  googleSub: string | null;
  /** Administrateur de l'application : paramètres généraux. Les droits sur les projets restent par projet. */
  isAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectRole;
  invitedById: string | null;
  createdAt: Date;
}

/** Profil renvoyé par Google après connexion. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}
