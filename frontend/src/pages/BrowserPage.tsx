import { useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { browserSocketUrl } from '../apollo';
import { SESSION_BROWSER, type Session } from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';

type StreamState = 'connecting' | 'waiting' | 'live' | 'ended' | 'error' | 'closed';
type ServerMessage = { type: 'status'; state: 'waiting' | 'live' | 'ended' | 'error'; message?: string } | { type: 'page'; url: string; title: string; tabs: number };

const RECONNECT_MS = 3000;

/**
 * Vue en direct du navigateur headless d'une session : le backend diffuse le screencast (JPEG) de
 * l'onglet que pilote l'agent, une image à chaque changement de la page. Lecture seule.
 */
export default function BrowserPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ session: Pick<Session, 'id' | 'name' | 'status' | 'browserActive'> & { project: { id: string; name: string } } | null }>(SESSION_BROWSER, {
    variables: { id },
    pollInterval: 5000,
  });
  const session = data?.session;
  useTabTitle(session ? `Navigateur · ${session.name}` : null);

  const [state, setState] = useState<StreamState>('connecting');
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState<{ url: string; title: string; tabs: number } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const running = session?.status === 'RUNNING';
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (!id) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let lastUrl: string | null = null;

    const connect = () => {
      setState('connecting');
      ws = new WebSocket(browserSocketUrl(id));
      ws.binaryType = 'blob';
      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          const url = URL.createObjectURL(event.data);
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = url;
          setFrame(url);
          return;
        }
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        if (msg.type === 'page') setPage({ url: msg.url, title: msg.title, tabs: msg.tabs });
        else {
          setState(msg.state);
          setMessage(msg.message ?? null);
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setState((s) => (s === 'ended' ? s : 'closed'));
        // Coupure (redémarrage du serveur, réseau) : on se reconnecte tant que la session tourne.
        timer = setTimeout(() => runningRef.current !== false && connect(), RECONNECT_MS);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
    };
  }, [id]);

  if (loading && !data) return <Spinner animation="border" size="sm" className="m-3" />;
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!session) return <Alert variant="warning" className="m-3">Session introuvable.</Alert>;

  const stateLabel: Record<StreamState, string> = {
    connecting: 'connexion…',
    waiting: 'pas de navigateur',
    live: 'en direct',
    ended: 'navigateur fermé',
    error: 'erreur',
    closed: 'déconnecté',
  };
  return (
    <div className="term-page">
      <div className="term-header">
        <div className="browser-header-main">
          <span className="term-title">
            <i className="bi bi-globe2" /> Navigateur
          </span>
          <span className="term-meta">
            {' '}
            · <Link to={`/sessions/${session.id}`} className="term-meta">{session.name}</Link> · <Link to={`/projects/${session.project.id}`} className="term-meta">{session.project.name}</Link>
          </span>
        </div>
        <span className={`browser-state ${state}`} title={message ?? undefined}>
          <span className="browser-state-dot" /> {stateLabel[state]}
        </span>
      </div>
      <div className="browser-urlbar" title={page?.title || undefined}>
        <i className="bi bi-link-45deg" />
        <span className="browser-url">{page?.url || '—'}</span>
        {page && page.tabs > 1 && <span className="browser-tabs" title="Onglets ouverts ; la vue suit le plus récent">{page.tabs} onglets</span>}
      </div>
      <div className="browser-viewport">
        {frame ? <img src={frame} alt={page?.title ?? 'Page courante du navigateur'} className={state === 'live' ? '' : 'stale'} /> : <div className="browser-empty">{message ?? (state === 'live' ? 'En attente de la première image…' : stateLabel[state])}</div>}
        {frame && state !== 'live' && message && <div className="browser-overlay">{message}</div>}
      </div>
    </div>
  );
}
