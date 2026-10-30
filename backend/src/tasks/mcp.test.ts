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
  session: { id: 's1', worksessionId: 'w1' as string | null, ownerId: 'u1' },
  calls: [] as Array<[string, unknown[]]>,
  taskStatus: 'in_progress' as string,
  taskSessionIds: [] as string[],
}));
vi.mock('./service.js', () => ({ taskService: m.tasks, describeThread: () => ['Fil de discussion :'], summarizeReactions: () => '', formatPerson: () => '', statusTagText: () => '' }));
vi.mock('./attachments.js', () => ({ describeAttachments: () => [], imageBlocks: async () => [] }));
vi.mock('../pullRequests/service.js', () => ({ trackedPullRequestService: m.prs }));
vi.mock('../sessions/service.js', () => ({ sessionService: { get: async () => m.session } }));
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
  deployedAt: null,
  deployedByType: null,
  deployedByUserId: null,
  deployedBySessionId: null,
  deployNote: '',
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

async function connect() {
  const server = createTasksMcpServer(project, 's1', 'Session');
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
  m.session = { id: 's1', worksessionId: 'w1', ownerId: 'u1' };
  m.taskStatus = 'in_progress';
  m.taskSessionIds = [];
  Object.assign(m.tasks, {
    get: async (id: string) => {
      if (id !== 't1') throw new Error('Tâche introuvable');
      return { id, projectId: 'p', title: 'Tâche', description: '', status: m.taskStatus, priority: 'medium', tags: [], customFields: [], branch: 'task/x', commentCount: 0, sessionIds: m.taskSessionIds };
    },
    create: async (_p: string, input: Record<string, unknown>) => {
      record('create')(input);
      return { id: 't2', projectId: 'p', title: input.title, description: '', status: input.status ?? 'todo', priority: 'medium', tags: [], customFields: [], branch: null, commentCount: 0, sessionIds: input.sessionId ? [input.sessionId] : [] };
    },
    update: async (id: string, input: Record<string, unknown>) => {
      record('taskUpdate')(id, input);
      return { id, projectId: 'p', title: 'Tâche', description: '', status: input.status ?? m.taskStatus, priority: 'medium', tags: [], customFields: [], branch: null, commentCount: 0, sessionIds: input.sessionId ? [input.sessionId] : m.taskSessionIds };
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
      return pr({ status: 'merged', deployedAt: new Date(), deployNote: 'prod' });
    },
    open: async (...args: unknown[]) => {
      record('open')(...args);
      return pr({ number: 44, title: 'Ouverte' });
    },
  });
});

describe('serveur MCP tasks', () => {
  it('déclare tous ses outils (schémas acceptés par le SDK), dont ceux des pull requests', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['claim', 'comment', 'create', 'get', 'list', 'people', 'pr_list', 'pr_open', 'pr_register', 'pr_update', 'react', 'release', 'update']);
    // Tout outil libre existe ; pr_open (pousse et ouvre sur GitHub) n'est pas libre.
    for (const free of TASKS_FREE_TOOLS) expect(names).toContain(free.replace('mcp__tasks__', ''));
    expect(TASKS_FREE_TOOLS).not.toContain('mcp__tasks__pr_open');
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
    const text = textOf(await client.callTool({ name: 'pr_list', arguments: { task_id: 't1', stage: ['to_merge', 'to_deploy'] } }));
    expect(text).toContain('PR #42');
    expect(text).toContain('PR #43');
    expect(text).toContain('PR autre/depot#5'); // dépôt nommé seulement quand ce n'est pas celui du projet
    expect(text).toContain('branche feat/wip « Ma PR » · en préparation (2 commits, 1 fichier non commité)');
    expect(m.calls[0]).toEqual(['list', [{ projectId: 'p', taskId: 't1', stage: ['to_merge', 'to_deploy'], limit: 200 }]]);
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

  it('pr_update accepte le numéro GitHub et transmet le déploiement', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'pr_update', arguments: { id: '#42', deployed: true, deploy_note: 'prod' } }));
    expect(text).toContain('déployée');
    expect(m.calls[0]).toEqual(['update', ['pr1', { status: undefined, note: undefined, deployed: true, deployNote: 'prod', taskId: undefined }, { type: 'agent', sessionId: 's1' }]]);
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
  });
});
