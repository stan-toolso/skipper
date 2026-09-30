import { NotFoundError } from '../errors.js';
import { pubSub } from '../pubsub.js';
import { notificationRepository } from './repository.js';
import type { Notification, NotificationScope, NotifyInput } from './types.js';

export const notificationService = {
  list: (opts?: { unreadOnly?: boolean; limit?: number } & NotificationScope) => notificationRepository.list(opts),
  countUnread: (scope?: NotificationScope) => notificationRepository.countUnread(scope),

  async get(id: string): Promise<Notification> {
    const n = await notificationRepository.findById(id);
    if (!n) throw new NotFoundError('Notification introuvable');
    return n;
  },

  /** Crée une notification et la diffuse en temps réel. Ne lève jamais : un échec ne doit pas casser l'action d'origine. */
  async notify(input: NotifyInput): Promise<Notification | null> {
    try {
      const notification = await notificationRepository.create(input);
      pubSub.publish('notificationCreated', notification);
      return notification;
    } catch (err) {
      console.error('[notifications] création impossible', err);
      return null;
    }
  },

  async markRead(id: string): Promise<Notification> {
    const n = await notificationRepository.markRead(id);
    if (!n) throw new NotFoundError('Notification introuvable');
    return n;
  },

  markAllRead: (scope?: NotificationScope) => notificationRepository.markAllRead(scope),

  /**
   * Une demande réglée (répondue, annulée, expirée) n'a plus à attirer l'attention : sa notification
   * est marquée lue. Ne lève jamais : le règlement de la demande ne doit pas en dépendre.
   */
  async markReadForRequests(requestIds: string[]): Promise<void> {
    try {
      await notificationRepository.markReadForRequests(requestIds);
    } catch (err) {
      console.error('[notifications] marquage des demandes réglées impossible', err);
    }
  },

  async markReadForSettledRequests(): Promise<void> {
    try {
      await notificationRepository.markReadForSettledRequests();
    } catch (err) {
      console.error('[notifications] rattrapage des demandes réglées impossible', err);
    }
  },
};
