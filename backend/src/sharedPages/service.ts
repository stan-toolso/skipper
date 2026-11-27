import { AppError, NotFoundError } from '../errors.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { mailService } from '../notifications/mail.js';
import { userRepository } from '../users/repository.js';
import { isRestrictedAccount } from '../users/restricted.js';
import { userService } from '../users/service.js';
import { ROLE_RANK, type User } from '../users/types.js';
import { SHARE_LOGIN_LINK_DAYS, signInService } from '../auth/signInService.js';
import { pageShareEmail } from './emails.js';
import { sharedPageCommentRepository } from './commentRepository.js';
import { sharedPageRepository } from './repository.js';
import { dataSourceRepository } from './dataRepository.js';
import { parseRefreshMinutes } from './dataSources.js';
import { AGENT_HANDOFF_MODES, type AgentHandoff, type PublishInput, type SharedPage } from './types.js';

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

export const MAX_SHARE_MESSAGE = 2000;

function cleanMessage(raw: string | null | undefined): string | null {
  const m = (raw ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (m.length > MAX_SHARE_MESSAGE) throw new AppError(`Le message dépasse ${MAX_SHARE_MESSAGE} caractères`);
  return m || null;
}

/**
 * E-mail de partage, si l'envoi des e-mails est configuré ; un échec est journalisé (le lien reste à envoyer à la main).
 * Un invité reçoit un lien de connexion directe (aucun compte à créer) ; une personne de Skipper, le lien de la page.
 */
async function sendShareEmail(actor: User, page: SharedPage, user: User, message: string | null): Promise<void> {
  try {
    if (!(await mailService.configured())) return;
    const pagePath = `/shared/${page.id}`;
    const direct = user.isGuest;
    const url = direct ? await signInService.createLoginLink(user, pagePath, { createdById: actor.id, ttlMs: SHARE_LOGIN_LINK_DAYS * 24 * 3600 * 1000 }) : `${config.appUrl}${pagePath}`;
    await mailService.send({ to: user.email, ...pageShareEmail({ actor, page, to: user.email, message, url, directLoginDays: direct ? SHARE_LOGIN_LINK_DAYS : null }) });
  } catch (err) {
    log.warn(`[pages] e-mail de partage à ${user.email} : ${(err as Error).message}`);
  }
}

/** Nom de fichier sûr pour un téléchargement. */
export const downloadName = (title: string) => `${title.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80) || 'page'}.html`;

export const sharedPageService = {
  async get(id: string): Promise<SharedPage> {
    const page = await sharedPageRepository.findById(id);
    if (!page) throw new NotFoundError('Page partagée introuvable, ou non partagée avec vous');
    return page;
  },

  /**
   * Peut-on voir la page ? Propriétaire, lien ouvert, ou membre. Le lien ouvert vaut pour les personnes de Skipper,
   * pas pour un invité des pages partagées (`guest`) : lui ne voit que les pages où il a été ajouté.
   */
  async canView(page: SharedPage, userId: string, guest = false): Promise<boolean> {
    if (page.ownerId === userId || page.publicAccess || (page.linkAccess && !guest)) return true;
    if (await sharedPageRepository.isMember(page.id, userId)) return true;
    // Ouverte aux membres de son projet, lecteurs et plus (jamais à un invité des pages, ni à un invité du projet :
    // lui ne voit que les artefacts où il a été ajouté).
    if (!page.projectAccess || !page.projectId || guest) return false;
    const role = await userService.memberRoleFor(userId, page.projectId);
    return role !== null && ROLE_RANK[role] >= ROLE_RANK.viewer;
  },

  /** Page ouverte à tout le monde sans connexion ; null sinon (inexistante ou non publique, sans les distinguer). */
  async getPublic(id: string): Promise<SharedPage | null> {
    const page = await sharedPageRepository.findById(id);
    return page?.publicAccess ? page : null;
  },

  /** Page visible par la personne ; sinon « introuvable » (l'existence n'est pas révélée). */
  async getFor(userId: string, id: string): Promise<SharedPage> {
    const page = await this.get(id);
    if (page.publicAccess) return page;
    const guest = (page.linkAccess || page.projectAccess) && page.ownerId !== userId ? Boolean((await userRepository.findById(userId))?.isGuest) : false;
    if (!(await this.canView(page, userId, guest))) throw new NotFoundError('Page partagée introuvable, ou non partagée avec vous');
    return page;
  },

  async getOwned(userId: string, id: string): Promise<SharedPage> {
    const page = await this.getFor(userId, id);
    if (page.ownerId !== userId) throw new AppError('Seul le propriétaire de la page peut faire cela', 'FORBIDDEN');
    return page;
  },

  /** Administrer la page (historique, suppression de tous les commentaires) : son propriétaire ou un administrateur de Skipper. */
  canManage(page: SharedPage, user: Pick<User, 'id' | 'isAdmin' | 'isGuest'>): boolean {
    return page.ownerId === user.id || (user.isAdmin && !user.isGuest);
  },

  /** Page visible par la personne et qu'elle administre ; sinon FORBIDDEN (ou « introuvable » si elle ne la voit pas). */
  async getManaged(user: User, id: string): Promise<SharedPage> {
    const page = await this.getFor(user.id, id);
    if (!this.canManage(page, user)) throw new AppError('Seul le propriétaire de la page ou un administrateur peut faire cela', 'FORBIDDEN');
    return page;
  },

  /** Active ou désactive l'historique : désactivé, seule la dernière version est listée et servie (pour tout le monde). */
  async setHistory(user: User, id: string, enabled: boolean): Promise<SharedPage> {
    await this.getManaged(user, id);
    return (await sharedPageRepository.update(id, { historyEnabled: enabled })) ?? this.get(id);
  },

  /** Supprime tous les commentaires de la page (réponses comprises) ; renvoie le nombre de fils supprimés. */
  async deleteAllComments(user: User, id: string): Promise<number> {
    await this.getManaged(user, id);
    return sharedPageCommentRepository.deleteAllOfPage(id);
  },

  listFor: (userId: string) => sharedPageRepository.listFor(userId),
  /** Artefacts d'un projet visibles par la personne (l'appartenance au projet est vérifiée par l'appelant). */
  listForProject: (user: Pick<User, 'id' | 'isGuest'>, projectId: string) => sharedPageRepository.listForProject(projectId, user.id, !user.isGuest),
  /** Favoris de la personne, limités à ce qu'elle peut encore voir. */
  listFavorites: (user: Pick<User, 'id' | 'isGuest'>) => sharedPageRepository.listFavorites(user.id, !user.isGuest),
  favoriteIds: (userId: string, pageIds: string[]) => sharedPageRepository.favoriteIds(userId, pageIds),

  /** Met un artefact en favori (ou l'en retire) : seulement un artefact que la personne voit. */
  async setFavorite(user: Pick<User, 'id' | 'isGuest'>, id: string, favorite: boolean): Promise<SharedPage> {
    const page = await this.getFor(user.id, id);
    await sharedPageRepository.setFavorite(user.id, page.id, favorite);
    return page;
  },
  listOwned: (userId: string, limit = 20) => sharedPageRepository.listOwned(userId, Math.min(Math.max(limit, 1), 100)),
  versions: (pageId: string) => sharedPageRepository.versions(pageId),

  /** Versions consultables : toutes, ou seulement la dernière quand l'historique est désactivé. */
  async visibleVersions(page: SharedPage) {
    const all = await sharedPageRepository.versions(page.id);
    return page.historyEnabled ? all : all.filter((v) => v.version === page.version);
  },
  members: (pageId: string) => sharedPageRepository.members(pageId),

  /** La page est-elle vue par d'autres que son propriétaire ? */
  async isShared(page: SharedPage): Promise<boolean> {
    return page.linkAccess || page.publicAccess || page.projectAccess || (await sharedPageRepository.members(page.id)).length > 0;
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
      if (input.projectAccess && !(input.projectId ?? page.projectId)) throw new AppError("Cet artefact n'est rattaché à aucun projet");
      const updated = await sharedPageRepository.addVersion(page.id, {
        title,
        description,
        linkAccess: input.linkAccess ?? null,
        projectAccess: input.projectAccess ?? null,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        sourcePath: input.sourcePath ?? null,
        html: input.html,
        createdBy: input.ownerId,
        kind: input.kind ?? null,
      });
      if (!updated) throw new NotFoundError('Page partagée introuvable');
      // La nouvelle version garde le type, le rafraîchissement et les sources du moment (remplacées ensuite si l'agent en donne).
      await sharedPageRepository.snapshotLatest(updated.id);
      return updated;
    }
    if (input.projectAccess && !input.projectId) throw new AppError("Cet artefact n'est rattaché à aucun projet");
    const created = await sharedPageRepository.create({
      ownerId: input.ownerId,
      title,
      description: description ?? null,
      linkAccess: input.linkAccess ?? false,
      projectAccess: input.projectAccess ?? false,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      sourcePath: input.sourcePath ?? null,
      html: input.html,
      kind: input.kind ?? 'page',
    });
    await sharedPageRepository.snapshotLatest(created.id);
    return created;
  },

  /**
   * Duplique un artefact pour la personne : une copie privée dont elle est propriétaire, à partir de la dernière version
   * (ou de `version`, si l'historique le permet). Le type, le rafraîchissement et les sources de données suivent ; ni
   * les membres, ni le lien ouvert, ni les commentaires, ni l'historique. Quiconque voit une page peut la dupliquer, sauf
   * un invité ; un artefact de données seulement par qui en administre les sources (propriétaire ou administrateur de
   * Skipper : la copie emporte requêtes et scripts, qu'un simple lecteur ne voit pas). La copie garde le projet
   * d'origine (ses sources tournent dans ce projet, au nom de son nouveau propriétaire) ; la session d'origine
   * seulement quand on duplique sa propre page.
   */
  async duplicate(user: User, id: string, opts: { title?: string | null; version?: number | null } = {}): Promise<SharedPage> {
    if (await isRestrictedAccount(user)) throw new AppError('Un invité ne peut pas dupliquer une page', 'FORBIDDEN');
    const page = await this.getFor(user.id, id);
    if (page.kind === 'data' && !this.canManage(page, user)) throw new AppError("Seul le propriétaire d'un artefact de données (ou un administrateur) peut le dupliquer : la copie emporte ses requêtes et ses scripts", 'FORBIDDEN');
    const version = opts.version ?? page.version;
    if (!Number.isInteger(version) || version < 1 || version > page.version) throw new NotFoundError('Version introuvable');
    if (version !== page.version && !page.historyEnabled) throw new NotFoundError("L'historique de cette page est désactivé : seule la dernière version peut être dupliquée");
    const title = cleanTitle(opts.title?.trim() ? opts.title : `Copie de ${page.title}`.slice(0, 200));
    const own = page.ownerId === user.id;
    const copy = await sharedPageRepository.duplicate(page.id, version, {
      ownerId: user.id,
      title,
      description: page.description,
      projectId: page.projectId,
      sessionId: own ? page.sessionId : null,
      sourcePath: own ? page.sourcePath : null,
    });
    if (!copy) throw new NotFoundError('Page partagée introuvable');
    return copy;
  },

  /** Contenu d'une version (la dernière par défaut). */
  async content(page: SharedPage, version?: number | null): Promise<{ html: Buffer; version: number }> {
    const v = version ?? page.version;
    if (!Number.isInteger(v) || v < 1 || v > page.version) throw new NotFoundError('Version introuvable');
    if (v !== page.version && !page.historyEnabled) throw new NotFoundError("L'historique de cette page est désactivé : seule la dernière version est consultable");
    const html = await sharedPageRepository.content(page.id, v);
    if (!html) throw new NotFoundError('Le contenu de cette version est manquant');
    return { html, version: v };
  },

  async update(userId: string, id: string, input: { title?: string | null; description?: string | null; linkAccess?: boolean | null; publicAccess?: boolean | null; projectAccess?: boolean | null; agentHandoff?: string | null; refreshMinutes?: number | null }): Promise<SharedPage> {
    const page = await this.getOwned(userId, id);
    const patch: { title?: string; description?: string | null; linkAccess?: boolean; publicAccess?: boolean; projectAccess?: boolean; agentHandoff?: AgentHandoff; refreshMinutes?: number | null } = {};
    if (input.refreshMinutes !== undefined) {
      if (page.kind !== 'data') throw new AppError("Seul un artefact de données se rafraîchit");
      patch.refreshMinutes = parseRefreshMinutes(input.refreshMinutes, (await dataSourceRepository.list(page.id)).some((s) => s.kind === 'agent'));
    }
    if (input.title != null) patch.title = cleanTitle(input.title);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.linkAccess != null) patch.linkAccess = input.linkAccess;
    // Public (sans connexion) implique le lien ouvert ; refermer le lien referme aussi l'accès public.
    if (input.publicAccess != null) {
      patch.publicAccess = input.publicAccess;
      if (input.publicAccess) patch.linkAccess = true;
    }
    if (patch.linkAccess === false) patch.publicAccess = false;
    if (input.projectAccess != null) {
      if (input.projectAccess && !page.projectId) throw new AppError("Cet artefact n'est rattaché à aucun projet");
      patch.projectAccess = input.projectAccess;
    }
    if (input.agentHandoff != null) {
      if (!AGENT_HANDOFF_MODES.includes(input.agentHandoff as AgentHandoff)) throw new AppError('Réglage de transmission à l’agent inconnu');
      patch.agentHandoff = input.agentHandoff as AgentHandoff;
    }
    const updated = (await sharedPageRepository.update(id, patch)) ?? (await this.get(id));
    if (patch.refreshMinutes !== undefined) await sharedPageRepository.snapshotLatest(id);
    return updated;
  },

  /**
   * Ajoute une personne à la page, avec un message d'introduction facultatif. Une adresse sans compte Skipper est
   * refusée (code NO_ACCOUNT), sauf avec `invite` : un compte d'invité des pages partagées est alors créé (il ne
   * verra que les pages partagées avec lui). Avec `notify` (par défaut), un e-mail la prévient si l'envoi des e-mails est
   * configuré : lien de connexion directe pour un invité, lien de la page sinon. Partager à nouveau avec quelqu'un
   * qui a déjà accès remplace le message et le prévient de nouveau.
   */
  async addMember(actor: User, id: string, email: string, opts: { invite?: boolean; message?: string | null; notify?: boolean } = {}): Promise<SharedPage> {
    const page = await this.getOwned(actor.id, id);
    const message = cleanMessage(opts.message);
    const address = email.trim().toLowerCase();
    let user = await userRepository.findByEmail(address);
    if (!user) {
      if (!opts.invite) throw new AppError(`Aucun compte Skipper pour ${email.trim()} : invitez cette personne pour qu'elle puisse se connecter et voir la page`, 'NO_ACCOUNT');
      if (actor.isGuest) throw new AppError('Un invité ne peut pas inviter de nouvelles personnes', 'FORBIDDEN');
      ({ user } = await userService.findOrCreateGuest(address));
    }
    if (user.kind === 'agent') throw new AppError("Cette adresse est celle d'un agent de projet : une page se partage avec des personnes");
    if (user.id === page.ownerId) throw new AppError('Le propriétaire voit toujours la page');
    const notify = opts.notify !== false;
    const added = await sharedPageRepository.addMember(id, user.id, actor.id, message);
    if (added || message) void notificationService.notify({ type: 'page.shared', title: `${actor.name} a partagé une page avec vous`, message: message ? `${page.title}\n\n${message}` : page.title, link: `/shared/${page.id}`, userId: user.id, payload: { pageId: page.id } });
    if (notify) void sendShareEmail(actor, page, user, message);
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
