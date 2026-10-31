import pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { log } from '../log.js';
import { notificationRepository } from '../notifications/repository.js';
import { pubSub, type PubSubMessage } from '../pubsub.js';
import { requestRepository } from '../requests/repository.js';
import { requestService } from '../requests/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { instanceRegistry } from './registry.js';

/**
 * Bus entre instances du backend (PostgreSQL LISTEN/NOTIFY, canal `skipper_bus`). Pendant un déploiement bleu/vert,
 * l'ancienne instance finit les tours en cours pendant que l'interface est servie par la nouvelle : chaque publication
 * temps réel (événement et état de session, demandes, notifications) est relayée aux autres instances, qui la livrent
 * à leurs subscriptions GraphQL. Seule la référence circule (NOTIFY est limité à 8 000 octets) : le destinataire relit
 * la ligne en base. Les réponses aux demandes passent par là aussi : l'instance qui attend la réponse la reçoit.
 *
 * Les publications reçues ne vont qu'aux abonnés (pubSub.publishLocal) : la logique serveur qui réagit aux
 * publications locales ne s'exécute qu'une fois, sur l'instance d'origine.
 */

const CHANNEL = 'skipper_bus';
const RECONNECT_MS = 2_000;

type BusMessage =
  | { o: string; t: 'pub'; c: PubSubMessage[0]; id: string; s?: string }
  | { o: string; t: 'hello' }
  | { o: string; t: 'bye'; interrupted: number };

let client: pg.Client | null = null;
let stopped = true;
let sending: Promise<unknown> = Promise.resolve();
let receiving: Promise<unknown> = Promise.resolve();
const exitListeners: ((instanceId: string, interrupted: number) => void)[] = [];

/** Envoi dans l'ordre des publications (un événement ne double pas le précédent). */
function send(message: BusMessage): Promise<unknown> {
  sending = sending
    .then(() => pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(message)]))
    .catch((err) => log.warn(`[instances] bus : envoi impossible : ${(err as Error).message}`));
  return sending;
}

/** Référence d'une publication : le type de la ligne et son identifiant. */
function reference(message: PubSubMessage): BusMessage | null {
  const o = instanceRegistry.id;
  switch (message[0]) {
    case 'sessionEvent':
      return { o, t: 'pub', c: 'sessionEvent', id: message[2].id, s: message[1] };
    case 'sessionUpdated':
      return { o, t: 'pub', c: 'sessionUpdated', id: message[1].id };
    case 'requestCreated':
    case 'requestUpdated':
      return { o, t: 'pub', c: message[0], id: message[1].id };
    case 'notificationCreated':
      return { o, t: 'pub', c: 'notificationCreated', id: message[1].id };
  }
}

/** Relit la ligne publiée par une autre instance et la livre aux abonnés d'ici. */
async function deliver(message: Extract<BusMessage, { t: 'pub' }>): Promise<void> {
  switch (message.c) {
    case 'sessionEvent': {
      const event = await sessionRepository.findEvent(message.id);
      if (event) pubSub.publishLocal('sessionEvent', message.s ?? event.sessionId, event);
      return;
    }
    case 'sessionUpdated': {
      const session = await sessionRepository.findById(message.id);
      if (session) pubSub.publishLocal('sessionUpdated', session);
      return;
    }
    case 'requestCreated':
    case 'requestUpdated': {
      const request = await requestRepository.findById(message.id);
      if (!request) return;
      pubSub.publishLocal(message.c, request);
      // Réponse donnée sur une autre instance à une demande dont l'agent tourne ici.
      if (message.c === 'requestUpdated') requestService.settleLocalWaiter(request);
      return;
    }
    case 'notificationCreated': {
      const notification = await notificationRepository.findById(message.id);
      if (notification) pubSub.publishLocal('notificationCreated', notification);
      return;
    }
  }
}

async function receive(payload: string | undefined): Promise<void> {
  let message: BusMessage;
  try {
    message = JSON.parse(payload ?? '');
  } catch {
    return;
  }
  if (!message?.o || message.o === instanceRegistry.id) return;
  // Instance inconnue (elle vient de démarrer) ou qui s'arrête : la liste des pairs est relue.
  if (message.t !== 'pub' || !instanceRegistry.peers().some((p) => p.id === message.o)) await instanceRegistry.refresh();
  if (message.t === 'pub') await deliver(message);
  else if (message.t === 'bye') for (const listener of exitListeners) listener(message.o, message.interrupted);
}

async function connect(): Promise<void> {
  if (stopped) return;
  const c = new pg.Client({ connectionString: config.databaseUrl });
  const retry = (err?: Error) => {
    if (client !== c) return;
    client = null;
    c.removeAllListeners();
    c.on('error', () => undefined);
    void c.end().catch(() => undefined);
    if (stopped) return;
    if (err) log.warn(`[instances] bus : connexion perdue (${err.message}), reconnexion`);
    setTimeout(() => void connect(), RECONNECT_MS).unref();
  };
  c.on('error', (err) => retry(err));
  c.on('end', () => retry(new Error('fermée')));
  c.on('notification', (n) => {
    receiving = receiving.then(() => receive(n.payload)).catch((err) => log.warn(`[instances] bus : réception : ${(err as Error).message}`));
  });
  client = c;
  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
  } catch (err) {
    retry(err as Error);
  }
}

export const instanceBus = {
  /** Écoute du bus et relais des publications locales ; annonce l'arrivée de cette instance. */
  async start(): Promise<void> {
    stopped = false;
    await connect();
    pubSub.setRelay((message) => {
      if (!instanceRegistry.hasPeers()) return;
      const ref = reference(message);
      if (ref) void send(ref);
    });
    await send({ o: instanceRegistry.id, t: 'hello' });
  },

  /** Une autre instance s'arrête (`interrupted` : sessions qu'elle a dû interrompre). */
  onPeerExit(listener: (instanceId: string, interrupted: number) => void): void {
    exitListeners.push(listener);
  },

  /** Annonce le départ de cette instance, puis cesse d'écouter. */
  async stop(interrupted = 0): Promise<void> {
    pubSub.setRelay(null);
    await send({ o: instanceRegistry.id, t: 'bye', interrupted });
    stopped = true;
    const c = client;
    client = null;
    if (c) {
      c.removeAllListeners();
      c.on('error', () => undefined);
      await c.end().catch(() => undefined);
    }
  },
};
