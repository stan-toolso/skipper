import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from './dataSources.js';
import type { SharedPage } from './types.js';

const state = vi.hoisted(() => ({
  sources: [] as DataSource[],
  saved: [] as { id: string; status: string; data?: unknown; error?: string }[],
  item: { id: 'i1', name: 'base', kind: 'postgres', requireApproval: false, readOnly: true } as Record<string, unknown>,
  member: 'member' as string | null,
  exec: { stdout: '[{"a":1}]', code: 0 },
  audits: [] as string[],
  marked: 0,
  running: [] as { id: string; sessionId: string }[],
  agentData: [] as { id: string; data: unknown }[],
  created: [] as Record<string, unknown>[],
  summoned: [] as { agentId: string; text: string }[],
  sent: [] as string[],
  sessions: {} as Record<string, { status: string; activity: string | null; archivedAt: Date | null }>,
  evaluated: [] as string[][],
  claudeChecked: [] as (string | null)[],
}));

vi.mock('./dataRepository.js', () => ({
  dataSourceRepository: {
    list: async () => state.sources,
    saveSuccess: async (id: string, data: unknown) => void state.saved.push({ id, status: 'ok', data }),
    saveFailure: async (id: string, status: string, error: string) => void state.saved.push({ id, status, error }),
    replace: async () => undefined,
    dataOf: async () => ({}),
    markRunning: async (id: string, sessionId: string) => void state.running.push({ id, sessionId }),
    saveAgentData: async (id: string, data: unknown) => void state.agentData.push({ id, data }),
  },
}));
vi.mock('./alertRepository.js', () => ({ alertRepository: { pruneMissingSources: async () => [] } }));
vi.mock('./alertService.js', () => ({ alertService: { evaluate: async (_p: unknown, names: string[]) => (state.evaluated.push(names), []) } }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { findById: async (id: string) => state.sessions[id] ?? null } }));
vi.mock('../sessions/service.js', () => ({
  sessionService: {
    create: async (input: Record<string, unknown>) => (state.created.push(input), { id: 'new-session' }),
    sendMessage: async (_id: string, text: string) => void state.sent.push(text),
    waitForIdle: () => new Promise(() => undefined),
  },
}));
vi.mock('../agents/service.js', () => ({
  agentService: {
    resolve: async (_p: string, ref: string) => ({ id: `agent-${ref}` }),
    // Un agent joue avec le compte Claude qu'une personne lui prête.
    accountsForOwner: async (id: string) => ({ claudeUserId: id.startsWith('agent-') ? `lender-of-${id}` : id }),
    summon: async (agentId: string, opts: { text: string }) => (state.summoned.push({ agentId, text: opts.text }), { id: 'agent-session' }),
  },
}));
vi.mock('../settings/claude.js', () => ({ claudeSettings: { forSession: async (id: string | null) => (state.claudeChecked.push(id), { assertCredentials: () => undefined, assertBudgetAvailable: async () => undefined }) } }));
vi.mock('../projects/budget.js', () => ({ projectBudget: { assertAvailable: async () => undefined } }));
vi.mock('./repository.js', () => ({ sharedPageRepository: { snapshotLatest: async () => undefined, version: async () => null, markDataRefreshed: async () => void state.marked++, update: async (_id: string, patch: unknown) => ({ ...page(), ...(patch as object) }), dueForRefresh: async () => [] } }));
vi.mock('./service.js', () => ({ sharedPageService: { get: async () => page(), getManaged: async () => page() } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, name: 'Projet', slug: 'projet' }) } }));
vi.mock('../users/service.js', () => ({ userService: { memberRoleFor: async () => state.member, get: async () => ({ id: 'owner', isAdmin: false }) } }));
vi.mock('../vault/service.js', () => ({
  vaultService: {
    agentItemByName: async () => state.item,
    postgresCredentials: async () => ({ host: 'h', via: null }),
    rememberHostKey: async () => undefined,
    audit: async (_i: unknown, _a: string, _actor: unknown, detail: string, ok = true) => void state.audits.push(`${ok ? 'ok' : 'ko'} ${detail}`),
  },
}));
vi.mock('../vault/postgres.js', () => ({
  query: async (_c: unknown, sql: string, readOnly: boolean) => {
    if (!readOnly) throw new Error('doit être en lecture seule');
    if (/boom/.test(sql)) throw new Error('relation inexistante');
    return { statements: [{ command: 'SELECT', rowCount: 2, fields: ['jour', 'n'], rows: [{ jour: '2026-11-01', n: '3' }, { jour: '2026-11-02', n: '5' }], truncated: false }], durationMs: 1, sshHostKey: null };
  },
}));
vi.mock('../runners/index.js', () => ({
  runner: {
    putFile: async () => undefined,
    exec: async () => state.exec,
    removePath: async () => undefined,
  },
}));
vi.mock('../log.js', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));

const page = (extra: Partial<SharedPage> = {}): SharedPage => ({ id: 'p1', ownerId: 'owner', title: 'Tableau', description: null, linkAccess: false, projectAccess: false, version: 1, projectId: 'pr', sessionId: null, sourcePath: null, agentHandoff: 'manual', historyEnabled: true, kind: 'data', refreshMinutes: null, dataRefreshedAt: null, viewedAt: null, createdAt: new Date(), updatedAt: new Date(), ...extra });
const source = (extra: Partial<DataSource>): DataSource => ({ id: 's1', pageId: 'p1', name: 'ventes', kind: 'sql', config: { item: 'base', database: null, query: 'SELECT 1' }, position: 0, data: null, rowCount: null, status: 'pending', error: null, durationMs: null, refreshedAt: null, attemptedAt: null, ...extra });

const { artifactDataService } = await import('./dataService.js');

beforeEach(() => {
  state.sources = [];
  state.saved = [];
  state.audits = [];
  state.item = { id: 'i1', name: 'base', kind: 'postgres', requireApproval: false, readOnly: true };
  state.member = 'member';
  state.exec = { stdout: '[{"a":1}]', code: 0 };
  state.marked = 0;
  state.running = [];
  state.agentData = [];
  state.created = [];
  state.summoned = [];
  state.sent = [];
  state.sessions = {};
  state.evaluated = [];
  state.claudeChecked = [];
});

describe('artifactDataService.refresh', () => {
  it('exécute une source SQL en lecture seule, normalise les lignes et journalise dans le coffre', async () => {
    state.sources = [source({})];
    await artifactDataService.refresh(page(), 'auto');
    expect(state.saved).toEqual([{ id: 's1', status: 'ok', data: { columns: ['jour', 'n'], rows: [{ jour: '2026-11-01', n: 3 }, { jour: '2026-11-02', n: 5 }] } }]);
    expect(state.audits[0]).toMatch(/^ok data_refresh : \[artefact Tableau\] SELECT 1$/);
    expect(state.marked).toBe(1);
    // Les alertes des sources exécutées sont évaluées après le rafraîchissement.
    expect(state.evaluated).toEqual([['ventes']]);
  });

  it('garde une erreur SQL sur la source (données précédentes conservées) et continue avec les autres', async () => {
    state.sources = [source({ id: 's1', config: { item: 'base', database: null, query: 'SELECT boom' } }), source({ id: 's2', name: 'autre' })];
    await artifactDataService.refresh(page(), 'auto');
    expect(state.saved.map((s) => [s.id, s.status])).toEqual([['s1', 'error'], ['s2', 'ok']]);
    expect(state.saved[0].error).toMatch(/relation inexistante/);
    expect(state.audits[0]).toMatch(/^ko /);
  });

  it('saute un élément soumis à approbation en mode automatique, pas quand une personne rafraîchit', async () => {
    state.item.requireApproval = true;
    state.sources = [source({})];
    await artifactDataService.refresh(page(), 'auto');
    expect(state.saved[0]).toMatchObject({ status: 'skipped', error: expect.stringMatching(/soumis à approbation/) });
    state.saved = [];
    await artifactDataService.refresh(page(), 'person');
    expect(state.saved[0].status).toBe('ok');
  });

  it('saute tout quand le propriétaire n’est plus membre du projet', async () => {
    state.member = null;
    state.sources = [source({})];
    await artifactDataService.refresh(page(), 'person');
    expect(state.saved[0]).toMatchObject({ status: 'skipped', error: expect.stringMatching(/plus membre/) });
  });

  it('lance un script dans l’environnement du projet et lit son JSON ; échec et délai dépassé rapportés', async () => {
    state.sources = [source({ id: 's3', name: 'cpu', kind: 'script', config: { interpreter: 'node', code: 'x', timeoutSeconds: 5 } })];
    await artifactDataService.refresh(page(), 'auto');
    expect(state.saved[0]).toEqual({ id: 's3', status: 'ok', data: [{ a: 1 }] });
    state.saved = [];
    state.exec = { stdout: 'oops', code: 1 };
    await artifactDataService.refresh(page(), 'auto');
    expect(state.saved[0].error).toMatch(/code 1.*oops/);
    state.saved = [];
    state.exec = { stdout: '', code: 124 };
    await artifactDataService.refresh(page(), 'auto');
    expect(state.saved[0].error).toMatch(/dépassé 5 s/);
  });

  it('ne lance pas deux rafraîchissements en même temps sur le même artefact', async () => {
    state.sources = [source({})];
    const a = artifactDataService.refresh(page(), 'auto');
    const b = artifactDataService.refresh(page(), 'auto');
    expect(b).toBe(a);
    await a;
    expect(state.marked).toBe(1);
  });
});

describe('réglages', () => {
  it('refuse les sources et l’intervalle sur une page simple', async () => {
    await expect(artifactDataService.setSources(page({ kind: 'page' }), [])).rejects.toThrow(/kind: data/);
    await expect(artifactDataService.setRefresh(page({ kind: 'page' }), 60)).rejects.toThrow(/données/);
    expect((await artifactDataService.setRefresh(page(), 60)).refreshMinutes).toBe(60);
  });
});

describe('sources agent', () => {
  const agentSource = (extra: Partial<DataSource> = {}) => source({ id: 'sa', name: 'resultat', kind: 'agent', config: { prompt: 'Recalcule le prévisionnel', agent: null }, ...extra });

  it('ne lance rien à la publication ni par pages.refresh (sans agents: true)', async () => {
    state.sources = [agentSource()];
    await artifactDataService.refresh(page(), 'auto');
    expect(state.created).toEqual([]);
    expect(state.running).toEqual([]);
  });

  it('lance une session au nom du propriétaire avec la consigne, archivée d’office, et passe la source en calcul', async () => {
    state.sources = [agentSource()];
    await artifactDataService.refresh(page(), 'auto', { agents: true });
    expect(state.created[0]).toMatchObject({ projectId: 'pr', ownerId: 'owner', provider: 'claude', config: { autoArchive: true }, autoStart: false });
    expect(state.sent[0]).toMatch(/Recalcule le prévisionnel/);
    expect(state.sent[0]).toMatch(/pages\.set_data.*page_id: "p1", source: "resultat"/);
    expect(state.running).toEqual([{ id: 'sa', sessionId: 'new-session' }]);
  });

  it('confie la source à l’agent nommé', async () => {
    state.sources = [agentSource({ config: { prompt: 'x', agent: 'Chris' } })];
    await artifactDataService.refresh(page(), 'auto', { agents: true });
    expect(state.summoned[0].agentId).toBe('agent-Chris');
    expect(state.running).toEqual([{ id: 'sa', sessionId: 'agent-session' }]);
    // Identifiants vérifiés : ceux du compte prêté à l'agent, pas les réglages propres de l'agent.
    expect(state.claudeChecked).toEqual(['lender-of-agent-Chris']);
  });

  it('ne double pas une session encore au travail ; relance après une session terminée', async () => {
    state.sessions.busy = { status: 'running', activity: 'busy', archivedAt: null };
    state.sources = [agentSource({ status: 'running', sessionId: 'busy' })];
    await artifactDataService.refresh(page(), 'auto', { agents: true });
    expect(state.created).toEqual([]);
    state.sessions.busy = { status: 'running', activity: 'idle', archivedAt: null };
    await artifactDataService.refresh(page(), 'auto', { agents: true });
    expect(state.created).toHaveLength(1);
  });

  it('écrit les données depuis une session du propriétaire ou la session lancée, pas d’ailleurs', async () => {
    state.sources = [agentSource({ sessionId: 'agent-session' }), source({})];
    await artifactDataService.setAgentData(page(), 'resultat', { total: 3 }, { id: 'x', ownerId: 'owner' });
    await artifactDataService.setAgentData(page(), 'resultat', { total: 4 }, { id: 'agent-session', ownerId: 'agent' });
    expect(state.agentData).toEqual([{ id: 'sa', data: { total: 3 } }, { id: 'sa', data: { total: 4 } }]);
    expect(state.evaluated).toEqual([['resultat'], ['resultat']]);
    await expect(artifactDataService.setAgentData(page(), 'resultat', {}, { id: 'autre', ownerId: 'quelqu-un' })).rejects.toThrow(/propriétaire/);
    await expect(artifactDataService.setAgentData(page(), 'ventes', {}, { id: 'x', ownerId: 'owner' })).rejects.toThrow(/type sql/);
    await expect(artifactDataService.setAgentData(page(), 'inconnue', {}, { id: 'x', ownerId: 'owner' })).rejects.toThrow(/introuvable/);
  });

  it('refuse un intervalle de moins d’une heure avec une source agent', async () => {
    state.sources = [agentSource()];
    await expect(artifactDataService.setRefresh(page(), 15)).rejects.toThrow(/60 minutes/);
    await expect(artifactDataService.setSources(page({ refreshMinutes: 15 }), [{ name: 'r', type: 'agent', prompt: 'x' }])).rejects.toThrow(/60 minutes/);
  });
});
