import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const pause = () => new Promise((r) => setTimeout(r, Math.random() * 20));
const root = await mkdtemp(path.join(os.tmpdir(), 'skills-'));

vi.mock('../config.js', () => ({ config: { workspacesRoot: root } }));
vi.mock('./repository.js', () => ({
  contextRepository: {
    // Lectures lentes et inégales, comme la base : les générations simultanées s'entrecroisent.
    listFolders: async () => (await pause(), [{ id: 'f1', parentId: null, slug: 'dev' }]),
    listInstructions: async () => (
      await pause(),
      Array.from({ length: 300 }, (_, i) => ({ folderId: 'f1', slug: `note-${i}`, name: `Note ${i}`, description: `Note ${i}`, content: `contenu ${i}`, version: 1 }))
    ),
  },
}));

const { materializeSkills } = await import('./skills.js');
const project = { id: 'p1', slug: 'demo', name: 'Démo' } as never;

afterAll(() => rm(root, { recursive: true, force: true }));

describe('materializeSkills', () => {
  it('supporte des générations simultanées du même dossier sans ENOTEMPTY ni restes', async () => {
    const dirs = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((r) => setTimeout(r, i * 3)).then(() => materializeSkills(project))));
    const dir = dirs[0];
    expect((await readdir(path.join(dir, 'skills'))).length).toBe(300);
    expect(await readFile(path.join(dir, 'skills', 'dev--note-3', 'SKILL.md'), 'utf8')).toContain('contenu 3');
    expect((await readdir(dir)).sort()).toEqual(['.claude-plugin', 'skills']);
  });
});
