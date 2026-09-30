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
    window.location.reload();
  }
});

export const apolloClient = new ApolloClient({
  // Le cookie de session est envoyé avec chaque requête (l'API autorise l'origine du front en CORS).
  link: from([sessionLink, new HttpLink({ uri: graphqlUrl, credentials: 'include' })]),
  cache: new InMemoryCache(),
});

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

/** Écran de consentement Google pour relier un compte (Gmail, Drive) à un projet ; le retour ramène sur la page du projet. */
export function googleConnectUrl(projectId: string, gmail: string, drive: string): string {
  return `${apiBaseUrl}/auth/google/connect?${new URLSearchParams({ projectId, gmail, drive })}`;
}

/** Ferme la session côté serveur (le cookie est effacé par la réponse). */
export async function logoutRequest(): Promise<void> {
  await fetch(`${apiBaseUrl}/auth/logout`, { method: 'POST', credentials: 'include' });
}
