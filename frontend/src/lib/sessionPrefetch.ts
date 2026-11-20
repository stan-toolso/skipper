import type { ApolloClient } from '@apollo/client';
import { SESSION, SESSION_EVENTS, type SessionEvent, type SessionLiveDraft } from '../graphql/operations';

/** Taille de la première page d'événements préchargée : celle que demande useSessionEvents. */
export const EVENTS_PAGE_SIZE = 500;
/** Au-delà, une session préchargée l'est à nouveau (survol répété) ; un fil préchargé n'est plus utilisé. */
const FRESH_MS = 10_000;
/** Intention de survol : le pointeur doit rester sur le lien ce temps-là (on ne précharge pas tout ce que l'on traverse). */
const HOVER_INTENT_MS = 80;

type EventsPage = { session: { events: SessionEvent[]; liveDraft: SessionLiveDraft | null } | null };

const started = new Map<string, number>();
const events = new Map<string, { at: number; promise: Promise<EventsPage> }>();

/**
 * Précharge une session avant son ouverture (survol ou appui sur un lien) : ses données vont dans le cache Apollo,
 * que la page lit tout de suite, et la première page de son fil est gardée pour le premier relevé de
 * useSessionEvents. La page s'ouvre alors déjà remplie au lieu de passer par un écran de chargement.
 */
export function prefetchSession(client: ApolloClient<object>, id: string): void {
  const now = Date.now();
  const last = started.get(id);
  if (last !== undefined && now - last < FRESH_MS) return;
  started.set(id, now);
  void client.query({ query: SESSION, variables: { id }, fetchPolicy: 'network-only' }).catch(() => undefined);
  const promise = client
    .query<EventsPage>({ query: SESSION_EVENTS, variables: { id, after: null, limit: EVENTS_PAGE_SIZE, toolUseId: null }, fetchPolicy: 'no-cache' })
    .then((r) => r.data);
  promise.catch(() => events.delete(id));
  events.set(id, { at: now, promise });
}

/** Première page du fil préchargée (récente), consommée une seule fois ; null sinon. */
export function takePrefetchedEvents(id: string): Promise<EventsPage> | null {
  const hit = events.get(id);
  events.delete(id);
  return hit && Date.now() - hit.at < FRESH_MS ? hit.promise : null;
}

/** Identifiant de la session visée par un lien de l'application (/sessions/<id> ou /chats/<id>), ou null. */
export function sessionIdOfHref(href: string | null): string | null {
  const m = href?.match(/^\/(?:sessions|chats)\/([^/?#]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Gestionnaires à poser sur un conteneur (délégation) : précharge la session d'un lien survolé un instant, et
 * tout de suite à l'appui (souris, doigt) ou au focus clavier, avant même le clic.
 */
export function sessionPrefetchHandlers(client: ApolloClient<object>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idOf = (target: EventTarget | null) => sessionIdOfHref((target instanceof Element ? target.closest('a[href]') : null)?.getAttribute('href') ?? null);
  return {
    onPointerOver: (e: { target: EventTarget | null }) => {
      clearTimeout(timer);
      const id = idOf(e.target);
      if (id) timer = setTimeout(() => prefetchSession(client, id), HOVER_INTENT_MS);
    },
    onPointerOut: () => clearTimeout(timer),
    onPointerDown: (e: { target: EventTarget | null }) => {
      const id = idOf(e.target);
      if (id) prefetchSession(client, id);
    },
    onFocus: (e: { target: EventTarget | null }) => {
      const id = idOf(e.target);
      if (id) prefetchSession(client, id);
    },
  };
}
