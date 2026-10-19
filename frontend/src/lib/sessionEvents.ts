import { useApolloClient } from '@apollo/client';
import { useEffect, useState } from 'react';
import { SESSION_EVENTS, type SessionEvent, type SessionLiveDraft } from '../graphql/operations';

/** Taille d'une page d'événements (le serveur plafonne à 2000). */
const PAGE_SIZE = 500;
/** Délai entre deux relevés une fois l'historique rattrapé. */
const POLL_MS = 1500;
/** Délai resserré tant que l'agent écrit (brouillon en direct) : la réponse s'affiche au fil de l'eau. */
const LIVE_POLL_MS = 400;

/**
 * Événements d'une session : l'historique est chargé page par page, puis seuls les nouveaux événements
 * sont demandés (curseur `after`). Le serveur ne renvoie qu'une page à la fois : sans curseur, le
 * transcript d'une longue session resterait figé sur ses premiers événements. `draft` : ce que l'agent est en
 * train d'écrire (texte reçu en streaming par le serveur, pas encore journalisé), relevé plus souvent tant qu'il existe.
 */
export function useSessionEvents(sessionId: string): { events: SessionEvent[]; loaded: boolean; draft: SessionLiveDraft | null } {
  const client = useApolloClient();
  const [state, setState] = useState<{ sessionId: string; events: SessionEvent[]; loaded: boolean; draft: SessionLiveDraft | null }>({ sessionId, events: [], loaded: false, draft: null });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after: string | null = null;
    setState({ sessionId, events: [], loaded: false, draft: null });

    const tick = async () => {
      let full = false;
      let live = false;
      try {
        const { data } = await client.query<{ session: { events: SessionEvent[]; liveDraft: SessionLiveDraft | null } | null }>({
          query: SESSION_EVENTS,
          variables: { id: sessionId, after, limit: PAGE_SIZE },
          fetchPolicy: 'no-cache',
        });
        if (cancelled) return;
        const page = data.session?.events ?? [];
        full = page.length >= PAGE_SIZE;
        if (page.length) after = page[page.length - 1].id;
        const draft = data.session?.liveDraft ?? null;
        live = draft !== null;
        setState((prev) => ({ sessionId, events: page.length ? [...prev.events, ...page] : prev.events, loaded: prev.loaded || !full, draft }));
      } catch {
        // Erreur passagère (réseau, redémarrage du serveur) : nouvel essai au prochain relevé.
        if (cancelled) return;
      }
      // Page pleine : il reste de l'historique, on enchaîne sans attendre.
      timer = setTimeout(tick, full ? 0 : live ? LIVE_POLL_MS : POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, sessionId]);

  // Au changement de session, l'état de la précédente ne doit pas s'afficher le temps d'un rendu.
  return state.sessionId === sessionId ? { events: state.events, loaded: state.loaded, draft: state.draft } : { events: [], loaded: false, draft: null };
}
