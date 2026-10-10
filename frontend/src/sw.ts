/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0] };

/**
 * Service worker de Skipper : coquille de l'application en cache (navigation hors ligne), mise à jour sur
 * demande, et notifications push (notifications système, badge de l'icône, clic qui ouvre la page concernée).
 */
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/graphql/, /^\/terminals\//, /^\/browsers\//, /^\/auth\//, /^\/api\//, /^\/privacy\.html$/] }));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

interface PushPayload {
  id: string;
  title: string;
  body?: string | null;
  link?: string | null;
  tag?: string;
  /** Non-lues du destinataire ; -1 : inconnu. */
  unread?: number;
}

/** Safari / iOS révoque un abonnement dont une notification n'affiche rien : on affiche toujours chez WebKit. */
const mustAlwaysShow = /AppleWebKit/.test(self.navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(self.navigator.userAgent);

self.addEventListener('push', (event) => {
  let payload: PushPayload | null = null;
  try {
    payload = event.data?.json() as PushPayload;
  } catch {
    payload = null;
  }
  if (!payload?.title) return;
  const p = payload;
  event.waitUntil(
    (async () => {
      try {
        if (typeof p.unread === 'number' && p.unread >= 0) {
          if (p.unread > 0) await self.navigator.setAppBadge?.(p.unread);
          else await self.navigator.clearAppBadge?.();
        }
      } catch {
        /* badge indisponible */
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = clients.some((c) => c.focused);
      // Une fenêtre au premier plan a déjà la cloche ; la notification système n'apporterait que du bruit.
      if (focused && p.id !== 'test' && !mustAlwaysShow) return;
      await self.registration.showNotification(p.title, { body: p.body ?? undefined, tag: p.tag ?? `skipper-${p.id}`, icon: '/icon-192.png', data: { link: p.link ?? '/' } });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data as { link?: string } | undefined)?.link ?? '/';
  const link = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = clients.find((c) => c.focused) ?? clients[0];
      if (target) {
        await target.focus();
        target.postMessage({ type: 'skipper:navigate', link });
      } else {
        await self.clients.openWindow(link);
      }
    })(),
  );
});
