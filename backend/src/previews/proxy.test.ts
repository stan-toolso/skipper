import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lien public d'un aperçu ouvert hors de l'onglet (donné par un agent) : le sous-domaine renvoie vers Skipper, qui
// reconnaît la personne et revient avec un lien d'accès. Base, connexion et droits simulés.
const WS = '11111111-2222-3333-4444-555555555555';
const row = { worksessionId: WS, projectId: 'p', hostLabel: 'ma-branche-p-abc123', port: 41000, startedBy: null, startedAt: null };
const state = vi.hoisted(() => ({ user: null as { id: string } | null, member: true }));
vi.mock('../config.js', () => ({ config: { previewUrl: 'https://*.apercu.example.org', apiUrl: 'https://skipper.example.org', appUrl: 'https://skipper.example.org' } }));
vi.mock('./repository.js', () => ({
  previewRepository: { find: async (id: string) => (id === WS ? row : null), findByLabel: async (l: string) => (l === row.hostLabel ? row : null), findAccess: async () => null },
}));
vi.mock('./service.js', () => ({
  ACCESS_COOKIE: 'skipper_apercu',
  ACCESS_PATH: '/__skipper/acces',
  ACCESS_TTL_MS: 1000,
  previewService: { enabled: () => true, accessUrl: async (_ws: string, userId: string, next: string) => `https://ma-branche-p-abc123.apercu.example.org/__skipper/acces?t=grant-${userId}&next=${encodeURIComponent(next)}` },
}));
vi.mock('../auth/session.js', () => ({ SESSION_COOKIE: 'skipper_session', authSession: { resolve: async () => state.user }, readCookie: () => null }));
vi.mock('../auth/access.js', () => ({ createAuthContext: (u: unknown) => u, requireProject: async () => (state.member ? 'viewer' : Promise.reject(new Error('non'))) }));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async (id: string) => ({ id }) } }));
vi.mock('../projects/service.js', () => ({ projectService: {} }));
vi.mock('../runners/index.js', () => ({ runner: {} }));

const { handlePreviewOpenRoute, handlePreviewRoute, openUrl } = await import('./proxy.js');

function call(handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>, url: string, headers: Record<string, string> = {}) {
  const out = { status: 0, headers: {} as Record<string, unknown> };
  const res = {
    headersSent: false,
    writeHead(status: number, h: Record<string, unknown> = {}) {
      out.status = status;
      out.headers = h;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  const req = { method: 'GET', url, headers } as IncomingMessage;
  return handler(req, res).then((handled) => ({ handled, ...out }));
}

beforeEach(() => {
  state.user = null;
  state.member = true;
});

describe('lien public d’un aperçu', () => {
  it('openUrl pointe vers la route de Skipper, chemin local seulement', () => {
    expect(openUrl(WS)).toBe(`https://skipper.example.org/api/previews/${WS}/open`);
    expect(openUrl(WS, '/tasks?x=1')).toBe(`https://skipper.example.org/api/previews/${WS}/open?next=%2Ftasks%3Fx%3D1`);
    expect(openUrl(WS, '//ailleurs.example')).toBe(`https://skipper.example.org/api/previews/${WS}/open`);
  });

  it('le sous-domaine sans accès renvoie une navigation vers Skipper, pas un cadre', async () => {
    const host = 'ma-branche-p-abc123.apercu.example.org';
    const nav = await call(handlePreviewRoute, '/tasks', { host, 'sec-fetch-dest': 'document' });
    expect(nav.status).toBe(302);
    expect(nav.headers.Location).toBe(openUrl(WS, '/tasks'));
    const frame = await call(handlePreviewRoute, '/tasks', { host, 'sec-fetch-dest': 'iframe' });
    expect(frame.status).toBe(401);
  });

  it('la route d’ouverture : connexion, puis lien d’accès pour un membre, refus sinon', async () => {
    const anon = await call(handlePreviewOpenRoute, `/api/previews/${WS}/open?next=/tasks`);
    expect(anon.status).toBe(302);
    expect(String(anon.headers.Location)).toBe(`https://skipper.example.org/auth/google?next=${encodeURIComponent(`/api/previews/${WS}/open?next=/tasks`)}`);
    state.user = { id: 'u1' };
    const ok = await call(handlePreviewOpenRoute, `/api/previews/${WS}/open?next=/tasks`);
    expect(ok.status).toBe(302);
    expect(String(ok.headers.Location)).toContain('t=grant-u1');
    expect(String(ok.headers.Location)).toContain(encodeURIComponent('/tasks'));
    state.member = false;
    expect((await call(handlePreviewOpenRoute, `/api/previews/${WS}/open`)).status).toBe(403);
    expect((await call(handlePreviewOpenRoute, '/api/previews/autre/open')).handled).toBe(false);
  });
});
