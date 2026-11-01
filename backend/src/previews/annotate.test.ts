import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Annotations sur l'aperçu : injection du script dans les pages, lecture du lot envoyé, instruction transmise à la
// session de la branche. Base, droits et sessions simulés.
const state = vi.hoisted(() => ({
  member: true,
  sessions: [] as Array<{ id: string; name: string; status: string; activity: string | null; config: Record<string, unknown> }>,
  sent: [] as Array<{ id: string; text: string }>,
}));
vi.mock('../config.js', () => ({ config: { appUrl: 'https://skipper.example.org' } }));
vi.mock('../auth/access.js', () => ({ createAuthContext: (u: unknown) => u, requireProject: async () => (state.member ? 'member' : Promise.reject(new Error('non'))) }));
vi.mock('../users/repository.js', () => ({ userRepository: { findById: async (id: string) => ({ id, name: 'Alice Martin', email: 'alice@example.org' }) } }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { list: async () => state.sessions } }));
vi.mock('../sessions/service.js', () => ({
  sessionService: {
    sendMessage: async (id: string, text: string) => {
      state.sent.push({ id, text });
      return { ...state.sessions.find((s) => s.id === id)!, status: 'running', activity: 'busy' };
    },
  },
}));

const { asciiOnly, formatInstruction, handleAnnotateRoute, injectScript, parseBatch, wantsInjection, ANNOTATE_SCRIPT_PATH } = await import('./annotate.js');

const preview = { worksessionId: 'ws', projectId: 'p', hostLabel: 'b', port: 41000, startedBy: null, startedAt: null };

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Object.assign(Readable.from(raw), { method, url, headers: { host: 'b.apercu.example.org', ...headers } }) as unknown as IncomingMessage;
  const out = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(b?: string) {
      out.body = b ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await handleAnnotateRoute(req, res, preview, 'u1');
  return { handled, status: out.status, json: out.body && out.body.startsWith('{') ? JSON.parse(out.body) : null, body: out.body };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call('POST', '/__skipper/annotations', body, { 'content-type': 'application/json', 'x-skipper-annotation': '1', ...headers });

const batch = {
  page: '/produits?x=1',
  title: 'Produits',
  viewport: { width: 390, height: 844 },
  note: '',
  annotations: [{ comment: 'Plus gros et en vert', selector: 'main > button.cta', tag: 'BUTTON', text: '  Acheter\n maintenant ', html: '<button class="cta">Acheter maintenant</button>', rect: { x: 10.4, y: 20, width: 100, height: 40 } }],
};

beforeEach(() => {
  state.member = true;
  state.sent = [];
  state.sessions = [
    { id: 'rev', name: 'Relecture', status: 'running', activity: 'busy', config: { review: true } },
    { id: 's1', name: 'Page produits', status: 'completed', activity: null, config: {} },
  ];
});

describe('injection du script', () => {
  it('ajoute la balise avant </head>, sinon </body>, sinon à la fin, une seule fois', () => {
    expect(injectScript('<html><head><title>x</title></head><body></body></html>')).toBe(`<html><head><title>x</title><script src="${ANNOTATE_SCRIPT_PATH}" defer></script></head><body></body></html>`);
    expect(injectScript('<body>a</BODY>')).toBe(`<body>a<script src="${ANNOTATE_SCRIPT_PATH}" defer></script></BODY>`);
    expect(injectScript('<p>a')).toBe(`<p>a<script src="${ANNOTATE_SCRIPT_PATH}" defer></script>`);
    const once = injectScript('<head></head>');
    expect(injectScript(once)).toBe(once);
  });

  it("ne vise que les chargements de page (document ou cadre de l'onglet Aperçu)", () => {
    expect(wantsInjection({ method: 'GET', headers: { 'sec-fetch-dest': 'document' } })).toBe(true);
    expect(wantsInjection({ method: 'GET', headers: { 'sec-fetch-dest': 'iframe' } })).toBe(true);
    expect(wantsInjection({ method: 'GET', headers: { 'sec-fetch-dest': 'script', accept: 'text/html' } })).toBe(false);
    expect(wantsInjection({ method: 'GET', headers: { accept: 'text/html,*/*' } })).toBe(true);
    expect(wantsInjection({ method: 'POST', headers: { 'sec-fetch-dest': 'document' } })).toBe(false);
  });

  it('le script client est du JavaScript valide', () => {
    const file = fileURLToPath(new URL('./annotate-client.js', import.meta.url));
    expect(readFileSync(file, 'utf8')).toContain('__skipperAnnotate');
    execFileSync(process.execPath, ['--check', file]);
  });
});

describe('lot d’annotations', () => {
  it('borne et nettoie ce que le script envoie', () => {
    const b = parseBatch({ ...batch, annotations: [...batch.annotations, { comment: '', selector: 'x' }, { comment: 'sans élément' }, 'bruit'] })!;
    expect(b.annotations).toHaveLength(1);
    expect(b.annotations[0]).toMatchObject({ tag: 'button', text: 'Acheter maintenant', rect: { x: 10, y: 20, width: 100, height: 40 } });
    expect(parseBatch({ annotations: [] })).toBeNull();
    expect(parseBatch({ note: '  Tout est trop petit  ' })).toMatchObject({ note: 'Tout est trop petit', page: '/', annotations: [] });
    expect(parseBatch(null)).toBeNull();
  });

  it("rédige une instruction qui situe chaque élément et demande de vérifier par l'aperçu", () => {
    const text = formatInstruction(parseBatch(batch)!, 'Alice Martin');
    expect(text).toContain("Retours de Alice Martin sur l'aperçu de cette branche (1 élément annoté dans la page)");
    expect(text).toContain('Page : /produits?x=1, titre « Produits », fenêtre 390×844 px (téléphone)');
    expect(text).toContain('1. Plus gros et en vert');
    expect(text).toContain('sélecteur `main > button.cta`, texte « Acheter maintenant »');
    expect(text).toContain('```html');
    expect(text).toContain('outils `preview`');
  });
});

describe('routes du script', () => {
  it('sert le script et laisse passer les autres chemins', async () => {
    const r = await call('GET', ANNOTATE_SCRIPT_PATH);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toContain('__skipperAnnotate');
    // ASCII seulement (page hôte sans encodage déclaré), et toujours du JavaScript valide.
    expect(/[^\x00-\x7f]/.test(r.body)).toBe(false);
    expect(new Function(r.body)).toBeTypeOf('function');
    expect(eval(asciiOnly("'é🎤«»'"))).toBe('é🎤«»');
    expect((await call('GET', '/src/main.tsx')).handled).toBe(false);
  });

  it('indique la session visée (hors relecture) et si la personne peut annoter', async () => {
    expect((await call('GET', '/__skipper/session')).json).toEqual({
      canAnnotate: true,
      session: { id: 's1', name: 'Page produits', status: 'completed', activity: null, url: 'https://skipper.example.org/sessions/s1' },
    });
    state.member = false;
    expect((await call('GET', '/__skipper/session')).json.canAnnotate).toBe(false);
  });

  it('envoie le lot comme instruction à la session de la branche', async () => {
    const r = await post(batch, { origin: 'https://b.apercu.example.org' });
    expect(r.status).toBe(200);
    expect(r.json.session).toMatchObject({ id: 's1', status: 'running', activity: 'busy' });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].id).toBe('s1');
    expect(state.sent[0].text).toContain('Plus gros et en vert');
  });

  it("refuse l'envoi d'un autre site, sans l'en-tête dédié, d'un lecteur ou sans session", async () => {
    expect((await post(batch, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await call('POST', '/__skipper/annotations', batch, { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await post({ annotations: [] })).status).toBe(400);
    expect((await post('{pas du json')).status).toBe(400);
    state.member = false;
    expect((await post(batch)).status).toBe(403);
    state.member = true;
    state.sessions = [];
    expect((await post(batch)).status).toBe(409);
    expect(state.sent).toHaveLength(0);
  });
});
