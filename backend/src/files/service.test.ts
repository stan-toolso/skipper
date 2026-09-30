import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, NotFoundError } from '../errors.js';

// Projets et worktrees viennent de la base : on les simule, et leurs dossiers pointent vers un
// répertoire temporaire recréé pour chaque test.
const dirs = vi.hoisted(() => ({ workspace: '', worktrees: '' }));
vi.mock('../projects/service.js', () => ({
  projectService: {
    get: vi.fn(async (id: string) => {
      if (id !== 'p1' && id !== 'p2') throw new Error(`Projet inconnu : ${id}`);
      return { id, slug: id };
    }),
  },
}));
vi.mock('../projects/workspace.js', () => ({ workspacePath: () => dirs.workspace }));
vi.mock('../worktrees/service.js', () => ({
  worktreeService: {
    get: vi.fn(async (id: string) => ({ id, projectId: id === 'wt-other' ? 'p2' : 'p1', name: id })),
  },
  worktreePath: (_project: unknown, wt: { name: string }) => path.join(dirs.worktrees, wt.name),
}));

const { fileService, resolveRoot } = await import('./service.js');

const ref = { projectId: 'p1' };
let base: string;
let root: string;
let outside: string;

/** Erreur métier levée par l'appel (échoue si aucune erreur ou une erreur d'un autre type). */
async function appError(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skipper-files-')));
  root = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  dirs.workspace = root;
  dirs.worktrees = path.join(base, 'workspace.worktrees');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
  await writeFile(path.join(outside, 'secret.txt'), 'confidentiel');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('racine du workspace', () => {
  it('résout le dossier principal du projet', async () => {
    await expect(resolveRoot(ref)).resolves.toBe(root);
  });

  it("résout un worktree du projet", async () => {
    await mkdir(path.join(dirs.worktrees, 'wt-1'), { recursive: true });
    await writeFile(path.join(dirs.worktrees, 'wt-1', 'a.txt'), 'dans le worktree');
    await expect(resolveRoot({ projectId: 'p1', worktreeId: 'wt-1' })).resolves.toBe(path.join(dirs.worktrees, 'wt-1'));
    await expect(fileService.read({ projectId: 'p1', worktreeId: 'wt-1' }, 'a.txt')).resolves.toMatchObject({ content: 'dans le worktree' });
  });

  it("refuse le worktree d'un autre projet", async () => {
    const err = await appError(resolveRoot({ projectId: 'p1', worktreeId: 'wt-other' }));
    expect(err.message).toMatch(/autre projet/);
  });

  it("signale un dossier qui n'existe pas encore (NOT_FOUND)", async () => {
    await rm(root, { recursive: true });
    const err = await appError(fileService.list(ref));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('normalisation des chemins', () => {
  it.each([
    ['a/b/../c.txt', 'a/c.txt'],
    ['/a/c.txt', 'a/c.txt'],
    ['a\\c.txt', 'a/c.txt'],
    ['./a//c.txt', 'a/c.txt'],
    ['a/./b/../../a/c.txt', 'a/c.txt'],
  ])('%j devient %j', async (input, expected) => {
    const written = await fileService.write(ref, input, 'contenu');
    expect(written.path).toBe(expected);
    expect(written.name).toBe('c.txt');
    expect(await readFile(path.join(root, 'a', 'c.txt'), 'utf8')).toBe('contenu');
  });

  it.each(['', '.', '/', './', 'src/..', 'src/../'])('%j désigne la racine', async (input) => {
    const entries = await fileService.list(ref, input);
    expect(entries.map((e) => e.path)).toEqual(['src']);
  });

  it('liste un sous-dossier avec des chemins relatifs à la racine, dossiers en premier', async () => {
    await mkdir(path.join(root, 'src', 'lib'));
    const entries = await fileService.list(ref, 'src/');
    expect(entries.map((e) => [e.path, e.kind])).toEqual([
      ['src/lib', 'dir'],
      ['src/index.ts', 'file'],
    ]);
  });
});

describe('chemins hors de la racine', () => {
  it.each(['..', '../outside/secret.txt', 'src/../../outside/secret.txt', '/../outside/secret.txt', '..\\outside\\secret.txt'])(
    'refuse la lecture de %j',
    async (input) => {
      const err = await appError(fileService.read(ref, input));
      expect(err.message).toMatch(/hors du dossier du projet/);
    },
  );

  it("refuse d'écrire, créer, renommer ou supprimer hors de la racine", async () => {
    await appError(fileService.write(ref, '../evil.txt', 'x'));
    await appError(fileService.create(ref, '../evil-dir', 'dir'));
    await appError(fileService.rename(ref, 'src/index.ts', '../moved.ts'));
    await appError(fileService.delete(ref, '../outside'));
    expect(existsSync(path.join(base, 'evil.txt'))).toBe(false);
    expect(existsSync(path.join(base, 'evil-dir'))).toBe(false);
    expect(existsSync(path.join(base, 'moved.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('refuse de supprimer ou renommer la racine', async () => {
    await appError(fileService.delete(ref, ''));
    await appError(fileService.rename(ref, '', 'ailleurs'));
    expect(existsSync(root)).toBe(true);
  });

  it('protège le dossier .git', async () => {
    await mkdir(path.join(root, '.git'));
    await appError(fileService.delete(ref, '.git'));
    await appError(fileService.rename(ref, '.git', 'git-old'));
    expect(existsSync(path.join(root, '.git'))).toBe(true);
  });
});

describe('liens symboliques', () => {
  it('refuse de lire à travers un lien vers un dossier extérieur', async () => {
    await symlink(outside, path.join(root, 'fuite'));
    const err = await appError(fileService.read(ref, 'fuite/secret.txt'));
    expect(err.message).toMatch(/lien symbolique/);
    await appError(fileService.list(ref, 'fuite'));
  });

  it('refuse de lire un lien vers un fichier extérieur', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'));
    const err = await appError(fileService.read(ref, 'secret.txt'));
    expect(err.message).toMatch(/lien symbolique/);
  });

  it("refuse d'écrire ou de créer à travers un lien sortant, même dans un sous-dossier qui n'existe pas", async () => {
    await symlink(outside, path.join(root, 'fuite'));
    await appError(fileService.write(ref, 'fuite/nouveau.txt', 'x'));
    await appError(fileService.write(ref, 'fuite/a/b/nouveau.txt', 'x'));
    await appError(fileService.create(ref, 'fuite/dossier', 'dir'));
    await appError(fileService.write(ref, 'fuite/secret.txt', 'écrasé'));
    expect(existsSync(path.join(outside, 'nouveau.txt'))).toBe(false);
    expect(existsSync(path.join(outside, 'a'))).toBe(false);
    expect(existsSync(path.join(outside, 'dossier'))).toBe(false);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('confidentiel');
  });

  it('suit un lien qui reste dans la racine', async () => {
    await symlink(path.join(root, 'src'), path.join(root, 'raccourci'));
    await expect(fileService.read(ref, 'raccourci/index.ts')).resolves.toMatchObject({ path: 'raccourci/index.ts', content: 'export {};\n' });
    const entries = await fileService.list(ref);
    expect(entries.find((e) => e.name === 'raccourci')?.kind).toBe('dir');
  });
});

describe('lecture', () => {
  it('ne renvoie pas le contenu d’un fichier binaire', async () => {
    await writeFile(path.join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await expect(fileService.read(ref, 'image.bin')).resolves.toMatchObject({ binary: true, content: null, size: 4 });
  });

  it("refuse un fichier de plus de 2 Mo (FILE_TOO_LARGE)", async () => {
    await writeFile(path.join(root, 'gros.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
    expect((await appError(fileService.read(ref, 'gros.txt'))).code).toBe('FILE_TOO_LARGE');
  });

  it('signale un fichier absent (NOT_FOUND) et un dossier lu comme fichier', async () => {
    expect((await appError(fileService.read(ref, 'absent.txt'))).code).toBe('NOT_FOUND');
    expect((await appError(fileService.read(ref, 'src'))).message).toMatch(/pas un fichier/);
  });
});

describe('écriture et FILE_CONFLICT', () => {
  it('écrit quand le fichier n’a pas changé depuis sa lecture', async () => {
    const opened = await fileService.read(ref, 'src/index.ts');
    const saved = await fileService.write(ref, 'src/index.ts', 'export const a = 1;\n', opened.modifiedAt);
    expect(saved.content).toBe('export const a = 1;\n');
  });

  it('refuse (FILE_CONFLICT) si le fichier a été modifié depuis son ouverture, sans rien écrire', async () => {
    const opened = await fileService.read(ref, 'src/index.ts');
    const file = path.join(root, 'src', 'index.ts');
    await writeFile(file, 'modifié par un agent\n');
    const later = new Date(opened.modifiedAt.getTime() + 5_000);
    await utimes(file, later, later);

    const err = await appError(fileService.write(ref, 'src/index.ts', 'version de l’éditeur', opened.modifiedAt));
    expect(err.code).toBe('FILE_CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('modifié par un agent\n');
  });

  it("écrase sans contrôle quand aucune date n'est transmise (choix « écraser »)", async () => {
    const file = path.join(root, 'src', 'index.ts');
    const past = new Date('2020-01-01T00:00:00Z');
    await utimes(file, past, past);
    await fileService.write(ref, 'src/index.ts', 'écrasé', null);
    expect(await readFile(file, 'utf8')).toBe('écrasé');
  });

  it("crée un fichier absent, dossiers intermédiaires compris, même avec une date attendue", async () => {
    const saved = await fileService.write(ref, 'nouveau/dossier/f.txt', 'x', new Date('2020-01-01'));
    expect(saved.path).toBe('nouveau/dossier/f.txt');
    expect((await stat(path.join(root, 'nouveau', 'dossier', 'f.txt'))).isFile()).toBe(true);
  });

  it("refuse d'écrire sur un dossier", async () => {
    expect((await appError(fileService.write(ref, 'src', 'x'))).message).toMatch(/pas un fichier/);
  });
});

describe('création, renommage et suppression', () => {
  it('crée un fichier et un dossier, et refuse un nom déjà pris', async () => {
    await expect(fileService.create(ref, 'docs', 'dir')).resolves.toMatchObject({ path: 'docs', kind: 'dir' });
    await expect(fileService.create(ref, 'docs/notes.md', 'file')).resolves.toMatchObject({ path: 'docs/notes.md', kind: 'file', size: 0 });
    expect((await appError(fileService.create(ref, 'docs/notes.md', 'file'))).message).toMatch(/déjà/);
  });

  it('renomme dans la racine et refuse d’écraser une cible existante', async () => {
    await writeFile(path.join(root, 'b.txt'), 'b');
    await appError(fileService.rename(ref, 'src/index.ts', 'b.txt'));
    await expect(fileService.rename(ref, 'src/index.ts', 'lib/main.ts')).resolves.toMatchObject({ path: 'lib/main.ts', kind: 'file' });
    expect(existsSync(path.join(root, 'lib', 'main.ts'))).toBe(true);
  });

  it('supprime un dossier récursivement et signale un élément absent', async () => {
    await expect(fileService.delete(ref, 'src')).resolves.toBe(true);
    expect(existsSync(path.join(root, 'src'))).toBe(false);
    expect((await appError(fileService.delete(ref, 'src'))).code).toBe('NOT_FOUND');
  });
});
