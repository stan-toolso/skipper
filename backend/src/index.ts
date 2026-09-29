import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSchema, createYoga, maskError } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import { AppError } from './errors.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { resolvers } from './graphql/resolvers.js';
import { sessionService } from './sessions/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(here, 'graphql/schema.graphql'), 'utf8');

async function main() {
  const applied = await runMigrations();
  if (applied.length) console.log(`[db] migrations appliquées : ${applied.join(', ')}`);

  const recovered = await sessionService.recoverAfterRestart();
  if (recovered.sessions) console.log(`[sessions] ${recovered.sessions} session(s) marquée(s) comme interrompue(s)`);
  if (recovered.requests) console.log(`[requests] ${recovered.requests} demande(s) expirée(s)`);

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    cors: { origin: '*', credentials: false },
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

  const server = createServer(yoga);
  server.listen(config.port, () => {
    console.log(`[http] GraphQL prêt sur http://localhost:${config.port}/graphql`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[http] ${signal} reçu, arrêt en cours...`);
    // On cesse d'accepter des requêtes avant d'arrêter les sessions et de fermer le pool.
    server.close();
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
