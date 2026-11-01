import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { VaultItem } from '../vault/types.js';
import type { Worksession } from '../worksessions/types.js';
import type { EnvFile } from './types.js';

// Pas de base : dépôt des fichiers, coffre et chemins des work sessions simulés ; l'écriture se fait pour de vrai
// dans un dossier temporaire.
const h = vi.hoisted(() => ({ files: [] as EnvFile[], items: [] as unknown[], audits: [] as string[], dir: '' }));
vi.mock('./repository.js', () => ({
  envFileRepository: {
    listByProject: async () => h.files,
    findByPath: async (_p: string, p: string) => h.files.find((f) => f.path === p) ?? null,
  },
}));
vi.mock('../vault/service.js', () => ({
  vaultService: {
    agentItems: async () => h.items,
    secretsOf: (i: VaultItem) => (i.name === 'rds' ? { password: 's3cret #1' } : {}),
    audit: async (i: VaultItem, action: string, _a: unknown, detail: string) => void h.audits.push(`${i.name} ${action} ${detail}`),
  },
}));
vi.mock('../worksessions/service.js', () => ({ worksessionHooks: { onCreated: [] }, worksessionPath: () => h.dir }));
vi.mock('../projects/workspace.js', () => ({ git: async () => { throw new Error('pas de git'); } }));

const { envFileService } = await import('./service.js');

const project = { id: 'p', slug: 'p', gitUrl: null } as unknown as Project;
const ws = { id: 'w', name: 'ma-branche' } as Worksession;
const file = (p: string, content: string, applyOnCreate = true): EnvFile => ({ id: p, projectId: 'p', path: p, content, applyOnCreate, updatedById: null, updatedBySessionId: null, createdAt: new Date(), updatedAt: new Date() });
const pg = (over: Partial<VaultItem> = {}) =>
  ({ id: 'i1', name: 'rds', kind: 'postgres', envExport: true, settings: { host: 'db', port: 5432, username: 'app', database: 'app', ssl: false, sslCa: null, viaItemId: null }, ...over }) as VaultItem;

beforeEach(async () => {
  h.dir = await mkdtemp(path.join(os.tmpdir(), 'env-'));
  h.files = [];
  h.items = [pg(), pg({ id: 'i2', name: 'prod', envExport: false })];
  h.audits = [];
});
afterEach(() => rm(h.dir, { recursive: true, force: true }));

describe('écriture des fichiers d’environnement', () => {
  it('rend les références du coffre, journalise, droits 0600', async () => {
    h.files = [file('backend/.env', 'PASSWORD={{vault:rds.password}}\nURL={{vault:rds.url}}\nX={{vault:prod.password}}\n')];
    const r = await envFileService.apply(project, ws, 'u', { overwrite: false, onCreate: true });
    expect(r.written).toEqual(['backend/.env']);
    expect(await readFile(path.join(h.dir, 'backend/.env'), 'utf8')).toBe('PASSWORD="s3cret #1"\nURL=postgresql://app:s3cret%20%231@db:5432/app\nX=\n');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/prod.*pas utilisable/);
    expect(h.audits).toEqual(['rds env_export backend/.env → ma-branche']);
    expect((await stat(path.join(h.dir, 'backend/.env'))).mode & 0o777).toBe(0o600);
  });

  it('à la création, ne remplace pas un fichier présent ni ceux non marqués', async () => {
    h.files = [file('.env', 'A=1\n'), file('other.env', 'B=2\n', false)];
    await writeFile(path.join(h.dir, '.env'), 'déjà là\n');
    const r = await envFileService.apply(project, ws, 'u', { overwrite: false, onCreate: true });
    expect(r.written).toEqual([]);
    expect(r.skipped[0]).toMatch(/déjà présent/);
    expect(await readFile(path.join(h.dir, '.env'), 'utf8')).toBe('déjà là\n');
    expect(await lstat(path.join(h.dir, 'other.env')).catch(() => null)).toBeNull();
  });

  it('ne suit jamais un lien symbolique', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'env-out-'));
    await symlink(path.join(outside, 'cible'), path.join(h.dir, '.env'));
    await symlink(outside, path.join(h.dir, 'lien'));
    h.files = [file('.env', 'A=1\n'), file('lien/.env', 'A=1\n')];
    const r = await envFileService.apply(project, ws, 'u', { overwrite: true });
    expect(r.written).toEqual([]);
    expect(r.skipped).toHaveLength(2);
    expect(await lstat(path.join(outside, 'cible')).catch(() => null)).toBeNull();
    expect(await lstat(path.join(outside, '.env')).catch(() => null)).toBeNull();
    await rm(outside, { recursive: true, force: true });
  });

  it('met à jour une seule clé dans le fichier déjà écrit', async () => {
    await mkdir(h.dir, { recursive: true });
    await writeFile(path.join(h.dir, '.env'), 'A=local\nB=2\n');
    const f = file('.env', 'A=1\nB=2\nC={{vault:rds.host}}\n');
    await envFileService.applyKey(project, ws, 'u', f, 'C', 's');
    expect(await readFile(path.join(h.dir, '.env'), 'utf8')).toBe('A=local\nB=2\nC=db\n');
    await envFileService.applyKey(project, ws, 'u', file('.env', 'A=1\n'), 'B', 's');
    expect(await readFile(path.join(h.dir, '.env'), 'utf8')).toBe('A=local\nC=db\n');
  });

  it('signale les références non résolues sans rien déchiffrer', async () => {
    const problems = await envFileService.problems({ content: '{{vault:rds.nope}} {{vault:absent.x}} {{vault:rds.url}}' }, 'p', 'u');
    expect(problems).toHaveLength(2);
  });
});
