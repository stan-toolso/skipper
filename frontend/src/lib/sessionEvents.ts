import { useApolloClient } from '@apollo/client';
import { useEffect, useState } from 'react';
import { SESSION_EVENTS, type SessionEvent } from '../graphql/operations';

/** Taille d'une page d'événements (le serveur plafonne à 2000). */
const PAGE_SIZE = 500;
/** Délai entre deux relevés une fois l'historique rattrapé. */
const POLL_MS = 1500;

/**
 * Événements d'une session : l'historique est chargé page par page, puis seuls les nouveaux événements
 * sont demandés (curseur `after`). Le serveur ne renvoie qu'une page à la fois : sans curseur, le
 * transcript d'une longue session resterait figé sur ses premiers événements.
 */
export function useSessionEvents(sessionId: string): { events: SessionEvent[]; loaded: boolean } {
  const client = useApolloClient();
  const [state, setState] = useState<{ sessionId: string; events: SessionEvent[]; loaded: boolean }>({ sessionId, events: [], loaded: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after: string | null = null;
    setState({ sessionId, events: [], loaded: false });

    const tick = async () => {
      let full = false;
      try {
        const { data } = await client.query<{ session: { events: SessionEvent[] } | null }>({
          query: SESSION_EVENTS,
          variables: { id: sessionId, after, limit: PAGE_SIZE },
          fetchPolicy: 'no-cache',
        });
        if (cancelled) return;
        const page = data.session?.events ?? [];
        full = page.length >= PAGE_SIZE;
        if (page.length) after = page[page.length - 1].id;
        setState((prev) => ({ sessionId, events: page.length ? [...prev.events, ...page] : prev.events, loaded: prev.loaded || !full }));
      } catch {
        // Erreur passagère (réseau, redémarrage du serveur) : nouvel essai au prochain relevé.
        if (cancelled) return;
      }
      // Page pleine : il reste de l'historique, on enchaîne sans attendre.
      timer = setTimeout(tick, full ? 0 : POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, sessionId]);

  // Au changement de session, l'état de la précédente ne doit pas s'afficher le temps d'un rendu.
  return state.sessionId === sessionId ? { events: state.events, loaded: state.loaded } : { events: [], loaded: false };
}
