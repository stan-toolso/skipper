import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// Le CLI Claude liste les outils d'un serveur in-process au démarrage (tools/list) : si la conversion d'un
// schéma zod échoue, tout le serveur disparaît pour l'agent, sans erreur visible dans l'interface (incident
// du 10/10/2026 : `z.record` de zod 4 n'est pas accepté par le convertisseur du SDK, aucun outil `vault`).
// Services voisins simulés : seule la déclaration des outils est exercée, sans base ni réseau.
vi.mock('./service.js', () => ({ vaultService: {} }));
vi.mock('./ssh.js', () => ({}));
vi.mock('./postgres.js', () => ({}));
vi.mock('../browser/fill.js', () => ({ browserFill: vi.fn() }));

const { createVaultMcpServer } = await import('./mcp.js');

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

describe('serveur MCP vault', () => {
  it('expose tous ses outils au CLI (tools/list réussit, schémas convertis)', async () => {
    const server = createVaultMcpServer({
      project: { id: 'p', slug: 'projet' } as Project,
      sessionId: 's',
      ownerId: 'u',
      cwd: '/tmp',
      emit: async () => {},
      remembered: async () => false,
      approve: async () => {},
    });
    const tools = await listTools(server);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['browser_fill', 'http_request', 'list', 'sql_query', 'sql_schema', 'ssh_download', 'ssh_run', 'ssh_upload']);
    const http = tools.find((t) => t.name === 'http_request')!;
    const props = http.inputSchema.properties as Record<string, { type?: string; additionalProperties?: unknown }>;
    expect(props.query.type).toBe('object');
    expect(props.query.additionalProperties).toEqual({ type: 'string' });
    expect(props.headers.additionalProperties).toEqual({ type: 'string' });
  });
});
