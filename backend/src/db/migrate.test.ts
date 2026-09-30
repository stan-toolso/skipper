import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Test d'intégration : applique les migrations sur une base PostgreSQL jetable.
 *
 * TEST_DATABASE_URL désigne un serveur où le rôle peut créer des bases (ex. celui de
 * `npm run db:up`) ; le test y crée puis supprime une base `skipper_test_*` et ne touche à rien
 * d'autre. Sans cette variable, le test est ignoré en local et échoue en CI.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Crée une base vide et renvoie son URL. */
async function createDatabase(label: string): Promise<{ name: string; url: string }> {
  const name = `skipper_test_${label}_${process.pid}_${Date.now()}`;
  await withAdmin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

const dropDatabase = (name: string) => withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name}`));

/** Charge migrate.ts (et son pool) contre la base donnée : le pool lit DATABASE_URL à l'import. */
async function loadMigrate(url: string) {
  vi.resetModules();
  process.env.DATABASE_URL = url;
  const [{ runMigrations }, { pool }] = await Promise.all([import('./migrate.js'), import('./pool.js')]);
  return { runMigrations, pool };
}

describe.skipIf(!adminUrl)('runMigrations (PostgreSQL)', () => {
  let db: { name: string; url: string };
  let migrate: Awaited<ReturnType<typeof loadMigrate>>;
  let files: string[];

  beforeAll(async () => {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    db = await createDatabase('migrate');
    migrate = await loadMigrate(db.url);
  });

  afterAll(async () => {
    await migrate?.pool.end();
    if (db) await dropDatabase(db.name);
  });

  it('applique toutes les migrations dans l’ordre alphabétique sur une base vide', async () => {
    expect(files.length).toBeGreaterThan(0);
    await expect(migrate.runMigrations()).resolves.toEqual(files);
    const { rows } = await migrate.pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(files);
  });

  it('ne rejoue rien au second passage (idempotent)', async () => {
    await expect(migrate.runMigrations()).resolves.toEqual([]);
    await expect(migrate.runMigrations()).resolves.toEqual([]);
    const { rows } = await migrate.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBe(files.length);
  });

  it('laisse un schéma utilisable (tables principales présentes)', async () => {
    const { rows } = await migrate.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = rows.map((r) => r.table_name);
    for (const table of ['projects', 'sessions', 'session_events', 'requests', 'tasks', 'users', 'project_members', 'app_settings']) {
      expect(tables).toContain(table);
    }
  });
});

describe.skipIf(!adminUrl)('runMigrations : migration en échec (PostgreSQL)', () => {
  let db: { name: string; url: string };
  let migrate: Awaited<ReturnType<typeof loadMigrate>>;

  beforeAll(async () => {
    db = await createDatabase('broken');
    // Une migration de plus, en dernier, dont la seconde instruction échoue.
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readdir: (async (dir: string) => [...(await actual.readdir(dir)), 'zzz_broken.sql']) as typeof actual.readdir,
        readFile: (async (file: string, encoding: BufferEncoding) =>
          path.basename(file) === 'zzz_broken.sql'
            ? 'CREATE TABLE broken_partial (id int); SELECT * FROM table_inexistante;'
            : actual.readFile(file, encoding)) as typeof actual.readFile,
      };
    });
    migrate = await loadMigrate(db.url);
  });

  afterEach(() => {
    vi.doUnmock('node:fs/promises');
  });

  afterAll(async () => {
    await migrate?.pool.end();
    if (db) await dropDatabase(db.name);
  });

  it('annule la migration fautive, la signale, et garde les précédentes', async () => {
    await expect(migrate.runMigrations()).rejects.toThrow(/Migration zzz_broken\.sql échouée/);
    const { rows } = await migrate.pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const names = rows.map((r) => r.name);
    expect(names).not.toContain('zzz_broken.sql');
    expect(names.length).toBeGreaterThan(0);
    const partial = await migrate.pool.query("SELECT to_regclass('public.broken_partial') AS t");
    expect(partial.rows[0].t).toBeNull();
  });
});
