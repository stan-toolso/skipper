import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { GoogleAccount } from './types.js';

// Le CLI Claude liste les outils d'un serveur in-process au démarrage (tools/list) : si la conversion d'un
// schéma zod échoue, tout le serveur disparaît pour l'agent sans erreur visible (voir dev/outils-mcp-agents).
// Services voisins simulés : seule la déclaration des outils et l'outil gmail_attachment sont exercés.
const { downloadAttachment } = vi.hoisted(() => ({ downloadAttachment: vi.fn() }));
vi.mock('./service.js', () => ({ accessLabels: { none: 'aucun accès', read: 'lecture', write: 'lecture et écriture' } }));
vi.mock('./drive.js', () => ({}));
vi.mock('./gmail.js', () => ({ downloadAttachment }));

const { createGoogleMcpServer } = await import('./mcp.js');

const account = (over: Partial<GoogleAccount> = {}): GoogleAccount => ({
  id: 'g1',
  name: 'google-tresorier@example.org',
  email: 'tresorier@example.org',
  displayName: null,
  avatarUrl: null,
  googleSub: 'sub',
  gmailAccess: 'write',
  driveAccess: 'write',
  scopes: [],
  requireApproval: false,
  ...over,
});

async function connect(server: McpSdkServerConfigWithInstance) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

let cwd: string;
const events: Array<Record<string, unknown>> = [];
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'google-mcp-'));
  events.length = 0;
  downloadAttachment.mockReset();
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

const server = (accounts: GoogleAccount[]) =>
  createGoogleMcpServer({
    project: { id: 'p', name: 'Projet', slug: 'projet' } as Project,
    accounts,
    sessionId: 's',
    cwd,
    emit: async (type, payload) => {
      events.push({ type, ...payload });
    },
  });

describe('serveur MCP google', () => {
  it('expose tous ses outils au CLI (tools/list réussit, schémas convertis)', async () => {
    const client = await connect(server([account()]));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['account', 'drive_download', 'drive_read', 'drive_search', 'drive_upload', 'drive_write', 'gmail_attachment', 'gmail_read', 'gmail_search', 'gmail_send']);
    } finally {
      await client.close();
    }
  });

  it("n'expose que les lectures Gmail à un compte en lecture seule sans Drive", async () => {
    const client = await connect(server([account({ gmailAccess: 'read', driveAccess: 'none' })]));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['account', 'gmail_attachment', 'gmail_read', 'gmail_search']);
    } finally {
      await client.close();
    }
  });

  it('gmail_attachment écrit dans le dossier de travail et journalise un événement connection', async () => {
    downloadAttachment.mockImplementation(async (_acct: string, _msg: string, _which: string, resolve: (name: string) => string) => {
      const localPath = resolve('ticket.jpeg');
      return { filename: 'ticket.jpeg', mimeType: 'image/jpeg', bytes: 3, localPath };
    });
    const client = await connect(server([account({ gmailAccess: 'read', driveAccess: 'none' })]));
    try {
      const res = (await client.callTool({ name: 'gmail_attachment', arguments: { message_id: 'm1', attachment: '1', local_path: 'pj/ticket.jpeg' } })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe('Pièce jointe « ticket.jpeg » (image/jpeg) enregistrée dans pj/ticket.jpeg (3 octets).');
      expect(downloadAttachment).toHaveBeenCalledWith('g1', 'm1', '1', expect.any(Function));
      expect(events).toEqual([expect.objectContaining({ type: 'connection', connection: 'tresorier@example.org', kind: 'gmail', action: 'gmail_attachment', ok: true, note: 'ticket.jpeg · 3 octets' })]);

      // Sans chemin : le nom du fichier à la racine du dossier de travail.
      await client.callTool({ name: 'gmail_attachment', arguments: { message_id: 'm1', attachment: 'ticket.jpeg' } });
      const resolve = downloadAttachment.mock.calls[1][3] as (name: string) => string;
      expect(resolve('ticket.jpeg')).toBe(path.join(cwd, 'ticket.jpeg'));

      // Un chemin qui sort du dossier de travail est refusé, et l'échec journalisé.
      const out = (await client.callTool({ name: 'gmail_attachment', arguments: { message_id: 'm1', attachment: '1', local_path: '../ailleurs.jpeg' } })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain('doit rester dans le dossier de travail');
      expect(events.at(-1)).toEqual(expect.objectContaining({ action: 'gmail_attachment', ok: false }));
    } finally {
      await client.close();
    }
  });
});
