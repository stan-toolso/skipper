import { createPubSub } from 'graphql-yoga';
import type { Notification } from './notifications/types.js';
import type { HumanRequest } from './requests/types.js';
import type { Session, SessionEvent } from './sessions/types.js';

export type PubSubChannels = {
  sessionEvent: [sessionId: string, payload: SessionEvent];
  sessionUpdated: [payload: Session];
  requestCreated: [payload: HumanRequest];
  requestUpdated: [payload: HumanRequest];
  notificationCreated: [payload: Notification];
};

export type PubSubMessage = { [K in keyof PubSubChannels]: [K, ...PubSubChannels[K]] }[keyof PubSubChannels];

const local = createPubSub<PubSubChannels>();
/** Relais vers les autres instances du backend (bus PostgreSQL, voir instances/bus.ts), posé au démarrage. */
let relay: ((message: PubSubMessage) => void) | null = null;

/**
 * Canaux temps réel partagés par les services et les subscriptions GraphQL. Une publication est relayée aux autres
 * instances du backend (déploiement bleu/vert) : leurs subscriptions voient ce que fait celle-ci.
 */
export const pubSub = {
  publish: ((...message: PubSubMessage) => {
    (local.publish as (...args: unknown[]) => void)(...message);
    relay?.(message);
  }) as typeof local.publish,
  subscribe: local.subscribe.bind(local) as typeof local.subscribe,
  /** Publication reçue d'une autre instance : livrée aux abonnés d'ici, sans être relayée de nouveau. */
  publishLocal(...message: PubSubMessage): void {
    (local.publish as (...args: unknown[]) => void)(...message);
  },
  setRelay(fn: ((message: PubSubMessage) => void) | null): void {
    relay = fn;
  },
};
