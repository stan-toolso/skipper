import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import type { SpawnSpec } from '../runners/types.js';

/**
 * Client CDP (Chrome DevTools Protocol) minimal, en sessions « à plat » (`flatten`), relié au navigateur
 * par un tunnel : un processus (`docker exec -i ... node`) dont l'entrée et la sortie standard sont un flux
 * d'octets vers le port CDP. Le WebSocket est ouvert par-dessus ce flux, sans connexion réseau directe.
 */
export class CdpClient extends EventEmitter {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    super();
    ws.on('message', (raw: Buffer) => this.onMessage(raw));
    ws.on('close', () => this.onClose());
    ws.on('error', (err) => this.emit('error', err));
  }

  /** Ouvre le WebSocket CDP `path` (ex. /devtools/browser/<id>) à travers le tunnel décrit par `tunnel`. */
  static connect(tunnel: SpawnSpec, path: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(`ws://127.0.0.1${path}`, {
      createConnection: () => tunnelStream(tunnel) as never,
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
      handshakeTimeout: timeoutMs,
    });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new CdpClient(ws)));
      ws.once('error', reject);
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Connexion CDP fermée'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.ws.terminate();
  }

  private onMessage(raw: Buffer): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit('event', msg.method, msg.params ?? {}, msg.sessionId);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('Connexion CDP fermée'));
    this.pending.clear();
    this.emit('close');
  }
}

/** Flux duplex adossé à l'entrée et à la sortie standard d'un processus. */
function tunnelStream(spec: SpawnSpec): Duplex {
  const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env: spec.env ? { ...process.env, ...spec.env } : process.env });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
  const stream = new Duplex({
    write(chunk, _enc, cb) {
      child.stdin.write(chunk, cb);
    },
    final(cb) {
      child.stdin.end(cb);
    },
    read() {
      child.stdout.resume();
    },
    destroy(err, cb) {
      child.kill();
      cb(err);
    },
  });
  child.stdout.on('data', (b: Buffer) => {
    if (!stream.push(b)) child.stdout.pause();
  });
  child.stdout.on('end', () => stream.push(null));
  child.stdin.on('error', () => undefined);
  child.on('error', (err) => stream.destroy(err));
  child.on('close', (code) => {
    if (code) stream.destroy(new Error(`Tunnel CDP fermé (code ${code})${stderr.trim() ? ` : ${stderr.trim()}` : ''}`));
  });
  // Le client WebSocket attend un net.Socket : ces réglages n'ont pas de sens sur un tube.
  return Object.assign(stream, { setNoDelay: () => stream, setTimeout: () => stream, setKeepAlive: () => stream });
}
