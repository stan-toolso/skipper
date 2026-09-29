import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { terminalService } from './service.js';

/** Branche les WebSockets `/terminals/<id>` sur le serveur HTTP existant (à côté de GraphQL). */
export function attachTerminalWebSockets(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = (req.url ?? '').match(/^\/terminals\/([0-9a-f-]{36})(?:\?|$)/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => terminalService.attach(match[1], ws));
  });
}
