import { z } from 'zod';
import { AppError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { slugify } from '../projects/slug.js';
import type { Project } from '../projects/types.js';
import { userService } from '../users/service.js';
import { ROLE_RANK } from '../users/types.js';

/**
 * Portée d'une session d'espace personnel : tous les projets de la personne. Les serveurs MCP `sessions`,
 * `tasks` et `worksessions` agissent par défaut dans le projet de la session (l'espace personnel) et, quand une
 * portée leur est fournie, acceptent un paramètre `project` pour agir dans l'un des projets de la personne,
 * avec les droits de celle-ci (lecture dès le rôle lecteur, écriture à partir du rôle membre).
 */
export interface ProjectScope {
  /** Personne dont les droits s'appliquent (propriétaire de la session). */
  readonly ownerId: string;
  /** Projet de la session : l'espace personnel. */
  readonly home: Project;
  /** Projets de la personne (espace personnel compris). */
  projects(): Promise<Project[]>;
  /** Projet désigné par un identifiant, un dossier (slug) ou un nom ; sans référence, l'espace personnel. */
  resolve(ref?: string | null, opts?: { write?: boolean }): Promise<Project>;
  /** Un objet de ce projet est-il visible de la personne ? */
  canRead(projectId: string): Promise<boolean>;
  /** Lève si la personne n'a pas le rôle membre sur le projet. */
  assertWritable(projectId: string): Promise<void>;
}

/** Comparaison souple d'une référence de projet avec un nom ou un dossier. */
const norm = (s: string) => slugify(s.trim());

export function createProjectScope(ownerId: string, home: Project): ProjectScope {
  const list = () => projectService.listForUser(ownerId, { includePersonal: true });
  const roleOf = async (projectId: string) => (projectId === home.id ? 'admin' : userService.memberRoleFor(ownerId, projectId));
  return {
    ownerId,
    home,
    projects: list,
    async resolve(ref, opts = {}) {
      const wanted = ref?.trim();
      let project: Project | undefined = home;
      if (wanted) {
        const projects = await list();
        const key = norm(wanted);
        project = projects.find((p) => p.id === wanted) ?? projects.find((p) => p.slug === wanted) ?? projects.find((p) => norm(p.name) === key || p.slug === key);
        if (!project) {
          const names = projects.map((p) => `« ${p.name} » (${p.slug})`).join(', ');
          throw new AppError(`Projet « ${wanted} » introuvable parmi tes projets : ${names || 'aucun'}`);
        }
      }
      if (opts.write) await this.assertWritable(project.id);
      return project;
    },
    async canRead(projectId) {
      return (await roleOf(projectId)) !== null;
    },
    async assertWritable(projectId) {
      const role = await roleOf(projectId);
      if (!role) throw new AppError("Tu n'as pas accès à ce projet");
      if (ROLE_RANK[role] < ROLE_RANK.member) throw new AppError('Cette action demande le rôle membre sur le projet (tu y es lecteur)');
    },
  };
}

/**
 * Paramètre `project` des outils MCP, ajouté seulement aux sessions qui ont une portée (espace personnel) :
 * le schéma des sessions ordinaires ne change pas. Le type déclare toujours le paramètre, optionnel, pour que
 * le gestionnaire de l'outil s'écrive une seule fois.
 */
export function withProjectParam<T extends z.ZodRawShape>(shape: T, scope: ProjectScope | undefined): T & { project: z.ZodOptional<z.ZodString> } {
  return (scope ? { ...shape, project: z.string().optional().describe("Projet visé : nom, identifiant ou dossier (défaut : ton espace personnel). L'outil projects.list donne la liste.") } : shape) as T & { project: z.ZodOptional<z.ZodString> };
}

/** Projet visé par un appel d'outil : celui du paramètre `project` dans la portée, sinon le projet de la session. */
export async function targetProject(project: Project, scope: ProjectScope | undefined, ref: string | null | undefined, opts: { write?: boolean } = {}): Promise<Project> {
  if (!scope) {
    if (ref?.trim()) throw new AppError("Cette session n'agit que dans son projet : le paramètre project est réservé aux sessions d'un espace personnel");
    return project;
  }
  return scope.resolve(ref, opts);
}

/** Un objet d'un autre projet est-il à la portée de la session ? (Son propre projet l'est toujours.) */
export async function inScope(project: Project, scope: ProjectScope | undefined, projectId: string, opts: { write?: boolean } = {}): Promise<boolean> {
  if (projectId === project.id) return true;
  if (!scope) return false;
  if (opts.write) {
    await scope.assertWritable(projectId);
    return true;
  }
  return scope.canRead(projectId);
}
