import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { userRepository } from './repository.js';
import type { GoogleProfile, OpenItems, ProjectMember, ProjectRole, User } from './types.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Nom par défaut d'un utilisateur invité : la partie locale de son e-mail, un peu lissée. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const userService = {
  async get(id: string): Promise<User> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('Utilisateur introuvable');
    return user;
  },

  list: () => userRepository.list(),
  listColleagues: (userId: string) => userRepository.listColleagues(userId),
  projectIdsHolding: (open: OpenItems) => userRepository.projectIdsHolding(open),

  /** Invite une personne dans l'application (sans projet) ; une personne existante peut être promue administratrice. */
  async inviteToApp(email: string, isAdmin: boolean): Promise<User> {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw new AppError('Adresse e-mail invalide');
    const existing = await userRepository.findByEmail(normalized);
    if (existing) return isAdmin && !existing.isAdmin ? (await userRepository.setAdmin(existing.id, true))! : existing;
    return userRepository.create({ email: normalized, name: nameFromEmail(normalized), isAdmin });
  },

  async setAdmin(userId: string, isAdmin: boolean): Promise<User> {
    const user = await this.get(userId);
    if (!isAdmin) {
      if (user.isSuperAdmin) throw new AppError("Retirez d'abord le rôle de super administrateur");
      if (user.isAdmin && (await userRepository.countAppAdmins()).admins <= 1) throw new AppError("L'application doit garder au moins un administrateur");
    }
    return (await userRepository.setAdmin(userId, isAdmin)) ?? user;
  },

  async setSuperAdmin(userId: string, isSuperAdmin: boolean): Promise<User> {
    const user = await this.get(userId);
    if (!isSuperAdmin && user.isSuperAdmin && (await userRepository.countAppAdmins()).superAdmins <= 1) throw new AppError("L'application doit garder au moins un super administrateur");
    return (await userRepository.setSuperAdmin(userId, isSuperAdmin)) ?? user;
  },

  /** Supprime un utilisateur (ses appartenances suivent) ; jamais soi-même ni le dernier administrateur. */
  async delete(userId: string, actor: User): Promise<boolean> {
    if (userId === actor.id) throw new AppError('Vous ne pouvez pas supprimer votre propre compte');
    const user = await this.get(userId);
    if (user.isSuperAdmin && !actor.isSuperAdmin) throw new AppError('Seul un super administrateur peut supprimer un super administrateur', 'FORBIDDEN');
    const counts = await userRepository.countAppAdmins();
    if (user.isAdmin && counts.admins <= 1) throw new AppError("L'application doit garder au moins un administrateur");
    if (user.isSuperAdmin && counts.superAdmins <= 1) throw new AppError("L'application doit garder au moins un super administrateur");
    return userRepository.delete(userId);
  },

  /**
   * Connexion Google : l'utilisateur doit déjà exister (créé par une invitation à un projet ou
   * dans la base). Il est retrouvé par son identifiant Google, sinon par son e-mail (première connexion).
   */
  async loginWithGoogle(profile: GoogleProfile): Promise<User> {
    if (!profile.emailVerified) throw new AppError('Adresse e-mail Google non vérifiée', 'EMAIL_NOT_VERIFIED');
    const email = profile.email.toLowerCase();
    const user = (await userRepository.findByGoogleSub(profile.sub)) ?? (await userRepository.findByEmail(email));
    if (!user) throw new AppError(`Aucune invitation pour ${email}`, 'NOT_INVITED');
    if (user.googleSub && user.googleSub !== profile.sub) throw new AppError('Ce compte est déjà relié à un autre compte Google', 'ACCOUNT_MISMATCH');
    return userRepository.recordLogin(user.id, { googleSub: profile.sub, name: profile.name, avatarUrl: profile.picture });
  },

  // ---- Membres d'un projet ------------------------------------------------------------------

  members: (projectId: string) => userRepository.listMembers(projectId),

  /** Rôle effectif : l'appartenance, sinon administrateur pour un super administrateur. */
  async roleFor(userId: string, projectId: string): Promise<ProjectRole | null> {
    const m = await userRepository.findMembership(projectId, userId);
    if (m) return m.role;
    const user = await userRepository.findById(userId);
    return user?.isSuperAdmin ? 'admin' : null;
  },

  /** Rôle d'appartenance seul (null pour un super administrateur non membre). */
  async memberRoleFor(userId: string, projectId: string): Promise<ProjectRole | null> {
    return (await userRepository.findMembership(projectId, userId))?.role ?? null;
  },

  projectIdsFor: (userId: string) => userRepository.projectIdsForUser(userId),

  /** Invite un e-mail sur un projet : crée l'utilisateur s'il n'existe pas, puis l'appartenance (ou met à jour le rôle). */
  async invite(projectId: string, email: string, role: ProjectRole, invitedBy: User): Promise<ProjectMember> {
    await projectService.get(projectId);
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw new AppError('Adresse e-mail invalide');
    const user = (await userRepository.findByEmail(normalized)) ?? (await userRepository.create({ email: normalized, name: nameFromEmail(normalized) }));
    return userRepository.upsertMembership({ projectId, userId: user.id, role, invitedById: invitedBy.id });
  },

  async setRole(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
    const current = await userRepository.findMembership(projectId, userId);
    if (!current) throw new NotFoundError("Cet utilisateur n'est pas membre du projet");
    if (current.role === 'admin' && role !== 'admin' && (await userRepository.countAdmins(projectId)) <= 1) {
      throw new AppError('Un projet doit garder au moins un administrateur');
    }
    return userRepository.upsertMembership({ projectId, userId, role, invitedById: current.invitedById });
  },

  async remove(projectId: string, userId: string): Promise<boolean> {
    const current = await userRepository.findMembership(projectId, userId);
    if (!current) throw new NotFoundError("Cet utilisateur n'est pas membre du projet");
    if (current.role === 'admin' && (await userRepository.countAdmins(projectId)) <= 1) {
      throw new AppError('Un projet doit garder au moins un administrateur');
    }
    return userRepository.removeMembership(projectId, userId);
  },

  /** Le créateur d'un projet en devient administrateur. */
  addCreator: (projectId: string, user: User) => userRepository.upsertMembership({ projectId, userId: user.id, role: 'admin', invitedById: user.id }),
};
