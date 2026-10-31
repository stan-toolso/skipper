import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { FORWARDED_HEADER } from './client.js';
import type { InstanceInfo } from './registry.js';

/** La demande d'upgrade vient-elle déjà d'une autre instance ? (jamais routée deux fois) */
export const isForwarded = (req: IncomingMessage) => req.headers[FORWARDED_HEADER] === '1';

/**
 * Relaie une demande d'upgrade WebSocket (terminal, navigateur d'une session) vers l'instance du backend qui tient
 * le processus : la requête est réécrite telle quelle sur son port local, puis les deux flux sont reliés. L'instance
 * cible fait elle-même l'authentification (cookie) et la poignée de main.
 */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: InstanceInfo): void {
  const upstream = net.connect(target.port, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === FORWARDED_HEADER) continue;
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += `${FORWARDED_HEADER}: 1\r\n\r\n`;
    upstream.write(raw);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}
