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
import { csrfPreventionPlugin, introspectionGuardPlugin } from './graphql/security.js';
import { isAllowedOrigin } from './origin.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { resolvers } from './graphql/resolvers.js';
import { projectService } from './projects/service.js';
import { runner } from './runners/index.js';
import { scheduleService } from './schedules/service.js';
import { sessionService } from './sessions/service.js';
import { containerMonitor } from './runners/monitor.js';
import { trackedPullRequestService } from './pullRequests/service.js';
import { reviewService } from './reviews/service.js';
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
import { instanceRegistry } from './instances/registry.js';
import { instanceBus } from './instances/bus.js';
import { leadership, type LeaderJob } from './instances/leadership.js';
import { handleInternalRoute } from './instances/internalRoute.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(here, 'graphql/schema.graphql'), 'utf8');

/**
 * Passage de l'instance qui tient les tâches périodiques : sessions et terminaux d'une instance morte (arrêt brutal)
 * interrompus puis relancés, sessions garées inactives terminées, lignes d'instances anciennes purgées.
 */
const orphanSweep = (() => {
  let timer: NodeJS.Timeout | null = null;
  const sweep = async () => {
    const live = await instanceRegistry.liveIds();
    const { sessions, requests } = await sessionService.recoverAfterRestart(live);
    const terminals = await terminalService.recoverAfterRestart(live);
    if (sessions || requests || terminals) log.warn(`[instances] instance disparue : ${sessions} session(s) interrompue(s), ${requests} demande(s) expirée(s), ${terminals} terminal(aux) fermé(s)`);
    if (sessions) {
      const resumed = await sessionService.resumeInterruptedAfterRestart();
      if (resumed.length) log.info(`[sessions] ${resumed.length} session(s) interrompue(s) relancée(s)`);
    }
    const ended = await sessionService.endParkedIdle();
    if (ended.length) log.info(`[sessions] ${ended.length} session(s) garée(s) inactive(s) terminée(s)`);
    await instanceRegistry.prune();
  };
  return {
    start() {
      timer ??= setInterval(() => void sweep().catch((err) => log.error('[instances] reprise des sessions orphelines', err)), 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
})();

async function main() {
  captureProcessWarnings();
  const applied = await runMigrations();
  if (applied.length) log.info(`[db] migrations appliquées : ${applied.join(', ')}`);

  await rateLimitService.load();
  await serverSettings.load();

  // Registre des instances (déploiement bleu/vert) : ce que tient une autre instance vivante n'est pas repris.
  await instanceRegistry.register(config.port);
  await instanceBus.start();
  // Une instance qui s'arrête a pu interrompre des sessions au travail (délai de drainage dépassé) : l'instance qui
  // tient les tâches périodiques les relance.
  instanceBus.onPeerExit((id, interrupted) => {
    log.info(`[instances] instance ${id} arrêtée${interrupted ? ` (${interrupted} session(s) interrompue(s))` : ''}`);
    if (interrupted && leadership.isLeader) {
      void sessionService
        .resumeInterruptedAfterRestart()
        .then((ids) => ids.length && log.info(`[sessions] ${ids.length} session(s) interrompue(s) relancée(s)`))
        .catch((err) => log.error('[sessions] reprise automatique', err));
    }
  });
  const liveInstances = await instanceRegistry.liveIds();
  log.info(`[instances] instance ${instanceRegistry.id}${config.instanceLabel ? ` (${config.instanceLabel})` : ''} inscrite${liveInstances.length > 1 ? ` ; ${liveInstances.length - 1} autre(s) instance(s) vivante(s), leurs sessions et terminaux restent en place` : ''}`);
  const recovered = await sessionService.recoverAfterRestart(liveInstances);
  if (recovered.sessions) log.info(`[sessions] ${recovered.sessions} session(s) marquée(s) comme interrompue(s)`);
  if (recovered.requests) log.info(`[requests] ${recovered.requests} demande(s) expirée(s)`);
  const vault = await vaultService.startup();
  if (vault.converted || vault.rewrapped || vault.failed) log.info(`[vault] secrets convertis : ${vault.converted}, clés ré-enveloppées : ${vault.rewrapped}, échecs : ${vault.failed}`);
  if (vault.pruned) log.info(`[vault] ${vault.pruned} entrée(s) de journal élaguée(s)`);
  const legacy = await migrateLegacyCredentials();
  if (legacy.length) log.info(`[settings] identifiants historiques transférés : ${legacy.join(', ')}`);
  registerTaskSessionFeed();
  registerWorkflowTriggers();
  const closedTerminals = await terminalService.recoverAfterRestart(liveInstances);
  if (closedTerminals) log.info(`[terminals] ${closedTerminals} terminal(aux) fermé(s)`);
  // Conteneurs créés avec d'anciens paramètres (ou une image depuis reconstruite) : supprimés maintenant que rien n'y
  // tourne, recréés à la première session. Plus tard, `ensureReady` recrée un conteneur obsolète si le projet est inactif :
  // aucun processus de session (la session qui démarre occupe sa place mais n'a encore rien lancé), aucun terminal ouvert.
  // Les sessions et terminaux d'une autre instance (déploiement bleu/vert) occupent aussi le conteneur.
  runner.setIdleCheck(
    async (project) =>
      sessionService.runningCountByProject(project.id) === 0 &&
      sessionService.slotsOfProject(project.id) <= 1 &&
      terminalService.liveCountByProject(project.id) === 0 &&
      (await instanceRegistry.remoteActivity(project.id)) === 0,
  );
  const unused = [];
  for (const project of await projectService.list()) if ((await instanceRegistry.remoteActivity(project.id)) === 0) unused.push(project);
  const recreated = await runner.recreateOutdated(unused);
  if (recreated.length) log.info(`[runner] conteneur(s) obsolète(s) supprimé(s), recréé(s) à la demande : ${recreated.join(", ")}`);
  const purged = await authSession.purgeExpired();
  if (purged) log.info(`[auth] ${purged} session(s) de connexion expirée(s) supprimée(s)`);
  const purgedTokens = await gitTokenService.purgeExpired();
  if (purgedTokens) log.info(`[git-server] ${purgedTokens} jeton(s) d'accès git expiré(s) supprimé(s)`);
  log.info(googleAuth.configured ? `[auth] connexion Google active (callback ${googleAuth.redirectUri})` : '[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET absents : la connexion est impossible');

  // Guetteur des sessions de relecture (publication de leur rapport), tâche de l'instance meneuse.
  let stopReviewWatcher: (() => void) | null = null;
  /**
   * Tâches périodiques uniques : seule l'instance qui tient le verrou consultatif (instances/leadership.ts) les fait
   * tourner ; en déploiement bleu/vert, l'ancienne instance le cède en drainage et la nouvelle le reprend.
   */
  const leaderJobs: LeaderJob[] = [
    {
      name: 'planificateur des sessions',
      start: async () => {
        const missed = await scheduleService.start();
        if (missed) log.info(`[schedules] ${missed} échéance(s) manquée(s) pendant l'arrêt, non rattrapée(s)`);
      },
      stop: () => scheduleService.stop(),
    },
    { name: 'planificateur des workflows', start: async () => void (await automationScheduler.start()), stop: () => automationScheduler.stop() },
    { name: 'surveillance mémoire', start: () => healthService.startMonitor(), stop: () => healthService.stopMonitor() },
    { name: 'synchronisation des pull requests', start: () => trackedPullRequestService.startBackgroundSync(), stop: () => trackedPullRequestService.stopBackgroundSync() },
    // Les mises à jour de session sont relayées entre instances : un seul guetteur publie les rapports de relecture.
    { name: 'rapports de relecture', start: () => void (stopReviewWatcher = reviewService.startWatcher()), stop: () => { stopReviewWatcher?.(); stopReviewWatcher = null; } },
    { name: 'sauvegardes git', start: () => gitServer.startBackgroundBackups(), stop: () => gitServer.stopBackgroundBackups() },
    { name: 'reprise des sessions orphelines', start: () => orphanSweep.start(), stop: () => orphanSweep.stop() },
  ];

  // Origines autorisées à appeler l'API avec le cookie de session : voir origin.ts (aussi appliqué aux WebSockets).
  const appOrigin = new URL(config.appUrl).origin;

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    logging: yogaLogger,
    // Prévention CSRF (requêtes « simples » d'un autre site) et introspection réservée aux utilisateurs connectés.
    plugins: [csrfPreventionPlugin(), introspectionGuardPlugin(), appErrorLogPlugin(), operationTimingPlugin()],
    cors: (request) => {
      const origin = request.headers.get('origin');
      return isAllowedOrigin(origin) ? { origin, credentials: true } : { origin: appOrigin, credentials: true };
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
      .then((handled) => handled || handleInternalRoute(req, res))
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
    containerMonitor.start();
    void leadership.start(leaderJobs);
    sessionService
      .drainQueue()
      .then(() => sessionService.resumeInterruptedAfterRestart())
      .then((ids) => ids.length && log.info(`[sessions] ${ids.length} session(s) interrompue(s) relancée(s)`))
      .catch((err) => log.error('[sessions] reprise automatique', err));
  });

  let shuttingDown = false;
  let draining = false;
  const shutdown = async (signal: string) => {
    // Avant tout await : pm2 envoie le signal à tout l'arbre de processus, les agents meurent en même
    // temps que nous et leur fin doit être vue comme une interruption, pas comme une erreur.
    sessionService.beginShutdown();
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[http] arrêt en cours (${signal})...`);
    // On cesse d'accepter des requêtes avant d'arrêter les sessions et de fermer le pool.
    server.close();
    await leadership.release();
    containerMonitor.stop();
    loginService.shutdown();
    const [interrupted] = await Promise.all([sessionService.shutdown(), terminalService.shutdown()]);
    if (interrupted) log.info(`[sessions] ${interrupted} session(s) marquée(s) comme interrompue(s)`);
    // Les autres instances relancent les sessions interrompues ici (reprise automatique), puis oublient celle-ci.
    await instanceBus.stop(interrupted).catch(() => undefined);
    await instanceRegistry.unregister().catch((err) => log.error('[instances] désinscription', err));
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  /**
   * Drainage (déploiement bleu/vert, SIGUSR2 envoyé par deploy/cellule/deploy.sh une fois nginx basculé sur la nouvelle
   * instance) : tâches périodiques et verrou cédés, plus aucune session ne démarre ici (transmises à la nouvelle
   * instance), les tours en cours se terminent puis chaque session est garée ; l'instance s'arrête d'elle-même quand
   * plus aucune session ni terminal ne tourne, ou au bout de SKIPPER_DRAIN_TIMEOUT_MINUTES (les sessions encore au
   * travail sont alors interrompues, et relancées par la nouvelle instance).
   */
  const drain = async () => {
    if (draining || shuttingDown) return;
    draining = true;
    const deadline = Date.now() + config.drainTimeoutMinutes * 60_000;
    log.info(`[instances] SIGUSR2 reçu : drainage (${sessionService.localCount()} session(s), ${terminalService.liveCount()} terminal(aux), au plus ${config.drainTimeoutMinutes} min)`);
    await instanceRegistry.setDraining().catch((err) => log.error('[instances] drainage', err));
    await leadership.release();
    sessionService.beginDrain();
    let lastReport = Date.now();
    const timer = setInterval(() => {
      const sessions = sessionService.localCount();
      const terminals = terminalService.liveCount();
      if (sessions + terminals === 0) {
        clearInterval(timer);
        void shutdown('drainage terminé');
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        log.warn(`[instances] délai de drainage dépassé : ${sessions} session(s) et ${terminals} terminal(aux) encore ouverts`);
        void shutdown('délai de drainage dépassé');
      } else if (Date.now() - lastReport >= 60_000) {
        lastReport = Date.now();
        log.info(`[instances] drainage : ${sessions} session(s) et ${terminals} terminal(aux) encore ouverts`);
      }
    }, 2_000);
  };
  process.on('SIGUSR2', () => void drain());
}

main().catch((err) => {
  log.error('[fatal]', err);
  process.exit(1);
});
