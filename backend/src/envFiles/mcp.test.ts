import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// Le CLI liste les outils au démarrage : un schéma zod refusé ferait disparaître tout le serveur (voir vault/mcp.test.ts).
const h = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./service.js', () => ({
  envFileService: {
    list: async () => [{ path: '.env', content: 'A=1\n', applyOnCreate: true }],
    byPath: async () => ({ path: '.env', content: 'A=1\nB={{vault:rds.url}}\n', applyOnCreate: true }),
    isDotenv: () => true,
    keys: () => [
      { key: 'A', value: '1', refs: [] },
      { key: 'B', value: '{{vault:rds.url}}', refs: [{ item: 'rds', field: 'url' }] },
    ],
    problems: async () => [],
    setKey: async (...args: unknown[]) => {
      h.calls.push(args);
      return { path: '.env', content: 'A=1\n' };
    },
    applyKey: async () => ({ written: ['.env'], skipped: [], problems: [] }),
  },
}));
vi.mock('../worksessions/service.js', () => ({ worksessionService: { assertUsable: async () => ({ id: 'w', name: 'w' }) } }));

const { createEnvMcpServer } = await import('./mcp.js');

describe('serveur MCP env', () => {
  it('liste ses outils et répond', async () => {
    const server = createEnvMcpServer({ project: { id: 'p', name: 'P' } as Project, sessionId: 's', ownerId: 'u', worksessionId: 'w' });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['apply', 'keys', 'list', 'set', 'unset']);
    const keys = (await client.callTool({ name: 'keys', arguments: { path: '.env' } })) as { content: { text: string }[] };
    expect(keys.content[0].text).toContain('B = {{vault:rds.url}}  (coffre)');
    const set = (await client.callTool({ name: 'set', arguments: { path: '.env', key: 'NEW', value: 'v' } })) as { content: { text: string }[] };
    expect(set.content[0].text).toContain('NEW enregistrée dans .env');
    expect(h.calls[0]).toEqual(['p', '.env', 'NEW', 'v', { userId: 'u', sessionId: 's' }]);
  });
});
