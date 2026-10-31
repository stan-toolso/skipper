import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { Session } from '../sessions/types.js';

// Le CLI Claude liste les outils de chaque serveur au démarrage (tools/list) : un schéma zod refusé par le
// convertisseur du SDK fait disparaître tout le serveur en silence. On liste donc les serveurs de l'espace
// personnel (`projects`) et les serveurs ordinaires avec et sans portée, et on exerce la portée elle-même.
const { projectService, userService, sessionService, sessionRepository, taskService, worksessionService } = vi.hoisted(() => ({
  projectService: { listForUser: vi.fn(), get: vi.fn() },
  userService: { memberRoleFor: vi.fn(), get: vi.fn() },
  sessionService: { list: vi.fn(), get: vi.fn(), create: vi.fn(), waitForIdle: vi.fn(), sendMessage: vi.fn(), end: vi.fn(), isRunning: vi.fn() },
  sessionRepository: { list: vi.fn(async () => []), findById: vi.fn(), findLastEvent: vi.fn(async () => null) },
  taskService: { list: vi.fn(async () => []), get: vi.fn(), create: vi.fn(), update: vi.fn(), comments: vi.fn(async () => []), attachments: vi.fn(async () => []), addComment: vi.fn() },
  worksessionService: { listByProject: vi.fn(async () => []), get: vi.fn(), gitInfo: vi.fn(async () => null), exists: vi.fn(async () => true), create: vi.fn() },
}));
vi.mock('../projects/service.js', () => ({ projectService }));
vi.mock('../users/service.js', () => ({ userService }));
vi.mock('../sessions/service.js', () => ({ sessionService }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository }));
vi.mock('../tasks/service.js', () => ({ taskService, formatPerson: (p: { name?: string; email?: string }) => p.name ?? p.email ?? '', statusTagText: () => '', describeComment: () => [] }));
vi.mock('../tasks/attachments.js', () => ({ describeAttachments: () => [], imageBlocks: async () => [] }));
vi.mock('../worksessions/service.js', () => ({ worksessionService, worksessionPath: () => '/tmp/ws' }));
vi.mock('../projects/cleanup.js', () => ({ removeWorksessionKeepingSessions: vi.fn() }));

const { createProjectScope } = await import('./scope.js');
const { createProjectsMcpServer } = await import('./mcp.js');
const { createSessionsMcpServer } = await import('../sessions/mcp.js');
const { createTasksMcpServer } = await import('../tasks/mcp.js');
const { createWorksessionsMcpServer } = await import('../worksessions/mcp.js');

const project = (over: Partial<Project>): Project => ({ id: 'p1', name: 'Curso', slug: 'curso', description: null, systemPrompt: '', gitUrl: 'https://github.com/x/curso.git', gitBranch: 'main', gitHosted: false, runnerConfig: {}, defaultPermissionMode: 'default', taskInstructions: '', personalOwnerId: null, createdAt: new Date(), updatedAt: new Date(), ...over });
const home = project({ id: 'home', name: 'Espace personnel', slug: 'moi-alice', gitUrl: null, gitBranch: null, personalOwnerId: 'u1' });
const curso = project({});
const viewerOnly = project({ id: 'p2', name: 'Lecture seule', slug: 'lecture-seule' });

beforeEach(() => {
  projectService.listForUser.mockReset().mockResolvedValue([home, curso, viewerOnly]);
  userService.memberRoleFor.mockReset().mockImplementation(async (_u: string, id: string) => (id === 'p1' ? 'member' : id === 'p2' ? 'viewer' : null));
  sessionService.list.mockReset().mockResolvedValue([]);
  sessionService.get.mockReset();
  sessionService.create.mockReset();
  taskService.list.mockReset().mockResolvedValue([]);
  taskService.create.mockReset();
});

async function connect(server: McpSdkServerConfigWithInstance) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

const paramsOf = async (server: McpSdkServerConfigWithInstance, name: string) => {
  const { tools } = await (await connect(server)).listTools();
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`outil ${name} absent de ${tools.map((x) => x.name).join(', ')}`);
  return Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
};

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe('portée d’un espace personnel', () => {
  const scope = () => createProjectScope('u1', home);

  it("résout un projet par identifiant, dossier ou nom (sans tenir compte de la casse ni des accents), sinon l'espace personnel", async () => {
    const s = scope();
    expect((await s.resolve()).id).toBe('home');
    expect((await s.resolve('p1')).id).toBe('p1');
    expect((await s.resolve('curso')).id).toBe('p1');
    expect((await s.resolve('CURSO')).id).toBe('p1');
    expect((await s.resolve('Lecture seule')).id).toBe('p2');
    await expect(s.resolve('inconnu')).rejects.toThrow(/introuvable parmi tes projets/);
  });

  it("refuse l'écriture sans le rôle membre, et l'accès hors des projets de la personne", async () => {
    const s = scope();
    await expect(s.resolve('curso', { write: true })).resolves.toBeTruthy();
    await expect(s.resolve('Lecture seule', { write: true })).rejects.toThrow(/rôle membre/);
    expect(await s.canRead('p2')).toBe(true);
    expect(await s.canRead('autre')).toBe(false);
    await expect(s.assertWritable('autre')).rejects.toThrow(/pas accès/);
  });
});

describe('serveur MCP projects', () => {
  it('liste ses outils et décrit les projets de la personne', async () => {
    const client = await connect(createProjectsMcpServer(createProjectScope('u1', home)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get', 'list']);
    const res = (await client.callTool({ name: 'list', arguments: {} })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Curso · dossier curso · id p1 · rôle membre');
    expect(res.content[0].text).toContain('ton espace personnel');
  });
});

describe('paramètre project des serveurs sessions, tasks et worksessions', () => {
  it("n'apparaît que dans les sessions d'un espace personnel", async () => {
    const s = createProjectScope('u1', home);
    expect(await paramsOf(createSessionsMcpServer(curso, 's1'), 'create')).not.toContain('project');
    expect(await paramsOf(createSessionsMcpServer(home, 's1', s), 'create')).toContain('project');
    expect(await paramsOf(createSessionsMcpServer(home, 's1', s), 'list')).toContain('project');
    expect(await paramsOf(createTasksMcpServer(curso, 's1', 'S'), 'create')).not.toContain('project');
    expect(await paramsOf(createTasksMcpServer(home, 's1', 'S', s), 'create')).toContain('project');
    expect(await paramsOf(createTasksMcpServer(home, 's1', 'S', s), 'list')).toContain('project');
    expect(await paramsOf(createWorksessionsMcpServer(curso, 's1'), 'create')).not.toContain('project');
    expect(await paramsOf(createWorksessionsMcpServer(home, 's1', s), 'create')).toContain('project');
    expect(await paramsOf(createWorksessionsMcpServer(home, 's1', s), 'list')).toContain('project');
  });

  it('lance une session dans le projet visé, avec le provider Claude et sans le mode d’autorisation du chat', async () => {
    const me = { id: 'chat1', kind: 'chat', provider: 'claude', config: { permissionMode: 'bypassPermissions', model: 'opus' } } as unknown as Session;
    sessionService.get.mockResolvedValue(me);
    sessionService.create.mockImplementation(async (input: { projectId: string; name: string }) => ({ id: 'new', name: input.name, status: 'running', activity: 'busy', projectId: input.projectId, worksessionId: null, parentSessionId: 'chat1', error: null }));
    const client = await connect(createSessionsMcpServer(home, 'chat1', createProjectScope('u1', home)));
    const res = (await client.callTool({ name: 'create', arguments: { prompt: 'Corrige le bug', project: 'curso' } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(sessionService.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', provider: 'claude', config: { model: 'opus' }, newWorksession: { baseRef: null } }), { type: 'agent', sessionId: 'chat1' });
    expect(res.content[0].text).toContain('projet Curso');
  });

  it("refuse de créer une tâche dans un projet où la personne n'est que lectrice", async () => {
    const client = await connect(createTasksMcpServer(home, 's1', 'S', createProjectScope('u1', home)));
    const res = (await client.callTool({ name: 'create', arguments: { title: 'x', project: 'lecture-seule' } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('rôle membre');
    expect(taskService.create).not.toHaveBeenCalled();
  });

  it("ignore un paramètre project hors d'un espace personnel : le schéma ne le déclare pas, l'outil reste dans son projet", async () => {
    const client = await connect(createSessionsMcpServer(curso, 's1'));
    const res = (await client.callTool({ name: 'list', arguments: { project: 'autre' } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(sessionService.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
  });
});
