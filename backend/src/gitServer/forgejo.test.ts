import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

/**
 * Dépôts hébergés dans Forgejo. Les fonctions pures sont toujours testées ; le reste tourne contre un vrai Forgejo jetable
 * (SQLite, port aléatoire), démarré par le test quand FORGEJO_TEST_BIN donne le binaire (absent en CI : ignoré) :
 *   FORGEJO_TEST_BIN=/chemin/forgejo npx vitest run src/gitServer/forgejo.test.ts
 * La base de Skipper (projets, membres, comptes, sauvegardes) est simulée.
 */
const execFileAsync = promisify(execFile);
const BIN = process.env.FORGEJO_TEST_BIN ?? '';
const root = await mkdtemp(path.join(os.tmpdir(), 'skipper-forgejo-'));
const port = 41000 + Math.floor(Math.random() * 15000);
const forgeUrl = `http://127.0.0.1:${port}`;
const ini = path.join(root, 'forgejo', 'app.ini');
const cli = `${BIN} --config ${ini} --work-path ${path.join(root, 'forgejo')}`;
const SECRET = 'secret-de-test';
process.env.WORKSPACES_ROOT = path.join(root, 'workspaces');
process.env.FORGEJO_URL = forgeUrl;
process.env.FORGEJO_INTERNAL_URL = forgeUrl;
process.env.FORGEJO_CLI = cli;
process.env.FORGEJO_WEBHOOK_SECRET = SECRET;
process.env.FORGEJO_TOKEN = BIN ? 'remplacé-au-démarrage' : '';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  users: new Map<string, { id: string; email: string; name: string }>(),
  members: new Map<string, Array<{ userId: string; role: 'viewer' | 'member' | 'admin' }>>(),
  accounts: new Map<string, { username: string; token: string | null }>(),
  backups: [] as { id: string; projectId: string; refs: string; head: string; bundle: Buffer; takenAt: Date }[],
  sessionUser: null as null | { id: string; email: string; name: string },
}));

vi.mock('./accounts.js', () => ({
  forgeAccountRepository: {
    usernameOf: async (id: string) => state.accounts.get(id)?.username ?? null,
    userIdOf: async (name: string) => [...state.accounts].find(([, a]) => a.username === name)?.[0] ?? null,
    link: async (id: string, username: string) => {
      if (!state.accounts.has(id)) state.accounts.set(id, { username, token: null });
      return state.accounts.get(id)!.username;
    },
    agentToken: async (id: string) => state.accounts.get(id)?.token ?? null,
    setAgentToken: async (id: string, c: string) => void (state.accounts.get(id)!.token = c),
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
        const b = { id: `00000000-0000-4000-8000-00000000000${state.backups.length + 1}`, projectId, takenAt: new Date(), ...input };
        state.backups.push(b);
        return view(b);
      },
      content: async (id: string) => state.backups.find((b) => b.id === id) ?? null,
    },
  };
});
vi.mock('../projects/repository.js', () => ({
  projectRepository: {
    findBySlug: async (slug: string) => state.projects.find((p) => p.slug === slug) ?? null,
    findById: async (id: string) => state.projects.find((p) => p.id === id) ?? null,
    list: async () => state.projects,
  },
}));
vi.mock('../users/service.js', () => ({
  userService: {
    get: async (id: string) => state.users.get(id),
    members: async (projectId: string) => state.members.get(projectId) ?? [],
  },
}));
vi.mock('../worksessions/service.js', () => ({ worksessionService: { listByProject: async () => [] }, worksessionPath: () => '' }));
vi.mock('../auth/session.js', () => ({ SESSION_COOKIE: 's', readCookie: () => 'x', authSession: { resolve: async () => state.sessionUser } }));
vi.mock('../auth/access.js', () => ({ createAuthContext: (u: unknown) => ({ user: u }), roleFor: async () => 'member' }));

const { forgeUsernameFromEmail, reviewDecisionOf, toPullRequest, forgejoAccounts, forgejoApi, forgejoPulls } = await import('./forgejo.js');
const { isMachineRequest, validWebhookSignature, handleGitHttpRoute } = await import('./httpRoute.js');
const { gitServer } = await import('./service.js');
const { ensureWorkspace } = await import('../projects/workspace.js');
const { hostedGitUrl, bareRepoPath } = await import('./paths.js');
const { config } = await import('../config.js');

describe('fonctions pures', () => {
  it('dérive un nom de compte Forgejo de l’adresse e-mail', () => {
    expect(forgeUsernameFromEmail('Stan.Toolso@toolso.io')).toBe('stan.toolso');
    expect(forgeUsernameFromEmail('élise+test@x.fr')).toBe('elise-test');
    expect(forgeUsernameFromEmail('admin@x.fr')).toBe('admin-1');
    expect(forgeUsernameFromEmail('___@x.fr')).toBe('membre');
  });

  it('calcule la décision de revue à partir de la dernière revue de chacun', () => {
    const r = (login: string, state: string) => ({ user: { login }, state });
    expect(reviewDecisionOf([])).toBeNull();
    expect(reviewDecisionOf([r('a', 'APPROVED')])).toBe('APPROVED');
    expect(reviewDecisionOf([r('a', 'REQUEST_CHANGES'), r('b', 'APPROVED')])).toBe('CHANGES_REQUESTED');
    expect(reviewDecisionOf([r('a', 'REQUEST_CHANGES'), r('a', 'APPROVED')])).toBe('APPROVED');
    expect(reviewDecisionOf([r('a', 'COMMENT')])).toBeNull();
  });

  it('convertit une PR Forgejo au format de Skipper', () => {
    const base = { number: 3, title: 'WIP: essai', body: null, html_url: 'u', state: 'open' as const, merged: false, merged_at: null, closed_at: null, created_at: '2026-10-31T10:00:00Z', updated_at: '2026-10-31T10:00:00Z', mergeable: false, merge_commit_sha: null, user: { login: 'alice', avatar_url: 'a' }, head: { ref: 'f', sha: 's', repo_id: 1 }, base: { ref: 'main', repo_id: 1 } };
    const pr = toPullRequest('p', { owner: 'skipper', name: 'x' }, base, { status: { state: 'failure', statuses: [{ context: 'ci', status: 'failure', target_url: null }] } });
    expect(pr).toMatchObject({ repo: 'skipper/x', state: 'OPEN', isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DRAFT', checksState: 'FAILURE', author: 'alice', isCrossRepository: false });
    expect(toPullRequest('p', { owner: 'skipper', name: 'x' }, { ...base, state: 'closed', merged: true, title: 'ok' }).state).toBe('MERGED');
  });

  it('reconnaît git et l’API, pas une page web', () => {
    expect(isMachineRequest('/forge/skipper/x.git/info/refs?service=git-upload-pack', {})).toBe(true);
    expect(isMachineRequest('/forge/api/v1/repos', {})).toBe(true);
    expect(isMachineRequest('/forge/skipper/x', { 'user-agent': 'git/2.43' })).toBe(true);
    expect(isMachineRequest('/forge/skipper/x', { authorization: 'Basic x' })).toBe(true);
    expect(isMachineRequest('/forge/skipper/x/pulls', { 'user-agent': 'Mozilla/5.0' })).toBe(false);
  });

  it('vérifie la signature des webhooks', () => {
    const body = Buffer.from('{"a":1}');
    const sig = createHmac('sha256', 'k').update(body).digest('hex');
    expect(validWebhookSignature(body, sig, 'k')).toBe(true);
    expect(validWebhookSignature(body, sig, 'autre')).toBe(false);
    expect(validWebhookSignature(body, undefined, 'k')).toBe(false);
    expect(validWebhookSignature(body, sig, '')).toBe(false);
  });
});

const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}
const withToken = (slug: string, token: string) => hostedGitUrl(slug).replace('http://', `http://x:${token}@`);

function addProject(slug: string, over: Partial<Project> = {}): Project {
  const p: Project = { id: `id-${slug}`, name: slug, slug, description: null, systemPrompt: '', gitUrl: hostedGitUrl(slug), gitBranch: null, gitHosted: true, runnerConfig: {}, defaultPermissionMode: 'default', taskInstructions: '', personalOwnerId: null, createdAt: new Date(), updatedAt: new Date(), ...over };
  state.projects.push(p);
  return p;
}
function addUser(id: string, email: string) {
  const u = { id, email, name: id };
  state.users.set(id, u);
  return u;
}

describe.skipIf(!BIN)('Forgejo réel', () => {
  let server: ChildProcess;
  beforeAll(async () => {
    await mkdir(path.dirname(ini), { recursive: true });
    await writeFile(
      ini,
      [
        'WORK_PATH = ' + path.join(root, 'forgejo'),
        '[server]', 'HTTP_ADDR = 127.0.0.1', `HTTP_PORT = ${port}`, `ROOT_URL = ${forgeUrl}/`, 'DISABLE_SSH = true', 'OFFLINE_MODE = true',
        '[database]', 'DB_TYPE = sqlite3', `PATH = ${path.join(root, 'forgejo', 'forgejo.db')}`,
        '[repository]', `ROOT = ${path.join(root, 'forgejo', 'repos')}`, 'DEFAULT_BRANCH = main',
        '[security]', 'INSTALL_LOCK = true',
        '[service]', 'DISABLE_REGISTRATION = true',
        '[webhook]', 'ALLOWED_HOST_LIST = loopback',
        '[log]', 'LEVEL = Error',
      ].join('\n'),
    );
    const run = (args: string[]) => execFileAsync(BIN, ['--config', ini, '--work-path', path.join(root, 'forgejo'), ...args]);
    await run(['migrate']);
    await run(['admin', 'user', 'create', '--admin', '--username', 'skipper-admin', '--email', 'admin@skipper.local', '--random-password', '--must-change-password=false']);
    config.forgejo.token = (await run(['admin', 'user', 'generate-access-token', '--username', 'skipper-admin', '--token-name', 't', '--scopes', 'all', '--raw'])).stdout.trim();
    server = spawn(BIN, ['--config', ini, '--work-path', path.join(root, 'forgejo'), 'web'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${forgeUrl}/api/v1/version`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 60_000);
  afterAll(async () => {
    gitServer.stopBackgroundBackups();
    server?.kill();
    await rm(root, { recursive: true, force: true });
  });

  it('crée le dépôt avec un premier commit, et le serveur le clone avec le jeton administrateur', async () => {
    const project = addProject('alpha');
    await gitServer.ensure(project);
    const dir = await ensureWorkspace(project);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toContain('alpha');
    expect(await git(['remote', 'get-url', 'origin'], dir)).toBe(hostedGitUrl('alpha'));
  });

  it('donne aux membres les droits de leur rôle : un membre pousse, un lecteur non', async () => {
    const project = state.projects[0];
    addUser('u-alice', 'alice@example.org');
    addUser('u-bob', 'bob@example.org');
    state.members.set(project.id, [
      { userId: 'u-alice', role: 'member' },
      { userId: 'u-bob', role: 'viewer' },
    ]);
    await gitServer.syncMembers(project);
    const alice = await forgejoAccounts.agentToken(state.users.get('u-alice')!);
    const bob = await forgejoAccounts.agentToken(state.users.get('u-bob')!);
    expect(alice).toMatch(/^[0-9a-f]{40}$/);
    // Le jeton est gardé : le second appel le redonne sans en créer un autre.
    expect(await forgejoAccounts.agentToken(state.users.get('u-alice')!)).toBe(alice);
    const clone = path.join(root, 'alice');
    await git(['clone', '-q', withToken('alpha', alice), clone]);
    await git(['checkout', '-q', '-b', 'feature'], clone);
    await writeFile(path.join(clone, 'f.txt'), 'f\n');
    await git(['add', '.'], clone);
    await git(['commit', '-q', '-m', 'Ajout de f'], clone);
    await git(['push', '-q', 'origin', 'feature'], clone);
    const cloneBob = path.join(root, 'bob');
    await git(['clone', '-q', withToken('alpha', bob), cloneBob]);
    await git(['commit', '-q', '--allow-empty', '-m', 'refusé'], cloneBob);
    await expect(git(['push', '-q', 'origin', 'HEAD:refs/heads/bob'], cloneBob)).rejects.toThrow();
    // Bob retiré du projet : il n'est plus collaborateur.
    state.members.set(project.id, [{ userId: 'u-alice', role: 'member' }]);
    await gitServer.syncMembers(project);
    const collaborators = await forgejoApi<Array<{ login: string }>>('GET', '/repos/skipper/alpha/collaborators');
    expect(collaborators.map((c) => c.login)).toEqual(['alice']);
  });

  it('ouvre, lit et fusionne une pull request au nom de la personne', async () => {
    const repo = { owner: 'skipper', name: 'alpha' };
    const number = await forgejoPulls.create(repo, { title: 'Ajout de f', head: 'feature', base: 'main', body: 'corps', draft: false }, 'alice');
    const pr = await forgejoPulls.get('id-alpha', repo, number);
    expect(pr).toMatchObject({ number, state: 'OPEN', author: 'alice', headRefName: 'feature', baseRefName: 'main', mergeable: 'MERGEABLE', isDraft: false });
    expect(pr.url).toBe(`${forgeUrl}/skipper/alpha/pulls/${number}`);
    await expect(forgejoPulls.create(repo, { title: 'doublon', head: 'feature', base: 'main', body: '', draft: false }, 'alice')).rejects.toThrow(/déjà ouverte/);
    expect((await forgejoPulls.list('id-alpha', repo, 'OPEN', 10)).map((p) => p.number)).toEqual([number]);
    const sha = await forgejoPulls.merge(repo, number, 'MERGE', 'alice');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await forgejoPulls.get('id-alpha', repo, number)).state).toBe('MERGED');
    expect((await forgejoPulls.list('id-alpha', repo, 'MERGED', 10)).map((p) => p.number)).toEqual([number]);
    await forgejoPulls.deleteBranch(repo, 'feature');
    await forgejoPulls.deleteBranch(repo, 'feature');
  });

  it('sauvegarde en base, puis recrée un dépôt supprimé de Forgejo depuis le miroir, puis depuis la sauvegarde', async () => {
    const project = state.projects[0];
    const first = await gitServer.backup(project);
    expect(first?.refCount).toBeGreaterThanOrEqual(1);
    expect((await gitServer.backup(project))?.id).toBe(first?.id);
    const before = await git(['ls-remote', '--heads', withToken('alpha', config.forgejo.token)]);
    await forgejoApi('DELETE', '/repos/skipper/alpha');
    await gitServer.ensure(project);
    expect(await git(['ls-remote', '--heads', withToken('alpha', config.forgejo.token)])).toBe(before);
    await forgejoApi('DELETE', '/repos/skipper/alpha');
    await rm(bareRepoPath('alpha'), { recursive: true, force: true });
    await gitServer.ensure(project);
    expect(await git(['ls-remote', '--heads', withToken('alpha', config.forgejo.token)])).toBe(before);
    // Les collaborateurs sont remis.
    expect((await forgejoApi<Array<{ login: string }>>('GET', '/repos/skipper/alpha/collaborators')).map((c) => c.login)).toEqual(['alice']);
  });

  it('reprend un ancien dépôt nu du serveur git minimal', async () => {
    const legacy = bareRepoPath('ancien');
    const work = path.join(root, 'ancien-src');
    await mkdir(work, { recursive: true });
    await git(['init', '-q', '--initial-branch=main'], work);
    await writeFile(path.join(work, 'a.txt'), 'a\n');
    await git(['add', '.'], work);
    await git(['commit', '-q', '-m', 'Avant Forgejo'], work);
    await git(['clone', '-q', '--bare', work, legacy]);
    const project = addProject('ancien');
    await gitServer.ensure(project);
    expect(await git(['log', '-1', '--format=%s', 'main'], legacy)).toBe('Avant Forgejo');
    expect(await git(['ls-remote', withToken('ancien', config.forgejo.token), 'refs/heads/main'])).toContain(await git(['rev-parse', 'main'], legacy));
  });

  it('héberge un projet qui n’avait qu’un simple dossier', async () => {
    const before = addProject('beta', { gitHosted: false, gitUrl: null, gitBranch: 'trunk' });
    const dir = path.join(config.workspacesRoot, 'beta');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'notes.md'), 'notes\n');
    await gitServer.enable(before);
    expect(await git(['rev-parse', '--abbrev-ref', '@{u}'], dir)).toBe('origin/trunk');
    expect((await forgejoApi<{ default_branch: string }>('GET', '/repos/skipper/beta')).default_branch).toBe('trunk');
    await expect(gitServer.enable(before)).rejects.toThrow(/existe déjà/);
  });

  it('traduit la session Skipper en compte Forgejo pour nginx, et laisse passer git sans session', async () => {
    const call = async (headers: Record<string, string>) => {
      const res = { status: 0, headers: {} as Record<string, string>, writeHead(s: number, h: Record<string, string>) { this.status = s; this.headers = h; return this; }, end() { return this; } };
      await handleGitHttpRoute({ url: '/api/forge/auth', method: 'GET', headers } as never, res as never);
      return res;
    };
    state.sessionUser = state.users.get('u-alice')!;
    expect((await call({ 'x-original-uri': '/forge/skipper/alpha' })).headers['X-Forge-User']).toBe('alice');
    state.sessionUser = null;
    expect((await call({ 'x-original-uri': '/forge/skipper/alpha/pulls' })).status).toBe(401);
    const machine = await call({ 'x-original-uri': '/forge/skipper/alpha.git/info/refs' });
    expect([machine.status, machine.headers['X-Forge-User']]).toEqual([200, undefined]);
  });
});
