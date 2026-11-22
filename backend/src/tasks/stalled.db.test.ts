import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * « Agent arrêté » et « en attente » (`Task.stalledSince`, `Task.waitingSince`, ATTENTION_JOIN) sur une base
 * PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : tâche en cours dont aucune session en charge ne
 * tourne, sans pull request ouverte ; en attente quand l'agent a dit ce qu'il attendait.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe.skipIf(!adminUrl)('tâches « agent arrêté » (PostgreSQL)', () => {
  const name = `skipper_test_stalled_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./repository.js').taskRepository;
  let project: string;
  let alice: string;

  const session = async (status: string, endedAt: string | null = null) =>
    (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider, owner_id, status, ended_at) VALUES ($1, 'S', 'claude', $2, $3, $4) RETURNING id`, [project, alice, status, endedAt])).rows[0].id;
  const task = async (status: string, sessions: string[]) => {
    const id = (await pool.query<{ id: string }>(`INSERT INTO tasks (project_id, title, status, created_by_type) VALUES ($1, 'T', $2, 'human') RETURNING id`, [project, status])).rows[0].id;
    for (const s of sessions) await pool.query(`INSERT INTO task_sessions (task_id, session_id, in_charge_since) VALUES ($1, $2, now())`, [id, s]);
    return id;
  };
  const stalled = async (id: string) => (await repo.findById(id))?.stalledSince ?? null;
  const waiting = async (id: string) => (await repo.findById(id))?.waitingSince ?? null;
  const note = async (taskId: string, sessionId: string, at: string) => {
    const conv = (
      await pool.query<{ id: string }>(
        `INSERT INTO conversations (project_id, kind, task_id, slug, name) VALUES ($1, 'task', $2::uuid, 'task-' || $2::text, 'T')
         ON CONFLICT (task_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [project, taskId],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO messages (conversation_id, author_type, author_session_id, author_name, body, created_at) VALUES ($1, 'agent', $2, 'Agent', 'compte rendu', $3)`, [conv, sessionId, at]);
  };
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    repo = (await import('./repository.js')).taskRepository;
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Stalled', 'stalled') RETURNING id`)).rows[0].id;
    alice = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('signale une tâche en cours dont les sessions en charge sont toutes arrêtées, avec la fin la plus récente', async () => {
    const a = await session('stopped', '2026-11-01T10:00:00Z');
    const b = await session('failed', '2026-11-02T10:00:00Z');
    const t = await task('in_progress', [a, b]);
    expect((await stalled(t))?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    const listed = await repo.list({ projectId: project, stalled: true });
    expect(listed.map((x) => x.id)).toContain(t);
  });

  it('ni « agent arrêté » ni « en attente » dans un statut qui attend une personne (« À valider »), y compris un statut choisi par le projet', async () => {
    const review = await task('in_progress', [await session('failed', '2026-11-01T10:00:00Z')]);
    await pool.query(`UPDATE tasks SET state = 'review' WHERE id = $1`, [review]);
    expect(await stalled(review)).toBeNull();
    expect(await waiting(review)).toBeNull();
    // Statuts propres au projet : « recette » attend une personne, « review » n'existe plus (statut par défaut : en cours).
    await pool.query(
      `UPDATE projects SET task_statuses = $2::jsonb WHERE id = $1`,
      [project, JSON.stringify([
        { key: 'todo', label: 'À faire', category: 'todo', description: null, attention: false, isDefault: true },
        { key: 'dev', label: 'Dev', category: 'in_progress', description: null, attention: false, isDefault: true },
        { key: 'recette', label: 'Recette', category: 'in_progress', description: null, attention: true, isDefault: false },
        { key: 'done', label: 'Terminée', category: 'done', description: null, attention: false, isDefault: true },
        { key: 'cancelled', label: 'Annulée', category: 'cancelled', description: null, attention: false, isDefault: true },
      ])],
    );
    try {
      expect(await stalled(review)).not.toBeNull();
      await pool.query(`UPDATE tasks SET state = 'recette' WHERE id = $1`, [review]);
      expect(await stalled(review)).toBeNull();
    } finally {
      await pool.query(`UPDATE projects SET task_statuses = NULL WHERE id = $1`, [project]);
    }
  });

  it('rien tant qu’une session en charge tourne, sans session, hors « en cours », ou avec une PR ouverte', async () => {
    const running = await task('in_progress', [await session('stopped', '2026-11-01T10:00:00Z'), await session('running')]);
    const none = await task('in_progress', []);
    const todo = await task('todo', [await session('completed', '2026-11-01T10:00:00Z')]);
    const withPr = await task('in_progress', [await session('completed', '2026-11-01T10:00:00Z')]);
    await pool.query(`INSERT INTO pull_requests (project_id, task_id, number, url, title, head_branch, status, created_by_type) VALUES ($1, $2, 1, 'https://example.com/pr/1', 'PR', 'b', 'open', 'human')`, [project, withPr]);
    for (const id of [running, none, todo, withPr]) expect(await stalled(id)).toBeNull();
    const listed = (await repo.list({ projectId: project, stalled: true })).map((x) => x.id);
    for (const id of [running, none, todo, withPr]) expect(listed).not.toContain(id);
    // La PR fusionnée, l'agent n'a plus de raison d'attendre : la tâche restée en cours redevient « agent arrêté ».
    await pool.query(`UPDATE pull_requests SET status = 'merged' WHERE task_id = $1`, [withPr]);
    expect(await stalled(withPr)).not.toBeNull();
  });

  it('en attente quand l’agent s’arrête proprement en laissant une étiquette d’état, à traiter s’il est en erreur', async () => {
    const clean = await task('in_progress', [await session('stopped', ago(1))]);
    await pool.query(`UPDATE tasks SET status_tag = 'surveillance' WHERE id = $1`, [clean]);
    expect(await stalled(clean)).toBeNull();
    expect(await waiting(clean)).not.toBeNull();
    expect((await repo.list({ projectId: project, waiting: true })).map((x) => x.id)).toContain(clean);
    expect((await repo.list({ projectId: project, stalled: true })).map((x) => x.id)).not.toContain(clean);

    const failed = await task('in_progress', [await session('failed', ago(1))]);
    await pool.query(`UPDATE tasks SET status_tag = 'surveillance' WHERE id = $1`, [failed]);
    expect(await stalled(failed)).not.toBeNull();
    expect(await waiting(failed)).toBeNull();
  });

  it('en attente quand une session a rendu compte dans le fil depuis la prise en charge, pendant 7 jours', async () => {
    const s = await session('completed', ago(3));
    const reported = await task('in_progress', [s]);
    await pool.query(`UPDATE task_sessions SET in_charge_since = $2 WHERE task_id = $1`, [reported, ago(4)]);
    // Une exécution planifiée (autre session, pas en charge) rend compte après la fin de la session en charge.
    await note(reported, await session('completed', ago(1)), ago(1));
    expect(await waiting(reported)).not.toBeNull();
    expect(await stalled(reported)).toBeNull();

    const silent = await task('in_progress', [await session('completed', ago(1))]);
    expect(await stalled(silent)).not.toBeNull();

    const old = await session('completed', ago(10));
    const forgotten = await task('in_progress', [old]);
    await pool.query(`UPDATE task_sessions SET in_charge_since = $2 WHERE task_id = $1`, [forgotten, ago(12)]);
    await note(forgotten, old, ago(10));
    expect(await stalled(forgotten)).not.toBeNull();
    expect(await waiting(forgotten)).toBeNull();
  });

  it('date de réveil : en attente avant, agent arrêté après (depuis le réveil), traitée une seule fois', async () => {
    const s = await session('stopped', ago(2));
    const future = await task('in_progress', [s]);
    await repo.update(future, { wakeAt: new Date(Date.now() + 3_600_000), wakeNote: 'compter les compétitions' });
    expect(await waiting(future)).not.toBeNull();
    expect((await repo.findById(future))?.wakeNote).toBe('compter les compétitions');

    const past = await task('in_progress', [await session('stopped', ago(2))]);
    await pool.query(`UPDATE tasks SET wake_at = $2, status_tag = 'surveillance' WHERE id = $1`, [past, ago(1)]);
    expect((await stalled(past))?.toISOString().slice(0, 13)).toBe(ago(1).slice(0, 13));
    expect(await waiting(past)).toBeNull();

    const due = await repo.claimDueWakes();
    expect(due).toContain(past);
    expect(due).not.toContain(future);
    expect(await repo.claimDueWakes()).not.toContain(past);

    // Une nouvelle date repart de zéro ; quitter « en cours » efface l'attente.
    await repo.update(past, { wakeAt: new Date(Date.now() - 1000) });
    expect(await repo.claimDueWakes()).toContain(past);
    await repo.update(future, { status: 'done' });
    const done = await repo.findById(future);
    expect(done?.wakeAt).toBeNull();
    expect(done?.wakeNote).toBeNull();
  });
});
