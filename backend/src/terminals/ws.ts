import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { terminalService } from './service.js';

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Branche les WebSockets `/terminals/<id>` sur le serveur HTTP existant (à côté de GraphQL).
 * La connexion est authentifiée par le cookie de session ; il faut être membre du projet du terminal.
 */
export function attachTerminalWebSockets(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = (req.url ?? '').match(/^\/terminals\/([0-9a-f-]{36})(?:\?|$)/);
    if (!match) {
      socket.destroy();
      return;
    }
    const id = match[1];
    void (async () => {
      const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!user) return reject(socket, 401, 'Unauthorized');
      const terminal = await terminalService.get(id);
      await requireProject(createAuthContext(user), terminal.projectId, 'member');
      wss.handleUpgrade(req, socket, head, (ws) => terminalService.attach(id, ws));
    })().catch((err) => {
      console.warn(`[terminals] connexion refusée sur ${id} : ${(err as Error).message}`);
      reject(socket, 403, 'Forbidden');
    });
  });
}
