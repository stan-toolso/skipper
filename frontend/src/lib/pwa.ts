import { registerSW } from 'virtual:pwa-register';

/** Événement Chrome/Android proposant l'installation ; on le garde pour le déclencher depuis un bouton. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((l) => l());
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  listeners.forEach((l) => l());
  return outcome === 'accepted';
}

export function onInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const updateListeners = new Set<() => void>();
let updateReady: (() => Promise<void>) | null = null;

/** Enregistre le service worker ; une nouvelle version attend que l'utilisateur demande le rechargement. */
export function setupServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateReady = () => update(true);
      updateListeners.forEach((l) => l());
    },
    onRegisteredSW(_url, registration) {
      // Vérification horaire et au retour sur l'onglet.
      if (!registration) return;
      setInterval(() => void registration.update(), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update();
      });
    },
  });
  // Navigation demandée par une notification système (service worker).
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; link?: string }>) => {
    if (e.data?.type === 'skipper:navigate' && typeof e.data.link === 'string') navigateListeners.forEach((l) => l(e.data.link!));
  });
}

export function onUpdateAvailable(listener: () => void): () => void {
  updateListeners.add(listener);
  if (updateReady) listener();
  return () => updateListeners.delete(listener);
}

/** Applique la nouvelle version et recharge la page. */
export async function reloadForUpdate(): Promise<void> {
  if (updateReady) await updateReady();
  else window.location.reload();
}

const navigateListeners = new Set<(link: string) => void>();
export function onPushNavigate(listener: (link: string) => void): () => void {
  navigateListeners.add(listener);
  return () => navigateListeners.delete(listener);
}
