import { AppError } from '../errors.js';
import { userService } from '../users/service.js';
import { ROLE_RANK, type ProjectRole, type User } from '../users/types.js';

/** Contexte GraphQL : utilisateur connecté et cache des rôles résolus pendant la requête. */
export interface AuthContext {
  user: User | null;
  /** Rôles d'appartenance (null : pas membre), par projet. */
  roles: Map<string, ProjectRole | null>;
  projectIds?: string[];
}

export const createAuthContext = (user: User | null): AuthContext => ({ user, roles: new Map() });

const roleLabels: Record<ProjectRole, string> = { viewer: 'lecteur', member: 'membre', admin: 'administrateur' };

export function requireUser(ctx: AuthContext): User {
  if (!ctx.user) throw new AppError('Connexion requise', 'UNAUTHENTICATED');
  return ctx.user;
}

export function requireAdmin(ctx: AuthContext): User {
  const user = requireUser(ctx);
  if (!user.isAdmin) throw new AppError("Réservé aux administrateurs de l'application", 'FORBIDDEN');
  return user;
}

export function requireSuperAdmin(ctx: AuthContext): User {
  const user = requireUser(ctx);
  if (!user.isSuperAdmin) throw new AppError('Réservé aux super administrateurs', 'FORBIDDEN');
  return user;
}

/** Rôle d'appartenance de l'utilisateur courant sur un projet (null : pas membre), mémorisé pour la requête. */
export async function memberRoleFor(ctx: AuthContext, projectId: string): Promise<ProjectRole | null> {
  const user = requireUser(ctx);
  if (!ctx.roles.has(projectId)) ctx.roles.set(projectId, await userService.memberRoleFor(user.id, projectId));
  return ctx.roles.get(projectId) ?? null;
}

/** Rôle effectif : l'appartenance, sinon administrateur pour un super administrateur (null : aucun accès). */
export async function roleFor(ctx: AuthContext, projectId: string): Promise<ProjectRole | null> {
  const user = requireUser(ctx);
  return (await memberRoleFor(ctx, projectId)) ?? (user.isSuperAdmin ? 'admin' : null);
}

/** Lève une erreur si l'utilisateur n'a pas au moins le rôle demandé sur le projet. */
export async function requireProject(ctx: AuthContext, projectId: string, min: ProjectRole = 'viewer'): Promise<ProjectRole> {
  const role = await roleFor(ctx, projectId);
  if (!role) throw new AppError("Vous n'avez pas accès à ce projet", 'FORBIDDEN');
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw new AppError(`Cette action demande le rôle ${roleLabels[min]} sur le projet`, 'FORBIDDEN');
  return role;
}

/** Projets dont l'utilisateur courant est membre (mémorisés pour la requête) : ce sont eux qui alimentent les listes et les flux. */
export async function accessibleProjectIds(ctx: AuthContext): Promise<string[]> {
  const user = requireUser(ctx);
  if (!ctx.projectIds) ctx.projectIds = await userService.projectIdsFor(user.id);
  return ctx.projectIds;
}

/** Appartenance seule : un événement d'un projet dont un super administrateur n'est pas membre ne lui parvient pas. */
export const canAccessProject = async (ctx: AuthContext, projectId: string | null | undefined): Promise<boolean> =>
  Boolean(ctx.user) && (projectId == null || (await memberRoleFor(ctx, projectId)) !== null);

/** Filtre un flux de subscription selon un prédicat asynchrone. */
export async function* filterAsync<T>(source: AsyncIterable<T>, predicate: (value: T) => Promise<boolean> | boolean): AsyncGenerator<T> {
  for await (const value of source) if (await predicate(value)) yield value;
}
