import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client';

// Par défaut, l'API est cherchée sur l'hôte qui sert le front (port 4000) : fonctionne en localhost
// comme depuis un autre appareil du réseau. VITE_GRAPHQL_URL permet d'imposer une URL.
const graphqlUrl = import.meta.env.VITE_GRAPHQL_URL || `${window.location.protocol}//${window.location.hostname}:4000/graphql`;

export const apolloClient = new ApolloClient({
  link: new HttpLink({ uri: graphqlUrl }),
  cache: new InMemoryCache(),
});
