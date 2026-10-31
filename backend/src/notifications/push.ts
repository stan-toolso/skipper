import webPush from 'web-push';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { settingsRepository } from '../settings/repository.js';
import { pushPreferencesService, wantsPush } from './preferences.js';
import { pushRepository } from './pushRepository.js';
import { notificationRepository } from './repository.js';
import type { Notification } from './types.js';
import { log } from '../log.js';

/**
 * Notifications Web Push : les appareils abonnés reçoivent les notifications de la cloche même quand
 * Skipper est fermé. La paire de clés VAPID est générée une fois et rangée dans app_settings (clé
 * privée chiffrée). Aucune donnée secrète ne circule dans une notification.
 */

const VAPID_KEY = 'push.vapid';
const TTL_SECONDS = 86_400;

interface VapidPair {
  publicKey: string;
  /** Chiffrée. */
  privateKey: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

let vapid: { publicKey: string; privateKey: string } | null = null;

/** Sujet VAPID : l'URL de l'application en https, sinon une adresse mailto (le service d'Apple refuse localhost). */
function subject(): string {
  const env = process.env.VAPID_SUBJECT?.trim();
  if (env) return env;
  return config.appUrl.startsWith('https://') ? config.appUrl : 'mailto:skipper@localhost.localdomain';
}

async function loadVapid(): Promise<{ publicKey: string; privateKey: string }> {
  if (vapid) return vapid;
  let stored = await settingsRepository.get<VapidPair>(VAPID_KEY);
  if (!stored) {
    const pair = webPush.generateVAPIDKeys();
    // Plusieurs instances au démarrage : la première écrit, les autres relisent.
    await settingsRepository.setIfAbsent(VAPID_KEY, { publicKey: pair.publicKey, privateKey: encryptSecret(pair.privateKey) } satisfies VapidPair);
    stored = (await settingsRepository.get<VapidPair>(VAPID_KEY))!;
  }
  vapid = { publicKey: stored.publicKey, privateKey: decryptSecret(stored.privateKey) };
  return vapid;
}

interface Payload {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  tag: string;
  /** Nombre de notifications non lues du destinataire ; -1 : inconnu (ne pas toucher au badge). */
  unread: number;
}

async function send(sub: { id: string; endpoint: string; keys: string }, payload: Payload, urgency: 'high' | 'normal'): Promise<void> {
  const keys = JSON.parse(decryptSecret(sub.keys)) as { p256dh: string; auth: string };
  const { publicKey, privateKey } = await loadVapid();
  try {
    await webPush.sendNotification({ endpoint: sub.endpoint, keys }, JSON.stringify(payload), { TTL: TTL_SECONDS, urgency, timeout: 10_000, vapidDetails: { subject: subject(), publicKey, privateKey } });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await pushRepository.deleteById(sub.id);
      log.info(`[push] abonnement expiré supprimé (${status})`);
      return;
    }
    await pushRepository.recordError(sub.id, (err as Error).message);
    log.warn(`[push] envoi impossible : ${(err as Error).message}`);
  }
}

export const pushService = {
  publicKey: async () => (await loadVapid()).publicKey,

  async subscribe(userId: string, input: PushSubscriptionInput): Promise<void> {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new AppError("Adresse d'abonnement invalide");
    }
    if (endpoint.protocol !== 'https:') throw new AppError("L'adresse d'abonnement doit être en https");
    if (!input.p256dh || input.p256dh.length > 200 || !input.auth || input.auth.length > 100) throw new AppError("Clés d'abonnement invalides");
    await pushRepository.upsert(userId, input.endpoint, encryptSecret(JSON.stringify({ p256dh: input.p256dh, auth: input.auth })), input.userAgent?.slice(0, 300) ?? null);
  },

  unsubscribe: (userId: string, endpoint: string) => pushRepository.delete(userId, endpoint),

  /**
   * Envoie la notification aux appareils des personnes qui la verraient dans leur cloche et qui n'ont pas
   * coupé cette famille de notifications (preferences.ts). Ne lève jamais.
   */
  async deliver(n: Notification): Promise<void> {
    try {
      const subscribed = await pushRepository.recipients({ userId: n.userId, adminsOnly: n.adminsOnly, projectId: n.projectId });
      if (!subscribed.length) return;
      const muted = await pushPreferencesService.mutedOf([...new Set(subscribed.map((s) => s.userId))]);
      const recipients = subscribed.filter((s) => wantsPush(n.type, muted.get(s.userId) ?? []));
      if (!recipients.length) return;
      const unreadByUser = new Map<string, Promise<number>>();
      const unreadOf = (userId: string, admin: boolean) => {
        let p = unreadByUser.get(userId);
        if (!p) {
          p = notificationRepository.countUnread({ userId, admin, projectIds: undefined }).catch(() => 0);
          unreadByUser.set(userId, p);
        }
        return p;
      };
      await Promise.all(
        recipients.map(async (sub) =>
          send(
            sub,
            { id: n.id, title: n.title, body: n.message ? (n.message.length > 1000 ? `${n.message.slice(0, 1000)}…` : n.message) : null, link: n.link, tag: `skipper-${n.id}`, unread: await unreadOf(sub.userId, sub.isAdmin) },
            n.type === 'request.created' ? 'high' : 'normal',
          ),
        ),
      );
    } catch (err) {
      log.error('[push] distribution impossible', err);
    }
  },

  /** Notification de test vers les appareils de la personne ; renvoie leur nombre. */
  async test(userId: string): Promise<number> {
    const subs = await pushRepository.listForUser(userId);
    await Promise.all(subs.map((sub) => send(sub, { id: 'test', title: 'Skipper', body: 'Les notifications push fonctionnent', link: '/', tag: 'skipper-test', unread: -1 }, 'high')));
    return subs.length;
  },
};
