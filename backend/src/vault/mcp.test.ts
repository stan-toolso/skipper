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
const { service, query, sshMock, sessionSecrets, runIsolated, envFiles } = vi.hoisted(() => ({
  service: {} as Record<string, unknown>,
  query: vi.fn(),
  sshMock: { connect: vi.fn(), exec: vi.fn(), writeFile: vi.fn() },
  sessionSecrets: { find: vi.fn(), list: vi.fn(), values: vi.fn() },
  runIsolated: vi.fn(),
  envFiles: { list: vi.fn() },
}));
vi.mock('./service.js', () => ({ vaultService: service }));
vi.mock('./awsService.js', () => ({ awsService: {} }));
vi.mock('./scalewayService.js', () => ({ scalewayService: {} }));
vi.mock('./ssh.js', () => sshMock);
vi.mock('../browser/fill.js', () => ({ browserFill: {} }));
vi.mock('./sessionSecrets.js', () => ({ sessionSecretService: sessionSecrets }));
vi.mock('../runners/index.js', () => ({ runner: { runIsolated } }));
vi.mock('../envFiles/service.js', () => ({ envFileService: envFiles }));
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
      expect(tools.map((t) => t.name).sort()).toEqual(['aws_run', 'browser_fill', 'http_request', 'list', 'run_with_secrets', 'scw_api', 'scw_run', 'sql_query', 'sql_schema', 'ssh_download', 'ssh_run', 'ssh_upload', 'ssh_write_secret', 'write_env_secret']);
      const props = (name: string) => tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { type?: string; additionalProperties?: unknown }>;
      expect(props('scw_api').query.type).toBe('object');
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

describe('secrets : demande par une modale et usage sans les voir', () => {
  const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----';
  const sshItem = (over: Partial<VaultItem> = {}) =>
    ({ id: 'h1', name: 'prod', kind: 'ssh', description: '', ownerUserId: null, ownerProjectId: 'p', settings: { host: 'h', port: 22, username: 'u' }, hostKey: null, readOnly: false, requireApproval: false, commandAllowlist: [], ...over }) as VaultItem;
  const secretItem = (over: Partial<VaultItem> = {}) =>
    ({ id: 's1', name: 'cle', kind: 'secret', description: '', ownerUserId: null, ownerProjectId: 'p', settings: { fields: [{ key: 'private_key', label: 'Clé', secret: true, value: null }] }, readOnly: true, requireApproval: true, commandAllowlist: [], ...over }) as VaultItem;
  const asks: Array<Record<string, unknown>> = [];

  const withAsk = (response: Record<string, unknown>) =>
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
      ask: async (input) => {
        asks.push(input as unknown as Record<string, unknown>);
        return response;
      },
    });

  beforeEach(() => {
    asks.length = 0;
    items = [sshItem(), secretItem()];
    sshMock.connect.mockReset().mockResolvedValue({ hostKey: null, close: () => undefined });
    sshMock.exec.mockReset();
    sshMock.writeFile.mockReset().mockResolvedValue(undefined);
    Object.assign(service, {
      rememberHostKey: async () => undefined,
      sshCredentials: () => ({ host: 'h', port: 22, username: 'u', privateKey: 'x' }),
      assertCommandAllowed: () => undefined,
      fieldCredentials: () => ({ url: null, fields: [{ key: 'private_key', label: 'Clé', secret: true, value: KEY, variable: 'CLE_PRIVATE_KEY' }] }),
    });
  });

  it('ssh_write_secret écrit la valeur sur le serveur (600, saut de ligne final) sans la renvoyer, après accord pour le secret', async () => {
    const client = await connect(withAsk({}));
    try {
      const res = (await client.callTool({ name: 'ssh_write_secret', arguments: { item: 'prod', secret: 'cle.private_key', remote_path: '/home/u/.ssh/id_ed25519' } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(sshMock.writeFile).toHaveBeenCalledWith(expect.anything(), '/home/u/.ssh/id_ed25519', `${KEY}\n`, 0o600);
      expect(res.content[0].text).not.toContain('PRIVATE KEY');
      expect(approvals).toEqual([expect.objectContaining({ toolName: 'mcp__vault__ssh_write_secret', key: 'cle' })]);
      expect(JSON.stringify(events)).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmU');
      const bad = (await client.callTool({ name: 'ssh_write_secret', arguments: { item: 'prod', secret: 'cle.private_key', remote_path: '/x', mode: '999' } })) as ToolResult;
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("ssh_run avec stdin_secret passe la valeur sur l'entrée standard et la masque dans la sortie", async () => {
    sshMock.exec.mockResolvedValue({ stdout: `lu : ${KEY}\n`, stderr: '', exitCode: 0, signal: null, truncated: false, durationMs: 3 });
    const client = await connect(withAsk({}));
    try {
      const res = (await client.callTool({ name: 'ssh_run', arguments: { item: 'prod', command: 'cat', stdin_secret: 'cle.private_key' } })) as ToolResult;
      expect(sshMock.exec.mock.calls[0][2]).toEqual(expect.objectContaining({ stdin: KEY }));
      expect(res.content[0].text).toContain('[secret masqué]');
      expect(res.content[0].text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmU');
    } finally {
      await client.close();
    }
  });

  it('request_secrets pose une demande « secrets » et ne renvoie que le nom et les clés', async () => {
    items = [sshItem()];
    const client = await connect(withAsk({ item: 'deploy-key', itemId: 'n1', fields: ['private_key'], created: true, destination: 'personal', requireApproval: true }));
    try {
      const res = (await client.callTool({
        name: 'request_secrets',
        arguments: { item: 'deploy-key', reason: 'Installer la clé de déploiement', fields: [{ key: 'private_key', label: 'Clé privée', multiline: true }] },
      })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(asks[0]).toEqual(
        expect.objectContaining({
          type: 'secrets',
          message: 'Installer la clé de déploiement',
          payload: expect.objectContaining({ item: 'deploy-key', itemId: null, personalUserId: 'u', fields: [{ key: 'private_key', label: 'Clé privée', hint: null, multiline: true }] }),
        }),
      );
      expect(res.content[0].text).toContain('`deploy-key.private_key`');
      const clash = (await client.callTool({ name: 'request_secrets', arguments: { item: 'prod', reason: 'x', fields: [{ key: 'token' }] } })) as ToolResult;
      expect(clash.isError).toBe(true);
      expect(clash.content[0].text).toContain("n'est pas un secret");
    } finally {
      await client.close();
    }
  });

  it('run_with_secrets passe les secrets (coffre et session) en variables du conteneur jetable et masque la sortie', async () => {
    sessionSecrets.find.mockResolvedValue({ id: 'x', sessionId: 's', name: 'brevo', fields: [{ key: 'token', label: 'Jeton' }], requireApproval: false, expiresAt: new Date() });
    sessionSecrets.values.mockResolvedValue({ token: 'xkeysib-123456789' });
    runIsolated.mockReset().mockResolvedValue({ stdout: 'jeton xkeysib-123456789\n', stderr: '', exitCode: 0, signal: null, truncated: false, durationMs: 5 });
    const client = await connect(withAsk({}));
    try {
      const res = (await client.callTool({ name: 'run_with_secrets', arguments: { command: './deploy.sh', env: { BREVO: 'session:brevo.token', KEY: 'cle.private_key' } } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(runIsolated).toHaveBeenCalledTimes(1);
      expect(runIsolated.mock.calls[0][1]).toEqual(expect.objectContaining({ cwd: '/tmp', command: ['sh', '-c', './deploy.sh'], env: { BREVO: 'xkeysib-123456789', KEY } }));
      expect(res.content[0].text).toContain('jeton [secret masqué]');
      // Le secret du coffre (accord requis) passe par la porte ; celui de session (sans accord) non.
      expect(approvals.map((a) => a.key)).toEqual(['cle']);
      expect(events.some((e) => e.connection === 'session:brevo' && e.ok === true)).toBe(true);
      const bad = (await client.callTool({ name: 'run_with_secrets', arguments: { command: 'x', env: { PATH: 'cle.private_key' } } })) as ToolResult;
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("write_env_secret écrit la variable (600, exclue de git), toujours avec accord, et refuse un élément non ouvert à l'environnement", async () => {
    const { mkdtemp, readFile, stat } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(`${os.tmpdir()}/envsecret-`);
    sessionSecrets.find.mockResolvedValue({ id: 'x', sessionId: 's', name: 'brevo', fields: [{ key: 'token', label: 'Jeton' }], requireApproval: false, expiresAt: new Date() });
    sessionSecrets.values.mockResolvedValue({ token: 'a b"c' });
    envFiles.list.mockResolvedValue([{ path: '.env' }]);
    const srv = createVaultMcpServer({
      project: { id: 'p', name: 'Projet', slug: 'projet' } as Project,
      sessionId: 's',
      ownerId: 'u',
      cwd: dir,
      emit: async (type, payload) => {
        events.push({ type, ...payload });
      },
      remembered: async () => false,
      approve: async (a) => {
        approvals.push({ toolName: a.toolName, key: a.key, input: a.input });
      },
    });
    const client = await connect(srv);
    try {
      const managed = (await client.callTool({ name: 'write_env_secret', arguments: { path: '.env', name: 'BREVO', secret: 'session:brevo.token' } })) as ToolResult;
      expect(managed.isError).toBe(true);
      const res = (await client.callTool({ name: 'write_env_secret', arguments: { path: '.env.local', name: 'BREVO', secret: 'session:brevo.token' } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).not.toContain('a b');
      expect(await readFile(`${dir}/.env.local`, 'utf8')).toBe('BREVO="a b\\"c"\n');
      expect((await stat(`${dir}/.env.local`)).mode & 0o777).toBe(0o600);
      expect(approvals).toEqual([expect.objectContaining({ toolName: 'mcp__vault__write_env_secret', key: 'session:brevo' })]);
      const vaultItem = (await client.callTool({ name: 'write_env_secret', arguments: { path: '.env.local', name: 'KEY', secret: 'cle.private_key' } })) as ToolResult;
      expect(vaultItem.isError).toBe(true);
      expect(vaultItem.content[0].text).toContain("n'est pas ouvert aux fichiers d'environnement");
    } finally {
      await client.close();
    }
  });
});
