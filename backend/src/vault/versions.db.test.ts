import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Historique des versions du coffre sur une base PostgreSQL jetable (TEST_DATABASE_URL) : une version par
 * modification, différences sans valeur secrète, restauration (secrets compris) qui crée une nouvelle version.
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

describe.skipIf(!adminUrl)('versions du coffre (PostgreSQL)', () => {
  const name = `skipper_test_vault_versions_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let vault: typeof import('./service.js').vaultService;
  let user: string;
  const previousKey = process.env.SKIPPER_SECRET_KEY;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    vi.resetModules();
    process.env.DATABASE_URL = u.toString();
    process.env.SKIPPER_SECRET_KEY = 'cd'.repeat(32);
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations();
    pool = (await import('../db/pool.js')).pool;
    vault = (await import('./service.js')).vaultService;
    user = (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('stan@example.org', 'Stan') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.SKIPPER_SECRET_KEY;
    else process.env.SKIPPER_SECRET_KEY = previousKey;
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('historise chaque modification et restaure une version, secrets compris', async () => {
    const actor = { userId: user };
    const item = await vault.create(actor, null, {
      kind: 'secret',
      name: 'brevo',
      fields: [
        { key: 'user', label: 'Utilisateur', secret: false, value: 'a' },
        { key: 'token', label: 'Jeton', secret: true, value: 'xkeysib-1' },
      ],
    });
    await vault.update({ userId: user, sessionId: '00000000-0000-0000-0000-000000000001' }, item.id, {
      description: 'Brevo',
      fields: [
        { key: 'user', label: 'Utilisateur', secret: false, value: 'b' },
        { key: 'token', label: 'Jeton', secret: true, value: 'xkeysib-2' },
      ],
    });
    // Aucune différence : pas de nouvelle version.
    await vault.update(actor, item.id, { commandAllowlist: [] });
    let versions = await vault.versions(user, item.id);
    expect(versions.map((v) => [v.version, v.action])).toEqual([
      [2, 'secret_changed'],
      [1, 'created'],
    ]);
    expect(versions[0].sessionId).toBe('00000000-0000-0000-0000-000000000001');
    expect(versions[0].changes.map((c) => c.field)).toEqual(['description', 'fields.user', 'fields.token']);
    const raw = JSON.stringify((await pool.query('SELECT * FROM vault_item_versions')).rows);
    expect(raw).not.toContain('xkeysib');

    const restored = await vault.restoreVersion(actor, item.id, 1);
    expect(restored.description).toBe('');
    expect(vault.fieldCredentials(restored).fields.find((f) => f.key === 'token')?.value).toBe('xkeysib-1');
    versions = await vault.versions(user, item.id);
    expect(versions[0]).toMatchObject({ version: 3, action: 'restored', restoredFrom: 1 });
    await expect(vault.restoreVersion(actor, item.id, 3)).rejects.toThrow(/actuelle/);
    const audit = await vault.auditLog(item.id);
    expect(audit[0]).toMatchObject({ action: 'restored' });
  });
});
