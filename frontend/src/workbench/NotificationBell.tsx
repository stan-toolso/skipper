import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PUSH_PREFERENCES, PUSH_PUBLIC_KEY, SEND_TEST_PUSH, SUBSCRIBE_PUSH, UNSUBSCRIBE_PUSH, type PushCategory } from '../graphql/misc';
import { MARK_ALL_NOTIFICATIONS_READ, MARK_NOTIFICATION_READ, NOTIFICATIONS, type AppNotification } from '../graphql/operations';
import { timeAgo } from '../lib/humanize';
import { OS_HINTS, osPlatform, pushSupported, subscribePush, unsubscribePush } from '../lib/push';
import { onPushNavigate } from '../lib/pwa';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useShortcut } from '../lib/useShortcut';

const icons: Record<string, string> = {
  'request.created': 'bi-hand-index-thumb',
  'task.created': 'bi-plus-square',
  'task.completed': 'bi-check2-square',
  'task.mentioned': 'bi-at',
  'task.replied': 'bi-reply',
  'pull_request.opened': 'bi-git',
  'pull_request.merged': 'bi-check2-circle',
  'pull_request.closed': 'bi-x-circle',
  'session.completed': 'bi-check-circle',
  'session.failed': 'bi-x-octagon',
  'session.created': 'bi-chat-dots',
  'page.shared': 'bi-file-earmark-richtext',
  'claude.rate_limit': 'bi-speedometer2',
  'server.memory_low': 'bi-memory',
  'container.memory_high': 'bi-memory',
  'container.cpu_saturated': 'bi-speedometer2',
  'context.created': 'bi-journal-plus',
  'schedule.run': 'bi-alarm',
  'schedule.skipped': 'bi-alarm',
  'schedule.failed': 'bi-alarm',
  'workflow.run': 'bi-diagram-3',
  'workflow.failed': 'bi-diagram-3',
};

const BROWSER_KEY = 'skipper.notifications.browser';
type Permission = 'unsupported' | 'default' | 'granted' | 'denied';

const readPref = () => {
  try {
    return localStorage.getItem(BROWSER_KEY) === '1';
  } catch {
    return false;
  }
};
const writePref = (on: boolean) => {
  try {
    localStorage.setItem(BROWSER_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
};
const currentPermission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** Cloche de notifications : compteur de non-lues, panneau, notifications du navigateur et push (même application fermée). */
export default function NotificationBell() {
  const navigate = useNavigate();
  const client = useApolloClient();
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(false);
  const { data, refetch } = usePollingQuery<{ notifications: AppNotification[]; unreadNotificationCount: number }>(NOTIFICATIONS, { variables: { limit: 30 }, pollInterval: 3000 });
  const [markRead] = useMutation(MARK_NOTIFICATION_READ, { onCompleted: () => refetch() });
  const [markAllRead] = useMutation(MARK_ALL_NOTIFICATIONS_READ, { onCompleted: () => refetch() });
  const [subscribe] = useMutation(SUBSCRIBE_PUSH);
  const [unsubscribe] = useMutation(UNSUBSCRIBE_PUSH);
  const [sendTest] = useMutation<{ sendTestPush: number }>(SEND_TEST_PUSH);
  const unread = data?.unreadNotificationCount ?? 0;
  const notifications = data?.notifications ?? [];
  const [permission, setPermission] = useState<Permission>(currentPermission);
  const [pref, setPref] = useState(readPref);
  const [pushOn, setPushOn] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [showHint, setShowHint] = useState(false);
  const browserEnabled = pref && permission === 'granted';
  // Familles coupées dans Paramètres › Notifications : la cloche affiche tout, le navigateur ne montre que le reste.
  const { data: prefData } = useQuery<{ pushPreferences: PushCategory[] }>(PUSH_PREFERENCES, { skip: !browserEnabled, fetchPolicy: 'cache-and-network' });
  const mutedTypes = new Set(prefData?.pushPreferences.filter((c) => !c.enabled).flatMap((c) => c.types) ?? []);
  useShortcut({ id: 'notifications.close', keys: ['Escape'], label: 'Fermer les notifications', scope: 'context', area: 'Notifications', preventDefault: false }, () => setOpen(false), open);

  // Permission tenue à jour avec les réglages du site et du système.
  useEffect(() => {
    const refresh = () => setPermission(currentPermission());
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    let status: PermissionStatus | null = null;
    navigator.permissions?.query({ name: 'notifications' as PermissionName }).then((s) => {
      status = s;
      s.onchange = refresh;
    }).catch(() => undefined);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      if (status) status.onchange = null;
    };
  }, []);

  /** Abonne l'appareil au push (idempotent : garde l'abonnement à jour à chaque montage). */
  const registerPush = useCallback(async () => {
    if (!pushSupported()) return false;
    const { data: keyData } = await client.query<{ pushPublicKey: string }>({ query: PUSH_PUBLIC_KEY, fetchPolicy: 'network-only' });
    const reg = await subscribePush(keyData.pushPublicKey);
    await subscribe({ variables: { input: reg } });
    setPushOn(true);
    return true;
  }, [client, subscribe]);

  useEffect(() => {
    if (browserEnabled) registerPush().catch((err) => console.warn('[push] abonnement impossible', err));
  }, [browserEnabled, registerPush]);

  // Badge de l'icône de l'application installée.
  useEffect(() => {
    try {
      if (unread > 0) void navigator.setAppBadge?.(unread);
      else void navigator.clearAppBadge?.();
    } catch {
      /* badge indisponible */
    }
  }, [unread]);

  // Clic sur une notification système : navigation dans l'application.
  useEffect(() => onPushNavigate((link) => navigate(link)), [navigate]);

  // Nouvelles notifications : la cloche sonne et, si activé, le navigateur notifie quand la fenêtre n'a pas le focus.
  const lastSeenId = useRef<string | null>(null);
  useEffect(() => {
    if (!notifications.length) return;
    const newest = notifications[0];
    if (lastSeenId.current === null) {
      lastSeenId.current = newest.id;
      return;
    }
    if (newest.id !== lastSeenId.current) {
      const fresh = notifications.filter((n) => Number(n.id) > Number(lastSeenId.current) && !n.readAt);
      lastSeenId.current = newest.id;
      if (fresh.length) {
        setRing(true);
        setTimeout(() => setRing(false), 1200);
        if (browserEnabled && !document.hasFocus()) {
          for (const n of fresh.filter((n) => !mutedTypes.has(n.type)).slice(0, 3)) void showLocal(n.title, n.message ?? undefined, `skipper-${n.id}`, n.link);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, browserEnabled]);

  const showLocal = async (title: string, body: string | undefined, tag: string, link: string | null) => {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) return registration.showNotification(title, { body, tag, icon: '/icon-192.png', data: { link: link ?? '/' } });
    const notif = new Notification(title, { body, tag });
    notif.onclick = () => {
      window.focus();
      if (link) navigate(link);
    };
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  const enable = async () => {
    if (permission === 'unsupported') return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== 'granted') return;
    writePref(true);
    setPref(true);
    try {
      await registerPush();
    } catch (err) {
      setNotice({ text: `Notifications push impossibles : ${(err as Error).message}`, error: true });
    }
    void showLocal('Skipper', 'Les notifications fonctionnent', 'skipper-test', null);
    setShowHint(true);
  };

  const disable = async () => {
    writePref(false);
    setPref(false);
    setPushOn(false);
    const endpoint = await unsubscribePush().catch(() => null);
    if (endpoint) await unsubscribe({ variables: { endpoint } }).catch(() => undefined);
  };

  const test = async () => {
    setNotice(null);
    try {
      if (pushOn) {
        const res = await sendTest();
        setNotice({ text: `Notification de test envoyée à ${res.data?.sendTestPush ?? 0} appareil(s). Si vous ne la voyez pas, vérifiez les réglages du système.` });
      } else {
        await showLocal('Skipper', 'Notification de test', 'skipper-test', null);
        setNotice({ text: 'Notification de test affichée.' });
      }
    } catch (err) {
      setNotice({ text: (err as Error).message, error: true });
    }
    setShowHint(true);
  };

  const openNotification = (n: AppNotification) => {
    if (!n.readAt) markRead({ variables: { id: n.id } });
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const hint = OS_HINTS[osPlatform()];
  return (
    <div className="wb-bell" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`wb-bell-btn${open ? ' open' : ''}${ring ? ' ring' : ''}`} title="Notifications" onClick={() => setOpen((v) => !v)}>
        <i className={`bi ${unread ? 'bi-bell-fill' : 'bi-bell'}`} />
        {unread > 0 && <span className="wb-bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="wb-notif-panel">
          <div className="wb-notif-head">
            <span>Notifications</span>
            {unread > 0 && (
              <button type="button" onClick={() => markAllRead()}>
                Tout marquer comme lu
              </button>
            )}
          </div>
          <div className="wb-notif-list">
            {notifications.length === 0 && <div className="wb-notif-empty">Rien à signaler pour le moment.</div>}
            {notifications.map((n) => (
              <div key={n.id} className={`wb-notif${n.readAt ? '' : ' unread'}`} onClick={() => openNotification(n)}>
                <span className="wb-notif-icon">
                  <i className={`bi ${icons[n.type] ?? 'bi-info-circle'}`} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <div className="wb-notif-title">{n.title}</div>
                  {n.message && <div className="wb-notif-msg">{n.message}</div>}
                  <div className="wb-notif-time">
                    {timeAgo(n.createdAt)}
                    {n.project && ` · ${n.project.name}`}
                  </div>
                </span>
              </div>
            ))}
          </div>
          <div className="wb-notif-foot flex-column align-items-stretch gap-1">
            {permission === 'unsupported' && <span>Les notifications du navigateur ne sont pas prises en charge ici.</span>}
            {permission === 'default' && (
              <div className="d-flex justify-content-between align-items-center gap-2">
                <span>Soyez prévenu même sur un autre onglet, ou application fermée</span>
                <button type="button" onClick={() => void enable()}>
                  Activer
                </button>
              </div>
            )}
            {permission === 'granted' && (
              <div className="d-flex justify-content-between align-items-center gap-2">
                <span>{pushOn ? 'Notifications actives, même Skipper fermé' : browserEnabled ? 'Notifications du navigateur activées' : 'Notifications du navigateur désactivées'}</span>
                <span className="d-flex gap-1">
                  {browserEnabled && (
                    <button type="button" onClick={() => void test()}>
                      Tester
                    </button>
                  )}
                  <button type="button" onClick={() => (browserEnabled ? void disable() : void enable())}>
                    {browserEnabled ? 'Désactiver' : 'Activer'}
                  </button>
                </span>
              </div>
            )}
            {permission === 'denied' && <span>Bloquées par le navigateur ou le système : autorisez les notifications pour ce site (cadenas de la barre d'adresse) et dans les réglages du système.</span>}
            {notice && (
              <span role="alert" className={notice.error ? 'text-danger' : ''}>
                {notice.text}
              </span>
            )}
            {(showHint || permission === 'denied') && <span className="text-secondary">{hint}</span>}
            {browserEnabled && (
              <button
                type="button"
                className="align-self-start"
                onClick={() => {
                  setOpen(false);
                  navigate('/settings?section=notifications');
                }}
              >
                <i className="bi bi-sliders me-1" />
                Choisir ce que vous recevez
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
