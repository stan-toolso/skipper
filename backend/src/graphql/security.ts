import { visit, type DocumentNode } from 'graphql';
import { createGraphQLError, type Plugin } from 'graphql-yoga';
import type { AuthContext } from '../auth/access.js';

/**
 * Prévention CSRF (même règle qu'Apollo Server) : une requête POST « simple » (sans en-tête Content-Type, ou en
 * text/plain, multipart/form-data, application/x-www-form-urlencoded) part d'un formulaire ou d'un `fetch` d'un autre
 * site sans requête préalable CORS, cookie compris. Elle est refusée, sauf si elle porte un en-tête que seul un script
 * autorisé en CORS peut poser. Le client Apollo envoie du JSON (`application/json`, jamais simple) : rien à ajouter.
 * Les GET restent permis (yoga n'y exécute jamais de mutation ; les sondes de déploiement en font).
 */
const SIMPLE_CONTENT_TYPES = new Set(['', 'text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded']);
export const CSRF_HEADERS = ['x-graphql-yoga-csrf', 'apollo-require-preflight'];

export function isCsrfSuspect(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return false;
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!SIMPLE_CONTENT_TYPES.has(contentType)) return false;
  return !CSRF_HEADERS.some((name) => request.headers.has(name));
}

export function csrfPreventionPlugin(): Plugin {
  return {
    onRequestParse({ request }) {
      if (isCsrfSuspect(request)) {
        throw createGraphQLError(`Requête refusée (prévention CSRF) : envoyez du JSON (Content-Type: application/json) ou l'en-tête ${CSRF_HEADERS[0]}.`, {
          extensions: { http: { status: 403 }, code: 'CSRF' },
        });
      }
    },
  };
}

/** Le document demande-t-il le schéma (`__schema`, `__type`) ? `__typename` reste permis. */
export function usesIntrospection(document: DocumentNode): boolean {
  let found = false;
  visit(document, {
    Field(node) {
      if (node.name.value === '__schema' || node.name.value === '__type') found = true;
    },
  });
  return found;
}

/**
 * Introspection réservée aux utilisateurs connectés : le schéma décrit toute l'API (coffre, partages, jetons...),
 * inutile de le livrer à un visiteur anonyme. Vérifiée à l'exécution, quand le contexte (utilisateur) est construit.
 */
export function introspectionGuardPlugin(): Plugin<AuthContext> {
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const context = args.contextValue as Partial<AuthContext>;
      if (!context.user && usesIntrospection(args.document)) {
        setResultAndStopExecution({ errors: [createGraphQLError("L'introspection du schéma est réservée aux utilisateurs connectés.", { extensions: { code: 'FORBIDDEN' } })] });
      }
    },
  };
}
