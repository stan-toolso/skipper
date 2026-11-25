import { execFileSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Worksession } from './types.js';

// Pas de base : enregistrements simulés ; git tourne pour de vrai dans un dossier temporaire (WORKSPACES_ROOT).
const root = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skipper-purge-')));
  process.env.WORKSPACES_ROOT = dir;
  return dir;
});
const m = vi.hoisted(() => ({ records: [] as Worksession[], busy: new Set<string>() }));
vi.mock('./repository.js', () => ({
  worksessionRepository: {
    listByProject: async () => m.records.filter((w) => w.archivedAt),
    findById: async (id: string) => m.records.find((w) => w.id === id) ?? null,
    countBusy: async (id: string) => ({ sessions: m.busy.has(id) ? 1 : 0, terminals: 0 }),
  },
}));
vi.mock('../envFiles/repository.js', () => ({ envFileRepository: { listByProject: async () => [{ path: 'front/.env.local' }] } }));
vi.mock('../projects/repository.js', () => ({ projectRepository: { list: async () => [] } }));
// Modules lourds de disk.ts (terminaux, aperçus) : hors sujet ici.
vi.mock('../projects/cleanup.js', () => ({ removeWorksessionKeepingSessions: async () => ({ archivedSessionIds: [] }) }));
vi.mock('../previews/service.js', () => ({ previewService: {}, previewStateDir: () => '/nonexistent' }));
vi.mock('../settings/github.js', () => ({ githubService: { gitConfigArgs: async () => [] } }));

const { assessPurge, precious, purgeArchivedWorksessions } = await import('./housekeeping.js');
const { removeNodeModules } = await import('../previews/deps.js');

const origin = path.join(root, 'origin.git');
const main = path.join(root, 'p');
const wsRoot = path.join(root, 'p.worktrees');
const project = { id: 'p', slug: 'p', gitUrl: 'x', gitBranch: 'main' } as never;
const old = new Date(Date.now() - 10 * 86_400_000);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const configure = (cwd: string) => {
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
};
async function commit(cwd: string, file: string, message: string) {
  await writeFile(path.join(cwd, file), message);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}
function addWorksession(name: string, archivedAt: Date | null = old): string {
  const dir = path.join(wsRoot, name);
  git(main, 'worktree', 'add', '-q', '-b', name, dir, 'origin/main');
  configure(dir);
  m.records.push({ id: name, projectId: 'p', name, branch: name, label: null, taskId: null, archivedAt, createdAt: old });
  return dir;
}
const present = (p: string) => stat(p).then(() => true, () => false);
const branches = () => git(main, 'branch', '--format=%(refname:short)').split('\n');

beforeAll(async () => {
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, main);
  configure(main);
  await writeFile(path.join(main, '.gitignore'), 'node_modules\n.env*\nnotes/\n');
  git(main, 'add', '.gitignore');
  git(main, 'commit', '-q', '-m', 'départ');
  git(main, 'push', '-q', '-u', 'origin', 'main');
});

describe('retrait des dossiers archivés', () => {
  it('retire les dossiers sans rien d’unique, garde les autres', async () => {
    const vierge = addWorksession('vierge');
    await mkdir(path.join(vierge, 'node_modules', 'x'), { recursive: true });
    await mkdir(path.join(vierge, 'front'), { recursive: true });
    await writeFile(path.join(vierge, 'front', '.env.local'), 'A=1');
    const pousse = addWorksession('poussee');
    await commit(pousse, 'p.txt', 'travail poussé');
    git(pousse, 'push', '-q', 'origin', 'poussee');
    const local = addWorksession('commit-local');
    await commit(local, 'l.txt', 'travail local');
    const modifie = addWorksession('modifie');
    await writeFile(path.join(modifie, 'brouillon.txt'), 'pas commité');
    const notes = addWorksession('notes-ignorees');
    await mkdir(path.join(notes, 'notes'));
    await writeFile(path.join(notes, 'notes', 'analyse.md'), 'précieux');
    const recent = addWorksession('recente', new Date());
    const occupee = addWorksession('occupee');
    m.busy.add('occupee');

    const result = await purgeArchivedWorksessions(project);
    expect(result.removed.sort()).toEqual(['poussee', 'vierge']);
    expect(Object.fromEntries(result.kept.map((k) => [k.name, k.reason]))).toEqual({
      'commit-local': 'Commits propres, branche absente d’origin',
      modifie: '1 fichier(s) modifié(s) ou non suivi(s)',
      'notes-ignorees': 'Fichiers ignorés à garder : notes/analyse.md',
    });
    for (const d of [vierge, pousse]) expect(await present(d)).toBe(false);
    for (const d of [local, modifie, notes, recent, occupee]) expect(await present(d)).toBe(true);
    // Branche vide supprimée ; branche aux commits poussés conservée (la restauration repart d'elle).
    expect(branches()).not.toContain('vierge');
    expect(branches()).toContain('poussee');
    expect(git(main, 'worktree', 'list')).not.toContain('vierge');
  });
});

describe('règles', () => {
  it('ne garde que les fichiers ignorés qui ne se régénèrent pas', () => {
    expect(precious(['node_modules/', 'front/node_modules/', 'back/var/', 'stripe.env', 'front/.env.local', 'front/.env', 'backend/dist/', 'tsconfig.tsbuildinfo', '.probe/'], ['stripe.env', 'front/.env.local'])).toEqual(['front/.env', '.probe/']);
  });
  it('refuse un état illisible, des modifications ou des commits absents d’origin', () => {
    const ok = { changes: 0, aheadCount: 0, unpushedCount: null, precious: [] };
    expect(assessPurge(ok)).toBeNull();
    expect(assessPurge({ ...ok, aheadCount: 2, unpushedCount: 0 })).toBeNull();
    expect(assessPurge({ ...ok, changes: null })).toBe('État git illisible');
    expect(assessPurge({ ...ok, aheadCount: 2, unpushedCount: 1 })).toBe('1 commit(s) absent(s) d’origin');
  });
});

describe('allègement à l’archivage', () => {
  it('retire les node_modules du dossier, rien d’autre', async () => {
    const dir = path.join(root, 'leger');
    await mkdir(path.join(dir, 'node_modules', 'a'), { recursive: true });
    await mkdir(path.join(dir, 'front', 'node_modules'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{}');
    await writeFile(path.join(dir, 'front', 'package.json'), '{}');
    expect((await removeNodeModules(dir)).sort()).toEqual(['front/node_modules', 'node_modules']);
    expect(await present(path.join(dir, 'node_modules'))).toBe(false);
    expect(await present(path.join(dir, 'front', 'package.json'))).toBe(true);
  });
});
