import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Planifications sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : la planification
 * est un objet du projet (plus de session qui la porte), ses exécutions lancent des sessions indépendantes ; la
 * migration 20261107T1142 reprend les planifications d'avant et reste compatible avec la version précédente.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

const MIGRATION = fileURLToPath(new URL('../db/migrations/20261107T1142_schedules_own_object.sql', import.meta.url));

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe.skipIf(!adminUrl)('planifications (PostgreSQL)', () => {
  const name = `skipper_test_schedules_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repo: typeof import('./repository.js').scheduleRepository;
  let project: string;
  let alice: string;
  const session = async (label: string, extra: { status?: string; config?: Record<string, unknown> } = {}) =>
    (await pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider, owner_id, status, config) VALUES ($1, $2, 'claude', $3, $4, $5::jsonb) RETURNING id`, [project, label, alice, extra.status ?? 'completed', JSON.stringify(extra.config ?? {})])).rows[0].id;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    repo = (await import('./repository.js')).scheduleRepository;
    project = (await pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('Plan', 'plan') RETURNING id`)).rows[0].id;
    alice = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('crée une planification sans session, rattache ses exécutions et leurs sessions', async () => {
    const sc = await repo.create({ projectId: project, ownerId: alice, requestedById: null, provider: 'claude', config: { model: 'sonnet' }, name: 'Revue', cron: '0 9 * * *', timezone: 'Europe/Paris', prompt: 'Revois', enabled: true, endAfterRun: true, nextRunAt: new Date() });
    expect(sc).toMatchObject({ projectId: project, ownerId: alice, provider: 'claude', config: { model: 'sonnet' }, archivePolicy: 'previous_on_run', allowedTools: [] });
    expect((await repo.listForProjects([project])).map((s) => s.id)).toEqual([sc.id]);

    const older = await session('Revue · 06/11 09:00');
    const newer = await session('Revue · 07/11 09:00', { status: 'running' });
    const r1 = await repo.createRun({ scheduleId: sc.id, trigger: 'schedule', status: 'running' });
    await repo.setRunSession(r1.id, older);
    await repo.finishRun(r1.id, { status: 'done', costUsd: 0.1, durationMs: 1000, message: null });
    const r2 = await repo.createRun({ scheduleId: sc.id, trigger: 'manual', status: 'running' });
    await repo.setRunSession(r2.id, newer);
    await repo.createRun({ scheduleId: sc.id, trigger: 'schedule', status: 'skipped', message: 'occupé' });

    expect((await repo.findByRunSessions([older, newer])).get(newer)?.id).toBe(sc.id);
    expect(await repo.hasRunning(sc.id)).toBe(true);
    expect(await repo.activeRunSessions(sc.id, newer)).toEqual([older]);
    expect(await repo.liveRunSessions(sc.id)).toEqual([newer, older]);
    expect((await repo.listRecentRuns([sc.id], 2)).get(sc.id)).toHaveLength(2);
    // Outils pré-autorisés : seulement dans la session de l'exécution en cours.
    await repo.update(sc.id, { cron: '0 9 * * *', timezone: 'Europe/Paris', prompt: 'Revois', enabled: true, endAfterRun: true, nextRunAt: null, allowedTools: ['Bash(git log *)'], config: { model: 'opus' } });
    expect(await repo.activeRunRules(newer)).toEqual(['Bash(git log *)']);
    expect(await repo.activeRunRules(older)).toBeNull();
    expect((await repo.findById(sc.id))?.config).toEqual({ model: 'opus' });

    // Supprimer la planification efface son historique ; les sessions restent.
    expect(await repo.delete(sc.id)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM session_schedule_runs WHERE schedule_id = $1', [sc.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE id = ANY($1::uuid[])', [[older, newer]])).rows[0].n).toBe(2);
  });

  it('migration : reprend les réglages de la session qui portait la planification, et ses exécutions d’avant', async () => {
    // État d'avant la migration : une planification portée par une session, une exécution jouée dans cette session.
    await pool.query('ALTER TABLE session_schedules ALTER COLUMN project_id DROP NOT NULL');
    await pool.query('ALTER TABLE session_schedules DISABLE TRIGGER session_schedules_fill_legacy');
    await pool.query('ALTER TABLE session_schedule_runs DISABLE TRIGGER session_schedule_runs_fill_legacy');
    const holder = await session('Revue des bases', { status: 'pending', config: { permissionMode: 'bypassPermissions' } });
    const legacyRunner = await session('Rapport');
    await pool.query(`INSERT INTO session_schedules (session_id, cron, timezone, prompt) VALUES ($1, '35 12 * * *', 'Europe/Paris', 'Revois les bases')`, [holder]);
    await pool.query(`INSERT INTO session_schedules (session_id, cron, timezone, prompt, name) VALUES ($1, '0 8 * * 1', 'UTC', 'Rapport', 'Rapport du lundi')`, [legacyRunner]);
    await pool.query(`INSERT INTO session_schedule_runs (session_id, trigger, status) VALUES ($1, 'schedule', 'done'), ($1, 'schedule', 'missed')`, [legacyRunner]);
    await pool.query('ALTER TABLE session_schedules ENABLE TRIGGER session_schedules_fill_legacy');
    await pool.query('ALTER TABLE session_schedule_runs ENABLE TRIGGER session_schedule_runs_fill_legacy');

    await pool.query(readFileSync(MIGRATION, 'utf8'));

    const { rows } = await pool.query<{ id: string; session_id: string; project_id: string; owner_id: string; config: Record<string, unknown>; name: string }>(
      'SELECT id, session_id, project_id, owner_id, config, name FROM session_schedules WHERE session_id = ANY($1::uuid[])',
      [[holder, legacyRunner]],
    );
    const bySession = new Map(rows.map((r) => [r.session_id, r]));
    expect(bySession.get(holder)).toMatchObject({ project_id: project, owner_id: alice, config: { permissionMode: 'bypassPermissions' }, name: 'Revue des bases' });
    expect(bySession.get(legacyRunner)?.name).toBe('Rapport du lundi');
    const runs = await repo.listRuns(bySession.get(legacyRunner)!.id);
    // L'exécution jouée dans la session d'avant en devient la session d'exécution ; l'échéance manquée n'en a pas.
    expect(runs.map((r) => [r.status, r.runSessionId]).sort()).toEqual([
      ['done', legacyRunner],
      ['missed', null],
    ]);
    // La session qui ne faisait que porter les réglages est à ranger ; celle qui a servi d'exécution, non.
    expect(await repo.legacyHolderSessions()).toEqual([holder]);
    expect((await repo.findByRunSessions([legacyRunner])).get(legacyRunner)?.id).toBe(bySession.get(legacyRunner)!.id);

    // Supprimer la session d'origine ne supprime plus la planification.
    await pool.query('DELETE FROM sessions WHERE id = $1', [holder]);
    expect(await repo.findById(bySession.get(holder)!.id)).not.toBeNull();
  });

  it('compatibilité bleu/vert : une écriture de la version précédente (session_id seul) est complétée', async () => {
    const holder = await session('Ancienne version', { config: { model: 'haiku' } });
    await pool.query(
      `INSERT INTO session_schedules (session_id, cron, timezone, prompt, enabled, end_after_run, next_run_at) VALUES ($1, '0 9 * * *', 'UTC', 'x', true, true, now())
       ON CONFLICT (session_id) DO UPDATE SET cron = EXCLUDED.cron`,
      [holder],
    );
    const sc = (await pool.query<{ id: string; project_id: string; config: Record<string, unknown> }>('SELECT id, project_id, config FROM session_schedules WHERE session_id = $1', [holder])).rows[0];
    expect(sc).toMatchObject({ project_id: project, config: { model: 'haiku' } });
    await pool.query(`INSERT INTO session_schedule_runs (session_id, trigger, status) VALUES ($1, 'manual', 'running')`, [holder]);
    expect(await repo.hasRunning(sc.id)).toBe(true);
  });

  it('budget : plafonds enregistrés et modifiés, consommation du mois et d’une exécution', async () => {
    const sc = await repo.create({ projectId: project, ownerId: alice, requestedById: null, provider: 'claude', config: {}, name: 'Budget', cron: '0 9 * * *', timezone: 'UTC', prompt: 'x', enabled: true, endAfterRun: true, nextRunAt: null, maxRunUsd: 1.5, monthlyBudgetUsd: 20 });
    expect(sc).toMatchObject({ maxRunUsd: 1.5, monthlyBudgetUsd: 20 });
    const base = { cron: sc.cron, timezone: sc.timezone, prompt: sc.prompt, enabled: true, endAfterRun: true, nextRunAt: null };
    expect(await repo.update(sc.id, { ...base })).toMatchObject({ maxRunUsd: 1.5, monthlyBudgetUsd: 20 });
    expect(await repo.update(sc.id, { ...base, maxRunUsd: null, monthlyBudgetUsd: 30 })).toMatchObject({ maxRunUsd: null, monthlyBudgetUsd: 30 });

    const s1 = await session('Budget · 1');
    const s2 = await session('Budget · 2');
    const other = await session('Hors planification');
    for (const sid of [s1, s2]) {
      const run = await repo.createRun({ scheduleId: sc.id, trigger: 'schedule', status: 'running' });
      await repo.setRunSession(run.id, sid);
    }
    const ledger = (sid: string, usd: number, at: string, billable = true) =>
      pool.query(`INSERT INTO usage_ledger (session_id, project_id, cost_usd, recorded_at, billable) VALUES ($1, $2, $3, $4, $5)`, [sid, project, usd, at, billable]);
    await ledger(s1, 2, '2026-10-30T10:00:00Z');
    await ledger(s1, 1.25, '2026-11-02T10:00:00Z');
    await ledger(s2, 0.5, '2026-11-03T10:00:00Z');
    await ledger(s2, 9, '2026-11-03T11:00:00Z', false);
    await ledger(other, 5, '2026-11-03T10:00:00Z');
    expect(await repo.spentSince(sc.id, new Date('2026-11-01T00:00:00Z'))).toBeCloseTo(1.75);
    expect(await repo.sessionSpent(s1)).toBeCloseTo(3.25);
    expect(await repo.sessionSpent(s2)).toBeCloseTo(0.5);
  });

  it('« dès la fin » : une exécution close bloquée est à archiver une fois que sa session a fini', async () => {
    const sc = await repo.create({ projectId: project, ownerId: alice, requestedById: null, provider: 'claude', config: {}, name: 'Jeton', cron: '0 6 * * *', timezone: 'UTC', prompt: 'x', enabled: true, endAfterRun: true, nextRunAt: null, archive: { policy: 'on_finish', afterMinutes: null } });
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 60_000);
    const runWith = async (label: string, status: 'blocked' | 'timeout' | 'done', extra: { status?: string } = {}) => {
      const sid = await session(label, extra);
      const run = await repo.createRun({ scheduleId: sc.id, trigger: 'schedule', status: 'running' });
      await repo.setRunSession(run.id, sid);
      await repo.finishRun(run.id, { status, costUsd: 0, durationMs: 1, message: null });
      await pool.query(`INSERT INTO session_events (session_id, type, created_at) VALUES ($1, 'claude.result', $2)`, [sid, old]);
      return sid;
    };
    // Bloquée, demande acceptée depuis, session terminée (fin pour inactivité) : à archiver.
    const answered = await runWith('Jeton · 18/11', 'blocked');
    await pool.query(`INSERT INTO requests (session_id, type, status, title, answered_at) VALUES ($1, 'permission', 'answered', 'Bash', $2)`, [answered, old]);
    // Délai dépassé, session encore ouverte mais au repos : à archiver (l'archivage la termine).
    const idle = await runWith('Jeton · 19/11', 'timeout', { status: 'running' });
    await pool.query(`UPDATE sessions SET activity = 'idle' WHERE id = $1`, [idle]);
    // Demande toujours en attente : on la laisse à portée de réponse.
    const pending = await runWith('Jeton · 20/11', 'blocked', { status: 'running' });
    await pool.query(`INSERT INTO requests (session_id, type, title) VALUES ($1, 'permission', 'Bash')`, [pending]);
    // Encore au travail.
    const busy = await runWith('Jeton · 21/11', 'blocked', { status: 'running' });
    await pool.query(`UPDATE sessions SET activity = 'busy' WHERE id = $1`, [busy]);
    // Quelqu'un vient d'y écrire : pas tout de suite.
    const recent = await runWith('Jeton · 22/11', 'blocked');
    await pool.query(`INSERT INTO session_events (session_id, type) VALUES ($1, 'instruction')`, [recent]);
    // Terminée normalement (déjà traitée par la clôture), ou déjà archivée : hors champ.
    await runWith('Jeton · 23/11', 'done');
    const archived = await runWith('Jeton · 24/11', 'blocked');
    await pool.query(`UPDATE sessions SET archived_at = now() WHERE id = $1`, [archived]);

    expect((await repo.settledUnfinishedRunSessions(now, 5)).sort()).toEqual([answered, idle].sort());
    // Autre politique d'archivage : rien.
    await repo.update(sc.id, { cron: sc.cron, timezone: sc.timezone, prompt: sc.prompt, enabled: true, endAfterRun: true, nextRunAt: null, archive: { policy: 'never', afterMinutes: null } });
    expect(await repo.settledUnfinishedRunSessions(now, 5)).toEqual([]);
  });

  it('politique de livraison : enregistrée, relue, listée pour la fusion automatique, retirée', async () => {
    const { deliveryRepository } = await import('../deliveries/repository.js');
    expect(await deliveryRepository.getPolicy(project)).toBeNull();
    const saved = await deliveryRepository.setPolicy(project, [{ tag: 'auto', mode: 'auto_merge' }], alice);
    expect(saved).toMatchObject({ projectId: project, rules: [{ tag: 'auto', mode: 'auto_merge' }], mergeUserId: alice });
    expect((await deliveryRepository.autoMergeProjects()).map((p) => p.projectId)).toEqual([project]);
    await deliveryRepository.setPolicy(project, [{ tag: 'auto', mode: 'manual' }], alice);
    expect(await deliveryRepository.autoMergeProjects()).toEqual([]);
    await deliveryRepository.deletePolicy(project);
    expect(await deliveryRepository.getPolicy(project)).toBeNull();
  });
});
