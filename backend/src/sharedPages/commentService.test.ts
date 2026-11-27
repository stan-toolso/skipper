import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedPage, SharedPageComment } from './types.js';

// Commentaires des pages partagées : droits (qui voit commente, l'auteur modifie, l'auteur ou le propriétaire
// supprime), ancre nettoyée, réponses, état traité et destinataires des notifications. Base simulée en mémoire.
const state = vi.hoisted(() => ({
  pages: new Map<string, { id: string; ownerId: string; title: string; version: number; linkAccess: boolean; members: string[]; sessionId?: string | null; agentHandoff?: SharedPage['agentHandoff'] }>(),
  forwarded: [] as Array<{ pageId: string; rootId: string; actor: string; trigger: string }>,
  comments: [] as SharedPageComment[],
  notified: [] as Array<{ type: string; userId: string | null | undefined; title: string; link: string | null | undefined }>,
  seq: 0,
}));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: { type: string; userId?: string | null; title: string; link?: string | null }) => void state.notified.push({ type: n.type, userId: n.userId, title: n.title, link: n.link }) } }));
vi.mock('./service.js', () => ({
  sharedPageService: {
    async getFor(userId: string, id: string): Promise<SharedPage> {
      const p = state.pages.get(id);
      if (!p || !(p.ownerId === userId || p.linkAccess || p.members.includes(userId))) throw new Error('Page partagée introuvable, ou non partagée avec vous');
      return { id: p.id, ownerId: p.ownerId, title: p.title, version: p.version, linkAccess: p.linkAccess, publicAccess: false, projectAccess: false, description: null, projectId: null, sessionId: p.sessionId ?? null, sourcePath: null, agentHandoff: p.agentHandoff ?? 'manual', historyEnabled: true, kind: 'page', refreshMinutes: null, dataRefreshedAt: null, viewedAt: null, createdAt: new Date(), updatedAt: new Date() };
    },
    canManage: (page: SharedPage, user: { id: string; isAdmin: boolean; isGuest: boolean }) => page.ownerId === user.id || (user.isAdmin && !user.isGuest),
  },
}));
vi.mock('./updateRequest.js', () => ({
  sharedPageUpdateService: {
    forward: async (page: SharedPage, root: SharedPageComment, actor: { id: string }, trigger: string) => void state.forwarded.push({ pageId: page.id, rootId: root.id, actor: actor.id, trigger }),
  },
}));
vi.mock('./commentRepository.js', () => ({
  sharedPageCommentRepository: {
    findById: async (id: string) => state.comments.find((c) => c.id === id) ?? null,
    listOfPage: async (pageId: string) => state.comments.filter((c) => c.pageId === pageId),
    replies: async (parentId: string) => state.comments.filter((c) => c.parentId === parentId),
    countOpen: async (pageId: string) => state.comments.filter((c) => c.pageId === pageId && !c.parentId && !c.resolvedAt).length,
    create: async (input: Omit<SharedPageComment, 'id' | 'resolvedAt' | 'resolvedById' | 'createdAt' | 'updatedAt'>) => {
      const c: SharedPageComment = { ...input, id: `c${++state.seq}`, resolvedAt: null, resolvedById: null, createdAt: new Date(), updatedAt: new Date() };
      state.comments.push(c);
      return c;
    },
    updateBody: async (id: string, body: string) => {
      const c = state.comments.find((x) => x.id === id);
      if (c) c.body = body;
      return c ?? null;
    },
    setResolved: async (id: string, by: string | null) => {
      const c = state.comments.find((x) => x.id === id);
      if (c) {
        c.resolvedAt = by ? new Date() : null;
        c.resolvedById = by;
      }
      return c ?? null;
    },
    delete: async (id: string) => {
      const before = state.comments.length;
      state.comments = state.comments.filter((c) => c.id !== id && c.parentId !== id);
      return state.comments.length < before;
    },
  },
}));

const { cleanAnchor, sharedPageCommentService: svc } = await import('./commentService.js');

const user = (id: string, name = id) => ({ id, name, email: `${id}@example.org`, avatarUrl: null, isAdmin: false, createdAt: new Date(), lastLoginAt: null }) as unknown as import('../users/types.js').User;
const owner = user('owner', 'Olivia');
const alice = user('alice', 'Alice');
const bob = user('bob', 'Bob');
const stranger = user('zed', 'Zed');

beforeEach(() => {
  state.pages.clear();
  state.pages.set('p1', { id: 'p1', ownerId: 'owner', title: 'Rapport', version: 3, linkAccess: false, members: ['alice', 'bob'] });
  state.comments = [];
  state.notified = [];
  state.forwarded = [];
  state.seq = 0;
});

describe("transmission automatique à l'agent", () => {
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it('page en « auto » avec session : commentaire et réponse des personnes transmis, pas ceux des sessions', async () => {
    state.pages.get('p1')!.sessionId = 's1';
    state.pages.get('p1')!.agentHandoff = 'auto';
    const c = await svc.add({ user: alice }, 'p1', { body: 'Trop petit' });
    await svc.reply({ user: bob }, c.id, 'Je confirme');
    await svc.reply({ user: owner, sessionId: 's1' }, c.id, 'Corrigé');
    await svc.add({ user: owner, sessionId: 's1' }, 'p1', { body: 'Note de l’agent' });
    await flush();
    expect(state.forwarded).toEqual([
      { pageId: 'p1', rootId: c.id, actor: 'alice', trigger: 'comment' },
      { pageId: 'p1', rootId: c.id, actor: 'bob', trigger: 'reply' },
    ]);
  });

  it('rien en « manual », en « off » ou sans session', async () => {
    state.pages.get('p1')!.sessionId = 's1';
    await svc.add({ user: alice }, 'p1', { body: 'a' });
    state.pages.get('p1')!.agentHandoff = 'off';
    await svc.add({ user: alice }, 'p1', { body: 'b' });
    state.pages.get('p1')!.agentHandoff = 'auto';
    state.pages.get('p1')!.sessionId = null;
    await svc.add({ user: alice }, 'p1', { body: 'c' });
    await flush();
    expect(state.forwarded).toEqual([]);
  });
});

describe('ancre', () => {
  it('ne garde que les champs attendus, bornés et nettoyés', () => {
    expect(cleanAnchor({ selector: '  main > p.lead  ', text: ' Bonjour\n le  monde ', tag: 'P', evil: 'x' })).toEqual({ selector: 'main > p.lead', text: 'Bonjour le monde', tag: 'p' });
    expect(cleanAnchor({ selector: 'x'.repeat(600), text: 'y'.repeat(300), tag: '<script>' })).toEqual({ selector: 'x'.repeat(500), text: 'y'.repeat(200), tag: 'script' });
    expect(cleanAnchor({ selector: 'div', text: 42, tag: null })).toEqual({ selector: 'div', text: null, tag: null });
    expect(cleanAnchor({ text: 'sans sélecteur' })).toBeNull();
    expect(cleanAnchor('bruit')).toBeNull();
    expect(cleanAnchor(null)).toBeNull();
  });
});

describe('commentaires', () => {
  it('quiconque voit la page commente ; la version par défaut est la dernière, une version inconnue est refusée', async () => {
    const c = await svc.add({ user: alice }, 'p1', { body: '  Trop long \r\n ici ', anchor: { selector: 'h1', text: 'Titre', tag: 'h1' } });
    expect(c).toMatchObject({ pageId: 'p1', authorId: 'alice', body: 'Trop long \n ici', version: 3, anchor: { selector: 'h1', text: 'Titre', tag: 'h1' }, sessionId: null });
    const older = await svc.add({ user: owner, sessionId: 's9' }, 'p1', { body: 'Général', version: 2 });
    expect(older).toMatchObject({ version: 2, anchor: null, sessionId: 's9' });
    await expect(svc.add({ user: alice }, 'p1', { body: 'x', version: 4 })).rejects.toThrow('Version de la page inconnue');
    await expect(svc.add({ user: alice }, 'p1', { body: '   ' })).rejects.toThrow('vide');
    await expect(svc.add({ user: stranger }, 'p1', { body: 'x' })).rejects.toThrow('introuvable');
  });

  it('prévient le propriétaire, jamais l’auteur, avec un lien vers le commentaire', async () => {
    const c = await svc.add({ user: alice }, 'p1', { body: 'Première ligne\nseconde' });
    expect(state.notified).toEqual([{ type: 'page.commented', userId: 'owner', title: 'Alice a commenté « Rapport »', link: `/shared/p1?comment=${c.id}` }]);
    state.notified = [];
    await svc.add({ user: owner }, 'p1', { body: 'Note à moi-même' });
    expect(state.notified).toEqual([]);
  });

  it('une réponse prévient le propriétaire, l’auteur et les participants, sans doublon ni l’auteur de la réponse', async () => {
    const root = await svc.add({ user: alice }, 'p1', { body: 'Question' });
    state.notified = [];
    await svc.reply({ user: bob }, root.id, 'Réponse de Bob');
    expect(state.notified.map((n) => n.userId).sort()).toEqual(['alice', 'owner']);
    state.notified = [];
    const r = await svc.reply({ user: alice }, root.id, 'Merci Bob');
    expect(r).toMatchObject({ parentId: root.id, version: root.version, anchor: null });
    expect(state.notified.map((n) => n.userId).sort()).toEqual(['bob', 'owner']);
    expect(state.notified[0].title).toBe('Alice a répondu à un commentaire sur « Rapport »');
    await expect(svc.reply({ user: bob }, r.id, 'À une réponse')).rejects.toThrow('pas à une réponse');
    await expect(svc.reply({ user: stranger }, root.id, 'x')).rejects.toThrow('introuvable');
  });

  it('seul l’auteur modifie ; l’auteur ou le propriétaire supprime (avec les réponses)', async () => {
    const root = await svc.add({ user: alice }, 'p1', { body: 'v1' });
    await svc.reply({ user: bob }, root.id, 'r');
    await expect(svc.update({ user: bob }, root.id, 'pirate')).rejects.toThrow("Seul l'auteur");
    expect((await svc.update({ user: alice }, root.id, 'v2')).body).toBe('v2');
    await expect(svc.delete({ user: bob }, root.id)).rejects.toThrow('propriétaire');
    expect(await svc.delete({ user: owner }, root.id)).toBe(true);
    expect(state.comments).toEqual([]);
  });

  it('traité / rouvert par quiconque voit la page, seulement sur un commentaire racine', async () => {
    const root = await svc.add({ user: alice }, 'p1', { body: 'À faire' });
    const reply = await svc.reply({ user: alice }, root.id, 'r');
    const done = await svc.resolve({ user: bob }, root.id, true);
    expect(done.resolvedAt).toBeInstanceOf(Date);
    expect(done.resolvedById).toBe('bob');
    expect(await svc.countOpen('p1')).toBe(0);
    expect((await svc.resolve({ user: bob }, root.id, true)).resolvedById).toBe('bob');
    const reopened = await svc.resolve({ user: owner }, root.id, false);
    expect(reopened.resolvedAt).toBeNull();
    expect(await svc.countOpen('p1')).toBe(1);
    await expect(svc.resolve({ user: alice }, reply.id, true)).rejects.toThrow('pas une réponse');
    expect((await svc.roots('p1')).map((c) => c.id)).toEqual([root.id]);
  });
});
