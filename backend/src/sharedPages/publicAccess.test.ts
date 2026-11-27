import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  page: null as null | Record<string, unknown>,
  patches: [] as Record<string, unknown>[],
  guest: false,
}));

vi.mock('./repository.js', () => ({
  sharedPageRepository: {
    findById: async () => state.page,
    isMember: async () => false,
    members: async () => [],
    update: async (_id: string, patch: Record<string, unknown>) => (state.patches.push(patch), { ...state.page, ...patch }),
  },
}));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async (id: string) => ({ id, isGuest: state.guest }) } }));
vi.mock('../users/service.js', () => ({ userService: { memberRoleFor: async () => null } }));

const { sharedPageService } = await import('./service.js');

const base = { id: 'p1', ownerId: 'stan', title: 'Offre', description: null, linkAccess: false, publicAccess: false, projectAccess: false, projectId: null, version: 1, kind: 'page' };

beforeEach(() => {
  state.page = { ...base };
  state.patches = [];
  state.guest = false;
});

describe('page publique (sans connexion)', () => {
  it("getPublic ne renvoie qu'une page publique", async () => {
    expect(await sharedPageService.getPublic('p1')).toBeNull();
    state.page = { ...base, linkAccess: true };
    expect(await sharedPageService.getPublic('p1')).toBeNull();
    state.page = { ...base, linkAccess: true, publicAccess: true };
    expect(await sharedPageService.getPublic('p1')).toMatchObject({ id: 'p1' });
    state.page = null;
    expect(await sharedPageService.getPublic('p1')).toBeNull();
  });

  it("une page publique s'ouvre aussi à un invité des pages, contrairement au lien réservé aux personnes connectées", async () => {
    state.guest = true;
    state.page = { ...base, linkAccess: true };
    await expect(sharedPageService.getFor('claire', 'p1')).rejects.toThrow(/introuvable/);
    state.page = { ...base, linkAccess: true, publicAccess: true };
    await expect(sharedPageService.getFor('claire', 'p1')).resolves.toMatchObject({ id: 'p1' });
  });

  it('rendre publique ouvre le lien ; refermer le lien referme aussi le public', async () => {
    await sharedPageService.update('stan', 'p1', { publicAccess: true });
    expect(state.patches.at(-1)).toEqual({ publicAccess: true, linkAccess: true });
    await sharedPageService.update('stan', 'p1', { linkAccess: false });
    expect(state.patches.at(-1)).toEqual({ linkAccess: false, publicAccess: false });
    await sharedPageService.update('stan', 'p1', { linkAccess: true, publicAccess: false });
    expect(state.patches.at(-1)).toEqual({ linkAccess: true, publicAccess: false });
  });

  it("seul le propriétaire change l'accès", async () => {
    state.page = { ...base, linkAccess: true, publicAccess: true };
    await expect(sharedPageService.update('alice', 'p1', { publicAccess: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
