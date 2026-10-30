import type { DocumentNode, ExecutionResult } from 'graphql';
import { createGraphQLError, isAsyncIterable, maskError, type Plugin, type YogaLogger } from 'graphql-yoga';
import type { AuthContext } from '../auth/access.js';
import { AppError } from '../errors.js';
import { createLogger } from '../log.js';

/**
 * Journal des requêtes GraphQL.
 *
 * Une erreur métier (`AppError`, `NotFoundError`) est renvoyée au client avec son message et son code ; côté
 * serveur elle tient sur une ligne `warn` (opération, chemin, utilisateur, message), sans trace ni `extensions`.
 * Les autres erreurs sont masquées pour le client (« Unexpected error. ») et journalisées en `error` avec leur trace.
 */

const log = createLogger('graphql');

/** Erreurs métier déjà journalisées par le plugin : le logger de yoga ne les répète pas. */
const reported = new WeakSet<object>();

/**
 * Erreur de résolveur telle que graphql l'enveloppe. Reconnue par sa forme et non par `instanceof GraphQLError` :
 * le paquet `graphql` existe en double (CommonJS et ESM) et yoga peut tenir l'autre copie, comme sous Vitest.
 */
interface GraphQLErrorLike extends Error {
  originalError?: Error | null;
  path?: ReadonlyArray<string | number> | null;
}

const asGraphQLError = (error: unknown): GraphQLErrorLike | null => (error instanceof Error && error.name === 'GraphQLError' ? (error as GraphQLErrorLike) : null);

export const appErrorOf = (error: unknown): AppError | null => {
  if (error instanceof AppError) return error;
  const original = asGraphQLError(error)?.originalError;
  return original instanceof AppError ? original : null;
};

const pathOf = (error: unknown): string | null => {
  const path = asGraphQLError(error)?.path;
  return path?.length ? path.join('.') : null;
};

/** `maskedErrors.maskError` de yoga : les erreurs métier passent telles quelles (message, code), les autres sont masquées. */
export function maskGraphQLError(error: unknown, message: string, isDev?: boolean): Error {
  const app = appErrorOf(error);
  if (app) return createGraphQLError(app.message, { path: asGraphQLError(error)?.path ?? undefined, extensions: { code: app.code } });
  return maskError(error, message, isDev);
}

/** Logger passé à `createYoga({ logging })` : route sur le journal, une erreur métier n'y est pas répétée. */
export const yogaLogger: YogaLogger = {
  debug: (...args: unknown[]) => log.debug(...args),
  info: (...args: unknown[]) => log.info(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => {
    const [first, ...rest] = args;
    const app = appErrorOf(first);
    const where = pathOf(first);
    if (app) {
      // Normalement déjà journalisée par le plugin (opération et utilisateur connus) ; sinon, une ligne quand même.
      if (!(typeof first === 'object' && first !== null && reported.has(first))) log.warn(`${where ? `${where} : ` : ''}${app.message}`);
      return;
    }
    // Erreur inattendue : la trace de l'erreur d'origine (celle du résolveur), précédée du chemin GraphQL.
    const wrapped = asGraphQLError(first);
    const original = wrapped?.originalError ?? first;
    log.error(...(where ? [`${where} :`] : []), original, ...rest);
  },
};

function operationNameOf(document: DocumentNode, explicit: string | null | undefined): string {
  if (explicit) return explicit;
  for (const def of document.definitions) if (def.kind === 'OperationDefinition' && def.name) return def.name.value;
  return '(anonyme)';
}

/** Journalise les erreurs métier d'un résultat d'exécution : une ligne `warn` par erreur. */
export function reportAppErrors(result: ExecutionResult, operation: string, user: string | null): void {
  for (const error of result.errors ?? []) {
    const app = appErrorOf(error);
    if (!app) continue;
    reported.add(error);
    log.warn(`${operation} · ${pathOf(error) ?? operation} · ${user ?? 'anonyme'} : ${app.message}`);
  }
}

/** Au-delà de cette durée, une opération est signalée en `warn` ; en dessous, elle n'apparaît qu'en `debug`. */
export const SLOW_OPERATION_MS = 500;

/**
 * Plugin yoga : durée de chaque opération (requête ou mutation ; les subscriptions, flux ouverts, sont ignorées).
 * Une opération lente tient sur une ligne `warn` avec son nom et l'utilisateur, pour repérer ce qui ralentit
 * l'interface (sidebar, fil d'une session…) sans outillage externe ; toutes sont en `debug` (LOG_LEVEL=debug).
 */
export function operationTimingPlugin(slowMs = SLOW_OPERATION_MS, now: () => number = () => performance.now()): Plugin {
  return {
    onExecute({ args }) {
      const started = now();
      const operation = operationNameOf(args.document, args.operationName);
      const user = (args.contextValue as Partial<AuthContext>).user?.email ?? null;
      return {
        onExecuteDone({ result }) {
          if (isAsyncIterable(result)) return;
          const ms = Math.round(now() - started);
          if (ms >= slowMs) log.warn(`${operation} · ${user ?? 'anonyme'} : ${ms} ms`);
          else log.debug(`${operation} : ${ms} ms`);
        },
      };
    },
  };
}

/** Plugin yoga : après chaque exécution, journalise les erreurs métier avec l'opération et l'utilisateur. */
export function appErrorLogPlugin(): Plugin {
  return {
    onExecute({ args }) {
      const operation = operationNameOf(args.document, args.operationName);
      const user = (args.contextValue as Partial<AuthContext>).user?.email ?? null;
      return {
        onExecuteDone({ result }) {
          if (isAsyncIterable(result)) return;
          reportAppErrors(result as ExecutionResult, operation, user);
        },
      };
    },
  };
}
