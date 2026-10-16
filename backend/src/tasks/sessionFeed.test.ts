import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskComment } from './types.js';

// Le fil des sessions importe le service des sessions et le registre des providers : inutiles ici.
vi.mock('../sessions/service.js', () => ({ sessionService: {} }));
vi.mock('../sessions/providers/registry.js', () => ({ getProvider: () => ({ describe: () => ({ interactive: true }) }) }));
const { feedFor } = await import('./sessionFeed.js');

const task: Task = {
  id: 't1',
  projectId: 'p1',
  title: 'Corriger le bug',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  sessionId: 's1',
  branch: null,
  createdByType: 'user',
  createdBySessionId: null,
  dueDate: null,
  customFields: [],
  statusTag: null,
  tags: [],
  assignee: null,
  reporter: null,
} as unknown as Task;

const comment = (over: Partial<TaskComment> = {}): TaskComment => ({
  id: 'c1',
  taskId: 't1',
  authorType: 'human',
  authorUserId: 'u1',
  authorSessionId: null,
  authorName: 'Alice',
  body: 'Peux-tu aussi vérifier le panier ?\nMerci.',
  createdAt: new Date('2026-10-10T09:30:00Z'),
  updatedAt: new Date('2026-10-10T09:30:00Z'),
  ...over,
});

describe('feedFor', () => {
  it('rien sans session en charge', () => {
    expect(feedFor({ kind: 'commented', attachments: [], task: { ...task, sessionId: null }, comment: comment() })).toBeNull();
  });
  it('un commentaire d’une personne est transmis à la session en charge, et la relance au besoin', () => {
    const feed = feedFor({ kind: 'commented', attachments: [], task, comment: comment() });
    expect(feed).not.toBeNull();
    expect(feed!.sessionId).toBe('s1');
    expect(feed!.restart).toBe(true);
    expect(feed!.text).toContain('[Commentaire sur la tâche]');
    expect(feed!.text).toContain('- Alice, 2026-10-10 09:30 UTC :');
    expect(feed!.text).toContain('  Peux-tu aussi vérifier le panier ?\n  Merci.');
  });
  it('le commentaire de la session elle-même ne lui est pas renvoyé', () => {
    expect(feedFor({ kind: 'commented', attachments: [], task, comment: comment({ authorType: 'agent', authorSessionId: 's1' }) })).toBeNull();
  });
  it('une modification par quelqu’un d’autre est décrite à la session, sans relance', () => {
    const feed = feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: { type: 'user', userId: 'u1', name: 'Alice', sessionId: null } as never });
    expect(feed).not.toBeNull();
    expect(feed!.restart).toBe(false);
    expect(feed!.text).toContain('[Mise à jour de la tâche]');
    expect(feed!.text).toContain('modifiée par Alice');
    expect(feed!.text).toContain('- Statut : à faire → en cours');
  });
  it('rien pour une passation, une modification par la session elle-même, ou sans changement visible', () => {
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, sessionId: 's0' }, task, actor: { type: 'user', userId: 'u1', name: 'Alice', sessionId: null } as never })).toBeNull();
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: { type: 'agent', userId: null, name: 'Session', sessionId: 's1' } as never })).toBeNull();
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: task, task: { ...task }, actor: { type: 'user', userId: 'u1', name: 'Alice', sessionId: null } as never })).toBeNull();
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: null })).toBeNull();
  });
});
