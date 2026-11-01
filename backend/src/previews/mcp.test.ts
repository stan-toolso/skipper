import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewInfo } from './service.js';

// Le CLI liste les outils au démarrage de la session : un schéma refusé ferait disparaître tout le serveur (voir
// vault/mcp.test.ts). Service des aperçus simulé : sans base, sans conteneur.
const service = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock('./service.js', () => ({ previewService: service, CAPTURE_SIZES: { desktop: [1280, 800], mobile: [390, 844] } }));

const { createPreviewMcpServer } = await import('./mcp.js');

const info = (over: Partial<PreviewInfo> = {}): PreviewInfo => ({
  worksessionId: 'w1',
  enabled: true,
  status: 'RUNNING',
  configured: true,
  configSource: '.skipper/preview.json',
  configError: null,
  command: 'npm run dev',
  url: 'https://ma-branche-p-abc123.apercu.example.org',
  error: null,
  startedAt: new Date(),
  readyAt: new Date(),
  depsMode: 'snapshot',
  installCommand: null,
  installMs: null,
  readyMs: 3400,
  ...over,
});

beforeEach(() => {
  Object.assign(service, {
    get: vi.fn(async () => info({ status: 'STOPPED' })),
    start: vi.fn(async () => info({ status: 'STARTING' })),
    waitSettled: vi.fn(async () => info()),
    stop: vi.fn(async () => info({ status: 'STOPPED' })),
    internalUrl: vi.fn(async () => 'http://localhost:41000'),
    logTail: vi.fn(async () => '› npm run dev\nprêt'),
    screenshot: vi.fn(async () => ({ file: '/w/.skipper-previews/w1/captures/x.png', png: Buffer.from('png'), url: 'http://localhost:41000/tasks' })),
  });
});

async function connect() {
  const server = createPreviewMcpServer({ worksessionId: 'w1', ownerId: 'u1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

const textOf = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '');

describe('serveur MCP preview', () => {
  it('liste ses outils (schémas acceptés par le SDK)', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['log', 'screenshot', 'start', 'status', 'stop']);
  });

  it('start lance l’aperçu de sa work session, attend, et donne lien public et adresse interne', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'start', arguments: { wait_seconds: 30 } });
    expect(service.start).toHaveBeenCalledWith('w1', 'u1');
    expect(service.waitSettled).toHaveBeenCalledWith('w1', 30_000);
    expect(textOf(r)).toContain('prêt');
    expect(textOf(r)).toContain('https://ma-branche-p-abc123.apercu.example.org');
    expect(textOf(r)).toContain('http://localhost:41000');
  });

  it('start encore en installation au bout du délai : état lisible et invitation à rappeler status', async () => {
    service.waitSettled.mockResolvedValueOnce(info({ status: 'INSTALLING' }));
    const client = await connect();
    const r = await client.callTool({ name: 'start', arguments: { wait_seconds: 5 } });
    expect(textOf(r)).toContain('installation des dépendances');
    expect(textOf(r)).toContain('preview.status');
  });

  it('start ne relance pas un lancement en cours ou prêt, sauf restart', async () => {
    service.get.mockResolvedValueOnce(info({ status: 'INSTALLING' }));
    const client = await connect();
    const r = await client.callTool({ name: 'start', arguments: { wait_seconds: 0 } });
    expect(service.start).not.toHaveBeenCalled();
    expect(service.waitSettled).toHaveBeenCalledWith('w1', 0);
    expect(textOf(r)).toContain('sans le relancer');
    service.get.mockResolvedValueOnce(info({ status: 'RUNNING' }));
    const ready = await client.callTool({ name: 'start', arguments: {} });
    expect(service.start).not.toHaveBeenCalled();
    expect(textOf(ready)).toContain('Déjà lancé');
    await client.callTool({ name: 'start', arguments: { restart: true } });
    expect(service.start).toHaveBeenCalledWith('w1', 'u1');
  });

  it('start joint la fin du journal en cas d’échec', async () => {
    service.waitSettled.mockResolvedValueOnce(info({ status: 'FAILED', error: "L'installation a échoué (code 1)" }));
    const client = await connect();
    const r = await client.callTool({ name: 'start', arguments: {} });
    expect(service.waitSettled).toHaveBeenCalledWith('w1', 90_000);
    expect(textOf(r)).toContain('échec');
    expect(textOf(r)).toContain('› npm run dev');
  });

  it('screenshot renvoie l’image PNG et le chemin du fichier ; une erreur reste un résultat', async () => {
    const client = await connect();
    const r = (await client.callTool({ name: 'screenshot', arguments: { path: '/tasks', size: 'mobile' } })) as { content: Array<{ type: string; data?: string; mimeType?: string }> };
    expect(service.screenshot).toHaveBeenCalledWith('w1', '/tasks', 'mobile');
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') });
    expect(textOf(r)).toContain('x.png');
    service.screenshot.mockRejectedValueOnce(new Error("L'aperçu n'est pas prêt"));
    const failed = (await client.callTool({ name: 'screenshot', arguments: {} })) as { isError?: boolean };
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("Erreur : L'aperçu n'est pas prêt");
  });
});
