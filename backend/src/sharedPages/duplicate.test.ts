import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../users/types.js';
import type { SharedPage } from './types.js';

const state = vi.hoisted(() => ({
  page: null as unknown as SharedPage,
  members: new Set<string>(),
  calls: [] as { sourceId: string; version: number; input: Record<string, unknown> }[],
}));

vi.mock('./repository.js', () => ({
  sharedPageRepository: {
    findById: async (id: string) => (id === state.page.id ? state.page : null),
    isMember: async (_p: string, userId: string) => state.members.has(userId),
    duplicate: async (sourceId: string, version: number, input: Record<string, unknown>) => {
      state.calls.push({ sourceId, version, input });
      return { ...state.page, ...input, id: 'copy', version: 1, linkAccess: false };
    },
  },
}));
// Les personnes du test sont membres d'un projet (compte non restreint) : la duplication n'est refusée qu'à l'invité des pages.
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async () => null, findByEmail: async () => null, hasFullMembership: async () => true } }));
vi.mock('../users/service.js', () => ({ userService: {} }));
vi.mock('../notifications/mail.js', () => ({ mailService: {} }));
vi.mock('../notifications/service.js', () => ({ notificationService: {} }));
vi.mock('../auth/signInService.js', () => ({ SHARE_LOGIN_LINK_DAYS: 30, signInService: {} }));

const { sharedPageService } = await import('./service.js');

function person(id: string, extra: Partial<User> = {}): User {
  return { id, email: `${id}@toolso.io`, name: id, kind: 'person', avatarUrl: null, googleSub: null, isAdmin: false, isSuperAdmin: false, isCto: false, isGuest: false, createdAt: new Date(), lastLoginAt: new Date(), passwordSetAt: null, ...extra };
}
const stan = person('stan');
const alice = person('alice');

function page(extra: Partial<SharedPage> = {}): SharedPage {
  return {
    id: 'p1', ownerId: 'stan', title: 'Tableau des ventes', description: 'Par mois', linkAccess: false, publicAccess: false, projectAccess: false, version: 3, projectId: 'proj', sessionId: 'sess', sourcePath: 'ventes.html',
    agentHandoff: 'manual', historyEnabled: true, kind: 'page', refreshMinutes: null, dataRefreshedAt: null, viewedAt: null, createdAt: new Date(), updatedAt: new Date(), ...extra,
  };
}

beforeEach(() => {
  state.page = page();
  state.members = new Set();
  state.calls = [];
});

describe('duplication d’un artefact', () => {
  it('copie la dernière version de sa propre page, en gardant session et fichier d’origine', async () => {
    const copy = await sharedPageService.duplicate(stan, 'p1');
    expect(copy.id).toBe('copy');
    expect(state.calls[0]).toMatchObject({ sourceId: 'p1', version: 3, input: { ownerId: 'stan', title: 'Copie de Tableau des ventes', description: 'Par mois', projectId: 'proj', sessionId: 'sess', sourcePath: 'ventes.html' } });
  });

  it('une personne qui voit la page en obtient une copie à son nom, sans la session d’origine', async () => {
    state.members.add('alice');
    await sharedPageService.duplicate(alice, 'p1', { title: '  Ma version  ', version: 2 });
    expect(state.calls[0]).toMatchObject({ version: 2, input: { ownerId: 'alice', title: 'Ma version', sessionId: null, sourcePath: null, projectId: 'proj' } });
  });

  it('refuse qui ne voit pas la page, et un invité', async () => {
    await expect(sharedPageService.duplicate(alice, 'p1')).rejects.toThrow(/introuvable/);
    state.page = page({ linkAccess: true });
    await expect(sharedPageService.duplicate(person('g', { isGuest: true }), 'p1')).rejects.toThrow(/invité/);
    expect(state.calls).toHaveLength(0);
  });

  it('artefact de données : propriétaire ou administrateur seulement (la copie emporte les requêtes)', async () => {
    state.page = page({ kind: 'data', linkAccess: true });
    await expect(sharedPageService.duplicate(alice, 'p1')).rejects.toThrow(/propriétaire/);
    await sharedPageService.duplicate(person('admin', { isAdmin: true }), 'p1');
    expect(state.calls[0].input).toMatchObject({ ownerId: 'admin', sessionId: null });
  });

  it('refuse une ancienne version quand l’historique est désactivé, ou une version qui n’existe pas', async () => {
    await expect(sharedPageService.duplicate(stan, 'p1', { version: 9 })).rejects.toThrow(/Version introuvable/);
    state.page = page({ historyEnabled: false });
    await expect(sharedPageService.duplicate(stan, 'p1', { version: 1 })).rejects.toThrow(/historique/);
    await sharedPageService.duplicate(stan, 'p1', { version: 3 });
    expect(state.calls).toHaveLength(1);
  });
});
