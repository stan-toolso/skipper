import { ApolloClient, from, HttpLink, InMemoryCache } from '@apollo/client';
import { onError } from '@apollo/client/link/error';

// Par défaut, l'API est cherchée sur l'hôte qui sert le front (port 4000) : fonctionne en localhost
// comme depuis un autre appareil du réseau. VITE_GRAPHQL_URL permet d'imposer une URL.
export const graphqlUrl: string = import.meta.env.VITE_GRAPHQL_URL || `${window.location.protocol}//${window.location.hostname}:4000/graphql`;

/** Racine de l'API (routes d'authentification, WebSockets). */
export const apiBaseUrl: string = graphqlUrl.replace(/\/graphql$/, '');

// Session expirée ou fermée : on recharge la page, qui affichera l'écran de connexion (la requête `me`
// ne renvoie jamais cette erreur, donc pas de boucle).
let reloading = false;
const sessionLink = onError(({ graphQLErrors }) => {
  if (!reloading && graphQLErrors?.some((e) => e.extensions?.code === 'UNAUTHENTICATED')) {
    reloading = true;
    forgetCachedUser();
    window.location.reload();
  }
});

export const apolloClient = new ApolloClient({
  // Le cookie de session est envoyé avec chaque requête (l'API autorise l'origine du front en CORS).
  link: from([sessionLink, new HttpLink({ uri: graphqlUrl, credentials: 'include' })]),
  cache: new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          // Une work session déjà chargé par la sidebar se lit directement dans le cache, sans aller-retour.
          worksession: { read: (existing, { args, toReference }) => existing ?? toReference({ __typename: 'Worksession', id: args?.id }) },
        },
      },
    },
  }),
});

/**
 * Dernier utilisateur connecté, gardé dans le navigateur : l'interface s'affiche aussitôt, sans attendre
 * la réponse de `me` (qui confirme ou corrige ensuite). Oublié à la déconnexion et à l'expiration.
 */
const CACHED_USER_KEY = 'skipper.me';

export function readCachedUser<T>(): T | null {
  try {
    return JSON.parse(localStorage.getItem(CACHED_USER_KEY) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

export function writeCachedUser(user: unknown): void {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    /* stockage indisponible : l'écran de chargement s'affiche simplement à chaque ouverture */
  }
}

export function forgetCachedUser(): void {
  writeCachedUser(null);
}

/** URL WebSocket d'un terminal, dérivée de l'URL de l'API. */
export function terminalSocketUrl(id: string): string {
  return `${apiBaseUrl.replace(/^http/, 'ws')}/terminals/${id}`;
}

/** Vue en direct du navigateur headless d'une session (WebSocket, lecture seule). */
export function browserSocketUrl(sessionId: string): string {
  return `${apiBaseUrl.replace(/^http/, 'ws')}/browsers/${sessionId}`;
}

/** Page de connexion Google ; `next` = chemin de l'application à rouvrir ensuite. */
export function googleLoginUrl(next: string): string {
  return `${apiBaseUrl}/auth/google?next=${encodeURIComponent(next)}`;
}

/** Écran de consentement Google pour relier un compte (Gmail, Drive) au coffre d'un projet ou au coffre personnel ; le retour ramène sur la page du coffre. */
export function googleConnectUrl(projectId: string | null, gmail: string, drive: string, itemId?: string | null): string {
  return `${apiBaseUrl}/auth/google/connect?${new URLSearchParams({ ...(projectId ? { projectId } : { personal: '1' }), gmail, drive, ...(itemId ? { itemId } : {}) })}`;
}

/** Fichier brut d'un workspace (aperçu HTML dans un bac à sable, téléchargement). */
export function fileViewUrl(projectId: string, worksessionId: string | null | undefined, path: string, download = false): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${apiBaseUrl}/api/files/view/${projectId}/${worksessionId ?? '-'}/${encoded}${download ? '?download=1' : ''}`;
}

/** Contenu d'une page partagée (bac à sable), éventuellement une version donnée ou en téléchargement. */
export function sharedPageUrl(id: string, version?: number | null, download = false): string {
  const params = new URLSearchParams({ ...(version ? { v: String(version) } : {}), ...(download ? { download: '1' } : {}) });
  const q = params.toString();
  return `${apiBaseUrl}/api/shared/${id}${q ? `?${q}` : ''}`;
}

/** Ferme la session côté serveur (le cookie est effacé par la réponse). */
export async function logoutRequest(): Promise<void> {
  forgetCachedUser();
  await fetch(`${apiBaseUrl}/auth/logout`, { method: 'POST', credentials: 'include' });
}
