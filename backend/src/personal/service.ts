import { AppError } from '../errors.js';
import { projectRepository } from '../projects/repository.js';
import { projectService } from '../projects/service.js';
import { slugify } from '../projects/slug.js';
import { isPersonalProject, type Project } from '../projects/types.js';
import { sessionService } from '../sessions/service.js';
import type { AttachmentInput, Session } from '../sessions/types.js';
import { userService } from '../users/service.js';
import type { User } from '../users/types.js';
import { createProjectScope, type ProjectScope } from './scope.js';

/** Nom affiché de l'espace personnel (le même pour tout le monde : chacun ne voit que le sien). */
export const PERSONAL_SPACE_NAME = 'Espace personnel';

/** Prompt système de départ de l'espace personnel (modifiable par la personne comme celui d'un projet). */
const DEFAULT_SYSTEM_PROMPT = `Tu es l'assistant personnel de la personne qui te parle, dans son espace personnel Skipper. Tu l'aides à piloter ses projets : faire le point, lancer et suivre des sessions d'agent, gérer ses tâches. Réponds en français, de façon concise, et préfère déléguer un vrai travail de développement à une session dans le projet concerné plutôt que de l'improviser ici.`;

/** Nom d'un chat : sa première ligne de texte, raccourcie. */
export function chatName(text: string): string {
  const first = text.trim().split('\n').find((l) => l.trim()) ?? 'Chat';
  const clean = first.replace(/^[#>*\-\s]+/, '').trim() || 'Chat';
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/** Dossier (slug) de l'espace personnel d'une personne, unique parmi les projets. */
export async function personalSlugFor(user: Pick<User, 'id' | 'email' | 'name'>, exists: (slug: string) => Promise<boolean> = (s) => projectRepository.slugExists(s)): Promise<string> {
  const local = user.email.split('@')[0] ?? '';
  const base = `moi-${slugify(local) || slugify(user.name) || user.id.slice(0, 8)}`.slice(0, 60);
  let slug = base;
  for (let n = 2; await exists(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

export const personalService = {
  /**
   * Espace personnel de la personne, créé à la première demande : un projet sans dépôt git qui lui appartient
   * (`personal_owner_id`), dont elle est l'unique membre (administratrice). Deux appels simultanés ne créent
   * qu'un espace (index unique) : le second relit celui du premier.
   */
  async ensure(user: User): Promise<Project> {
    const existing = await projectRepository.findPersonal(user.id);
    if (existing) return existing;
    let project: Project;
    try {
      project = await projectService.create(
        { name: PERSONAL_SPACE_NAME, slug: await personalSlugFor(user), description: `Espace personnel de ${user.name}`, systemPrompt: DEFAULT_SYSTEM_PROMPT, personalOwnerId: user.id },
        user.id,
      );
    } catch (err) {
      const again = await projectRepository.findPersonal(user.id);
      if (again) return again;
      throw err;
    }
    await userService.addCreator(project.id, user);
    return project;
  },

  /** Lève si le projet est un espace personnel : il ne se partage pas et ne se supprime pas comme un projet. */
  async assertNotPersonal(projectId: string, action = 'Cette action'): Promise<void> {
    if ((await projectRepository.personalOwnerOf(projectId)) !== null) throw new AppError(`${action} n'est pas possible sur un espace personnel : il n'appartient qu'à vous`, 'FORBIDDEN');
  },

  /** Portée d'une session de l'espace personnel : tous les projets de son propriétaire (null hors d'un espace personnel). */
  scopeFor(project: Project, ownerId: string | null): ProjectScope | undefined {
    if (!isPersonalProject(project)) return undefined;
    // Les sessions d'un espace personnel appartiennent toujours à la personne de l'espace.
    return createProjectScope(ownerId ?? project.personalOwnerId!, project);
  },

  /**
   * Chat : une session légère de l'espace personnel, sans work session ni conteneur, lancée aussitôt avec
   * son premier message. Même provider Claude, mêmes outils MCP de Skipper, mais aucun outil de fichiers.
   */
  async createChat(user: User, text: string, attachments: AttachmentInput[] | null | undefined, config: Record<string, unknown> | null | undefined): Promise<Session> {
    const trimmed = text.trim();
    if (!trimmed && !attachments?.length) throw new AppError('Le message est vide');
    const space = await this.ensure(user);
    return sessionService.create({
      projectId: space.id,
      kind: 'chat',
      name: chatName(trimmed || 'Fichiers joints'),
      provider: 'claude',
      prompt: trimmed,
      attachments: attachments ?? null,
      config: { permissionMode: 'default', ...(config ?? {}) },
      ownerId: user.id,
    });
  },

  /** Chats de la personne, les plus récents d'abord. */
  async listChats(user: User, limit = 50): Promise<Session[]> {
    const space = await projectRepository.findPersonal(user.id);
    if (!space) return [];
    return sessionService.list({ projectId: space.id, kind: 'chat', ownerId: user.id, archived: 'all', limit });
  },

  /** Paragraphe du prompt système d'une session d'espace personnel : ce qu'elle peut atteindre et comment. */
  async promptSummary(scope: ProjectScope, owner: Pick<User, 'name'>): Promise<string> {
    const projects = (await scope.projects()).filter((p) => p.id !== scope.home.id);
    const roles = await Promise.all(projects.map((p) => userService.memberRoleFor(scope.ownerId, p.id)));
    const lines = projects.map((p, i) => `- ${p.name} (dossier ${p.slug}, identifiant ${p.id}${p.gitUrl ? `, dépôt ${p.gitUrl}` : ''}, rôle ${roles[i] ?? 'lecteur'})`);
    return [
      `Tu tournes dans l'espace personnel de ${owner.name} : un espace qui n'appartient qu'à cette personne, avec ses propres tâches, sa bibliothèque de contexte et ses sessions. Depuis cet espace, tu as accès à l'ensemble de ses ressources : ses projets, leurs sessions, leurs work sessions et leurs tâches, avec ses droits.`,
      "Les outils des serveurs MCP `sessions`, `tasks` et `worksessions` agissent par défaut dans l'espace personnel ; chacun accepte un paramètre `project` (nom, identifiant ou dossier) pour agir dans l'un de ses projets : lancer une session dans un projet (`sessions.create` avec `project`), attendre sa réponse (`sessions.wait`), lui envoyer une instruction (`sessions.send`), lister ou créer des tâches d'un projet (`tasks.list`, `tasks.create` avec `project`), consulter ses work sessions. Le serveur MCP `projects` (`list`, `get`) décrit ses projets et leur activité. Pour un travail de développement, lance une session dans le projet concerné (elle a le code, le conteneur et les outils de fichiers) plutôt que de le faire ici.",
      lines.length ? `Projets de ${owner.name} :\n${lines.join('\n')}` : `${owner.name} n'est membre d'aucun projet pour le moment.`,
    ].join('\n');
  },
};
