import { AppError, NotFoundError } from '../errors.js';
import { projectRepository } from './repository.js';
import { projectPermissionModes, type CreateProjectInput, type Project, type UpdateProjectInput } from './types.js';
import { ensureWorkspace } from './workspace.js';

/** Dérive un identifiant de dossier sûr à partir du nom du projet. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new AppError('Le slug doit contenir uniquement des minuscules, chiffres et tirets');
  }
}

function validatePermissionMode(mode: string | null | undefined): void {
  if (mode && !(projectPermissionModes as readonly string[]).includes(mode)) throw new AppError(`Mode d'autorisation invalide : ${mode}`);
}

export const projectService = {
  list: () => projectRepository.list(),
  listForUser: (userId: string) => projectRepository.listForUser(userId),

  async get(id: string): Promise<Project> {
    const project = await projectRepository.findById(id);
    if (!project) throw new NotFoundError('Projet introuvable');
    return project;
  },

  async create(input: CreateProjectInput): Promise<Project> {
    if (!input.name.trim()) throw new AppError('Le nom du projet est obligatoire');
    const slug = input.slug?.trim() || slugify(input.name);
    validateSlug(slug);
    if (await projectRepository.slugExists(slug)) throw new AppError(`Le slug "${slug}" est déjà utilisé`);
    validatePermissionMode(input.defaultPermissionMode);

    const project = await projectRepository.create({ ...input, name: input.name.trim(), slug });
    try {
      await ensureWorkspace(project);
    } catch (err) {
      // Le workspace n'a pas pu être préparé (ex. clone impossible) : on ne garde pas le projet.
      await projectRepository.delete(project.id);
      throw err;
    }
    return project;
  },

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    if (input.name !== undefined && !input.name?.trim()) throw new AppError('Le nom du projet est obligatoire');
    validatePermissionMode(input.defaultPermissionMode);
    const project = await projectRepository.update(id, { ...input, name: input.name?.trim() });
    if (!project) throw new NotFoundError('Projet introuvable');
    return project;
  },

  /** (Re)crée le dossier du projet s'il a disparu ; ne modifie jamais un dossier existant. */
  async prepareWorkspace(id: string): Promise<Project> {
    const project = await this.get(id);
    await ensureWorkspace(project);
    return project;
  },

  /** Supprime le projet et ses sessions en base. Le dossier sur disque est conservé. */
  async delete(id: string): Promise<boolean> {
    if ((await projectRepository.countRunningSessions(id)) > 0) {
      throw new AppError('Impossible de supprimer un projet ayant des sessions en cours');
    }
    return projectRepository.delete(id);
  },
};
