import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSchema, createYoga } from 'graphql-yoga';
import { createAuthContext } from './auth/access.js';
import { googleAuth } from './auth/google.js';
import { handleAuthRoute } from './auth/routes.js';
import { handleAttachmentRoute } from './sessions/attachmentRoute.js';
import { handleTaskAttachmentRoute } from './tasks/attachmentRoute.js';
import { handleSharedPageRoute } from './sharedPages/viewRoute.js';
import { handleFileViewRoute } from './files/viewRoute.js';
import { handleTasksApiRoute } from './tasks/api.js';
import { handleGitHttpRoute } from './gitServer/httpRoute.js';
import { gitServer } from './gitServer/service.js';
import { gitTokenService } from './gitServer/tokens.js';
import { registerTaskSessionFeed } from './tasks/sessionFeed.js';
import { vaultService } from './vault/service.js';
import { authSession, readCookie, SESSION_COOKIE } from './auth/session.js';
import { config } from './config.js';
import { captureProcessWarnings, log } from './log.js';
import { appErrorLogPlugin, maskGraphQLError, operationTimingPlugin, yogaLogger } from './graphql/logging.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { resolvers } from './graphql/resolvers.js';
import { projectService } from './projects/service.js';
import { runner } from './runners/index.js';
import { scheduleService } from './schedules/service.js';
import { sessionService } from './sessions/service.js';
import { containerMonitor } from './runners/monitor.js';
import { trackedPullRequestService } from './pullRequests/service.js';
import { healthService } from './health/service.js';
import { loginService } from './settings/login.js';
import { migrateLegacyCredentials } from './settings/legacy.js';
import { registerWorkflowTriggers } from './workflows/triggers.js';
import { automationScheduler } from './workflows/scheduler.js';
import { rateLimitService } from './settings/rateLimits.js';
import { serverSettings } from './settings/server.js';
import { terminalService } from './terminals/service.js';
import { terminalUpgradeHandler } from './terminals/ws.js';
import { browserUpgradeHandler } from './browser/ws.js';
import { attachWebSockets } from './websockets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(here, 'graphql/schema.graphql'), 'utf8');

async function main() {
  captureProcessWarnings();
  const applied = await runMigrations();
  if (applied.length) log.info(`[db] migrations appliquées : ${applied.join(', ')}`);

  await rateLimitService.load();
  await serverSettings.load();

  const recovered = await sessionService.recoverAfterRestart();
  if (recovered.sessions) log.info(`[sessions] ${recovered.sessions} session(s) marquée(s) comme interrompue(s)`);
  if (recovered.requests) log.info(`[requests] ${recovered.requests} demande(s) expirée(s)`);
  const vault = await vaultService.startup();
  if (vault.converted || vault.rewrapped || vault.failed) log.info(`[vault] secrets convertis : ${vault.converted}, clés ré-enveloppées : ${vault.rewrapped}, échecs : ${vault.failed}`);
  if (vault.pruned) log.info(`[vault] ${vault.pruned} entrée(s) de journal élaguée(s)`);
  const legacy = await migrateLegacyCredentials();
  if (legacy.length) log.info(`[settings] identifiants historiques transférés : ${legacy.join(', ')}`);
  registerTaskSessionFeed();
  registerWorkflowTriggers();
  const closedTerminals = await terminalService.recoverAfterRestart();
  if (closedTerminals) log.info(`[terminals] ${closedTerminals} terminal(aux) fermé(s)`);
  // Conteneurs créés avec d'anciens paramètres (ou une image depuis reconstruite) : supprimés maintenant que rien n'y
  // tourne, recréés à la première session. Plus tard, `ensureReady` recrée un conteneur obsolète si le projet est inactif :
  // aucun processus de session (la session qui démarre occupe sa place mais n'a encore rien lancé), aucun terminal ouvert.
  runner.setIdleCheck(async (project) => sessionService.runningCountByProject(project.id) === 0 && sessionService.slotsOfProject(project.id) <= 1 && terminalService.liveCountByProject(project.id) === 0);
  const recreated = await runner.recreateOutdated(await projectService.list());
  if (recreated.length) log.info(`[runner] conteneur(s) obsolète(s) supprimé(s), recréé(s) à la demande : ${recreated.join(", ")}`);
  const missedRuns = await scheduleService.start();
  if (missedRuns) log.info(`[schedules] ${missedRuns} échéance(s) manquée(s) pendant l'arrêt, non rattrapée(s)`);
  automationScheduler.start();
  const purged = await authSession.purgeExpired();
  if (purged) log.info(`[auth] ${purged} session(s) de connexion expirée(s) supprimée(s)`);
  const purgedTokens = await gitTokenService.purgeExpired();
  if (purgedTokens) log.info(`[git-server] ${purgedTokens} jeton(s) d'accès git expiré(s) supprimé(s)`);
  log.info(googleAuth.configured ? `[auth] connexion Google active (callback ${googleAuth.redirectUri})` : '[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET absents : la connexion est impossible');

  // Origines autorisées à appeler l'API avec le cookie de session : l'application, et le poste de développement.
  const appOrigin = new URL(config.appUrl).origin;
  const isAllowedOrigin = (origin: string | null) => Boolean(origin) && (origin === appOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin!));

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    logging: yogaLogger,
    plugins: [appErrorLogPlugin(), operationTimingPlugin()],
    cors: (request) => {
      const origin = request.headers.get('origin');
      return isAllowedOrigin(origin) ? { origin: origin!, credentials: true } : { origin: appOrigin, credentials: true };
    },
    // Utilisateur connecté, lu dans le cookie de session ; les résolveurs vérifient ses droits.
    context: async ({ request }) => createAuthContext(await authSession.resolve(readCookie(request.headers.get('cookie'), SESSION_COOKIE))),
    // Les erreurs métier (AppError) sont renvoyées au client avec leur message et leur code, les autres masquées.
    maskedErrors: { maskError: maskGraphQLError },
  });

  const server = createServer((req, res) => {
    handleAuthRoute(req, res)
      .then((handled) => handled || handleAttachmentRoute(req, res))
      .then((handled) => handled || handleTaskAttachmentRoute(req, res))
      .then((handled) => handled || handleSharedPageRoute(req, res))
      .then((handled) => handled || handleFileViewRoute(req, res))
      .then((handled) => handled || handleTasksApiRoute(req, res))
      .then((handled) => handled || handleGitHttpRoute(req, res))
      .then((handled) => {
        if (!handled) return yoga(req, res);
      })
      .catch((err) => {
        log.error('[http]', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  attachWebSockets(server, [terminalUpgradeHandler(), browserUpgradeHandler()]);
  server.listen(config.port, () => {
    log.info(`[http] GraphQL prêt sur http://localhost:${config.port}/graphql`);
    // Sessions restées en file d'attente avant l'arrêt d'abord (elles attendaient), puis reprise automatique
    // des sessions coupées en plein tour par l'arrêt précédent (réglage du serveur), elles-mêmes soumises à la limite.
    sessionService.startHousekeeping();
    healthService.startMonitor();
    containerMonitor.start();
    trackedPullRequestService.startBackgroundSync();
    gitServer.startBackgroundBackups();
    sessionService
      .drainQueue()
      .then(() => sessionService.resumeInterruptedAfterRestart())
      .then((ids) => ids.length && log.info(`[sessions] ${ids.length} session(s) interrompue(s) relancée(s)`))
      .catch((err) => log.error('[sessions] reprise automatique', err));
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // Avant tout await : pm2 envoie le signal à tout l'arbre de processus, les agents meurent en même
    // temps que nous et leur fin doit être vue comme une interruption, pas comme une erreur.
    sessionService.beginShutdown();
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[http] ${signal} reçu, arrêt en cours...`);
    // On cesse d'accepter des requêtes avant d'arrêter les sessions et de fermer le pool.
    server.close();
    scheduleService.stop();
    automationScheduler.stop();
    healthService.stopMonitor();
    containerMonitor.stop();
    trackedPullRequestService.stopBackgroundSync();
    gitServer.stopBackgroundBackups();
    loginService.shutdown();
    const [interrupted] = await Promise.all([sessionService.shutdown(), terminalService.shutdown()]);
    if (interrupted) log.info(`[sessions] ${interrupted} session(s) marquée(s) comme interrompue(s)`);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('[fatal]', err);
  process.exit(1);
});
