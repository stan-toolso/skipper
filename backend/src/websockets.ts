import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/** Prend en charge une demande d'upgrade WebSocket si son chemin le concerne ; renvoie false sinon. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

/** Refus d'une demande d'upgrade (avant la poignée de main WebSocket). */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Branche les WebSockets sur le serveur HTTP existant (à côté de GraphQL) ; un chemin inconnu est refusé. */
export function attachWebSockets(server: Server, handlers: UpgradeHandler[]): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!handlers.some((handle) => handle(req, socket, head))) socket.destroy();
  });
}
