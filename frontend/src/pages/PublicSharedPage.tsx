import { useEffect, useState } from 'react';
import { Button, Spinner } from 'react-bootstrap';
import { apiBaseUrl, sharedPageUrl } from '../apollo';
import LoginPage from './LoginPage';
import './shared-session.css';

/** Réponse de GET /api/shared/<id>/info (backend/src/sharedPages/viewRoute.ts) : seulement pour une page publique. */
interface PublicPageInfo {
  id: string;
  title: string;
  description: string | null;
  kind: 'page' | 'data' | 'slides';
  version: number;
  updatedAt: string;
  ownerName: string | null;
}

type State = { kind: 'loading' } | { kind: 'login' } | { kind: 'error'; message: string } | { kind: 'ok'; info: PublicPageInfo };

/**
 * `/shared/<id>` sans connexion. Page publique (publicAccess) : lue dans un bac à sable, pleine fenêtre, avec un bandeau
 * (titre, auteur, « Se connecter » pour commenter). Toute autre page (inexistante, privée, ouverte aux seules personnes
 * connectées) : la page de connexion, sans révéler laquelle ; une fois connecté, l'application rouvre la même adresse.
 */
export default function PublicSharedPage({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/api/shared/${encodeURIComponent(id)}/info`, { credentials: 'omit' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) return setState({ kind: 'login' });
        if (!res.ok) return setState({ kind: 'error', message: `Le serveur a répondu ${res.status}.` });
        setState({ kind: 'ok', info: (await res.json()) as PublicPageInfo });
      })
      .catch((err: Error) => !cancelled && setState({ kind: 'error', message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (state.kind === 'ok') document.title = `${state.info.title} · Skipper`;
  }, [state]);

  if (state.kind === 'login') return <LoginPage />;
  if (state.kind === 'loading')
    return (
      <div className="shared-session-center">
        <Spinner animation="border" size="sm" />
      </div>
    );
  if (state.kind === 'error')
    return (
      <div className="shared-session-center">
        <div>
          <h1 className="h5">Page indisponible</h1>
          <p className="text-secondary mb-0">Impossible de charger la page ({state.message}).</p>
        </div>
      </div>
    );
  const { info } = state;
  return (
    <div className="public-page">
      <header className="public-page-bar">
        <span className="public-page-title" title={info.description ?? info.title}>
          {info.title}
        </span>
        {info.ownerName && <span className="public-page-meta">· {info.ownerName}</span>}
        <span className="flex-grow-1" />
        <Button size="sm" variant="link" className="p-0 text-nowrap" onClick={() => setState({ kind: 'login' })}>
          Se connecter
        </Button>
      </header>
      <iframe className="public-page-frame" title={info.title} src={sharedPageUrl(info.id)} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" allow="clipboard-write; fullscreen" />
    </div>
  );
}
