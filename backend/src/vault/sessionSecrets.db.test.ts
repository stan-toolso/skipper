import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Secrets de session sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme db/migrate.test.ts) : chiffrés en base,
 * complétés par une nouvelle saisie, invisibles une fois expirés, effacés avec la session.
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

describe.skipIf(!adminUrl)('secrets de session (PostgreSQL)', () => {
  const name = `skipper_test_session_secrets_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let service: typeof import('./sessionSecrets.js').sessionSecretService;
  let session: string;
  const previousKey = process.env.SKIPPER_SECRET_KEY;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    process.env.SKIPPER_SECRET_KEY = 'ab'.repeat(32); // clé maîtresse de test (pas de fichier .secret-key)
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    service = (await import('./sessionSecrets.js')).sessionSecretService;
    const id = async (sql: string, params: unknown[] = []) => (await pool.query<{ id: string }>(sql, params)).rows[0].id;
    const project = await id(`INSERT INTO projects (name, slug) VALUES ('Équipe', 'equipe') RETURNING id`);
    session = await id(`INSERT INTO sessions (project_id, name, provider) VALUES ($1, 'Session', 'claude') RETURNING id`, [project]);
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.SKIPPER_SECRET_KEY;
    else process.env.SKIPPER_SECRET_KEY = previousKey;
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('chiffre, complète, expire et efface', async () => {
    await service.store({ sessionId: session, name: 'brevo', fields: [{ key: 'token', label: 'Jeton' }], values: { token: 'xkeysib-1' }, requireApproval: true, createdById: null });
    const raw = await pool.query<{ secret_ciphertext: string }>('SELECT secret_ciphertext FROM session_secrets');
    expect(raw.rows[0].secret_ciphertext).not.toContain('xkeysib');
    await service.store({ sessionId: session, name: 'brevo', fields: [{ key: 'user', label: 'Utilisateur' }], values: { user: 'deploy' }, requireApproval: false, createdById: null });
    expect(await service.values(session, 'brevo')).toEqual({ token: 'xkeysib-1', user: 'deploy' });
    expect((await service.find(session, 'brevo'))?.fields.map((f) => f.key)).toEqual(['token', 'user']);
    await pool.query(`UPDATE session_secrets SET expires_at = now() - interval '1 minute'`);
    expect(await service.find(session, 'brevo')).toBeNull();
    expect(await service.values(session, 'brevo')).toEqual({});
    expect(await service.purgeExpired()).toBe(1);
    await service.store({ sessionId: session, name: 'autre', fields: [{ key: 'k', label: 'K' }], values: { k: 'v' }, requireApproval: true, createdById: null });
    expect(await service.clearSession(session)).toBe(1);
    expect(await service.list(session)).toEqual([]);
  });
});
