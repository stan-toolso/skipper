import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
const { pullRequestRepository } = await import('./repository.js');
const { pool } = await import('../db/pool.js');

const lastSql = (): string => String((pool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]);
/** Colonnes assignées par le SET, dans l'ordre. */
const assigned = (sql: string): string[] => [...sql.replace(/^UPDATE pull_requests SET /, '').replace(/ WHERE id = \$1 RETURNING \*$/, '').matchAll(/(^|, )(\w+) = /g)].map((m) => m[2]);

beforeEach(() => vi.mocked(pool.query).mockClear());

describe('pullRequestRepository.update', () => {
  it("n'assigne chaque colonne qu'une fois quand une PR ouverte est réenregistrée avec les champs de GitHub (bug de pr_register)", async () => {
    await pullRequestRepository.update('id', { status: 'open', mergedAt: null, closedAt: null, mergeSha: null, title: 'Titre', isDraft: false });
    const cols = assigned(lastSql());
    expect(new Set(cols).size).toBe(cols.length);
    expect(cols).toEqual(expect.arrayContaining(['status', 'merged_at', 'closed_at', 'merge_sha', 'title', 'is_draft']));
  });

  it('efface les traces de fusion et de fermeture quand une PR est rouverte sans ces champs', async () => {
    await pullRequestRepository.update('id', { status: 'open' });
    expect(lastSql()).toContain('merged_at = NULL');
    expect(lastSql()).toContain('closed_at = NULL');
    expect(lastSql()).toContain('merge_sha = NULL');
  });

  it("pose la date de fusion ou de fermeture si l'appelant ne la donne pas, sans la doubler sinon", async () => {
    await pullRequestRepository.update('id', { status: 'merged' });
    expect(lastSql()).toContain('merged_at = COALESCE(merged_at, now())');
    await pullRequestRepository.update('id', { status: 'merged', mergedAt: new Date() });
    expect(assigned(lastSql()).filter((c) => c === 'merged_at')).toHaveLength(1);
    await pullRequestRepository.update('id', { status: 'closed' });
    expect(lastSql()).toContain('closed_at = COALESCE(closed_at, now())');
  });

  it("n'assigne aucune colonne deux fois, quels que soient le statut et les champs de date fournis", async () => {
    const statuses = [undefined, 'pending', 'open', 'merged', 'closed'] as const;
    const values = { mergedAt: [undefined, null, new Date()], closedAt: [undefined, null, new Date()], mergeSha: [undefined, null, 'abc123'] };
    for (const status of statuses)
      for (const mergedAt of values.mergedAt)
        for (const closedAt of values.closedAt)
          for (const mergeSha of values.mergeSha) {
            await pullRequestRepository.update('id', { status, mergedAt, closedAt, mergeSha });
            const cols = assigned(lastSql());
            expect(cols.filter((c, i) => cols.indexOf(c) !== i), JSON.stringify({ status, mergedAt, closedAt, mergeSha })).toEqual([]);
          }
  });
});

describe('pullRequestRepository.findForWorksessions', () => {
  it("ne retient pas par sa branche une PR terminée avant la création de la work session (nom de branche réutilisé)", async () => {
    await pullRequestRepository.findForWorksessions([{ id: 'ws', projectId: 'p', branch: 'est-ce-qu-on-peut-faire' }]);
    const sql = lastSql();
    expect(sql).toContain('JOIN pull_requests p ON p.worksession_id = w.id');
    expect(sql).toContain('COALESCE(p.merged_at, p.closed_at) >= w.created_at');
  });

  it('garde, pour chaque work session, la première PR dans l’ordre de la requête (la plus avancée)', async () => {
    const row = (ws: string, id: string, status: string) => ({ ws_key: ws, id, status, project_id: 'p', head_branch: 'b', repo: '', number: 1, url: '', title: '' });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [row('a', 'pr1', 'open'), row('b', 'pr2', 'merged'), row('a', 'pr3', 'merged')], rowCount: 3 } as never);
    const found = await pullRequestRepository.findForWorksessions([
      { id: 'a', projectId: 'p', branch: 'b' },
      { id: 'b', projectId: 'p', branch: 'b' },
      { id: 'c', projectId: 'p', branch: 'c' },
    ]);
    expect(found.get('a')?.id).toBe('pr1');
    expect(found.get('b')?.id).toBe('pr2');
    expect(found.has('c')).toBe(false);
  });
});
