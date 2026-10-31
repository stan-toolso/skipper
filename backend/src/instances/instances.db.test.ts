import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Test d'intégration du déploiement bleu/vert sur une base PostgreSQL jetable (TEST_DATABASE_URL, comme
 * db/migrate.test.ts) : deux « instances » du backend dans le même processus (modules rechargés, chacune avec son
 * pool et son identifiant). Registre, reprise des sessions d'une instance morte seulement, bus LISTEN/NOTIFY et
 * verrou des tâches périodiques.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error('TEST_DATABASE_URL est obligatoire en CI (service PostgreSQL du job)');

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Une instance du backend : ses modules, chargés à neuf (identifiant, pool, bus, verrou propres). */
async function loadInstance(url: string) {
  vi.resetModules();
  process.env.DATABASE_URL = url;
  const [{ instanceRegistry }, { instanceBus }, { leadership }, { pubSub }, { pool }, { sessionRepository }, { requestRepository }, { terminalRepository }, { requestService }] = await Promise.all([
    import('./registry.js'),
    import('./bus.js'),
    import('./leadership.js'),
    import('../pubsub.js'),
    import('../db/pool.js'),
    import('../sessions/repository.js'),
    import('../requests/repository.js'),
    import('../terminals/repository.js'),
    import('../requests/service.js'),
  ]);
  return { instanceRegistry, instanceBus, leadership, pubSub, pool, sessionRepository, requestRepository, terminalRepository, requestService };
}

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!adminUrl)('instances du backend (PostgreSQL)', () => {
  const name = `skipper_test_instances_${process.pid}_${Date.now()}`;
  let url: string;
  let blue: Awaited<ReturnType<typeof loadInstance>>;
  let green: Awaited<ReturnType<typeof loadInstance>>;
  let projectId: string;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    url = u.toString();
    vi.resetModules();
    process.env.DATABASE_URL = url;
    const { runMigrations } = await import('../db/migrate.js');
    const { pool } = await import('../db/pool.js');
    await runMigrations();
    await pool.end();
    blue = await loadInstance(url);
    green = await loadInstance(url);
    projectId = (await blue.pool.query<{ id: string }>(`INSERT INTO projects (name, slug) VALUES ('P', 'p') RETURNING id`)).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    for (const i of [blue, green]) {
      if (!i) continue;
      await i.leadership.release();
      await i.instanceBus.stop();
      await i.instanceRegistry.unregister().catch(() => undefined);
      await i.pool.end();
    }
    if (url) await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it("inscrit les instances, se voient l'une l'autre, et la nouvelle ne reprend que ce qu'une instance morte tenait", async () => {
    await blue.instanceRegistry.register(4101);
    await blue.instanceBus.start();
    // Session au travail sur bleu, session garée, session d'une instance disparue, demande et terminal de bleu.
    const mk = async (instanceId: string | null, parked = false) =>
      (
        await blue.pool.query<{ id: string }>(
          `INSERT INTO sessions (project_id, name, provider, status, activity, instance_id, parked_at) VALUES ($1, 's', 'claude', 'running', $2, $3, $4) RETURNING id`,
          [projectId, parked ? 'idle' : 'busy', instanceId, parked ? new Date() : null],
        )
      ).rows[0].id;
    const onBlue = await mk(blue.instanceRegistry.id);
    const parked = await mk(null, true);
    const orphan = await mk('00000000-0000-0000-0000-000000000001');
    await blue.pool.query(`INSERT INTO requests (session_id, type, title) VALUES ($1, 'permission', 'r'), ($2, 'permission', 'r')`, [onBlue, orphan]);
    await blue.terminalRepository.create(projectId, 't', null, null, blue.instanceRegistry.id);

    await green.instanceRegistry.register(4102);
    await green.instanceBus.start();
    await waitFor(() => blue.instanceRegistry.hasPeers());
    const live = await green.instanceRegistry.liveIds();
    expect(live.sort()).toEqual([blue.instanceRegistry.id, green.instanceRegistry.id].sort());
    expect((await green.instanceRegistry.holder(blue.instanceRegistry.id))?.port).toBe(4101);
    expect(await green.instanceRegistry.remoteActivity(projectId)).toBe(2);

    const interrupted = await green.sessionRepository.markRunningAsInterrupted(live);
    expect(interrupted.map((s) => s.id)).toEqual([orphan]);
    expect((await green.sessionRepository.findById(onBlue))?.status).toBe('running');
    expect((await green.sessionRepository.findById(parked))).toMatchObject({ status: 'running', parkedAt: expect.any(Date) });
    expect(await green.requestRepository.expireAllPending(live)).toBe(1);
    expect(await green.terminalRepository.closeAllRunning(live)).toBe(0);

    // Une session garée n'est relancée qu'une fois.
    expect(await green.sessionRepository.claimParked(parked, green.instanceRegistry.id)).toBe(true);
    expect(await blue.sessionRepository.claimParked(parked, blue.instanceRegistry.id)).toBe(false);
  });

  it("relaie les publications d'une instance aux abonnés de l'autre, et les réponses aux demandes", async () => {
    const session = (await blue.pool.query<{ id: string }>(`INSERT INTO sessions (project_id, name, provider) VALUES ($1, 'bus', 'claude') RETURNING id`, [projectId])).rows[0].id;
    const updates = green.pubSub.subscribe('sessionUpdated');
    const events = green.pubSub.subscribe('sessionEvent', session);
    const updated = await blue.sessionRepository.update(session, { activity: 'busy' });
    blue.pubSub.publish('sessionUpdated', updated!);
    const event = await blue.sessionRepository.addEvent(session, 'assistant', { text: 'x'.repeat(20_000) });
    blue.pubSub.publish('sessionEvent', session, event);
    const u = await updates.next();
    expect(u.value).toMatchObject({ id: session, activity: 'busy' });
    expect(u.value.updatedAt).toBeInstanceOf(Date);
    const e = await events.next();
    expect(e.value).toMatchObject({ id: event.id, type: 'assistant' });
    expect(String(e.value.payload.text)).toHaveLength(20_000);
    await updates.return?.(undefined);
    await events.return?.(undefined);

    // L'agent attend sur bleu, la personne répond depuis vert : la réponse arrive à l'agent.
    let requestId = '';
    const answer = blue.requestService.ask(session, { type: 'question', title: 'Oui ?' }, undefined, (r) => (requestId = r.id));
    await waitFor(() => Boolean(requestId));
    await green.requestService.answer(requestId, { answer: 'oui' });
    await expect(answer).resolves.toEqual({ answer: 'oui' });
  });

  it("donne le verrou des tâches périodiques à une seule instance, et le passe quand elle le relâche", async () => {
    const started: string[] = [];
    const job = (who: string) => [{ name: 'test', start: () => void started.push(who), stop: () => undefined }];
    await blue.leadership.start(job('blue'));
    await green.leadership.start(job('green'));
    expect(blue.leadership.isLeader).toBe(true);
    expect(green.leadership.isLeader).toBe(false);
    await blue.leadership.release();
    await waitFor(() => green.leadership.isLeader);
    expect(started).toEqual(['blue', 'green']);
  }, 15_000);
});
