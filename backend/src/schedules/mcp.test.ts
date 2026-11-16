import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';
import type { SessionSchedule } from './types.js';

const h = vi.hoisted(() => ({
  role: 'member' as string | null,
  schedules: new Map<string, unknown>(),
  created: [] as unknown[][],
  updated: [] as unknown[][],
  enabled: [] as unknown[][],
  removed: [] as string[],
  ranNow: [] as unknown[][],
  audit: [] as Record<string, unknown>[],
}));

vi.mock('../users/repository.js', () => ({ userRepository: { findById: async (id: string) => ({ id, name: id, isSuperAdmin: false }) } }));
vi.mock('../users/service.js', () => ({ userService: { memberRoleFor: async () => h.role, isPersonalProject: async () => false } }));
vi.mock('../agents/service.js', () => ({
  agentService: {
    resolve: async (_projectId: string, ref: string) => {
      if (ref !== 'Ben' && ref !== 'ben-id') throw new Error(`Aucun agent « ${ref} » dans ce projet`);
      return { id: 'ben-id', name: 'Ben', projectId: 'p1' };
    },
  },
}));
vi.mock('../audit/service.js', () => ({ auditService: { record: async (e: Record<string, unknown>) => void h.audit.push(e) } }));
vi.mock('../billing/display.js', () => ({ describeCost: async (usd: number) => `${usd.toFixed(2)} $` }));
vi.mock('./service.js', () => ({
  scheduleLabel: (s: { name: string | null; prompt: string }) => s.name ?? s.prompt.slice(0, 20),
  scheduleService: {
    get: async (id: string) => h.schedules.get(id) ?? null,
    listForProjects: async (ids: string[]) => [...h.schedules.values()].filter((s) => ids.includes((s as SessionSchedule).projectId)),
    listRuns: async () => [
      { id: 'r1', scheduleId: 's1', runSessionId: 'sess1', trigger: 'schedule', triggeredBy: null, status: 'done', scheduledFor: null, startedAt: new Date('2026-11-12T08:00:00Z'), finishedAt: null, costUsd: 0.5, durationMs: 60_000, message: null, answer: null, startEventId: null },
    ],
    preview: () => [new Date('2026-11-14T08:00:00Z')],
    create: async (input: Record<string, unknown>, owner: unknown) => {
      h.created.push([input, owner]);
      return schedule({ id: 'new', name: input.name as string, cron: input.cron as string, prompt: input.prompt as string });
    },
    update: async (id: string, input: Record<string, unknown>, owner?: unknown) => {
      h.updated.push(owner === undefined ? [id, input] : [id, input, owner]);
      return { ...(h.schedules.get(id) as SessionSchedule), ...input };
    },
    setEnabled: async (id: string, enabled: boolean) => {
      h.enabled.push([id, enabled]);
      return { ...(h.schedules.get(id) as SessionSchedule), enabled };
    },
    remove: async (id: string) => void h.removed.push(id),
    runNow: async (id: string, userId: string | null) => {
      h.ranNow.push([id, userId]);
      return { id: 'run-session', name: 'Revue · 13/11 08:00' };
    },
  },
}));

const { createSchedulesMcpServer, scheduleInput } = await import('./mcp.js');

function schedule(over: Partial<SessionSchedule> = {}): SessionSchedule {
  return {
    id: 's1',
    projectId: 'p',
    ownerId: 'u',
    requestedById: null,
    provider: 'claude',
    config: { model: 'claude-sonnet-5-5' },
    name: 'Revue',
    cron: '0 8 * * *',
    timezone: 'Europe/Paris',
    prompt: 'Fais la revue',
    enabled: true,
    endAfterRun: true,
    archivePolicy: 'previous_on_run',
    archiveAfterMinutes: null,
    allowedTools: [],
    maxRunUsd: null,
    monthlyBudgetUsd: null,
    nextRunAt: new Date('2026-11-14T07:00:00Z'),
    lastRunAt: null,
    lastResult: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const project = { id: 'p', name: 'Projet', slug: 'projet' } as Project;

async function connect(opts: { ownerId?: string; requestedById?: string | null; rightsHolderId?: string } = {}) {
  const server = createSchedulesMcpServer({ project, sessionId: 'sess', ownerId: opts.ownerId ?? 'u', requestedById: opts.requestedById ?? null, rightsHolderId: opts.rightsHolderId ?? opts.ownerId ?? 'u' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };
  return { client, call };
}

afterEach(() => {
  h.role = 'member';
  h.schedules.clear();
  for (const list of [h.created, h.updated, h.enabled, h.removed, h.ranNow, h.audit]) list.length = 0;
});

describe('serveur MCP schedules', () => {
  it('liste ses outils', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['create', 'delete', 'get', 'list', 'pause', 'preview', 'resume', 'run_now', 'runs', 'update']);
  });

  it('liste, détaille et montre l’historique des planifications du projet seulement', async () => {
    h.schedules.set('s1', schedule());
    h.schedules.set('autre', schedule({ id: 'autre', projectId: 'q', name: 'Ailleurs' }));
    const { call } = await connect();
    const list = await call('list');
    expect(list.text).toContain('s1 · Revue · 0 8 * * * (Europe/Paris)');
    expect(list.text).not.toContain('Ailleurs');
    const get = await call('get', { id: 's1' });
    expect(get.text).toContain('modèle claude-sonnet-5-5');
    expect(get.text).toContain('Fais la revue');
    const other = await call('get', { id: 'autre' });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('introuvable dans ce projet');
    const runs = await call('runs', { id: 's1' });
    expect(runs.text).toContain('Terminée · 0.50 $ · 60 s · session sess1');
  });

  it('crée ou passe une planification au nom d’un agent du projet, la personne de la session en devenant la demandeuse', async () => {
    h.schedules.set('s1', schedule({ projectId: 'p' }));
    const { call } = await connect({ ownerId: 'stan' });
    const created = await call('create', { name: 'Tri', cron: '0 8 * * *', prompt: 'Trie les tâches', agent: 'Ben' });
    expect(created.isError).toBe(false);
    expect(h.created[0][1]).toEqual({ ownerId: 'ben-id', requestedById: 'stan' });
    const unknown = await call('create', { name: 'Tri', cron: '0 8 * * *', prompt: 'Trie', agent: 'Personne' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Aucun agent');
    await call('update', { id: 's1', agent: 'ben-id' });
    expect(h.updated[0][2]).toEqual({ ownerId: 'ben-id', requestedById: 'stan' });
    await call('update', { id: 's1', agent: '' });
    expect(h.updated[1][2]).toEqual({ ownerId: 'stan', requestedById: null });
    await call('update', { id: 's1', name: 'Autre' });
    expect(h.updated[2]).toHaveLength(2);
    expect(h.audit.at(1)?.details).toEqual({ fields: ['owner'] });
  });

  it('crée une planification au nom du propriétaire de la session, avec le demandeur d’un agent, et l’inscrit au journal', async () => {
    const { call } = await connect({ ownerId: 'agent', requestedById: 'stan', rightsHolderId: 'agent' });
    const r = await call('create', { name: 'Revue', cron: '0 8 * * 1-5', prompt: 'Fais la revue', timezone: 'Europe/Paris', model: 'claude-sonnet-5-5', allowed_tools: ['Bash(git status *)'] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Planification créée');
    const [input, owner] = h.created[0] as [Record<string, unknown>, unknown];
    expect(owner).toEqual({ ownerId: 'agent', requestedById: 'stan' });
    expect(input).toMatchObject({ projectId: 'p', provider: 'claude', name: 'Revue', cron: '0 8 * * 1-5', enabled: true, timezone: 'Europe/Paris', allowedTools: ['Bash(git status *)'], config: { model: 'claude-sonnet-5-5' }, runNow: false });
    expect(h.audit[0]).toMatchObject({ projectId: 'p', actor: { sessionId: 'sess' }, action: 'schedule.create', targetType: 'schedule', targetId: 'new' });
  });

  it('refuse les écritures à un simple lecteur et tout à qui n’est pas membre', async () => {
    h.schedules.set('s1', schedule());
    h.role = 'viewer';
    const { call } = await connect();
    expect((await call('list')).isError).toBe(false);
    const create = await call('create', { name: 'X', cron: '@daily', prompt: 'y' });
    expect(create.isError).toBe(true);
    expect(create.text).toContain('membre');
    expect((await call('delete', { id: 's1' })).isError).toBe(true);
    expect(h.created).toEqual([]);
    expect(h.removed).toEqual([]);
    h.role = null;
    expect((await call('list')).isError).toBe(true);
  });

  it('modifie seulement les champs donnés, met en pause, reprend, exécute et supprime', async () => {
    h.schedules.set('s1', schedule({ enabled: false }));
    const { call } = await connect({ ownerId: 'u' });
    const upd = await call('update', { id: 's1', cron: '0 9 * * *', model: '' });
    expect(upd.isError).toBe(false);
    expect(h.updated[0]).toEqual(['s1', { cron: '0 9 * * *', prompt: 'Fais la revue', timezone: 'Europe/Paris', enabled: false, config: { model: '' } }]);
    expect(h.audit[0]).toMatchObject({ action: 'schedule.set', details: { fields: ['cron', 'model'] } });
    await call('resume', { id: 's1' });
    await call('pause', { id: 's1' });
    expect(h.enabled).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
    const run = await call('run_now', { id: 's1' });
    expect(run.text).toContain('session run-session');
    expect(h.ranNow).toEqual([['s1', 'u']]);
    await call('delete', { id: 's1' });
    expect(h.removed).toEqual(['s1']);
    expect(h.audit.map((a) => a.action)).toEqual(['schedule.set', 'schedule.enable', 'schedule.enable', 'schedule.run', 'schedule.clear']);
  });
});

describe('scheduleInput', () => {
  it('exige cron et instruction à la création', () => {
    expect(() => scheduleInput({ prompt: 'x' })).toThrow(/cron/);
    expect(() => scheduleInput({ cron: '@daily' })).toThrow(/Instruction/);
  });
  it('garde la politique d’archivage en place quand seul le délai change', () => {
    const existing = schedule({ archivePolicy: 'after_delay', archiveAfterMinutes: 30 });
    expect(scheduleInput({ archive_after_minutes: 60 }, existing)).toMatchObject({ archivePolicy: 'after_delay', archiveAfterMinutes: 60 });
  });
});
