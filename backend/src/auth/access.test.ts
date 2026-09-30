import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import type { ProjectRole, User } from '../users/types.js';

// Le service des utilisateurs interroge la base : on le remplace par des fonctions simulées.
const userService = vi.hoisted(() => ({
  roleFor: vi.fn<(userId: string, projectId: string) => Promise<ProjectRole | null>>(),
  projectIdsFor: vi.fn<(userId: string) => Promise<string[]>>(),
}));
vi.mock('../users/service.js', () => ({ userService }));

const { accessibleProjectIds, canAccessProject, createAuthContext, filterAsync, requireAdmin, requireProject, requireUser, roleFor } = await import('./access.js');

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
  avatarUrl: null,
  googleSub: null,
  isAdmin: false,
  createdAt: new Date('2026-01-01'),
  lastLoginAt: null,
  ...overrides,
});

/** Capture l'erreur levée (synchrone ou asynchrone) pour en vérifier le type et le code. */
async function caught(fn: () => unknown): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("aucune erreur n'a été levée");
}

beforeEach(() => {
  userService.roleFor.mockReset();
  userService.projectIdsFor.mockReset();
});

describe('requireUser', () => {
  it('refuse une requête sans utilisateur (UNAUTHENTICATED)', async () => {
    const err = await caught(() => requireUser(createAuthContext(null)));
    expect(err.code).toBe('UNAUTHENTICATED');
  });

  it("renvoie l'utilisateur connecté", () => {
    const user = makeUser();
    expect(requireUser(createAuthContext(user))).toBe(user);
  });
});

describe('requireAdmin', () => {
  it('refuse une requête sans utilisateur (UNAUTHENTICATED)', async () => {
    expect((await caught(() => requireAdmin(createAuthContext(null)))).code).toBe('UNAUTHENTICATED');
  });

  it("refuse un utilisateur qui n'est pas administrateur de l'application (FORBIDDEN)", async () => {
    expect((await caught(() => requireAdmin(createAuthContext(makeUser({ isAdmin: false }))))).code).toBe('FORBIDDEN');
  });

  it("accepte un administrateur de l'application", () => {
    const admin = makeUser({ isAdmin: true });
    expect(requireAdmin(createAuthContext(admin))).toBe(admin);
  });
});

describe('requireProject', () => {
  it("refuse une requête sans utilisateur sans interroger la base", async () => {
    expect((await caught(() => requireProject(createAuthContext(null), 'p1'))).code).toBe('UNAUTHENTICATED');
    expect(userService.roleFor).not.toHaveBeenCalled();
  });

  it("refuse un utilisateur qui n'est pas membre du projet, même administrateur de l'application", async () => {
    userService.roleFor.mockResolvedValue(null);
    const err = await caught(() => requireProject(createAuthContext(makeUser({ isAdmin: true })), 'p1', 'viewer'));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toMatch(/pas accès/);
  });

  const cases: Array<[ProjectRole, ProjectRole, boolean]> = [
    ['viewer', 'viewer', true],
    ['viewer', 'member', false],
    ['viewer', 'admin', false],
    ['member', 'viewer', true],
    ['member', 'member', true],
    ['member', 'admin', false],
    ['admin', 'viewer', true],
    ['admin', 'member', true],
    ['admin', 'admin', true],
  ];

  it.each(cases)('rôle %s, rôle minimum %s : accès %s', async (role, min, allowed) => {
    userService.roleFor.mockResolvedValue(role);
    const ctx = createAuthContext(makeUser());
    if (allowed) {
      await expect(requireProject(ctx, 'p1', min)).resolves.toBe(role);
    } else {
      const err = await caught(() => requireProject(ctx, 'p1', min));
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toMatch(/demande le rôle/);
    }
    expect(userService.roleFor).toHaveBeenCalledWith('user-1', 'p1');
  });

  it('exige le rôle lecteur par défaut', async () => {
    userService.roleFor.mockResolvedValue('viewer');
    await expect(requireProject(createAuthContext(makeUser()), 'p1')).resolves.toBe('viewer');
  });

  it('mémorise le rôle pendant la requête, y compris une absence de rôle', async () => {
    userService.roleFor.mockImplementation(async (_user, projectId) => (projectId === 'p1' ? 'member' : null));
    const ctx = createAuthContext(makeUser());
    await requireProject(ctx, 'p1');
    await requireProject(ctx, 'p1', 'member');
    await expect(roleFor(ctx, 'p2')).resolves.toBeNull();
    await expect(roleFor(ctx, 'p2')).resolves.toBeNull();
    expect(userService.roleFor).toHaveBeenCalledTimes(2);
  });

  it("ne partage pas le cache entre deux requêtes", async () => {
    userService.roleFor.mockResolvedValueOnce('admin').mockResolvedValueOnce('viewer');
    const user = makeUser();
    await expect(requireProject(createAuthContext(user), 'p1', 'admin')).resolves.toBe('admin');
    expect((await caught(() => requireProject(createAuthContext(user), 'p1', 'admin'))).code).toBe('FORBIDDEN');
  });
});

describe('accessibleProjectIds et canAccessProject', () => {
  it('mémorise la liste des projets accessibles pendant la requête', async () => {
    userService.projectIdsFor.mockResolvedValue(['p1', 'p2']);
    const ctx = createAuthContext(makeUser());
    await expect(accessibleProjectIds(ctx)).resolves.toEqual(['p1', 'p2']);
    await accessibleProjectIds(ctx);
    expect(userService.projectIdsFor).toHaveBeenCalledTimes(1);
  });

  it("refuse la liste à une requête sans utilisateur", async () => {
    expect((await caught(() => accessibleProjectIds(createAuthContext(null)))).code).toBe('UNAUTHENTICATED');
  });

  it('filtre selon la connexion et le rôle', async () => {
    userService.roleFor.mockImplementation(async (_user, projectId) => (projectId === 'p1' ? 'viewer' : null));
    const ctx = createAuthContext(makeUser());
    await expect(canAccessProject(createAuthContext(null), 'p1')).resolves.toBe(false);
    await expect(canAccessProject(ctx, null)).resolves.toBe(true);
    await expect(canAccessProject(ctx, 'p1')).resolves.toBe(true);
    await expect(canAccessProject(ctx, 'p2')).resolves.toBe(false);
  });
});

describe('filterAsync', () => {
  it('ne laisse passer que les valeurs acceptées par le prédicat asynchrone', async () => {
    async function* source() {
      yield* [1, 2, 3, 4];
    }
    const out: number[] = [];
    for await (const n of filterAsync(source(), async (n) => n % 2 === 0)) out.push(n);
    expect(out).toEqual([2, 4]);
  });
});
