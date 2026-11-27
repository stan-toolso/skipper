import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../users/types.js';
import type { SharedPage, SharedPageVersion } from './types.js';

const state = vi.hoisted(() => ({
  page: null as unknown as SharedPage,
  members: new Set<string>(),
  purged: [] as string[],
  deleted: [] as string[],
}));

vi.mock('./repository.js', () => ({
  sharedPageRepository: {
    findById: async () => state.page,
    isMember: async (_p: string, userId: string) => state.members.has(userId),
    update: async (_id: string, patch: Partial<SharedPage>) => (state.page = { ...state.page, ...patch }),
    versions: async (): Promise<SharedPageVersion[]> => [3, 2, 1].map((version) => ({ pageId: 'p1', version, size: 10, createdById: 'stan', sessionId: null, createdAt: new Date(), kind: 'page', refreshMinutes: null, sources: null })),
    content: async (_p: string, v: number) => Buffer.from(`<p>v${v}</p>`),
  },
}));
vi.mock('./commentRepository.js', () => ({
  sharedPageCommentRepository: {
    deleteAllOfPage: async (pageId: string) => (state.purged.push(pageId), 4),
    findById: async (id: string) => ({ id, pageId: 'p1', parentId: null, authorId: 'alice', sessionId: null, body: 'x', anchor: null, version: 1, resolvedAt: null, resolvedById: null, createdAt: new Date(), updatedAt: new Date() }),
    delete: async (id: string) => (state.deleted.push(id), true),
  },
}));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async () => null } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async () => undefined } }));

const { sharedPageService } = await import('./service.js');
const { sharedPageCommentService } = await import('./commentService.js');

function person(id: string, extra: Partial<User> = {}): User {
  return { id, email: `${id}@toolso.io`, name: id, kind: 'person', avatarUrl: null, googleSub: null, isAdmin: false, isSuperAdmin: false, isCto: false, isGuest: false, createdAt: new Date(), lastLoginAt: new Date(), passwordSetAt: null, ...extra };
}
const stan = person('stan');
const admin = person('root', { isAdmin: true });
const reader = person('bob');

beforeEach(() => {
  state.page = { id: 'p1', ownerId: 'stan', title: 'Offre', description: null, linkAccess: true, publicAccess: false, projectAccess: false, version: 3, projectId: null, sessionId: null, sourcePath: null, agentHandoff: 'manual', historyEnabled: true, kind: 'page', refreshMinutes: null, dataRefreshedAt: null, viewedAt: null, createdAt: new Date(), updatedAt: new Date() };
  state.members.clear();
  state.purged = [];
  state.deleted = [];
});

describe('historique des versions', () => {
  it('le propriétaire ou un administrateur le désactive ; un lecteur, non', async () => {
    await expect(sharedPageService.setHistory(reader, 'p1', false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await sharedPageService.setHistory(admin, 'p1', false)).historyEnabled).toBe(false);
    expect((await sharedPageService.setHistory(stan, 'p1', true)).historyEnabled).toBe(true);
  });

  it('désactivé : seule la dernière version est listée et servie', async () => {
    expect((await sharedPageService.visibleVersions(state.page)).map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await sharedPageService.content(state.page, 2)).version).toBe(2);
    state.page = { ...state.page, historyEnabled: false };
    expect((await sharedPageService.visibleVersions(state.page)).map((v) => v.version)).toEqual([3]);
    await expect(sharedPageService.content(state.page, 2)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await sharedPageService.content(state.page, 3)).version).toBe(3);
    expect((await sharedPageService.content(state.page, null)).version).toBe(3);
  });

  it('un administrateur invité n’administre pas la page', () => {
    expect(sharedPageService.canManage(state.page, person('g', { isAdmin: true, isGuest: true }))).toBe(false);
  });
});

describe('suppression de tous les commentaires', () => {
  it('réservée au propriétaire et aux administrateurs', async () => {
    await expect(sharedPageService.deleteAllComments(reader, 'p1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.purged).toEqual([]);
    expect(await sharedPageService.deleteAllComments(admin, 'p1')).toBe(4);
    expect(await sharedPageService.deleteAllComments(stan, 'p1')).toBe(4);
    expect(state.purged).toEqual(['p1', 'p1']);
  });

  it('un administrateur supprime aussi un commentaire isolé', async () => {
    await expect(sharedPageCommentService.delete({ user: reader }, 'c1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await sharedPageCommentService.delete({ user: admin }, 'c1')).toBe(true);
  });
});
