import { createPubSub } from 'graphql-yoga';
import type { Notification } from './notifications/types.js';
import type { HumanRequest } from './requests/types.js';
import type { Session, SessionEvent } from './sessions/types.js';

/** Canaux temps réel partagés par les services et les subscriptions GraphQL. */
export const pubSub = createPubSub<{
  sessionEvent: [sessionId: string, payload: SessionEvent];
  sessionUpdated: [payload: Session];
  requestCreated: [payload: HumanRequest];
  requestUpdated: [payload: HumanRequest];
  notificationCreated: [payload: Notification];
}>();
