import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSchema, createYoga, maskError } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import { sweepStaleSessionDirs } from './connections/runtime.js';
import { createAuthContext } from './auth/access.js';
import { googleAuth } from './auth/google.js';
import { handleAuthRoute } from './auth/routes.js';
import { handleAttachmentRoute } from './sessions/attachmentRoute.js';
import { authSession, readCookie, SESSION_COOKIE } from './auth/session.js';
import { AppError } from './errors.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { resolvers } from './graphql/resolvers.js';
import { sessionService } from './sessions/service.js';
import { loginService } from './settings/login.js';
import { settingsService } from './settings/service.js';
import { terminalService } from './terminals/service.js';
import { attachTerminalWebSockets } from './terminals/ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(here, 'graphql/schema.graphql'), 'utf8');

async function main() {
  const applied = await runMigrations();
  if (applied.length) console.log(`[db] migrations appliquées : ${applied.join(', ')}`);

  await settingsService.load();
  console.log(`[settings] authentification Claude : ${settingsService.claude.authMode}`);

  const recovered = await sessionService.recoverAfterRestart();
  if (recovered.sessions) console.log(`[sessions] ${recovered.sessions} session(s) marquée(s) comme interrompue(s)`);
  if (recovered.requests) console.log(`[requests] ${recovered.requests} demande(s) expirée(s)`);
  const staleDirs = await sweepStaleSessionDirs();
  if (staleDirs) console.log(`[connections] ${staleDirs} dossier(s) de session orphelin(s) nettoyé(s)`);
  const closedTerminals = await terminalService.recoverAfterRestart();
  if (closedTerminals) console.log(`[terminals] ${closedTerminals} terminal(aux) fermé(s)`);
  const purged = await authSession.purgeExpired();
  if (purged) console.log(`[auth] ${purged} session(s) de connexion expirée(s) supprimée(s)`);
  console.log(googleAuth.configured ? `[auth] connexion Google active (callback ${googleAuth.redirectUri})` : '[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET absents : la connexion est impossible');

  // Origines autorisées à appeler l'API avec le cookie de session : l'application, et le poste de développement.
  const appOrigin = new URL(config.appUrl).origin;
  const isAllowedOrigin = (origin: string | null) => Boolean(origin) && (origin === appOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin!));

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    cors: (request) => {
      const origin = request.headers.get('origin');
      return isAllowedOrigin(origin) ? { origin: origin!, credentials: true } : { origin: appOrigin, credentials: true };
    },
    // Utilisateur connecté, lu dans le cookie de session ; les résolveurs vérifient ses droits.
    context: async ({ request }) => createAuthContext(await authSession.resolve(readCookie(request.headers.get('cookie'), SESSION_COOKIE))),
    maskedErrors: {
      // Les erreurs métier (AppError) sont renvoyées au client avec leur message et leur code.
      maskError: (error, message, isDev) => {
        const original = error instanceof GraphQLError ? error.originalError : error;
        if (original instanceof AppError) {
          return new GraphQLError(original.message, { extensions: { code: original.code } });
        }
        return maskError(error, message, isDev);
      },
    },
  });

  const server = createServer((req, res) => {
    handleAuthRoute(req, res)
      .then((handled) => handled || handleAttachmentRoute(req, res))
      .then((handled) => {
        if (!handled) return yoga(req, res);
      })
      .catch((err) => {
        console.error('[http]', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  attachTerminalWebSockets(server);
  server.listen(config.port, () => {
    console.log(`[http] GraphQL prêt sur http://localhost:${config.port}/graphql`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[http] ${signal} reçu, arrêt en cours...`);
    // On cesse d'accepter des requêtes avant d'arrêter les sessions et de fermer le pool.
    server.close();
    loginService.shutdown();
    await terminalService.shutdown();
    await sessionService.shutdown();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
