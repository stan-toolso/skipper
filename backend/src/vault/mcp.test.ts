import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { VaultItem } from './types.js';

// Le CLI Claude liste les outils d'un serveur in-process au démarrage (tools/list) : si la conversion d'un
// schéma zod échoue, tout le serveur disparaît pour l'agent, sans erreur visible dans l'interface (incident
// du 10/10/2026 : `z.record` de zod 4 refusé par le convertisseur du SDK, aucun outil `vault`).
// Services voisins simulés : la déclaration des outils et les outils PostgreSQL sont exercés, sans base ni réseau.
const { service, query } = vi.hoisted(() => ({ service: {} as Record<string, unknown>, query: vi.fn() }));
vi.mock('./service.js', () => ({ vaultService: service }));
vi.mock('./awsService.js', () => ({ awsService: {} }));
vi.mock('./ssh.js', () => ({}));
vi.mock('../browser/fill.js', () => ({ browserFill: {} }));
vi.mock('./postgres.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./postgres.js')>()), query }));

const { createVaultMcpServer } = await import('./mcp.js');

const pgItem = (over: Partial<VaultItem> = {}): VaultItem =>
  ({
    id: 'i1',
    name: 'rds',
    kind: 'postgres',
    description: '',
    ownerUserId: null,
    ownerProjectId: 'p',
    settings: { host: 'db.example.org', port: 5432, username: 'skipper', database: null, ssl: true, sslCa: null, viaItemId: null },
    readOnly: false,
    requireApproval: false,
    commandAllowlist: [],
    ...over,
  }) as VaultItem;

const approvals: Array<{ toolName: string; key: string; input: Record<string, unknown> }> = [];
const events: Array<Record<string, unknown>> = [];
let items: VaultItem[] = [];

beforeEach(() => {
  approvals.length = 0;
  events.length = 0;
  query.mockReset();
  items = [pgItem()];
  Object.assign(service, {
    agentItems: async () => items,
    agentItemByName: async (_p: string, _o: string | null, name: string) => {
      const i = items.find((x) => x.name === name);
      if (!i) throw new Error(`Aucun élément « ${name} »`);
      return i;
    },
    postgresCredentials: async (item: VaultItem, database?: string | null) => ({ host: 'db.example.org', port: 5432, username: 'skipper', database: database ?? 'postgres', ssl: true, sslCa: null, password: null, via: null }),
    audit: async () => undefined,
  });
});

async function connect(server: McpSdkServerConfigWithInstance) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

const server = () =>
  createVaultMcpServer({
    project: { id: 'p', name: 'Projet', slug: 'projet' } as Project,
    sessionId: 's',
    ownerId: 'u',
    cwd: '/tmp',
    emit: async (type, payload) => {
      events.push({ type, ...payload });
    },
    remembered: async () => false,
    approve: async (a) => {
      approvals.push({ toolName: a.toolName, key: a.key, input: a.input });
    },
  });

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe('serveur MCP vault', () => {
  it('expose tous ses outils au CLI (tools/list réussit, schémas convertis)', async () => {
    const client = await connect(server());
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(['aws_run', 'browser_fill', 'http_request', 'list', 'sql_query', 'sql_schema', 'ssh_download', 'ssh_run', 'ssh_upload']);
      const props = (name: string) => tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { type?: string; additionalProperties?: unknown }>;
      expect(Object.keys(props('sql_query')).sort()).toEqual(['database', 'item', 'sql']);
      expect(Object.keys(props('sql_schema')).sort()).toEqual(['database', 'item', 'table']);
      expect(props('http_request').query.type).toBe('object');
    } finally {
      await client.close();
    }
  });

  it('list signale un élément rattaché à un serveur entier', async () => {
    items = [pgItem(), pgItem({ id: 'i2', name: 'app', settings: { ...(pgItem().settings as object), database: 'app' } as VaultItem['settings'] })];
    const client = await connect(server());
    try {
      const res = (await client.callTool({ name: 'list', arguments: {} })) as ToolResult;
      expect(res.content[0].text).toContain('rds · Base PostgreSQL · skipper@db.example.org:5432 (serveur entier : toutes les bases, paramètre database, postgres par défaut)');
      expect(res.content[0].text).toContain('app · Base PostgreSQL · skipper@db.example.org:5432/app');
    } finally {
      await client.close();
    }
  });

  it('sql_schema sans base liste les bases d’un serveur entier, avec une base décrit ses tables', async () => {
    query.mockResolvedValue({ statements: [{ command: 'SELECT', rowCount: 0, fields: ['database'], rows: [], truncated: false }], durationMs: 1, sshHostKey: null });
    const client = await connect(server());
    try {
      await client.callTool({ name: 'sql_schema', arguments: { item: 'rds' } });
      expect(query.mock.calls[0][1]).toContain('FROM pg_database');
      expect(query.mock.calls[0][0].database).toBe('postgres');
      await client.callTool({ name: 'sql_schema', arguments: { item: 'rds', database: 'app' } });
      expect(query.mock.calls[1][1]).toContain('information_schema.tables');
      expect(query.mock.calls[1][0].database).toBe('app');
      expect(events.map((e) => e.summary)).toEqual(['(bases)', '[app] (tables)']);
    } finally {
      await client.close();
    }
  });

  it('sql_query transmet la base demandée et journalise un événement connection', async () => {
    query.mockResolvedValue({ statements: [{ command: 'SELECT', rowCount: 1, fields: ['n'], rows: [{ n: 1 }], truncated: false }], durationMs: 2, sshHostKey: null });
    const client = await connect(server());
    try {
      const res = (await client.callTool({ name: 'sql_query', arguments: { item: 'rds', sql: 'SELECT 1 AS n', database: 'app' } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('| n |');
      expect(query.mock.calls[0][0].database).toBe('app');
      expect(query.mock.calls[0][2]).toBe(false);
      expect(events).toEqual([expect.objectContaining({ type: 'connection', connection: 'rds', action: 'sql_query', summary: '[app] SELECT 1 AS n', ok: true })]);
      expect(approvals).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('sql_query avec approbation requise passe par la porte, et refuse une base étrangère à un élément rattaché', async () => {
    items = [pgItem({ requireApproval: true })];
    query.mockResolvedValue({ statements: [{ command: 'SELECT', rowCount: 0, fields: [], rows: [], truncated: false }], durationMs: 1, sshHostKey: null });
    Object.assign(service, {
      postgresCredentials: async (_item: VaultItem, database?: string | null) => {
        if (database === 'autre') throw new Error('« rds » est rattaché à la base app : la base « autre » n\'y est pas accessible');
        return { host: 'db.example.org', port: 5432, username: 'skipper', database: 'app', ssl: true, sslCa: null, password: null, via: null };
      },
    });
    const client = await connect(server());
    try {
      await client.callTool({ name: 'sql_query', arguments: { item: 'rds', sql: 'SELECT 1' } });
      expect(approvals).toEqual([{ toolName: 'mcp__vault__sql_query', key: 'rds', input: { item: 'rds', sql: 'SELECT 1', database: null } }]);
      const res = (await client.callTool({ name: 'sql_query', arguments: { item: 'rds', sql: 'SELECT 1', database: 'autre' } })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('la base « autre » n\'y est pas accessible');
      expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'connection', action: 'sql_query', ok: false }));
    } finally {
      await client.close();
    }
  });
});
