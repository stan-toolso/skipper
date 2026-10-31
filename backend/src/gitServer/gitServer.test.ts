import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// Serveur git hébergé avec un vrai git et un vrai serveur HTTP ; la base (projets, sauvegardes, jetons, rôles) est simulée.
const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'skipper-git-server-'));
const port = 40000 + Math.floor(Math.random() * 20000);
process.env.WORKSPACES_ROOT = path.join(root, 'workspaces');
process.env.API_URL = `http://127.0.0.1:${port}`;

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  backups: [] as { id: string; projectId: string; refs: string; head: string; bundle: Buffer; takenAt: Date }[],
  roles: new Map<string, 'viewer' | 'member' | 'admin'>(),
}));

vi.mock('../projects/repository.js', () => ({
  projectRepository: {
    findBySlug: async (slug: string) => state.projects.find((p) => p.slug === slug) ?? null,
    list: async () => state.projects,
  },
}));
vi.mock('./backups.js', () => {
  const view = (b: (typeof state.backups)[number]) => ({ id: b.id, projectId: b.projectId, takenAt: b.takenAt, size: b.bundle.length, refCount: b.refs.split('\n').filter(Boolean).length, head: b.head });
  const ofProject = (id: string) => state.backups.filter((b) => b.projectId === id).reverse();
  return {
    BACKUPS_KEPT: 3,
    gitBackupRepository: {
      list: async (id: string) => ofProject(id).map(view),
      latest: async (id: string) => {
        const b = ofProject(id)[0];
        return b ? { ...view(b), refs: b.refs } : null;
      },
      save: async (projectId: string, input: { refs: string; head: string; bundle: Buffer }) => {
        const b = { id: `b${state.backups.length + 1}`, projectId, takenAt: new Date(), ...input };
        state.backups.push(b);
        return view(b);
      },
      content: async (id: string) => state.backups.find((b) => b.id === id) ?? null,
    },
  };
});
vi.mock('./tokens.js', () => ({
  GIT_TOKEN_PREFIX: 'skgit_',
  gitTokenService: {
    authenticate: async (secret: string) => (secret.startsWith('skgit_') && secret.slice(6) ? { userId: secret.slice(6), token: {} } : null),
    purgeExpired: async () => 0,
    agentToken: async (userId: string) => `skgit_${userId}`,
  },
}));
vi.mock('../users/service.js', () => ({ userService: { get: async (id: string) => ({ id, email: `${id}@example.org` }) } }));
vi.mock('../auth/access.js', () => ({
  createAuthContext: (user: { id: string }) => ({ user }),
  roleFor: async (ctx: { user: { id: string } }) => state.roles.get(ctx.user.id) ?? null,
}));
vi.mock('../apiKeys/service.js', () => ({ apiKeyService: { authenticate: async () => null } }));
vi.mock('../auth/session.js', () => ({ SESSION_COOKIE: 'x', readCookie: () => null, authSession: { resolve: async () => null } }));
vi.mock('../worksessions/service.js', () => ({ worksessionService: { listByProject: async () => [] }, worksessionPath: () => '' }));

const { gitServer } = await import('./service.js');
const { handleGitHttpRoute } = await import('./httpRoute.js');
const { repoBrowser } = await import('./browse.js');
const { gitAuthFor, ensureWorkspace, workspacePath } = await import('../projects/workspace.js');
const { hostedGitUrl } = await import('./paths.js');

const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}
/** URL HTTP avec un jeton d'accès en mot de passe. */
const authUrl = (slug: string, user: string) => hostedGitUrl(slug).replace('http://', `http://x:skgit_${user}@`);

function makeProject(slug: string, over: Partial<Project> = {}): Project {
  const p: Project = { id: `id-${slug}`, name: slug, slug, description: null, systemPrompt: '', gitUrl: hostedGitUrl(slug), gitBranch: null, gitHosted: true, runnerConfig: {}, defaultPermissionMode: 'default', taskInstructions: '', personalOwnerId: null, createdAt: new Date(), updatedAt: new Date(), ...over };
  state.projects.push(p);
  return p;
}

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    void handleGitHttpRoute(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
});
afterAll(async () => {
  gitServer.stopBackgroundBackups();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

describe('dépôt hébergé', () => {
  it('crée le dépôt avec un premier commit et clone le dossier de travail sans passer par HTTP', async () => {
    const project = makeProject('alpha', { description: 'Un projet' });
    await gitServer.init(project, { initialCommit: true });
    const dir = await ensureWorkspace(project);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toContain('# alpha');
    expect(await git(['remote', 'get-url', 'origin'], dir)).toBe(hostedGitUrl('alpha'));
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).toBe('main');
    // Les commandes du serveur atteignent le dépôt nu par son chemin (insteadOf), sans jeton.
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    await git(['add', '.'], dir);
    await git(['commit', '-m', 'Ajout de a'], dir);
    await git([...(await gitAuthFor(project, null)), 'push', 'origin', 'main'], dir);
    expect(await git(['log', '-1', '--format=%s', 'main'], gitServer.path(project))).toBe('Ajout de a');
  });

  it('sert le smart HTTP : clone et push pour un membre, push refusé à un lecteur, rien sans jeton', async () => {
    state.roles.set('alice', 'member');
    state.roles.set('bob', 'viewer');
    const clone = path.join(root, 'clone-alice');
    await git(['clone', '-q', authUrl('alpha', 'alice'), clone]);
    expect(await readFile(path.join(clone, 'a.txt'), 'utf8')).toBe('a\n');
    await git(['checkout', '-q', '-b', 'feature'], clone);
    await writeFile(path.join(clone, 'b.txt'), 'b\n');
    await git(['add', '.'], clone);
    await git(['commit', '-q', '-m', 'Ajout de b'], clone);
    await git(['push', '-q', 'origin', 'feature'], clone);
    expect(await git(['log', '-1', '--format=%s', 'feature'], gitServer.path(state.projects[0]))).toBe('Ajout de b');

    const cloneBob = path.join(root, 'clone-bob');
    await git(['clone', '-q', authUrl('alpha', 'bob'), cloneBob]);
    await git(['commit', '-q', '--allow-empty', '-m', 'Interdit'], cloneBob);
    await expect(git(['push', '-q', 'origin', 'main'], cloneBob)).rejects.toThrow(/403/);

    await expect(git(['ls-remote', hostedGitUrl('alpha')])).rejects.toThrow();
    await expect(git(['ls-remote', authUrl('alpha', 'mallory')])).rejects.toThrow(/403/);
    await expect(git(['ls-remote', authUrl('inconnu', 'alice')])).rejects.toThrow(/404|not found/i);
  });

  it('sauvegarde en base quand les références changent, et restaure un dépôt disparu', async () => {
    const project = state.projects[0];
    const first = await gitServer.backup(project);
    expect(first?.refCount).toBe(2);
    // Même état : pas de nouvelle prise.
    expect((await gitServer.backup(project))?.id).toBe(first?.id);
    const refsBefore = await git(['for-each-ref', '--format=%(objectname) %(refname)'], gitServer.path(project));
    await rm(gitServer.path(project), { recursive: true, force: true });
    await gitServer.ensure(project);
    expect(await git(['for-each-ref', '--format=%(objectname) %(refname)'], gitServer.path(project))).toBe(refsBefore);
    expect(await git(['symbolic-ref', 'HEAD'], gitServer.path(project))).toBe('refs/heads/main');
    // Le dépôt restauré accepte toujours les pushes HTTP.
    const clone = path.join(root, 'clone-alice');
    await git(['commit', '-q', '--allow-empty', '-m', 'Après restauration'], clone);
    await git(['push', '-q', 'origin', 'feature'], clone);
  });

  it('se consulte : références, historique, arbre, fichier et détail de commit', async () => {
    const project = state.projects[0];
    const refs = await repoBrowser.refs(project);
    expect(refs.map((r) => [r.name, r.isDefault])).toEqual([
      ['main', true],
      ['feature', false],
    ]);
    const log = await repoBrowser.log(project, 'feature', 10);
    expect(log.map((c) => c.subject)).toEqual(['Après restauration', 'Ajout de b', 'Ajout de a', 'Premier commit']);
    expect((await repoBrowser.log(project, 'feature', 10, 0, 'b.txt')).map((c) => c.subject)).toEqual(['Ajout de b']);
    expect((await repoBrowser.tree(project, 'feature')).map((e) => e.name)).toEqual(['a.txt', 'b.txt', 'README.md']);
    expect((await repoBrowser.file(project, 'feature', 'b.txt')).content).toBe('b\n');
    const detail = await repoBrowser.commit(project, log[1].hash);
    expect(detail.files).toEqual([{ path: 'b.txt', origPath: null, status: 'A', additions: 1, deletions: 0 }]);
    expect(detail.diff).toContain('+b');
    await expect(repoBrowser.tree(project, '--upload-pack=x')).rejects.toThrow(/invalide/);
    await expect(repoBrowser.file(project, 'main', '../secret')).rejects.toThrow(/invalide/);
  });

  it('héberge un projet qui n’avait qu’un simple dossier : son contenu devient le premier commit', async () => {
    const before = makeProject('beta', { gitHosted: false, gitUrl: null, gitBranch: 'trunk' });
    const dir = workspacePath(before);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'notes.md'), 'notes\n');
    await gitServer.enable(before);
    const hosted = { ...before, gitHosted: true, gitUrl: hostedGitUrl('beta') };
    expect(await git(['log', '-1', '--format=%s', 'trunk'], gitServer.path(hosted))).toBe('Import du dossier existant');
    expect(await git(['rev-parse', '--abbrev-ref', '@{u}'], dir)).toBe('origin/trunk');
    expect(state.backups.some((b) => b.projectId === before.id)).toBe(true);
    await expect(gitServer.enable({ ...before, slug: 'gamma', gitUrl: 'https://github.com/x/y.git' })).rejects.toThrow(/distant/);
  });
});
