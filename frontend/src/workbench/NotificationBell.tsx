import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MARK_ALL_NOTIFICATIONS_READ, MARK_NOTIFICATION_READ, NOTIFICATIONS, type AppNotification } from '../graphql/operations';
import { timeAgo } from '../lib/humanize';

const icons: Record<string, string> = {
  'request.created': 'bi-hand-index-thumb',
  'task.created': 'bi-plus-square',
  'task.completed': 'bi-check2-square',
  'session.completed': 'bi-check-circle',
  'session.failed': 'bi-x-octagon',
  'claude.rate_limit': 'bi-speedometer2',
  'context.created': 'bi-journal-plus',
  'schedule.run': 'bi-alarm',
  'schedule.skipped': 'bi-alarm',
  'schedule.failed': 'bi-alarm',
};

const BROWSER_KEY = 'skipper.notifications.browser';

/** Cloche de notifications : compteur de non-lues, panneau déroulant, notifications natives du navigateur en option. */
export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(false);
  const { data, refetch } = useQuery<{ notifications: AppNotification[]; unreadNotificationCount: number }>(NOTIFICATIONS, { variables: { limit: 30 }, pollInterval: 3000 });
  const [markRead] = useMutation(MARK_NOTIFICATION_READ, { onCompleted: () => refetch() });
  const [markAllRead] = useMutation(MARK_ALL_NOTIFICATIONS_READ, { onCompleted: () => refetch() });
  const unread = data?.unreadNotificationCount ?? 0;
  const notifications = data?.notifications ?? [];
  const [browserEnabled, setBrowserEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BROWSER_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch {
      return false;
    }
  });

  // Détecte les nouvelles notifications pour faire sonner la cloche et, si activé, notifier le navigateur.
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
        if (browserEnabled && document.visibilityState !== 'visible') {
          for (const n of fresh.slice(0, 3)) {
            const notif = new Notification(n.title, { body: n.message ?? undefined, tag: `skipper-${n.id}` });
            notif.onclick = () => {
              window.focus();
              if (n.link) navigate(n.link);
            };
          }
        }
      }
    }
  }, [notifications, browserEnabled, navigate]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  const enableBrowser = async () => {
    if (typeof Notification === 'undefined') return;
    const permission = await Notification.requestPermission();
    const ok = permission === 'granted';
    setBrowserEnabled(ok);
    try {
      localStorage.setItem(BROWSER_KEY, ok ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const openNotification = (n: AppNotification) => {
    if (!n.readAt) markRead({ variables: { id: n.id } });
    setOpen(false);
    if (n.link) navigate(n.link);
  };

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
          <div className="wb-notif-foot">
            <span>{browserEnabled ? 'Notifications du navigateur activées' : 'Soyez prévenu même sur un autre onglet'}</span>
            {!browserEnabled && typeof Notification !== 'undefined' && (
              <button type="button" onClick={enableBrowser}>
                Activer
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
