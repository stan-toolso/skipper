import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';

// Le CLI Claude liste les outils d'un serveur in-process au démarrage : un schéma zod refusé par le convertisseur
// du SDK ferait disparaître tout le serveur `tasks` pour l'agent. Services voisins simulés : on exerce la
// déclaration des outils et les outils de suivi des pull requests (pr_list, pr_register, pr_update, pr_open).
const m = vi.hoisted(() => ({
  tasks: {} as Record<string, unknown>,
  prs: {} as Record<string, unknown>,
  session: { id: 's1', worksessionId: 'w1' as string | null, ownerId: 'u1', takenOverById: null as string | null },
  ownerKind: null as string | null,
  approvalImplicit: false,
  calls: [] as Array<[string, unknown[]]>,
  events: [] as unknown[][],
  taskStatus: 'in_progress' as string,
  taskSessionIds: [] as string[],
  blockedBy: [] as string[],
  check: { status: 'none' } as Record<string, unknown>,
  assertUnblocked: async (t: { blockedByIds: string[] }) => {
    if (t.blockedByIds.length) throw new Error(`La tâche est bloquée par ${t.blockedByIds.join(', ')}`);
  },
}));
vi.mock('./service.js', () => ({ taskService: m.tasks, describeThread: () => ['Fil de discussion :'], summarizeReactions: () => '', formatPerson: () => '', statusTagText: () => '', dependencyText: () => '', formatWakeAt: () => '', assertUnblocked: m.assertUnblocked }));
vi.mock('../deliveries/qualityService.js', () => ({ deliveryQualityService: { linkOf: async () => null } }));
vi.mock('./attachments.js', () => ({ describeAttachments: () => [], imageBlocks: async () => [] }));
vi.mock('../pullRequests/service.js', () => ({ trackedPullRequestService: m.prs, foreignRepoOf: (p: { repo: string }, projectRepo: string) => (p.repo && p.repo !== projectRepo ? { owner: p.repo.split('/')[0], name: p.repo.split('/')[1] } : null) }));
vi.mock('../git/pullRequests.js', () => ({
  pullRequestService: {
    close: async (...args: unknown[]) => void m.calls.push(['close', args]),
    comment: async (...args: unknown[]) => (m.calls.push(['comment', args]), 'https://github.com/o/r/pull/42#c1'),
    merge: async (...args: unknown[]) => {
      m.calls.push(['merge', args]);
      return { pullRequest: { number: args[2], state: 'MERGED' }, sha: 'abcdef1234567', deletedWorksessionIds: [], completedTaskIds: [], warnings: [] };
    },
  },
}));
// Comptes du propriétaire (délégation d'un agent de projet) : une personne utilise les siens ; un agent en lecture seule ne pousse pas.
const accounts = { claudeUserId: 'u1', githubUserId: 'u1', githubReadOnly: false, githubPullRequests: true, githubMerge: false, gitlabUserId: 'u1', gitlabReadOnly: false, gitlabPullRequests: true, gitlabMerge: false, forgeUserId: 'u1' };
vi.mock('../agents/service.js', () => ({
  agentService: {
    accountsForSession: async (s: { takenOverById: string | null }) => (s.takenOverById ? { ...accounts, githubUserId: s.takenOverById, githubReadOnly: false } : accounts),
    forUser: async () => (m.ownerKind ? { kind: m.ownerKind } : null),
  },
}));
vi.mock('../git/agentEnv.js', () => ({ gitAccountFor: async (a: typeof accounts) => ({ host: 'github', userId: a.githubUserId, readOnly: a.githubReadOnly, pullRequests: a.githubPullRequests, merge: a.githubMerge }) }));
vi.mock('../sessions/events.js', () => ({ traceSessionEvent: async (...args: unknown[]) => void m.events.push(args) }));
vi.mock('../worksessions/service.js', () => ({ worksessionService: { get: async (id: string) => ({ id, name: 'dossier' }) }, worksessionPath: (_p: unknown, w: { name: string }) => `/tmp/${w.name}` }));
vi.mock('../runners/index.js', () => ({ runner: {} }));
vi.mock('../pullRequests/localCheck.js', async (orig) => ({ ...(await orig<typeof import('../pullRequests/localCheck.js')>()), localCheck: { run: async (...a: unknown[]) => (m.calls.push(['check', a]), m.check) } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: async () => m.session } }));
vi.mock('../approvals/service.js', () => ({
  approvalService: {
    request: async (input: unknown) => (m.calls.push(['approval', [input]]), m.approvalImplicit ? { implicit: true, approver: { name: 'Stan', email: 's@x' } } : { implicit: false, request: { id: 'r1' } }),
  },
}));
vi.mock('../personal/scope.js', () => ({
  inScope: async (_p: Project, _s: unknown, projectId: string) => projectId === 'p',
  targetProject: async (p: Project) => p,
  withProjectParam: (shape: Record<string, unknown>) => shape,
}));

const { createTasksMcpServer, TASKS_FREE_TOOLS } = await import('./mcp.js');

const project = { id: 'p', name: 'Projet', gitUrl: 'https://github.com/acme/app.git' } as Project;
const pr = (over: Partial<TrackedPullRequest> = {}): TrackedPullRequest => ({
  id: 'pr1',
  projectId: 'p',
  taskId: 't1',
  repo: 'acme/app',
  number: 42,
  url: 'https://github.com/acme/app/pull/42',
  title: 'Ma PR',
  headBranch: 'task/x',
  baseBranch: 'main',
  status: 'open',
  isDraft: false,
  worksessionId: null,
  localCommits: null,
  localChanges: null,
  checksState: 'SUCCESS',
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  syncedAt: null,
  mergeSha: null,
  note: '',
  createdByType: 'agent',
  createdByUserId: null,
  createdBySessionId: 's1',
  openedAt: new Date(),
  mergedAt: null,
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

async function connect(options: Parameters<typeof createTasksMcpServer>[4] = {}) {
  const server = createTasksMcpServer(project, 's1', 'Session', undefined, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}
const textOf = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '');
const record = (name: string) => (...args: unknown[]) => void m.calls.push([name, args]);

beforeEach(() => {
  m.calls = [];
  m.events = [];
  m.session = { id: 's1', worksessionId: 'w1', ownerId: 'u1', takenOverById: null };
  m.taskStatus = 'in_progress';
  m.taskSessionIds = [];
  m.blockedBy = [];
  Object.assign(m.tasks, {
    get: async (id: string) => {
      if (id !== 't1') throw new Error('Tâche introuvable');
      return { id, projectId: 'p', title: 'Tâche', description: '', status: m.taskStatus, priority: 'medium', tags: [], customFields: [], branch: 'task/x', commentCount: 0, sessionIds: m.taskSessionIds, dependsOnIds: m.blockedBy, blockedByIds: m.blockedBy, dependentIds: [] };
    },
    findByIds: async (ids: string[]) => ids.map((id) => ({ id, title: `Tâche ${id}`, status: 'todo' })),
    create: async (_p: string, input: Record<string, unknown>) => {
      record('create')(input);
      return { id: 't2', projectId: 'p', title: input.title, description: '', status: input.status ?? 'todo', priority: 'medium', tags: [], customFields: [], branch: null, commentCount: 0, sessionIds: input.sessionId ? [input.sessionId] : [], dependsOnIds: [], blockedByIds: [], dependentIds: [] };
    },
    update: async (id: string, input: Record<string, unknown>) => {
      record('taskUpdate')(id, input);
      return { id, projectId: 'p', title: 'Tâche', description: '', status: input.status ?? m.taskStatus, priority: 'medium', tags: [], customFields: [], branch: null, commentCount: 0, sessionIds: input.sessionId ? [input.sessionId] : m.taskSessionIds, dependsOnIds: m.blockedBy, blockedByIds: m.blockedBy, dependentIds: [] };
    },
    comments: async () => [],
    attachments: async () => [],
    reactions: async () => [],
    mentionables: async () => [
      { kind: 'user', id: 'u1', label: 'Alice Martin', detail: 'alice@example.com', text: '@Alice Martin' },
      { kind: 'session', id: 's1', label: 'Session', detail: 'session · running', text: '@session:s1' },
    ],
    addComment: async (...args: unknown[]) => {
      record('addComment')(...args);
      return { id: 'c9', parentId: (args[4] as { parentId?: string } | undefined)?.parentId ?? null, mentions: [{ kind: 'user', id: 'u1', label: 'Alice Martin', text: '@Alice Martin' }] };
    },
    toggleReaction: async (...args: unknown[]) => {
      record('toggleReaction')(...args);
      return { added: true, reaction: { emoji: args[2] } };
    },
  });
  Object.assign(m.prs, {
    projectRepo: () => 'acme/app',
    forTask: async () => [pr()],
    list: async (f: unknown) => {
      record('list')(f);
      return [pr(), pr({ id: 'pr2', number: 43, status: 'merged', mergedAt: new Date(), taskId: null }), pr({ id: 'pr3', repo: 'autre/depot', number: 5, url: 'https://github.com/autre/depot/pull/5' }), pr({ id: 'pr4', status: 'pending', number: null, url: '', headBranch: 'feat/wip', localCommits: 2, localChanges: 1 })];
    },
    register: async (...args: unknown[]) => {
      record('register')(...args);
      return pr({ note: 'déclarée' });
    },
    resolve: async (_p: string, ref: string) => {
      if (ref !== 'pr1' && ref !== '#42') throw new Error('Pull request suivie introuvable dans ce projet');
      return pr();
    },
    update: async (...args: unknown[]) => {
      record('update')(...args);
      return pr({ status: 'merged' });
    },
    open: async (...args: unknown[]) => {
      record('open')(...args);
      return pr({ number: 44, title: 'Ouverte' });
    },
    markMerged: async (...args: unknown[]) => {
      record('markMerged')(...args);
      return pr({ status: 'merged', mergedAt: new Date() });
    },
  });
});

describe('serveur MCP tasks', () => {
  it('déclare tous ses outils (schémas acceptés par le SDK), dont ceux des pull requests', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['ci_status', 'claim', 'comment', 'create', 'deploy_record', 'get', 'list', 'people', 'pr_close', 'pr_list', 'pr_merge', 'pr_open', 'pr_register', 'pr_update', 'react', 'release', 'request_approval', 'update']);
    // Tout outil libre existe ; pr_open (pousse et ouvre sur GitHub) n'est pas libre.
    for (const free of TASKS_FREE_TOOLS) expect(names).toContain(free.replace('mcp__tasks__', ''));
    expect(TASKS_FREE_TOOLS).not.toContain('mcp__tasks__pr_open');
    expect(TASKS_FREE_TOOLS).not.toContain('mcp__tasks__pr_close');
  });

  it('request_approval pose une demande ou constate l’accord implicite, sans exécuter l’action', async () => {
    const client = await connect();
    m.approvalImplicit = false;
    const posted = textOf(await client.callTool({ name: 'request_approval', arguments: { id: 't1', action: 'Mettre en production main' } }));
    expect(posted).toContain("Demande d'accord posée");
    expect(posted).toContain('termine ton tour');
    expect(m.calls.at(-1)?.[1][0]).toMatchObject({ projectId: 'p', sessionId: 's1', taskId: 't1', action: 'Mettre en production main', actor: { type: 'agent', sessionId: 's1' } });
    m.approvalImplicit = true;
    const implicit = textOf(await client.callTool({ name: 'request_approval', arguments: { id: 't1', action: 'Mettre en production main' } }));
    expect(implicit).toContain('Accord implicite : Stan');
    m.approvalImplicit = false;
  });

  it('create rattache la session aux tâches créées en cours ou terminées, pas aux tâches à faire, sauf demande', async () => {
    const client = await connect();
    await client.callTool({ name: 'create', arguments: { title: 'Faite', status: 'done' } });
    await client.callTool({ name: 'create', arguments: { title: 'Plus tard' } });
    await client.callTool({ name: 'create', arguments: { title: 'Plus tard mais à moi', assign_to_me: true } });
    await client.callTool({ name: 'create', arguments: { title: 'Faite par un autre', status: 'in_progress', assign_to_me: false } });
    expect(m.calls.filter(([n]) => n === 'create').map(([, [input]]) => (input as { sessionId: string | null }).sessionId)).toEqual(['s1', null, 's1', null]);
    const text = textOf(await client.callTool({ name: 'create', arguments: { title: 'Encore', status: 'in_progress' } }));
    expect(text).toContain('(assignée à cette session)');
  });

  it('update prend la charge d’une tâche libre qu’on avance, pas d’une tâche déjà prise', async () => {
    const client = await connect();
    await client.callTool({ name: 'update', arguments: { id: 't1', status: 'done' } });
    expect(m.calls[0][1][1]).toMatchObject({ status: 'done', sessionId: 's1' });
    m.calls = [];
    await client.callTool({ name: 'update', arguments: { id: 't1', priority: 'high' } });
    expect((m.calls[0][1][1] as Record<string, unknown>).sessionId).toBeUndefined();
    m.calls = [];
    m.taskSessionIds = ['s9'];
    await client.callTool({ name: 'update', arguments: { id: 't1', status: 'in_progress' } });
    expect((m.calls[0][1][1] as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it('dépendances : create et update les transmettent, auto_start est armé au nom du propriétaire de la session', async () => {
    const client = await connect();
    await client.callTool({ name: 'create', arguments: { title: 'Suite', depends_on: ['t1'], auto_start: true } });
    expect(m.calls[0]).toEqual(['create', [expect.objectContaining({ dependsOn: ['t1'], autoStartWhenUnblocked: true, autoStartById: 'u1' })]]);
    await client.callTool({ name: 'update', arguments: { id: 't1', depends_on: [], auto_start: false } });
    expect(m.calls[1]).toEqual(['taskUpdate', ['t1', expect.objectContaining({ dependsOn: [], autoStartWhenUnblocked: false, autoStartById: null })]]);
  });

  it('une tâche bloquée ne se prend pas : claim refusé, pas de prise implicite par update', async () => {
    m.blockedBy = ['t0'];
    m.taskStatus = 'todo';
    const client = await connect();
    const claimed = await client.callTool({ name: 'claim', arguments: { id: 't1' } });
    expect(claimed.isError).toBe(true);
    expect(textOf(claimed)).toMatch(/bloquée par t0/);
    expect(m.calls).toEqual([]);
    await client.callTool({ name: 'update', arguments: { id: 't1', status: 'in_progress' } });
    expect((m.calls[0][1] as unknown[])[1]).not.toHaveProperty('sessionId');
    const got = await client.callTool({ name: 'get', arguments: { id: 't1' } });
    expect(textOf(got)).toMatch(/Bloquée par[\s\S]*t0 · \[todo\] Tâche t0/);
  });

  it('trace dans le transcript la création, la prise en charge et les changements de statut (événement task)', async () => {
    const client = await connect();
    const events = () => m.events.splice(0);
    await client.callTool({ name: 'create', arguments: { title: 'Nouvelle' } });
    expect(events()).toEqual([['s1', 'task', expect.objectContaining({ action: 'created', taskId: 't2', projectId: 'p', title: 'Nouvelle', status: 'todo', priority: 'medium' })]]);
    await client.callTool({ name: 'update', arguments: { id: 't1', priority: 'high' } });
    expect(events()).toEqual([]);
    await client.callTool({ name: 'update', arguments: { id: 't1', status: 'done' } });
    expect(events()).toEqual([['s1', 'task', expect.objectContaining({ action: 'status', taskId: 't1', status: 'done', previousStatus: 'in_progress' })]]);
    m.taskStatus = 'todo';
    await client.callTool({ name: 'claim', arguments: { id: 't1' } });
    expect(events()).toEqual([['s1', 'task', expect.objectContaining({ action: 'claimed', taskId: 't1', status: 'in_progress', previousStatus: 'todo' })]]);
  });

  it('release rend une tâche dont la session est en charge', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'release', arguments: { id: 't1' } });
    expect(textOf(res)).toContain("n'est pas en charge");
    expect(m.calls).toEqual([]);
    m.taskSessionIds = ['s1', 's2'];
    const text = textOf(await client.callTool({ name: 'release', arguments: { id: 't1' } }));
    expect(m.calls[0]).toEqual(['taskUpdate', ['t1', { releaseSessionIds: ['s1'] }]]);
    expect(text).toContain('Tâche rendue');
  });

  it('comment poste dans le fil (reply_to) et rend compte des mentions', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'comment', arguments: { id: 't1', body: 'Vu @Alice Martin', reply_to: 'c1' } }));
    expect(text).toBe('Message posté (c9) dans le fil de c1 ; mentionne Alice Martin.');
    const [name, args] = m.calls[0];
    expect(name).toBe('addComment');
    expect(args.slice(0, 3)).toEqual(['t1', 'Vu @Alice Martin', { type: 'agent', sessionId: 's1', name: 'Session' }]);
    expect(args[4]).toEqual({ parentId: 'c1' });
  });

  it('react pose un emoji sur un message ou sur la tâche', async () => {
    const client = await connect();
    expect(textOf(await client.callTool({ name: 'react', arguments: { id: 't1', comment_id: 'c1', emoji: '👍' } }))).toBe('Réaction 👍 posée sur le message c1.');
    expect(m.calls[0]).toEqual(['toggleReaction', ['t1', 'c1', '👍', { type: 'agent', sessionId: 's1', name: 'Session' }]]);
    expect(textOf(await client.callTool({ name: 'react', arguments: { id: 't1', emoji: '✅' } }))).toBe('Réaction ✅ posée sur la tâche.');
    expect(m.calls[1][1][1]).toBeNull();
  });

  it('people liste les membres et sessions mentionnables, en repérant la session courante', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'people', arguments: {} }));
    expect(text).toContain('- @Alice Martin → membre Alice Martin (alice@example.com)');
    expect(text).toContain('- @session:s1 → session Session (session · running) (cette session)');
  });

  it('get montre les pull requests suivies de la tâche', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'get', arguments: { id: 't1' } }));
    expect(text).toContain('Pull requests suivies');
    expect(text).toContain('PR #42 « Ma PR » · à fusionner (checks réussis)');
    expect(text).toContain('Branche : task/x');
  });

  it('pr_list filtre par tâche et par étape', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'pr_list', arguments: { task_id: 't1', stage: ['to_merge', 'merged'] } }));
    expect(text).toContain('PR #42');
    expect(text).toContain('PR #43');
    expect(text).toContain('PR autre/depot#5'); // dépôt nommé seulement quand ce n'est pas celui du projet
    expect(text).toContain('branche feat/wip « Ma PR » · en préparation (2 commits, 1 fichier non commité)');
    expect(m.calls[0]).toEqual(['list', [{ projectId: 'p', taskId: 't1', stage: ['to_merge', 'merged'], limit: 200 }]]);
    const res = await client.callTool({ name: 'pr_list', arguments: { task_id: 'autre' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Tâche introuvable');
  });

  it('pr_register déclare une PR avec le compte de la personne qui pilote la session', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'pr_register', arguments: { task_id: 't1', url: 'https://github.com/acme/app/pull/42', note: 'déclarée' } }));
    expect(text).toContain('Pull request suivie');
    expect(text).toContain('note : déclarée');
    const [name, args] = m.calls[0];
    expect(name).toBe('register');
    expect(args[0]).toBe('p');
    expect(args[1]).toEqual({ url: 'https://github.com/acme/app/pull/42', number: undefined });
    expect(args[2]).toMatchObject({ taskId: 't1', note: 'déclarée', userId: 'u1' });
    expect(args[3]).toEqual({ type: 'agent', sessionId: 's1' });
  });

  it('pr_update accepte le numéro GitHub et transmet le statut', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'pr_update', arguments: { id: '#42', status: 'merged' } }));
    expect(text).toContain('fusionnée');
    expect(m.calls[0]).toEqual(['update', ['pr1', { status: 'merged', note: undefined, taskId: undefined }]]);
    const res = await client.callTool({ name: 'pr_update', arguments: { id: '#7', status: 'closed' } });
    expect(res.isError).toBe(true);
  });

  it('pr_open ouvre la PR depuis la work session de la session, et refuse depuis le dossier principal', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'Ouverte', body: 'Détail', draft: false, path: 'vendor/lib' } }));
    expect(text).toContain('PR #44 « Ouverte »');
    expect(m.calls[0]).toEqual(['open', [{ projectId: 'p', worksessionId: 'w1' }, 'u1', { title: 'Ouverte', body: 'Détail', base: undefined, draft: false, path: 'vendor/lib' }, { taskId: 't1', note: undefined }, { type: 'agent', sessionId: 's1' }]]);
    m.session.worksessionId = null;
    const res = await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('dossier principal');
    // Compte GitHub prêté en lecture seule : ni push ni PR.
    m.session = { ...m.session, worksessionId: 'w1' } as typeof m.session;
    accounts.githubReadOnly = true;
    accounts.githubPullRequests = false;
    const ro = await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } });
    expect(ro.isError).toBe(true);
    expect(textOf(ro)).toContain('lecture seule');
    // Lecture seule mais pull requests permises : pr_open passe, avec le compte prêté.
    accounts.githubPullRequests = true;
    const allowed = await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'Permise' } });
    expect(allowed.isError).toBeFalsy();
    expect(textOf(allowed)).toContain('Pull request ouverte');
    accounts.githubReadOnly = false;
  });

  it('pr_open lance le contrôle local avant d’ouvrir, refuse s’il échoue, et force le saute', async () => {
    const client = await connect();
    // Rien de déclaré : on ouvre.
    m.calls = [];
    m.check = { status: 'none' };
    expect((await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } })).isError).toBeFalsy();
    expect(m.calls.map(([n]) => n)).toEqual(['check', 'open']);
    expect(m.calls[0][1]).toEqual([project, '/tmp/dossier']);
    // Contrôle réussi : on ouvre.
    m.calls = [];
    m.check = { status: 'passed', seconds: 40, command: 'npm run ci' };
    expect((await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } })).isError).toBeFalsy();
    // Échec : pas de PR, le journal et la façon de forcer sont dans le refus.
    m.calls = [];
    m.check = { status: 'failed', seconds: 12, command: 'npm run ci', code: 1, timedOut: false, log: 'TS2322 dans a.ts' };
    const refused = await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('npm run ci');
    expect(textOf(refused)).toContain('TS2322 dans a.ts');
    expect(textOf(refused)).toContain('force: true');
    expect(m.calls.map(([n]) => n)).toEqual(['check']);
    // Configuration invalide : refus aussi.
    m.check = { status: 'config_error', error: '.skipper/ci.json : « command » est obligatoire' };
    expect((await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } })).isError).toBe(true);
    // force : ni lancé ni bloquant. Un autre dépôt (path) n'est pas contrôlé non plus.
    m.calls = [];
    m.check = { status: 'failed', seconds: 1, command: 'npm run ci', code: 1, timedOut: false, log: '' };
    expect((await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x', force: true } })).isError).toBeFalsy();
    expect((await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x', path: 'vendor/lib' } })).isError).toBeFalsy();
    expect(m.calls.map(([n]) => n)).toEqual(['open', 'open']);
    m.check = { status: 'none' };
  });

  it("pr_open est refusé à un Product Manager, sauf quand une personne a pris la main (avec son compte)", async () => {
    const client = await connect();
    m.calls.length = 0;
    m.session = { ...m.session, worksessionId: 'w1', ownerId: 'pm', takenOverById: null };
    m.ownerKind = 'product_manager';
    accounts.githubReadOnly = true;
    accounts.githubPullRequests = false;
    const refused = await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'x' } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("Tu es Product Manager");
    expect(m.calls.filter(([n]) => n === 'open')).toHaveLength(0);
    // Stan prend la main : ses comptes (en écriture) servent la PR.
    m.session = { ...m.session, takenOverById: 'stan' };
    const taken = await client.callTool({ name: 'pr_open', arguments: { task_id: 't1', title: 'Reprise' } });
    expect(taken.isError).toBeFalsy();
    expect(m.calls.find(([n]) => n === 'open')?.[1][1]).toBe('stan');
    m.ownerKind = null;
    accounts.githubReadOnly = false;
    accounts.githubPullRequests = true;
    m.session = { ...m.session, ownerId: 'u1', takenOverById: null };
  });

  it("pr_merge pose la demande et fusionne avec le compte de la personne qui l'accepte", async () => {
    const approvals: unknown[] = [];
    const client = await connect({ approveMerge: async (a) => (approvals.push(a), 'stan') });
    const r = await client.callTool({ name: 'pr_merge', arguments: { id: '#42', method: 'squash' } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Pull request fusionnée (abcdef1)');
    expect(approvals).toEqual([expect.objectContaining({ projectId: 'p', ref: '#42', title: 'Ma PR', method: 'SQUASH' })]);
    const merge = m.calls.find(([n]) => n === 'merge')?.[1];
    // Compte de Stan, pas celui de la session ; le dossier de travail est gardé (la session y tourne).
    expect(merge?.slice(0, 4)).toEqual(['p', 'stan', 42, 'SQUASH']);
    expect(merge?.[4]).toEqual({ deleteRemoteBranch: true, deleteWorksession: false, completeTasks: true });
    expect(merge?.[5]).toBeNull();
    expect(m.calls.find(([n]) => n === 'markMerged')?.[1][3]).toEqual({ type: 'human', userId: 'stan' });
  });

  it('pr_merge fusionne directement avec le compte prêté en écriture, fusion permise, sans demande', async () => {
    accounts.githubUserId = 'lender';
    accounts.githubMerge = true;
    try {
      let asked = false;
      const r = await (await connect({ approveMerge: async () => ((asked = true), 'stan') })).callTool({ name: 'pr_merge', arguments: { id: '#42' } });
      expect(r.isError).toBeFalsy();
      expect(asked).toBe(false);
      expect(m.calls.find(([n]) => n === 'merge')?.[1].slice(0, 4)).toEqual(['p', 'lender', 42, 'MERGE']);
      expect(m.calls.find(([n]) => n === 'markMerged')?.[1][3]).toEqual({ type: 'agent', sessionId: 's1' });
      // Même sans demande possible (provider sans approveMerge), la fusion passe.
      m.calls.length = 0;
      const direct = await (await connect()).callTool({ name: 'pr_merge', arguments: { id: '#42' } });
      expect(direct.isError).toBeFalsy();
    } finally {
      accounts.githubUserId = 'u1';
      accounts.githubMerge = false;
    }
  });

  it('pr_merge ne fusionne pas si la demande est refusée, ni sans demande possible, ni une PR qui n’est pas ouverte', async () => {
    const denied = await (await connect({ approveMerge: async () => { throw new Error('Fusion refusée par la personne sollicitée'); } })).callTool({ name: 'pr_merge', arguments: { id: 'pr1' } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('Fusion refusée');
    const none = await (await connect()).callTool({ name: 'pr_merge', arguments: { id: 'pr1' } });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('ne peut pas fusionner');
    m.prs.resolve = async () => pr({ status: 'merged' });
    let asked = false;
    const closed = await (await connect({ approveMerge: async () => ((asked = true), 'stan') })).callTool({ name: 'pr_merge', arguments: { id: 'pr1' } });
    expect(closed.isError).toBe(true);
    expect(asked).toBe(false);
    expect(m.calls.filter(([n]) => n === 'merge')).toHaveLength(0);
  });

  it('pr_close commente puis ferme la PR sur la forge avec le compte de la session, et refuse une PR qui n’est pas ouverte', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'pr_close', arguments: { id: '#42', comment: 'Plus nécessaire' } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('fermée sans fusion');
    expect(m.calls.find(([n]) => n === 'comment')?.[1]).toEqual(['p', 'u1', 42, 'Plus nécessaire', null]);
    expect(m.calls.find(([n]) => n === 'close')?.[1]).toEqual(['p', 'u1', 42, null]);
    expect(m.calls.find(([n]) => n === 'update')?.[1]).toEqual(['pr1', { status: 'closed' }]);
    m.calls = [];
    m.prs.resolve = async () => pr({ status: 'merged' });
    const merged = await client.callTool({ name: 'pr_close', arguments: { id: 'pr1' } });
    expect(merged.isError).toBe(true);
    expect(m.calls.filter(([n]) => n === 'close')).toHaveLength(0);
  });
});
