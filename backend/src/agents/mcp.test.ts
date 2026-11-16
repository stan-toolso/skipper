import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import type { Agent } from './types.js';

// Le CLI liste les outils de chaque serveur au démarrage : un schéma zod refusé ferait disparaître tout le serveur.
const { service, sessions } = vi.hoisted(() => ({ service: {} as Record<string, unknown>, sessions: {} as Record<string, unknown> }));
vi.mock('./service.js', () => ({ agentService: service }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: sessions }));

const { createAgentsMcpServer, AGENTS_FREE_TOOLS } = await import('./mcp.js');

const project = { id: 'p1', name: 'Skipper' } as Project;
const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', userId: 'a1', name: 'Léa', email: 'agent-a1@agents.skipper', projectId: 'p1', kind: 'product_manager', description: 'Cadre les demandes', enabled: true, archivedAt: null, triggers: {}, actions: [], defaults: {}, ...over }) as unknown as Agent;

async function connect(scope?: ProjectScope) {
  const server = createAgentsMcpServer(project, 's1', scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) => (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('serveur MCP agents', () => {
  beforeEach(() => {
    service.listByProject = vi.fn(async () => [agent(), agent({ id: 'a2', name: 'Max', kind: 'developer', description: '' })]);
    service.forUser = vi.fn(async (id: string | null) => (id === 'a1' ? agent() : null));
    service.resolve = vi.fn(async (_p: string, ref: string) => (ref === 'Max' || ref === 'a2' ? agent({ id: 'a2', name: 'Max', kind: 'developer' }) : agent()));
    service.summon = vi.fn(async () => ({ id: 'new', name: 'Max · Export CSV' }));
    sessions.findById = vi.fn(async () => ({ id: 's1', ownerId: 'a1', requestedById: 'u9' }));
  });

  it('liste ses outils (schémas acceptés) ; seul list est libre', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list', 'summon']);
    expect(AGENTS_FREE_TOOLS).toEqual(['mcp__agents__list']);
  });

  it('list décrit les agents du projet et marque la session appelante', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'list', arguments: {} }));
    expect(text).toContain('a1 · Léa · Product Manager · Cadre les demandes · toi');
    expect(text).toContain('a2 · Max · Developer');
  });

  it('summon convoque un autre agent avec la tâche et le demandeur de la session appelante', async () => {
    const client = await connect();
    const text = textOf(await client.callTool({ name: 'summon', arguments: { agent: 'Max', text: 'Développe la tâche', task_id: 't1' } }));
    expect(service.summon).toHaveBeenCalledWith('a2', expect.objectContaining({ taskId: 't1', text: 'Développe la tâche', requestedById: 'u9' }));
    expect(text).toContain('Max convoqué sur la tâche t1 : session new');
  });

  it("summon accepte que l'agent se convoque lui-même : nouvelle session à son nom, jamais la session appelante", async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'summon', arguments: { agent: 'Léa', text: 'Traite la tâche t3', task_id: 't3' } });
    expect(res.isError).toBeFalsy();
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ taskId: 't3', text: 'Traite la tâche t3', requestedById: 'u9', excludeSessionId: 's1', autoArchive: true }));
    expect(textOf(res)).toContain('Nouvelle session à ton nom sur la tâche t3 : new');
  });
});

describe('serveur MCP agents depuis un espace personnel (chat)', () => {
  const home = { id: 'me', name: 'Mon espace' } as Project;
  const other = { id: 'p2', name: 'Girco' } as Project;
  let scope: ProjectScope;

  beforeEach(() => {
    service.listActive = vi.fn(async (ids: string[]) =>
      [agent({ id: 'a1', name: 'Chris', projectId: 'p1' }), agent({ id: 'a2', name: 'Max', kind: 'developer', projectId: 'p2' }), agent({ id: 'a3', name: 'Max', kind: 'developer', projectId: 'p1' })].filter((a) => ids.includes(a.projectId)),
    );
    service.forUser = vi.fn(async () => null);
    service.resolve = vi.fn(async (projectId: string) => agent({ id: projectId === 'p2' ? 'a2' : 'a3', name: 'Max', kind: 'developer', projectId }));
    service.summon = vi.fn(async () => ({ id: 'new', name: 'Chris · Derniers devs' }));
    sessions.findById = vi.fn(async () => ({ id: 's1', ownerId: 'u1', requestedById: null }));
    scope = {
      ownerId: 'u1',
      home,
      projects: vi.fn(async () => [home, project, other]),
      resolve: vi.fn(async (ref?: string | null) => (ref === 'Girco' ? other : project)),
      canRead: vi.fn(async () => true),
      assertWritable: vi.fn(async () => undefined),
    };
  });

  it('expose le paramètre project et liste les agents de tous les projets avec leur projet', async () => {
    const client = await connect(scope);
    const { tools } = await client.listTools();
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).toContain('project');
    const text = textOf(await client.callTool({ name: 'list', arguments: {} }));
    expect(text).toContain('a1 · Chris · Product Manager · projet Skipper');
    expect(text).toContain('a2 · Max · Developer · projet Girco');
  });

  it('summon trouve l\'agent par son nom dans tous les projets, au nom de la personne', async () => {
    const client = await connect(scope);
    const text = textOf(await client.callTool({ name: 'summon', arguments: { agent: '@chris', text: 'Les derniers développements ?' } }));
    expect(scope.assertWritable).toHaveBeenCalledWith('p1');
    expect(service.summon).toHaveBeenCalledWith('a1', expect.objectContaining({ text: 'Les derniers développements ?', requestedById: 'u1' }));
    expect(text).toContain('sessions.wait');
  });

  it('summon refuse un nom ambigu sans projet, et le résout avec project', async () => {
    const client = await connect(scope);
    const res = await client.callTool({ name: 'summon', arguments: { agent: 'max', text: 'go' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Plusieurs agents');
    await client.callTool({ name: 'summon', arguments: { agent: 'Max', text: 'go', project: 'Girco' } });
    expect(service.summon).toHaveBeenCalledWith('a2', expect.anything());
  });
});
