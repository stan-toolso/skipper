import { useApolloClient } from '@apollo/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSION_EVENTS, type SessionEvent } from '../graphql/operations';

/** Taille d'une page d'événements (le serveur plafonne à 2000). */
const PAGE_SIZE = 500;
/** Délai entre deux relevés une fois l'historique rattrapé. */
const POLL_MS = 1500;

/**
 * Événements d'une session : l'historique est chargé page par page, puis seuls les nouveaux événements
 * sont demandés (curseur `after`). Le serveur ne renvoie qu'une page à la fois : sans curseur, le
 * transcript d'une longue session resterait figé sur ses premiers événements.
 *
 * `refresh` déclenche un relevé sans attendre le prochain : après l'envoi d'une instruction, l'événement
 * qui la journalise est affiché dès que le serveur l'a écrit plutôt qu'au relevé suivant.
 */
export function useSessionEvents(sessionId: string): { events: SessionEvent[]; loaded: boolean; refresh: () => void } {
  const client = useApolloClient();
  const [state, setState] = useState<{ sessionId: string; events: SessionEvent[]; loaded: boolean }>({ sessionId, events: [], loaded: false });
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after: string | null = null;
    let inFlight = false;
    let again = false;
    setState({ sessionId, events: [], loaded: false });

    const tick = async () => {
      // Un relevé à la fois : une demande arrivée pendant un relevé en relance un dès qu'il est terminé.
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
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
      inFlight = false;
      if (cancelled) return;
      // Page pleine : il reste de l'historique, on enchaîne sans attendre.
      clearTimeout(timer);
      timer = setTimeout(tick, full || again ? 0 : POLL_MS);
      again = false;
    };
    refreshRef.current = () => {
      if (cancelled) return;
      clearTimeout(timer);
      void tick();
    };
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      refreshRef.current = () => undefined;
    };
  }, [client, sessionId]);
  const refresh = useCallback(() => refreshRef.current(), []);

  // Au changement de session, l'état de la précédente ne doit pas s'afficher le temps d'un rendu.
  return state.sessionId === sessionId ? { events: state.events, loaded: state.loaded, refresh } : { events: [], loaded: false, refresh };
}
