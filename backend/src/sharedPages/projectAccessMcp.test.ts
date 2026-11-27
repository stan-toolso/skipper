import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// Outils pages.publish (project_access) et pages.share : le paramètre arrive au service, l'accès est décrit.
const state = vi.hoisted(() => ({ published: [] as Record<string, unknown>[], updates: [] as { userId: string; id: string; input: Record<string, unknown> }[] }));

vi.mock('./service.js', () => ({
  sharedPageService: {
    publish: async (input: Record<string, unknown>) => {
      state.published.push(input);
      return { id: 'p1', title: input.title, kind: 'page', version: 1, linkAccess: false, projectAccess: input.projectAccess ?? false };
    },
    update: async (userId: string, id: string, input: Record<string, unknown>) => {
      state.updates.push({ userId, id, input });
      return { id, title: 'Tableau', kind: 'page', version: 2, linkAccess: input.linkAccess ?? false, projectAccess: input.projectAccess ?? false };
    },
    members: async () => [],
    get: async () => ({ id: 'p1', linkAccess: false, projectAccess: false }),
    isShared: async () => false,
  },
}));

const { createSharedPagesMcpServer, sharedPagesPolicy } = await import('./mcp.js');

const cwd = await mkdtemp(path.join(tmpdir(), 'pages-access-'));
await writeFile(path.join(cwd, 'page.html'), '<html><body>ok</body></html>');

async function call(name: string, args: Record<string, unknown>) {
  const server = createSharedPagesMcpServer({ project: { id: 'proj' } as Project, session: { id: 's', ownerId: 'stan' }, cwd });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: Boolean(res.isError) };
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  state.published = [];
  state.updates = [];
});

describe('pages.publish project_access', () => {
  it('transmet project_access au service et décrit l’accès', async () => {
    const res = await call('publish', { path: 'page.html', title: 'Tableau', project_access: true });
    expect(res.isError).toBe(false);
    expect(state.published[0]).toMatchObject({ projectAccess: true, projectId: 'proj', ownerId: 'stan' });
    expect(res.text).toContain('accès : les membres du projet');
    expect(res.text).not.toContain('Privé');
  });

  it('absent : null (inchangé), et le rappel du partage', async () => {
    const res = await call('publish', { path: 'page.html', title: 'Tableau' });
    expect(state.published[0].projectAccess).toBeNull();
    expect(res.text).toContain('pages.share');
  });
});

describe('pages.share', () => {
  it('ouvre aux membres du projet au nom du propriétaire de la session', async () => {
    const res = await call('share', { page_id: 'p1', project_access: true });
    expect(res.isError).toBe(false);
    expect(state.updates).toEqual([{ userId: 'stan', id: 'p1', input: { projectAccess: true, linkAccess: null, publicAccess: null } }]);
    expect(res.text).toContain('les membres du projet');
  });

  it('refuse un appel sans changement', async () => {
    const res = await call('share', { page_id: 'p1' });
    expect(res.isError).toBe(true);
    expect(state.updates).toEqual([]);
  });
});

describe('politique de publication', () => {
  it('ouvrir aux membres du projet est soumis à la personne, comme le lien', async () => {
    expect(await sharedPagesPolicy({ project_access: true })).toBe('ask');
    expect(await sharedPagesPolicy({ project_access: false })).toBe('allow');
  });
});
