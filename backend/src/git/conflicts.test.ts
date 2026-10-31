import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitStatus } from './service.js';

// Résolution des conflits git confiée à un agent : état git, dépôt et service des sessions simulés.
const m = vi.hoisted(() => ({
  status: null as unknown as GitStatus,
  sessions: [] as Array<{ id: string; projectId: string; worksessionId: string | null; archivedAt: Date | null }>,
  sent: [] as Array<[string, string]>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('./service.js', () => ({ gitService: { status: async () => m.status } }));
vi.mock('../sessions/repository.js', () => ({
  sessionRepository: {
    list: async (f: { projectId?: string; worksessionId?: string; limit?: number }) =>
      m.sessions.filter((s) => s.projectId === f.projectId && s.worksessionId === f.worksessionId && !s.archivedAt).slice(0, f.limit ?? 100),
  },
}));
vi.mock('../sessions/service.js', () => ({
  sessionService: {
    sendMessage: async (id: string, text: string) => {
      m.sent.push([id, text]);
      return { id };
    },
    create: async (input: Record<string, unknown>) => {
      m.created.push(input);
      return { id: 'nouvelle', ...input };
    },
  },
}));

const { gitConflictPrompt, requestGitConflictResolution } = await import('./conflicts.js');

const change = (p: string, conflicted: boolean) => ({ path: p, origPath: null, indexStatus: conflicted ? 'U' : 'M', worktreeStatus: conflicted ? 'U' : '.', staged: !conflicted, unstaged: false, untracked: false, conflicted });
const status = (over: Partial<GitStatus> = {}): GitStatus => ({ branch: 'feature', upstream: null, ahead: 0, behind: 0, detached: false, headCommit: null, operation: 'merge', changes: [change('a.ts', true), change('b.ts', false)], ...over });
const ref = { projectId: 'p', worksessionId: 'w1' };

beforeEach(() => {
  m.status = status();
  m.sessions = [];
  m.sent = [];
  m.created = [];
});

describe('consigne de résolution', () => {
  it('liste les fichiers en conflit, demande les vérifications, la fin de la fusion et interdit le push', () => {
    const text = gitConflictPrompt(status());
    expect(text).toContain('`a.ts`');
    expect(text).not.toContain('`b.ts`');
    expect(text).toMatch(/typecheck/);
    expect(text).toContain('git commit --no-edit');
    expect(text).toMatch(/Ne pousse pas/);
  });

  it('adapte la commande de fin à un rebase', () => {
    expect(gitConflictPrompt(status({ operation: 'rebase' }))).toContain('git rebase --continue');
  });
});

describe('requestGitConflictResolution', () => {
  it('envoie la consigne à la session active du dossier', async () => {
    m.sessions = [
      { id: 'archivee', projectId: 'p', worksessionId: 'w1', archivedAt: new Date() },
      { id: 's1', projectId: 'p', worksessionId: 'w1', archivedAt: null },
    ];
    const session = await requestGitConflictResolution(ref, 'u1');
    expect(session.id).toBe('s1');
    expect(m.sent).toHaveLength(1);
    expect(m.created).toHaveLength(0);
  });

  it('sans session active, lance une session dans le même dossier', async () => {
    const session = await requestGitConflictResolution(ref, 'u1');
    expect(session.id).toBe('nouvelle');
    expect(m.created[0]).toMatchObject({ projectId: 'p', worksessionId: 'w1', provider: 'claude', ownerId: 'u1', autoStart: true, name: 'Conflits git · feature' });
  });

  it('refuse sans conflit ni opération, et dans le dossier principal', async () => {
    m.status = status({ operation: null, changes: [change('b.ts', false)] });
    await expect(requestGitConflictResolution(ref, 'u1')).rejects.toThrow(/Aucun conflit/);
    await expect(requestGitConflictResolution({ projectId: 'p', worksessionId: null }, 'u1')).rejects.toThrow(/dossier principal/);
  });

  it('accepte une opération à terminer sans conflit restant', async () => {
    m.status = status({ changes: [change('b.ts', false)] });
    await requestGitConflictResolution(ref, 'u1');
    expect(m.created).toHaveLength(1);
  });
});
