import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lien public d'un aperçu ouvert hors de l'onglet (donné par un agent) : le sous-domaine renvoie vers Skipper, qui
// reconnaît la personne et revient avec un lien d'accès. Base, connexion et droits simulés.
const WS = '11111111-2222-3333-4444-555555555555';
const row = { worksessionId: WS, projectId: 'p', hostLabel: 'ma-branche-p-abc123', port: 41000, startedBy: null, startedAt: null };
const state = vi.hoisted(() => ({ user: null as { id: string } | null, member: true, cookie: null as string | null }));
vi.mock('../config.js', () => ({ config: { previewUrl: 'https://*.apercu.example.org', apiUrl: 'https://skipper.example.org', appUrl: 'https://skipper.example.org' } }));
vi.mock('./repository.js', () => ({
  previewRepository: { find: async (id: string) => (id === WS ? row : null), findByLabel: async (l: string) => (l === row.hostLabel ? row : null), findAccess: async () => (state.cookie ? { worksessionId: WS, userId: 'u1', expiresAt: new Date(Date.now() + 3600_000) } : null) },
}));
vi.mock('./service.js', () => ({
  ACCESS_COOKIE: 'skipper_apercu',
  ACCESS_PATH: '/__skipper/acces',
  ACCESS_TTL_MS: 1000,
  previewService: { enabled: () => true, accessUrl: async (_ws: string, userId: string, next: string) => `https://ma-branche-p-abc123.apercu.example.org/__skipper/acces?t=grant-${userId}&next=${encodeURIComponent(next)}` },
}));
vi.mock('../auth/session.js', () => ({ SESSION_COOKIE: 'skipper_session', authSession: { resolve: async () => state.user }, readCookie: (_h: string | undefined, name: string) => (name === 'skipper_apercu' ? state.cookie : null) }));
vi.mock('../auth/access.js', () => ({ createAuthContext: (u: unknown) => u, requireProject: async () => (state.member ? 'viewer' : Promise.reject(new Error('non'))) }));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async (id: string) => ({ id }) } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async () => ({ id: 'p' }) } }));
vi.mock('../runners/index.js', () => ({ runner: { containerAddress: async () => '127.0.0.1' } }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { list: async () => [] } }));
vi.mock('../sessions/service.js', () => ({ sessionService: {} }));

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
  state.cookie = null;
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

/** GET brut (fetch ne laisse pas choisir l'en-tête Host). */
function get(port: number, path: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

describe("script d'annotation injecté dans les pages", () => {
  it('ajoute le script aux pages HTML (sans compression ni 304), pas aux autres réponses', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const app = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html', ETag: '"abc"', 'Set-Cookie': ['a=1', 'b=2'] }).end('<html><head></head><body>Bonjour</body></html>');
      else res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('console.log(1)');
    });
    const front = http.createServer((req, res) => void handlePreviewRoute(req, res));
    await Promise.all([new Promise<void>((r) => app.listen(0, '127.0.0.1', r)), new Promise<void>((r) => front.listen(0, '127.0.0.1', r))]);
    row.port = (app.address() as AddressInfo).port;
    state.cookie = 'jeton';
    const port = (front.address() as AddressInfo).port;
    const headers = { host: 'ma-branche-p-abc123.apercu.example.org', 'accept-encoding': 'gzip', 'if-none-match': '"abc"' };
    try {
      const pageRes = await get(port, '/', { ...headers, 'sec-fetch-dest': 'document' });
      const html = pageRes.body;
      expect(html).toBe('<html><head><script src="/__skipper/annoter.js" defer></script></head><body>Bonjour</body></html>');
      expect(pageRes.headers['content-length']).toBe(String(Buffer.byteLength(html)));
      expect(pageRes.headers.etag).toBeUndefined();
      expect(pageRes.headers['set-cookie']).toEqual(['a=1', 'b=2']);
      expect(seen[0]['accept-encoding']).toBe('identity');
      expect(seen[0]['if-none-match']).toBeUndefined();
      const js = await get(port, '/main.js', { ...headers, 'sec-fetch-dest': 'script' });
      expect(js.body).toBe('console.log(1)');
      expect(seen[1]['accept-encoding']).toBe('gzip');
      const script = await get(port, '/__skipper/annoter.js', headers);
      expect(script.body).toContain('__skipperAnnotate');
      expect(seen).toHaveLength(2);
    } finally {
      app.close();
      front.close();
    }
  });
});
