import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://skipper.example.com';
vi.resetModules();
const { attachWebSockets, rejectUpgrade } = await import('./websockets.js');

let server: Server;
let port: number;
const handled: string[] = [];

beforeAll(async () => {
  server = createServer((_req, res) => res.end());
  // Gestionnaire factice : répond 418 pour prouver qu'il a été atteint.
  attachWebSockets(server, [
    (req, socket) => {
      if (!req.url?.startsWith('/terminals/')) return false;
      handled.push(req.url);
      rejectUpgrade(socket, 418, 'Reached');
      return true;
    },
  ]);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Demande d'upgrade WebSocket ; renvoie le statut de la réponse (ou 0 si la connexion est coupée sans réponse). */
function upgrade(path: string, origin?: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', () => resolve(0));
    req.end();
  });
}

describe('upgrade WebSocket : contrôle de l\'origine', () => {
  it("refuse une page d'un autre sous-domaine", async () => {
    expect(await upgrade('/terminals/abc', 'https://evil.example.com')).toBe(403);
    expect(await upgrade('/terminals/abc', 'https://skipper.example.com.evil.net')).toBe(403);
    expect(handled).toEqual([]);
  });

  it('refuse un upgrade sans en-tête Origin', async () => {
    expect(await upgrade('/terminals/abc')).toBe(403);
    expect(handled).toEqual([]);
  });

  it("transmet au gestionnaire un upgrade venant de l'application ou du poste de développement", async () => {
    expect(await upgrade('/terminals/abc', 'https://skipper.example.com')).toBe(418);
    expect(await upgrade('/terminals/dev', 'http://localhost:5173')).toBe(418);
    expect(handled).toEqual(['/terminals/abc', '/terminals/dev']);
  });

  it('coupe un chemin inconnu', async () => {
    expect(await upgrade('/autre', 'https://skipper.example.com')).toBe(0);
  });
});
