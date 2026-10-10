import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppError } from '../../errors.js';

/**
 * Ponts MCP d'une session OpenCode : les serveurs MCP in-process de Skipper (contexte, tâches, coffre,
 * worktrees, sessions, pages) sont offerts au serveur OpenCode qui tourne dans le conteneur du projet.
 * Skipper écoute sur un port TCP du serveur ; OpenCode lance, par serveur, un relais local (`node -e`) qui
 * ouvre une connexion, s'annonce par un jeton propre à la session et le nom du serveur, puis relaie
 * son entrée/sortie standard. Chaque connexion est servie par une instance neuve du serveur MCP demandé
 * (une instance ne tient qu'un transport) ; les outils s'exécutent dans Skipper, comme pour Claude.
 */

/** Relais TCP ↔ stdio exécuté par Node dans le conteneur : hôte, port, jeton et nom du serveur en arguments. */
const RELAY = `const [h,p,t,n]=process.argv.slice(1);const s=require('net').connect(Number(p),h);s.once('connect',()=>{s.write(t+' '+n+'\\n');process.stdin.pipe(s);s.pipe(process.stdout)});s.on('close',()=>process.exit(0));s.on('error',(e)=>{console.error(e.message);process.exit(1)});process.stdin.on('end',()=>s.end())`;

export type McpFactory = () => McpSdkServerConfigWithInstance;

export interface McpBridges {
  /** Section `mcp` de la configuration d'OpenCode pour les serveurs pontés. */
  config: Record<string, { type: 'local'; command: string[]; enabled: true }>;
  close(): Promise<void>;
}

/** Ouvre les ponts : un port d'écoute pour la session, un relais par serveur dans la configuration d'OpenCode. */
export async function startMcpBridges(hostAddress: string, servers: Record<string, McpFactory>, onError: (server: string, err: Error) => void): Promise<McpBridges> {
  const token = randomBytes(24).toString('base64url');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    // Première ligne : « <jeton> <serveur> ». Tout le reste est le flux MCP.
    let header = '';
    const onData = (chunk: Buffer) => {
      header += chunk.toString('utf8');
      const nl = header.indexOf('\n');
      if (nl < 0) {
        if (header.length > 512) socket.destroy();
        return;
      }
      socket.off('data', onData);
      const [got, name] = header.slice(0, nl).trim().split(' ');
      const rest = Buffer.from(header.slice(nl + 1), 'utf8');
      const factory = got === token ? servers[name ?? ''] : undefined;
      if (!factory) {
        socket.destroy();
        return;
      }
      const instance = factory().instance;
      socket.on('close', () => void instance.close().catch(() => undefined));
      // Les octets lus après l'en-tête appartiennent déjà au flux MCP.
      if (rest.length) socket.unshift(rest);
      instance.connect(new StdioServerTransport(socket, socket)).catch((err) => {
        onError(name ?? '?', err as Error);
        socket.destroy();
      });
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AppError("Impossible d'ouvrir les ponts MCP d'OpenCode");
  const config: McpBridges['config'] = {};
  for (const name of Object.keys(servers)) config[name] = { type: 'local', command: ['node', '-e', RELAY, hostAddress, String(address.port), token, name], enabled: true };
  return {
    config,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
