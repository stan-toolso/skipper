import { NotFoundError } from '../errors.js';
import { pubSub } from '../pubsub.js';
import { notificationRepository } from './repository.js';
import type { Notification, NotifyInput } from './types.js';

export const notificationService = {
  list: (opts?: { unreadOnly?: boolean; limit?: number }) => notificationRepository.list(opts),
  countUnread: () => notificationRepository.countUnread(),

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

  markAllRead: () => notificationRepository.markAllRead(),
};
