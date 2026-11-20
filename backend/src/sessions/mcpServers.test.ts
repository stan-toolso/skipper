import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
// Terminaux (module natif, absent hors du serveur) : chargés en chemin par les services, inutiles ici.
vi.mock('node-pty', () => ({}));

import type { GoogleAccount } from '../google/types.js';
import type { ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import { createAgentsMcpServer } from '../agents/mcp.js';
import { createContextMcpServer } from '../context/mcp.js';
import { createConversationsMcpServer } from '../conversations/mcp.js';
import { createEnvMcpServer } from '../envFiles/mcp.js';
import { createGoogleMcpServer } from '../google/mcp.js';
import { createProjectsMcpServer } from '../personal/mcp.js';
import { createPreviewMcpServer } from '../previews/mcp.js';
import { createChromeMcpServer } from '../chrome/mcp.js';
import { createCockpitMcpServer } from '../cockpit/mcp.js';
import { createSchedulesMcpServer } from '../schedules/mcp.js';
import { createSharedPagesMcpServer } from '../sharedPages/mcp.js';
import { createTasksMcpServer } from '../tasks/mcp.js';
import { createVaultMcpServer } from '../vault/mcp.js';
import { createWorksessionsMcpServer } from '../worksessions/mcp.js';
import { createSessionsMcpServer } from './mcp.js';

// Au démarrage d'une session, le CLI Claude appelle tools/list sur chaque serveur in-process et le SDK convertit
// les schémas zod en JSON Schema : un seul schéma refusé (ex. `z.record` de zod 4) fait disparaître tout le serveur
// pour l'agent (incident du 10/10/2026, serveur `vault`). Ce test liste les outils de chacun des serveurs que le
// provider Claude peut donner à une session, par un transport en mémoire : un schéma incompatible casse la CI.
// Lister ne touche à aucun service : ni base ni réseau.

const project = { id: 'p', name: 'Projet', slug: 'projet' } as Project;
const scope = { ownerId: 'u', home: project, projects: async () => [project] } as unknown as ProjectScope;
const googleAccount = { id: 'g', name: 'gmail', email: 'a@example.org', displayName: null, gmailAccess: 'write', driveAccess: 'write' } as unknown as GoogleAccount;

const servers: Record<string, () => McpSdkServerConfigWithInstance> = {
  context: () => createContextMcpServer(project, 's', { agentLibraries: [], defaultAgentId: null }),
  tasks: () => createTasksMcpServer(project, 's', 'Agent', undefined, { approveMerge: async () => '' }),
  'tasks (espace personnel)': () => createTasksMcpServer(project, 's', 'Agent', scope),
  conversations: () => createConversationsMcpServer(project, 's', 'Agent'),
  agents: () => createAgentsMcpServer(project, 's'),
  vault: () =>
    createVaultMcpServer({ project, sessionId: 's', ownerId: 'u', cwd: '/tmp', emit: async () => undefined, remembered: async () => false, approve: async () => undefined, ask: async () => ({}) }),
  worksessions: () => createWorksessionsMcpServer(project, 's'),
  sessions: () => createSessionsMcpServer(project, 's'),
  'sessions (espace personnel)': () => createSessionsMcpServer(project, 's', scope),
  env: () => createEnvMcpServer({ project, sessionId: 's', ownerId: 'u', worksessionId: 'w' }),
  projects: () => createProjectsMcpServer(scope),
  pages: () => createSharedPagesMcpServer({ project, session: { id: 's', ownerId: 'u' }, cwd: '/tmp' }),
  preview: () => createPreviewMcpServer({ worksessionId: 'w', ownerId: 'u' }),
  cockpit: () => createCockpitMcpServer({ project, sessionId: 's', userId: 'u' }),
  schedules: () => createSchedulesMcpServer({ project, sessionId: 's', ownerId: 'u', requestedById: null, rightsHolderId: 'u' }),
  chrome: () => createChromeMcpServer({ userId: 'u', sessionId: 's', sessionName: 'Session' }),
  google: () => createGoogleMcpServer({ project, accounts: [googleAccount], sessionId: 's', cwd: '/tmp', emit: async () => undefined }),
};

async function listTools(server: McpSdkServerConfigWithInstance) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe('serveurs MCP in-process des sessions', () => {
  it.each(Object.keys(servers))('%s : tools/list répond avec un schéma JSON pour chaque outil', async (name) => {
    const tools = await listTools(servers[name]());
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.inputSchema.type, `${name}.${t.name}`).toBe('object');
  });

  it('pages : publish accepte project_access et share est listé', async () => {
    const tools = await listTools(servers.pages());
    expect(tools.map((t) => t.name)).toContain('share');
    const publish = tools.find((t) => t.name === 'publish');
    expect(Object.keys((publish?.inputSchema.properties ?? {}) as object)).toContain('project_access');
  });
});
