import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { userRepository } from '../users/repository.js';
import type { User } from '../users/types.js';
import { sharedPageRepository } from './repository.js';
import type { PublishInput, SharedPage } from './types.js';

export const MAX_PAGE_BYTES = 10 * 1024 * 1024;

function cleanTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) throw new AppError('Le titre de la page est obligatoire');
  if (title.length > 200) throw new AppError('Le titre dépasse 200 caractères');
  return title;
}

function cleanDescription(raw: string | null | undefined): string | null {
  const d = raw?.trim() ?? '';
  if (d.length > 1000) throw new AppError('La description dépasse 1000 caractères');
  return d || null;
}

/** Nom de fichier sûr pour un téléchargement. */
export const downloadName = (title: string) => `${title.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80) || 'page'}.html`;

export const sharedPageService = {
  async get(id: string): Promise<SharedPage> {
    const page = await sharedPageRepository.findById(id);
    if (!page) throw new NotFoundError('Page partagée introuvable, ou non partagée avec vous');
    return page;
  },

  /** Peut-on voir la page ? Propriétaire, lien ouvert, ou membre. */
  async canView(page: SharedPage, userId: string): Promise<boolean> {
    if (page.ownerId === userId || page.linkAccess) return true;
    return sharedPageRepository.isMember(page.id, userId);
  },

  /** Page visible par la personne ; sinon « introuvable » (l'existence n'est pas révélée). */
  async getFor(userId: string, id: string): Promise<SharedPage> {
    const page = await this.get(id);
    if (!(await this.canView(page, userId))) throw new NotFoundError('Page partagée introuvable, ou non partagée avec vous');
    return page;
  },

  async getOwned(userId: string, id: string): Promise<SharedPage> {
    const page = await this.getFor(userId, id);
    if (page.ownerId !== userId) throw new AppError('Seul le propriétaire de la page peut faire cela', 'FORBIDDEN');
    return page;
  },

  listFor: (userId: string) => sharedPageRepository.listFor(userId),
  listOwned: (userId: string, limit = 20) => sharedPageRepository.listOwned(userId, Math.min(Math.max(limit, 1), 100)),
  versions: (pageId: string) => sharedPageRepository.versions(pageId),
  members: (pageId: string) => sharedPageRepository.members(pageId),

  /** La page est-elle vue par d'autres que son propriétaire ? */
  async isShared(page: SharedPage): Promise<boolean> {
    return page.linkAccess || (await sharedPageRepository.members(page.id)).length > 0;
  },

  /** Publie une nouvelle page, ou une nouvelle version d'une page du propriétaire. */
  async publish(input: PublishInput): Promise<SharedPage> {
    if (!input.html.length) throw new AppError('La page est vide');
    if (input.html.length > MAX_PAGE_BYTES) throw new AppError(`La page est trop volumineuse (${(input.html.length / 1024 / 1024).toFixed(1)} Mo, 10 Mo au plus)`);
    const title = cleanTitle(input.title);
    const description = input.description === undefined ? undefined : cleanDescription(input.description);
    if (input.pageId) {
      const page = await this.get(input.pageId);
      if (page.ownerId !== input.ownerId) throw new AppError("Seul le propriétaire d'une page en publie de nouvelles versions", 'FORBIDDEN');
      const updated = await sharedPageRepository.addVersion(page.id, {
        title,
        description,
        linkAccess: input.linkAccess ?? null,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        sourcePath: input.sourcePath ?? null,
        html: input.html,
        createdBy: input.ownerId,
      });
      if (!updated) throw new NotFoundError('Page partagée introuvable');
      return updated;
    }
    return sharedPageRepository.create({
      ownerId: input.ownerId,
      title,
      description: description ?? null,
      linkAccess: input.linkAccess ?? false,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      sourcePath: input.sourcePath ?? null,
      html: input.html,
    });
  },

  /** Contenu d'une version (la dernière par défaut). */
  async content(page: SharedPage, version?: number | null): Promise<{ html: Buffer; version: number }> {
    const v = version ?? page.version;
    if (!Number.isInteger(v) || v < 1 || v > page.version) throw new NotFoundError('Version introuvable');
    const html = await sharedPageRepository.content(page.id, v);
    if (!html) throw new NotFoundError('Le contenu de cette version est manquant');
    return { html, version: v };
  },

  async update(userId: string, id: string, input: { title?: string | null; description?: string | null; linkAccess?: boolean | null }): Promise<SharedPage> {
    await this.getOwned(userId, id);
    const patch: { title?: string; description?: string | null; linkAccess?: boolean } = {};
    if (input.title != null) patch.title = cleanTitle(input.title);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.linkAccess != null) patch.linkAccess = input.linkAccess;
    return (await sharedPageRepository.update(id, patch)) ?? this.get(id);
  },

  async addMember(actor: User, id: string, email: string): Promise<SharedPage> {
    const page = await this.getOwned(actor.id, id);
    const user = await userRepository.findByEmail(email.trim().toLowerCase());
    if (!user) throw new AppError(`Aucun compte Skipper pour ${email.trim()} : seules les personnes qui peuvent se connecter peuvent être ajoutées`);
    if (user.id === page.ownerId) throw new AppError('Le propriétaire voit toujours la page');
    if (await sharedPageRepository.addMember(id, user.id, actor.id)) {
      void notificationService.notify({ type: 'page.shared', title: `${actor.name} a partagé une page avec vous`, message: page.title, link: `/shared/${page.id}`, userId: user.id, payload: { pageId: page.id } });
    }
    return page;
  },

  /** Le propriétaire retire qui il veut ; un membre peut se retirer lui-même. */
  async removeMember(actor: User, id: string, userId: string): Promise<SharedPage> {
    const page = await this.getFor(actor.id, id);
    if (page.ownerId !== actor.id && userId !== actor.id) throw new AppError('Seul le propriétaire de la page retire des personnes', 'FORBIDDEN');
    if (userId === page.ownerId) throw new AppError('Le propriétaire ne peut pas être retiré');
    await sharedPageRepository.removeMember(id, userId);
    return page;
  },

  async delete(userId: string, id: string): Promise<boolean> {
    await this.getOwned(userId, id);
    return sharedPageRepository.delete(id);
  },
};
