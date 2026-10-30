import { useApolloClient } from '@apollo/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSION_EVENTS, type SessionEvent, type SessionLiveDraft } from '../graphql/operations';

/** Taille d'une page d'événements (le serveur plafonne à 2000). */
const PAGE_SIZE = 500;
/** Délai entre deux relevés une fois l'historique rattrapé. */
const POLL_MS = 1500;
/** Délai resserré tant que l'agent écrit (brouillon en direct) : la réponse s'affiche au fil de l'eau. */
const LIVE_POLL_MS = 400;

export interface SessionEventsState {
  sessionId: string;
  events: SessionEvent[];
  loaded: boolean;
  draft: SessionLiveDraft | null;
}

const sameDraft = (a: SessionLiveDraft | null, b: SessionLiveDraft | null): boolean => (a === null || b === null ? a === b : a.text === b.text && a.thinking === b.thinking);

/**
 * État après un relevé. Renvoie l'état précédent **tel quel** quand rien n'a changé (page vide, brouillon
 * identique, historique déjà rattrapé) : React ne re-rend alors ni la page ni le transcript, qui ne
 * recalcule ses nœuds qu'à l'arrivée d'événements. Les événements d'une page sont ajoutés en fin de liste.
 */
export function nextEventsState(prev: SessionEventsState, page: SessionEvent[], draft: SessionLiveDraft | null, full: boolean): SessionEventsState {
  const loaded = prev.loaded || !full;
  if (!page.length && loaded === prev.loaded && sameDraft(prev.draft, draft)) return prev;
  return { sessionId: prev.sessionId, events: page.length ? [...prev.events, ...page] : prev.events, loaded, draft };
}

/**
 * Événements d'une session : l'historique est chargé page par page, puis seuls les nouveaux événements
 * sont demandés (curseur `after`). Le serveur ne renvoie qu'une page à la fois : sans curseur, le
 * transcript d'une longue session resterait figé sur ses premiers événements. `draft` : ce que l'agent est en
 * train d'écrire (texte reçu en streaming par le serveur, pas encore journalisé), relevé plus souvent tant qu'il existe.
 *
 * Les pages du workbench cachées (`<Activity mode="hidden">`) perdent leurs effets mais gardent leur état :
 * au retour sur l'onglet, le relevé repart du curseur mémorisé et le transcript reste affiché, au lieu de se
 * vider et de recharger tout l'historique (plusieurs Mo sur une longue session).
 *
 * `refresh` déclenche un relevé sans attendre le prochain : après l'envoi d'une instruction, l'événement
 * qui la journalise est affiché dès que le serveur l'a écrit plutôt qu'au relevé suivant.
 */
export function useSessionEvents(sessionId: string): { events: SessionEvent[]; loaded: boolean; draft: SessionLiveDraft | null; refresh: () => void } {
  const client = useApolloClient();
  const [state, setState] = useState<SessionEventsState>({ sessionId, events: [], loaded: false, draft: null });
  const cursor = useRef<{ sessionId: string; after: string | null }>({ sessionId, after: null });
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false;
    if (cursor.current.sessionId !== sessionId) {
      cursor.current = { sessionId, after: null };
      setState({ sessionId, events: [], loaded: false, draft: null });
    }

    const tick = async () => {
      // Un relevé à la fois : une demande arrivée pendant un relevé en relance un dès qu'il est terminé.
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      let full = false;
      let live = false;
      try {
        const { data } = await client.query<{ session: { events: SessionEvent[]; liveDraft: SessionLiveDraft | null } | null }>({
          query: SESSION_EVENTS,
          variables: { id: sessionId, after: cursor.current.after, limit: PAGE_SIZE },
          fetchPolicy: 'no-cache',
        });
        if (cancelled) return;
        const page = data.session?.events ?? [];
        full = page.length >= PAGE_SIZE;
        if (page.length) cursor.current.after = page[page.length - 1].id;
        const draft = data.session?.liveDraft ?? null;
        live = draft !== null;
        setState((prev) => nextEventsState(prev, page, draft, full));
      } catch {
        // Erreur passagère (réseau, redémarrage du serveur) : nouvel essai au prochain relevé.
        if (cancelled) return;
      }
      inFlight = false;
      if (cancelled) return;
      // Page pleine : il reste de l'historique, on enchaîne sans attendre.
      clearTimeout(timer);
      timer = setTimeout(tick, full || again ? 0 : live ? LIVE_POLL_MS : POLL_MS);
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
  return state.sessionId === sessionId ? { events: state.events, loaded: state.loaded, draft: state.draft, refresh } : { events: [], loaded: false, draft: null, refresh };
}
