/** Abonnement de cet appareil aux notifications push (service worker). */

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && typeof Notification !== 'undefined';
}

function keyBytes(base64Url: string): Uint8Array {
  const padded = `${base64Url}${'='.repeat((4 - (base64Url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => Boolean(a) && new Uint8Array(a!).every((v, i) => v === b[i]) && a!.byteLength === b.length;

export interface PushRegistration {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}

/** Abonne l'appareil avec la clé publique du serveur (recrée l'abonnement si la clé a changé). */
export async function subscribePush(publicKey: string): Promise<PushRegistration> {
  const registration = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let sub = await registration.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.buffer as ArrayBuffer });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('Abonnement push incomplet');
  return { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, userAgent: navigator.userAgent };
}

/** Désabonne l'appareil ; renvoie l'adresse à oublier côté serveur. */
export async function unsubscribePush(): Promise<string | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return null;
  await sub.unsubscribe().catch(() => undefined);
  return sub.endpoint;
}

/** Système d'exploitation de l'appareil, pour les conseils d'activation des notifications. */
export function osPlatform(): 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'other' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mac/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}

export const OS_HINTS: Record<ReturnType<typeof osPlatform>, string> = {
  mac: 'Réglages système › Notifications › votre navigateur (ou l’application Skipper) › Autoriser les notifications, et désactivez Concentration / Ne pas déranger.',
  windows: 'Paramètres › Système › Notifications : activez votre navigateur ou l’application, et désactivez l’assistant de concentration.',
  ios: 'Ajoutez d’abord Skipper à l’écran d’accueil (Partager › Sur l’écran d’accueil), puis activez les notifications (iOS 16.4 ou plus).',
  android: 'Paramètres › Applications › votre navigateur ou Skipper › Notifications, et vérifiez que Ne pas déranger est désactivé.',
  linux: 'Vérifiez les notifications de votre bureau et celles du navigateur pour ce site.',
  other: 'Vérifiez que les notifications sont autorisées pour ce site dans le navigateur et dans le système.',
};
