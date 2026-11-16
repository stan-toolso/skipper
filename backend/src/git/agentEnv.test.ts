import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerAccounts } from '../agents/types.js';

// Jetons simulés : chaque compte GitHub / GitLab renvoie l'identifiant de la personne dont il est le compte.
const m = vi.hoisted(() => ({ gitlabHosts: {} as Record<string, string[]> }));
vi.mock('../settings/github.js', () => ({
  githubService: { gitAuth: async (userId: string | null) => (userId ? { token: `gh-${userId}`, name: `GH ${userId}`, email: `${userId}@github` } : null) },
}));
vi.mock('../settings/gitlab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/gitlab.js')>()),
  gitlabService: {
    gitAuth: async (userId: string | null) => (userId ? { token: `gl-${userId}`, host: 'gitlab.com', name: `GL ${userId}`, email: `${userId}@gitlab` } : null),
    hosts: async (userId: string | null) => (userId ? (m.gitlabHosts[userId] ?? []) : []),
  },
}));
vi.mock('../runners/index.js', () => ({}));
vi.mock('../users/service.js', () => ({ userService: { get: async (id: string) => ({ id, email: `${id}@x`, name: id }) } }));
vi.mock('../gitServer/forgejo.js', () => ({ forgejoAccounts: { agentToken: async (u: { id: string }) => `forge-${u.id}` } }));

const { agentGitEnv, gitAccountFor } = await import('./agentEnv.js');

const agentAccounts = (over: Partial<OwnerAccounts> = {}): OwnerAccounts => ({ claudeUserId: 'a1', githubUserId: 'a1', githubReadOnly: false, githubPullRequests: true, githubMerge: false, gitlabUserId: 'a1', gitlabReadOnly: false, gitlabPullRequests: true, gitlabMerge: false, forgeUserId: 'a1', ...over });
const pushUrl = (env: Record<string, string>) => Object.keys(env).find((k) => k.startsWith('GIT_CONFIG_KEY_') && env[k] === 'remote.origin.pushurl');

beforeEach(() => {
  m.gitlabHosts = { u2: ['gitlab.acme.io'] };
});

describe('agentGitEnv : comptes GitHub et GitLab prêtés séparément', () => {
  it('prend le jeton GitHub de la personne qui prête GitHub et le jeton GitLab de celle qui prête GitLab', async () => {
    const env = await agentGitEnv(agentAccounts({ githubUserId: 'u1', gitlabUserId: 'u2' }), 'https://github.com/acme/app.git');
    expect(env.GITHUB_TOKEN).toBe('gh-u1');
    expect(env.GITLAB_TOKEN).toBe('gl-u2');
    // Dépôt GitHub : identité des commits du compte GitHub.
    expect(env.GIT_AUTHOR_NAME).toBe('GH u1');
    expect(pushUrl(env)).toBeUndefined();
  });

  it("bloque le push de l'origine seulement si le compte de son hébergeur est prêté en lecture seule", async () => {
    const gitlabRo = agentAccounts({ gitlabUserId: 'u2', gitlabReadOnly: true });
    expect(pushUrl(await agentGitEnv(gitlabRo, 'https://github.com/acme/app.git'))).toBeUndefined();
    const onGitlab = await agentGitEnv(gitlabRo, 'https://gitlab.acme.io/acme/app.git');
    expect(pushUrl(onGitlab)).toBeDefined();
    expect(onGitlab.GIT_AUTHOR_NAME).toBe('GL u2');
    expect(pushUrl(await agentGitEnv(agentAccounts({ githubUserId: 'u1', githubReadOnly: true }), 'https://github.com/acme/app.git'))).toBeDefined();
    // Pull requests permises : le push depuis la session reste bloqué (seul pr_open pousse, côté serveur).
    expect(pushUrl(await agentGitEnv(agentAccounts({ githubUserId: 'u1', githubReadOnly: true, githubPullRequests: true }), 'https://github.com/acme/app.git'))).toBeDefined();
  });

  it('une personne (identifiant) utilise ses propres comptes, en écriture', async () => {
    const env = await agentGitEnv('u1', 'https://github.com/acme/app.git');
    expect(env.GITHUB_TOKEN).toBe('gh-u1');
    expect(env.GITLAB_TOKEN).toBe('gl-u1');
    expect(pushUrl(env)).toBeUndefined();
  });
});

describe('gitAccountFor', () => {
  it("choisit le compte selon l'hébergeur du dépôt", async () => {
    const acc = agentAccounts({ githubUserId: 'u1', githubReadOnly: true, githubPullRequests: false, gitlabUserId: 'u2', gitlabMerge: true });
    expect(await gitAccountFor(acc, 'https://github.com/acme/app.git')).toEqual({ host: 'github', userId: 'u1', readOnly: true, pullRequests: false, merge: false });
    expect(await gitAccountFor(acc, 'https://gitlab.com/acme/app.git')).toEqual({ host: 'gitlab', userId: 'u2', readOnly: false, pullRequests: true, merge: true });
    // Instance GitLab auto-hébergée reconnue par les comptes de la personne qui prête GitLab.
    expect(await gitAccountFor(acc, 'https://gitlab.acme.io/acme/app.git')).toEqual({ host: 'gitlab', userId: 'u2', readOnly: false, pullRequests: true, merge: true });
    expect(await gitAccountFor(acc, null)).toEqual({ host: 'github', userId: 'u1', readOnly: true, pullRequests: false, merge: false });
  });
});
