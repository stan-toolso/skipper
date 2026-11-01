import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, NotFoundError } from '../errors.js';
import { log } from '../log.js';
import type { Project } from '../projects/types.js';
import { git } from '../projects/workspace.js';
import { vaultService } from '../vault/service.js';
import type { VaultItem } from '../vault/types.js';
import { ENV_EXPORT_KINDS } from '../vault/types.js';
import { worksessionHooks, worksessionPath } from '../worksessions/service.js';
import type { Worksession } from '../worksessions/types.js';
import { envFileRepository } from './repository.js';
import { CONTENT_MAX, isDotenv, normalizePath, parseDotenv, references, render, setDotenvKey, unsetDotenvKey, vaultRef, type DotenvEntry } from './template.js';
import type { EnvActor, EnvApplyResult, EnvFile } from './types.js';
import { fieldNames, fieldValues } from './vaultValues.js';

/**
 * Fichiers d'environnement des work sessions. Un projet déclare des modèles (`.env`, `backend/.env`, tout fichier
 * texte) ; à la création de chaque work session, ils sont rendus — références `{{vault:élément.champ}}` remplacées
 * par la valeur du coffre — et écrits dans le dossier de travail, sans écraser un fichier présent (un fichier suivi
 * par git, par exemple), puis exclus de git (`info/exclude`) pour ne jamais être commités par mégarde.
 *
 * Écrire une valeur du coffre dans le dossier de travail la rend lisible par l'agent : c'est une exception à la
 * règle « rien du coffre n'atteint le conteneur », permise élément par élément par qui le gère (`envExport`).
 * La portée est celle des agents de la personne qui crée la work session (`vaultService.agentItems`), et chaque
 * écriture est journalisée dans le journal de l'élément (`env_export`).
 */

const NUL_RE = /\u0000/g;

function validateContent(content: string): string {
  const c = (content ?? '').replace(NUL_RE, '');
  if (Buffer.byteLength(c) > CONTENT_MAX) throw new AppError(`Fichier trop volumineux (${CONTENT_MAX / 1024} Ko au plus)`);
  return c;
}

/** Élément du coffre résolu pour une référence, ou la raison pour laquelle il ne peut pas servir. */
function refProblem(items: VaultItem[], item: string, field: string): string | null {
  const found = items.find((i) => i.name === item);
  if (!found) return `${vaultRef(item, field)} : « ${item} » n'est pas dans le coffre de ce projet`;
  if (!ENV_EXPORT_KINDS.includes(found.kind)) return `${vaultRef(item, field)} : un élément de ce type ne peut pas servir aux fichiers d'environnement`;
  if (!found.envExport) return `${vaultRef(item, field)} : « ${item} » n'est pas utilisable dans les fichiers d'environnement (option à cocher sur l'élément, par qui le gère)`;
  if (!fieldNames(found).includes(field)) return `${vaultRef(item, field)} : champ inconnu (disponibles : ${fieldNames(found).join(', ') || 'aucun'})`;
  return null;
}

/**
 * Écrit `content` à `rel` sous `root` sans jamais en sortir : aucun lien symbolique suivi (dossiers parents ni
 * fichier), droits 0600. `overwrite` false : un fichier présent est laissé tel quel (renvoie false).
 */
async function writeConfined(root: string, rel: string, content: string, overwrite: boolean): Promise<boolean> {
  const realRoot = await realpath(root);
  const segments = rel.split('/');
  let current = realRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (!st) await mkdir(current);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new AppError(`${rel} : ${path.relative(realRoot, current)} n'est pas un dossier (lien symbolique refusé)`);
  }
  const target = path.join(realRoot, rel);
  if (!target.startsWith(`${realRoot}${path.sep}`)) throw new AppError(`${rel} : chemin hors du dossier de travail`);
  const st = await lstat(target).catch(() => null);
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) throw new AppError(`${rel} : n'est pas un fichier ordinaire (lien symbolique refusé)`);
    if (!overwrite) return false;
  }
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

/** Ajoute les chemins à `info/exclude` du dépôt (partagé par ses worktrees) : `git add -A` ne les embarquera pas. */
async function excludeFromGit(dir: string, rels: string[]): Promise<void> {
  if (!rels.length) return;
  try {
    const excludePath = path.resolve(dir, await git(['rev-parse', '--git-path', 'info/exclude'], dir));
    const current = await readFile(excludePath, 'utf8').catch(() => '');
    const lines = new Set(current.split('\n').map((l) => l.trim()));
    const missing = rels.map((r) => `/${r}`).filter((r) => !lines.has(r));
    if (!missing.length) return;
    await mkdir(path.dirname(excludePath), { recursive: true });
    const header = lines.has('# Fichiers d\'environnement de Skipper') ? '' : "# Fichiers d'environnement de Skipper\n";
    await writeFile(excludePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${header}${missing.join('\n')}\n`);
  } catch (err) {
    log.warn(`[env] exclusion git dans ${dir} : ${(err as Error).message}`);
  }
}

/** Résolveur de références pour une portée : éléments lus une fois, secrets déchiffrés à la demande, problèmes notés. */
async function resolverFor(projectId: string, ownerId: string | null) {
  const items = await vaultService.agentItems(projectId, ownerId);
  const values = new Map<string, Record<string, string>>();
  /** Éléments servis depuis le dernier `used.clear()` (journal par fichier). */
  const used = new Set<VaultItem>();
  const problems: string[] = [];
  const resolve = (item: string, field: string): string => {
    const problem = refProblem(items, item, field);
    if (problem) {
      if (!problems.includes(problem)) problems.push(problem);
      return '';
    }
    const found = items.find((i) => i.name === item)!;
    let fields = values.get(found.id);
    if (!fields) {
      try {
        fields = fieldValues(found, vaultService.secretsOf(found));
      } catch (err) {
        const p = `${vaultRef(item, field)} : ${(err as Error).message}`;
        if (!problems.includes(p)) problems.push(p);
        return '';
      }
      values.set(found.id, fields);
    }
    used.add(found);
    return fields[field] ?? '';
  };
  return { items, resolve, used, problems };
}

export const envFileService = {
  list: (projectId: string) => envFileRepository.listByProject(projectId),

  async get(id: string): Promise<EnvFile> {
    const file = await envFileRepository.findById(id);
    if (!file) throw new NotFoundError("Fichier d'environnement introuvable");
    return file;
  },

  async byPath(projectId: string, rawPath: string): Promise<EnvFile> {
    const p = normalizePath(rawPath);
    const file = await envFileRepository.findByPath(projectId, p);
    if (!file) {
      const all = await envFileRepository.listByProject(projectId);
      throw new NotFoundError(`Aucun fichier d'environnement « ${p} »${all.length ? ` (fichiers : ${all.map((f) => f.path).join(', ')})` : ' : ce projet n\'en a pas encore'}`);
    }
    return file;
  },

  isDotenv: (file: Pick<EnvFile, 'path'>) => isDotenv(file.path),

  /** Clés d'un fichier dotenv (valeurs du modèle, références non résolues) ; vide pour un autre fichier. */
  keys: (file: Pick<EnvFile, 'path' | 'content'>): DotenvEntry[] => (isDotenv(file.path) ? parseDotenv(file.content) : []),

  /** Références au coffre qui ne pourront pas être résolues pour cette personne (sans rien déchiffrer). */
  async problems(file: Pick<EnvFile, 'content'>, projectId: string, ownerId: string | null): Promise<string[]> {
    const refs = references(file.content);
    if (!refs.length) return [];
    const items = await vaultService.agentItems(projectId, ownerId);
    return refs.map((r) => refProblem(items, r.item, r.field)).filter((p): p is string => Boolean(p));
  },

  /** Éléments du coffre de la portée et leurs champs utilisables (aide de l'éditeur ; rien n'est déchiffré). */
  async vaultChoices(projectId: string, ownerId: string | null): Promise<{ item: VaultItem; fields: string[] }[]> {
    const items = await vaultService.agentItems(projectId, ownerId);
    return items.filter((i) => ENV_EXPORT_KINDS.includes(i.kind)).map((item) => ({ item, fields: fieldNames(item) }));
  },

  /** Crée (sans `id`) ou met à jour un fichier. `expectedUpdatedAt` : refus si quelqu'un l'a modifié entre-temps. */
  async save(projectId: string, input: { id?: string | null; path: string; content: string; applyOnCreate?: boolean | null; expectedUpdatedAt?: Date | null }, actor: EnvActor): Promise<EnvFile> {
    const p = normalizePath(input.path);
    const content = validateContent(input.content);
    const clash = await envFileRepository.findByPath(projectId, p);
    if (clash && clash.id !== input.id) throw new AppError(`Un fichier « ${p} » existe déjà dans ce projet`);
    try {
      if (!input.id) {
        return await envFileRepository.create(projectId, { path: p, content, applyOnCreate: input.applyOnCreate ?? true, userId: actor.userId, sessionId: actor.sessionId ?? null });
      }
      const current = await this.get(input.id);
      if (current.projectId !== projectId) throw new AppError('Ce fichier appartient à un autre projet', 'FORBIDDEN');
      const updated = await envFileRepository.update(
        current.id,
        { path: p, content, applyOnCreate: input.applyOnCreate ?? undefined, userId: actor.userId, sessionId: actor.sessionId ?? null },
        input.expectedUpdatedAt ?? null,
      );
      if (!updated) throw new AppError(`« ${p} » a été modifié entre-temps (par une personne ou un agent) : rechargez-le avant d'enregistrer`, 'FILE_CONFLICT');
      return updated;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un fichier « ${p} » existe déjà dans ce projet`);
      throw err;
    }
  },

  async delete(id: string): Promise<boolean> {
    return envFileRepository.delete(id);
  },

  /**
   * Ajoute ou remplace une clé d'un fichier dotenv du projet (créé s'il n'existe pas). Relecture et écriture
   * conditionnelle, reprises en cas d'écriture concurrente.
   */
  async setKey(projectId: string, rawPath: string, key: string, value: string, actor: EnvActor): Promise<EnvFile> {
    return this.editDotenv(projectId, rawPath, actor, (content) => setDotenvKey(content, key, value.replace(NUL_RE, '')), true);
  },

  /** Retire une clé d'un fichier dotenv du projet. */
  async unsetKey(projectId: string, rawPath: string, key: string, actor: EnvActor): Promise<EnvFile> {
    return this.editDotenv(projectId, rawPath, actor, (content) => {
      const next = unsetDotenvKey(content, key);
      if (next === null) throw new AppError(`La clé ${key} n'est pas dans ce fichier`);
      return next;
    }, false);
  },

  async editDotenv(projectId: string, rawPath: string, actor: EnvActor, edit: (content: string) => string, create: boolean): Promise<EnvFile> {
    const p = normalizePath(rawPath);
    if (!isDotenv(p)) throw new AppError(`« ${p} » n'est pas un fichier dotenv (.env, .env.*, *.env) : modifiez-le en entier depuis la page Environnement du projet`);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await envFileRepository.findByPath(projectId, p);
      if (!current) {
        if (!create) throw new NotFoundError(`Aucun fichier d'environnement « ${p} »`);
        try {
          return await envFileRepository.create(projectId, { path: p, content: validateContent(edit('')), applyOnCreate: true, userId: actor.userId, sessionId: actor.sessionId ?? null });
        } catch (err) {
          if ((err as { code?: string }).code === '23505') continue;
          throw err;
        }
      }
      const updated = await envFileRepository.update(current.id, { content: validateContent(edit(current.content)), userId: actor.userId, sessionId: actor.sessionId ?? null }, current.updatedAt);
      if (updated) return updated;
    }
    throw new AppError(`« ${p} » est modifié en continu par ailleurs : réessayez`);
  },

  /**
   * Écrit les fichiers du projet dans une work session. `onlyPaths` : ces fichiers seulement (sinon tous, ou ceux
   * marqués « à la création » si `onCreate`). `overwrite` false : un fichier déjà présent est laissé tel quel.
   */
  async apply(
    project: Project,
    worksession: Worksession,
    ownerId: string | null,
    opts: { onlyPaths?: string[] | null; overwrite: boolean; onCreate?: boolean; sessionId?: string | null },
  ): Promise<EnvApplyResult> {
    const result: EnvApplyResult = { written: [], skipped: [], problems: [] };
    let files = await envFileRepository.listByProject(project.id);
    if (opts.onlyPaths?.length) {
      const wanted = opts.onlyPaths.map(normalizePath);
      const unknown = wanted.filter((w) => !files.some((f) => f.path === w));
      if (unknown.length) throw new NotFoundError(`Fichier(s) d'environnement inconnu(s) : ${unknown.join(', ')}`);
      files = files.filter((f) => wanted.includes(f.path));
    } else if (opts.onCreate) {
      files = files.filter((f) => f.applyOnCreate);
    }
    if (!files.length) return result;
    const dir = worksessionPath(project, worksession);
    const resolver = await resolverFor(project.id, ownerId);
    for (const file of files) {
      resolver.used.clear();
      const content = render(file.content, isDotenv(file.path), resolver.resolve);
      try {
        if (await writeConfined(dir, file.path, content, opts.overwrite)) result.written.push(file.path);
        else result.skipped.push(`${file.path} : déjà présent dans le dossier de travail, laissé tel quel`);
      } catch (err) {
        result.skipped.push(`${file.path} : ${(err as Error).message}`);
        continue;
      }
      for (const item of resolver.used) await vaultService.audit(item, 'env_export', { userId: ownerId, sessionId: opts.sessionId ?? null, projectId: project.id }, `${file.path} → ${worksession.name}`);
    }
    result.problems = resolver.problems;
    if (project.gitUrl && result.written.length) await excludeFromGit(dir, result.written);
    return result;
  },

  /**
   * Met à jour une seule clé dans le fichier déjà présent d'une work session (sans réécrire le reste, que l'agent
   * a pu modifier) ; écrit le fichier entier s'il n'y est pas encore.
   */
  async applyKey(project: Project, worksession: Worksession, ownerId: string | null, file: EnvFile, key: string, sessionId: string | null): Promise<EnvApplyResult> {
    const dir = worksessionPath(project, worksession);
    const target = path.join(dir, file.path);
    const local = await lstat(target).then((st) => (st.isFile() ? readFile(target, 'utf8') : null), () => null);
    if (local === null) return this.apply(project, worksession, ownerId, { onlyPaths: [file.path], overwrite: false, sessionId });
    const entry = parseDotenv(file.content).find((e) => e.key === key);
    const resolver = await resolverFor(project.id, ownerId);
    let next: string;
    if (entry) {
      const value = render(entry.value, false, resolver.resolve);
      next = setDotenvKey(local, key, value);
    } else {
      next = unsetDotenvKey(local, key) ?? local;
    }
    await writeConfined(dir, file.path, next, true);
    for (const item of resolver.used) await vaultService.audit(item, 'env_export', { userId: ownerId, sessionId, projectId: project.id }, `${file.path} (${key}) → ${worksession.name}`);
    return { written: [file.path], skipped: [], problems: resolver.problems };
  },

  /** Paragraphe du prompt système des sessions qui ont un dossier de travail. */
  async promptSummary(projectId: string): Promise<string> {
    const files = await envFileRepository.listByProject(projectId);
    const list = files.length ? `Fichiers du projet : ${files.map((f) => `\`${f.path}\`${f.applyOnCreate ? '' : ' (non importé à la création)'}`).join(', ')}.` : "Ce projet n'en a pas encore.";
    return [
      "Fichiers d'environnement (serveur MCP `env`) : le projet déclare des fichiers (`.env` ou autres) écrits dans chaque nouveau dossier de travail, avec des valeurs tirées du coffre (`{{vault:élément.champ}}` dans le modèle). " + list,
      "`env.list` les liste, `env.keys` montre les clés d'un fichier dotenv et leur source (valeur ou référence au coffre, jamais la valeur d'un secret), `env.set` ajoute ou modifie une clé pour tout le projet (et dans ton dossier de travail), `env.unset` en retire une, `env.apply` réécrit les fichiers dans ton dossier de travail. Ces fichiers ne doivent jamais être commités : ils sont exclus de git.",
    ].join(' ');
  },
};

// Écriture des fichiers « à la création » dans chaque nouvelle work session, pour la personne qui la crée.
worksessionHooks.afterCreate.push(async (project, ws, actorId) => {
  const result = await envFileService.apply(project, ws, actorId, { overwrite: false, onCreate: true });
  if (result.written.length) log.info(`[env] ${ws.name} : ${result.written.join(', ')} écrit(s)`);
  for (const s of [...result.skipped, ...result.problems]) log.warn(`[env] ${ws.name} : ${s}`);
});

