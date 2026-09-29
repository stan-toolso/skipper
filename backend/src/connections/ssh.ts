import { createHash } from 'node:crypto';
import net from 'node:net';
import ssh2, { type Client as SshClient, type ConnectConfig } from 'ssh2';
import { AppError } from '../errors.js';
import type { SshCredentials } from './types.js';

/**
 * Client SSH (bibliothèque ssh2) : exécution de commandes, transfert de fichiers et tunnels.
 * La clé privée n'existe qu'en mémoire, le temps de la connexion.
 */

// ssh2 est un module CommonJS : import par défaut puis déstructuration.
const { Client, utils } = ssh2;

export const SSH_CONNECT_TIMEOUT_MS = 20_000;

/** Paire de clés ed25519 au format OpenSSH ; la clé publique est prête pour authorized_keys. */
export function generateKeyPair(comment: string): { privateKey: string; publicKey: string } {
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

/** Vérifie qu'une clé privée collée est lisible ; renvoie la clé publique correspondante. */
export function publicKeyOf(privateKey: string): string {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw new AppError(`Clé privée illisible : ${parsed.message}`);
  if (!parsed.isPrivateKey()) throw new AppError("Ce n'est pas une clé privée");
  return `${sshKeyType(parsed.getPublicSSH())} ${parsed.getPublicSSH().toString('base64')}${parsed.comment ? ` ${parsed.comment}` : ''}`;
}

/** Type d'une clé au format binaire SSH (chaîne en tête du blob, ex. "ssh-ed25519"). */
export function sshKeyType(blob: Buffer): string {
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString('ascii');
}

/** Clé d'hôte telle que mémorisée et écrite dans un known_hosts : "<type> <base64>". */
export function hostKeyLine(blob: Buffer): string {
  return `${sshKeyType(blob)} ${blob.toString('base64')}`;
}

/** Empreinte lisible d'une clé d'hôte mémorisée, comme l'affiche OpenSSH. */
export function fingerprint(hostKey: string): string {
  const [, base64] = hostKey.split(' ');
  return `SHA256:${createHash('sha256').update(Buffer.from(base64 ?? '', 'base64')).digest('base64').replace(/=+$/, '')}`;
}

export class HostKeyMismatchError extends AppError {
  constructor(readonly expected: string, readonly actual: string) {
    super(`La clé de l'hôte a changé (attendue ${fingerprint(expected)}, reçue ${fingerprint(actual)}). Si le serveur a bien été réinstallé, oubliez la clé mémorisée dans la fiche de la connexion.`, 'HOST_KEY_MISMATCH');
  }
}

export interface SshSession {
  client: SshClient;
  /** Clé d'hôte présentée par le serveur (à mémoriser si elle ne l'était pas). */
  hostKey: string;
  close(): void;
}

/**
 * Ouvre une connexion. `knownHostKey` : clé mémorisée (TOFU) ; si elle diffère, la connexion est
 * refusée. Si aucune clé n'est mémorisée, celle du serveur est acceptée et renvoyée.
 */
export function connect(creds: SshCredentials, knownHostKey: string | null, extra: Partial<ConnectConfig> = {}): Promise<SshSession> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | null = null;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err instanceof AppError ? err : new AppError(`Connexion SSH à ${creds.username}@${creds.host}:${creds.port} impossible : ${err.message}`, 'SSH'));
    };
    client
      .on('ready', () => {
        if (settled) return;
        settled = true;
        resolve({ client, hostKey: presented ?? '', close: () => client.end() });
      })
      .on('error', fail)
      .connect({
        host: creds.host,
        port: creds.port,
        username: creds.username,
        privateKey: creds.privateKey,
        readyTimeout: SSH_CONNECT_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          presented = hostKeyLine(key);
          if (knownHostKey && knownHostKey !== presented) {
            // L'erreur est levée hors du callback pour porter un message explicite.
            setImmediate(() => fail(new HostKeyMismatchError(knownHostKey, presented!)));
            return false;
          }
          return true;
        },
        ...extra,
      });
  });
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  durationMs: number;
}

/** Exécute une commande ; la sortie est tronquée au-delà de `maxBytes` par flux. */
export function exec(session: SshSession, command: string, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    session.client.exec(command, (err, stream) => {
      if (err) return reject(new AppError(`Exécution impossible : ${err.message}`, 'SSH'));
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const append = (current: string, chunk: Buffer) => {
        if (current.length >= maxBytes) {
          truncated = true;
          return current;
        }
        const next = current + chunk.toString('utf8');
        if (next.length > maxBytes) {
          truncated = true;
          return next.slice(0, maxBytes);
        }
        return next;
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            stream.close();
            reject(new AppError(`Commande interrompue après ${Math.round(options.timeoutMs! / 1000)} s`, 'SSH_TIMEOUT'));
          }, options.timeoutMs)
        : null;
      stream.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
      stream.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
      stream.on('close', (code: number | null, signal: string | null) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? null, signal: signal ?? null, truncated, durationMs: Date.now() - started });
      });
    });
  });
}

export function upload(session: SshSession, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(new AppError(`SFTP indisponible : ${err.message}`, 'SSH'));
      sftp.fastPut(localPath, remotePath, (e) => {
        sftp.end();
        e ? reject(new AppError(`Envoi impossible : ${e.message}`, 'SSH')) : resolve();
      });
    });
  });
}

export function download(session: SshSession, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(new AppError(`SFTP indisponible : ${err.message}`, 'SSH'));
      sftp.fastGet(remotePath, localPath, (e) => {
        sftp.end();
        e ? reject(new AppError(`Récupération impossible : ${e.message}`, 'SSH')) : resolve();
      });
    });
  });
}

export interface Tunnel {
  /** Port local (127.0.0.1) qui mène à la cible à travers le serveur SSH. */
  port: number;
  close(): Promise<void>;
}

/**
 * Tunnel local : chaque connexion TCP reçue sur 127.0.0.1:<port> est relayée vers `targetHost:targetPort`
 * depuis le serveur SSH (port forwarding). Les clients (pg, psql) s'y connectent comme à une base locale.
 */
export async function openTunnel(session: SshSession, targetHost: string, targetPort: number): Promise<Tunnel> {
  // Vérifie d'abord qu'un canal peut s'ouvrir, pour renvoyer une erreur explicite plutôt qu'une
  // connexion locale coupée (forwarding interdit par le serveur, cible injoignable depuis le serveur...).
  await new Promise<void>((resolve, reject) => {
    session.client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, channel) => {
      if (err) return reject(new AppError(`Tunnel vers ${targetHost}:${targetPort} impossible : ${err.message}. Le serveur SSH autorise-t-il le port forwarding (AllowTcpForwarding) et la cible est-elle joignable depuis lui ?`, 'SSH'));
      channel.on('error', () => undefined);
      channel.close();
      resolve();
    });
  });
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined);
      session.client.forwardOut(socket.localAddress ?? '127.0.0.1', socket.localPort ?? 0, targetHost, targetPort, (err, channel) => {
        if (err) {
          socket.destroy();
          return;
        }
        channel.on('error', () => socket.destroy());
        socket.on('close', () => channel.destroy());
        channel.on('close', () => socket.end());
        socket.pipe(channel).pipe(socket);
      });
    });
    server.on('error', (err) => reject(new AppError(`Tunnel impossible : ${err.message}`, 'SSH')));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
