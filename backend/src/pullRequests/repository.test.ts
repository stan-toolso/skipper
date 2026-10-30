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
});
