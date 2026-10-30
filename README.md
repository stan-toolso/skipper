# Skipper

Interface de gestion de sessions d'agents tournant en arrière-plan. Claude Code est le premier type
supporté, mais l'architecture est générique : un « provider » par type d'agent (`shell` est fourni
comme second exemple).

Trois notions :

- **Utilisateur** : connexion uniquement avec un compte Google. Personne ne s'inscrit seul : un
  utilisateur existe parce qu'il a été **invité sur un projet** (par e-mail), avec un rôle propre à
  ce projet (administrateur, membre, lecteur). Il ne voit que les projets dont il est membre.
- **Projet** : prompt système, dépôt git optionnel, et un dossier de travail (workspace) dédié dans
  `WORKSPACES_ROOT`. Le dépôt y est cloné à la création du projet.
- **Environnement d'exécution** : chaque projet a son conteneur Docker (limite de mémoire, plafond CPU
  optionnel, ne voit que le code de ce projet). Agents, terminaux et commandes y tournent **toujours** : rien ne
  s'exécute directement sur le serveur avec l'utilisateur de Skipper.
- **Session** : une conversation interactive avec un agent, rattachée à un projet, et **l'unité de travail
  de l'interface**. Chaque session a **son propre dossier de travail**, à côté du checkout principal — un
  `git worktree` sur sa propre branche pour un projet relié à un dépôt, un simple dossier sinon — où
  tournent son agent et ses terminaux : rien ne s'exécute dans le dossier principal. La branche est nommée
  d'après la consigne (un slug de ses premiers mots ; modifiable, avec son point de départ, à la création).
  Une tâche a **son** dossier et sa branche `task/<slug>`, créés à sa première session et repris par les
  suivantes. La consigne de départ est facultative : sans consigne, la session est créée sans démarrer et
  la première instruction envoyée depuis sa page la lance. On peut lui envoyer des instructions à tout
  moment, comme dans Claude Code ; une session terminée est relancée (reprise de la conversation) par un
  simple message. Un agent peut lui-même lancer d'autres sessions (outil MCP `sessions`) ; elles gardent
  la trace de la session qui les a lancées.
- **Work session** : le nom technique de ce dossier de travail (table `worksessions`, serveur MCP
  `worksessions`, champs `worksessionId` de l'API). **L'interface ne la nomme jamais** : elle crée et
  gère des sessions, et ne montre du dossier que sa branche. Règle : **une work session n'héberge qu'une
  session active** (`sessionService.create` refuse une work session occupée) ; archiver une session archive
  sa work session (terminaux fermés, dossier et branche conservés), la restaurer la restaure (refusé si une
  autre session y travaille depuis), la supprimer supprime le dossier (branche conservée sauf demande ; une
  work session dont il ne reste que des sessions archivées est archivée). Relancer une session, ou confier
  à nouveau une tâche à un agent, archive la session précédente et donne le dossier à la nouvelle
  (`sessionService.vacateWorksession`). Supprimer une work session par l'API ou l'outil MCP
  (`worksessions.delete`, fusion d'une PR depuis le panneau git) n'efface jamais ses sessions : elles sont
  archivées avec leur transcript, leur coût, leur planification et leur lien de tâche, et gardent le nom du
  dossier disparu (`Session.formerWorksession`) ; seule la mutation `deleteWorksession(deleteSessions:
  true)` les supprime définitivement. Les work sessions s'appelaient « worktrees » jusqu'à la migration
  `036_worksessions.sql` ; leurs dossiers restent sous `WORKSPACES_ROOT/<slug>.worktrees/`. Les sessions
  d'avant les work sessions, sans dossier à elles, reprennent dans le dossier principal.
- **Espace personnel** : un projet qui n'appartient qu'à une personne (jamais partagé, créé à sa
  première visite de `/me`), sans dépôt git, où elle ouvre des sessions, des chats et des tâches. Ses
  sessions ont accès à **toutes ses ressources** : projets, sessions et tâches, avec ses
  droits (lancer une session dans un projet, attendre sa réponse, créer une tâche…).
- **Chat** : conversation légère de l'espace personnel, sans dossier de travail ni conteneur (le CLI tourne
  sur le serveur sans outil de fichiers ni de commande, avec les seuls outils MCP de Skipper), ouverte
  en une question depuis le tableau de bord ; elle pilote des sessions en arrière-plan si besoin.
  Voir « Espace personnel et chats » plus bas.
- **Demande** : intervention humaine attendue par un agent (autorisation d'outil, question, saisie).
  La session reste en cours jusqu'à la réponse.
- **Contexte** : bibliothèque d'instructions propre à chaque projet, rangée en dossiers, stockée en
  base et versionnée. Les agents la consultent (skills) et la gèrent (outils MCP) ; elle est
  administrable dans l'application.
- **Terminal** : un shell interactif (pty) ouvert dans le workspace d'un projet et piloté depuis le
  navigateur (xterm.js relié par WebSocket), pour travailler comme dans un terminal, y compris avec
  le CLI `claude`.
- **Notification** : cloche en haut à droite de l'interface. Signale une demande d'un agent, une
  tâche créée ou terminée par un agent, une session terminée ou en erreur, une instruction ajoutée au
  contexte par un agent. La notification d'une demande est marquée lue d'elle-même dès que la demande
  est réglée (répondue, annulée avec la session, expirée au redémarrage) : la cloche ne réclame que ce
  qui attend encore. Réservées aux administrateurs de l'application : les limites d'utilisation de
  l'abonnement Claude (fenêtre à 75 % puis 90 %, tours refusés). Notifications natives du navigateur
  activables en option.
- **Coffre** : serveurs SSH, bases PostgreSQL, API HTTP, comptes AWS, sites web, secrets et comptes Google que les
  agents utilisent sans jamais voir les identifiants : le serveur agit pour eux (outils MCP, saisie dans le
  navigateur headless). Un élément appartient à une personne (coffre personnel, partageable et ouvrable à
  des projets) ou à un projet. Le coffre garde aussi ce que Skipper utilise **lui-même** pour une
  personne, jamais offert aux agents : jetons applicatifs (abonnement Claude, clé API Anthropic, comptes
  GitHub, fournisseurs de modèles d'OpenCode), proxy LiteLLM, projet Langfuse. Voir « Coffre » plus bas.
- **Tâche** : élément de travail d'un projet avec priorité (basse, moyenne, haute, urgente) et statut
  (à faire, en cours, terminée, annulée). Créée et mise à jour par les humains (tableau dans
  l'application) comme par les agents (outils MCP). « Confier à un agent » lance une session avec la
  tâche comme consigne.
- **Workflow** : graphe d'un projet (déclencheur, appels de modèle, sessions, tâches, créations de tâche,
  conditions, fins) avec des branches oui / non et « en cas d'erreur », lancé à la main, par
  planification ou par une tâche créée. Un nœud **appel de modèle** (`callLlm`) appelle directement un
  modèle (LiteLLM, OpenAI, Anthropic, tracé dans Langfuse) avec des instructions, un prompt à variables et
  une sortie texte ou JSON. Voir « Workflows » plus bas.

## Stack

- **Backend** : Node.js 20, TypeScript, GraphQL ([graphql-yoga](https://the-guild.dev/graphql/yoga-server)), PostgreSQL (`pg`, migrations SQL), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), Google OAuth (sans dépendance)
- **Frontend** : React 18, Vite, Bootstrap 5 (react-bootstrap), Apollo Client, React Router
- **Infra locale** : Docker Compose (PostgreSQL 16)

## Démarrage rapide

Mise en production (serveur, nginx, base RDS, pm2) : voir `DEPLOY.md`.

Paramètres (menu en bas de la sidebar), **propres à chaque personne** : **Claude** (abonnement
connecté depuis la page ou clé API du coffre, modèles, budgets et consommation), **OpenCode** (modèle
par défaut, clés des fournisseurs, liste des modèles), **GitHub** (comptes connectés par code ou par
jeton du coffre, dépôts), **Serveur** (administrateurs : santé, sessions simultanées, maintenance,
limites de l'abonnement) et **Apparence**. Les sessions, actions git et pull requests d'une personne
utilisent ses propres comptes.

```bash
cp .env.example .env        # renseigner GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (voir « Utilisateurs »)
npm install
npm run db:up               # lance PostgreSQL dans Docker
npm run dev                 # backend (http://localhost:4000/graphql) + frontend (http://localhost:5173)
```

Les migrations SQL (`backend/src/db/migrations/*.sql`) sont appliquées automatiquement au démarrage
du backend, ou à la main avec `npm run db:migrate`.

### Tests

```bash
npm test                    # tests du backend puis du frontend (Vitest)
TEST_DATABASE_URL=postgres://skipper:skipper@localhost:5432/skipper npm test   # avec le test des migrations
npm run test:watch -w backend   # relance à chaque modification
```

Les tests sont à côté du code (`src/**/*.test.ts`), exclus du build du backend mais vérifiés par
`npm run typecheck` (`backend/tsconfig.test.json`). Ils couvrent en priorité les services critiques :
contrôle d'accès par rôle (`auth/access.ts`), confinement de l'explorateur de fichiers
(`files/service.ts` : normalisation, chemins et liens symboliques sortants, `FILE_CONFLICT`),
chiffrement des secrets (`settings/crypto.ts`), et, côté frontend, les formulations de
`lib/humanize.ts`. Les dépendances qui touchent la base (services des utilisateurs, projets,
worksessions) sont simulées avec `vi.mock`.

Le test des migrations (`db/migrate.test.ts`) a besoin d'un PostgreSQL où le rôle peut créer des
bases, par exemple celui de `npm run db:up` : il crée une base `skipper_test_*`, y applique toutes
les migrations deux fois (le second passage ne doit rien faire), vérifie qu'une migration en échec
est annulée, puis supprime la base. Sans `TEST_DATABASE_URL` il est ignoré en local et échoue en CI.
Ne jamais y mettre l'URL de la base de production.

**CI** : `.github/workflows/ci.yml` lance `npm ci`, `npm run typecheck`, `npm run build` et
`npm test` à chaque push et pull request, avec un service PostgreSQL 16 pour le test des migrations.
Le déploiement reste manuel (`DEPLOY.md`).

Le provider Claude s'appuie sur le [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
(`@anthropic-ai/claude-agent-sdk`), qui embarque son propre binaire Claude Code : chaque message du
flux `query()` est journalisé comme événement `claude.<type>`, sauf les `rate_limit_event` (un par
appel au modèle) : le dernier état des limites est gardé par `settings/rateLimits.ts` (clé
`claude.rate_limits` de app_settings) et le transcript ne garde que les changements de statut. Chaque
session s'authentifie avec les identifiants de **son propriétaire** (Paramètres → Claude : jeton
d'abonnement ou clé API, rangés dans son coffre), transmis au CLI par variables d'environnement.
`CLAUDE_BIN` permet, si besoin, d'imposer le binaire utilisé pour la connexion d'un abonnement depuis
l'interface ; les sessions utilisent toujours le CLI de l'image Docker du projet. Le provider
**OpenCode** (`sessions/providers/opencode.ts`) lance `opencode serve` dans le conteneur du projet et
le pilote par son API ; voir « OpenCode » plus bas.

## Structure

```
backend/
  src/
    index.ts                   # serveur HTTP + GraphQL (contexte = utilisateur du cookie de session)
    config.ts                  # variables d'environnement
    errors.ts                  # erreurs métier renvoyées au client
    pubsub.ts                  # canaux temps réel (subscriptions)
    db/                        # pool pg, runner de migrations, migrations SQL
    auth/
      routes.ts                # /auth/google, /auth/google/callback, /auth/logout
      google.ts                # flux OAuth Google (URL d'autorisation, échange du code, profil)
      session.ts               # sessions de connexion : jeton dans un cookie HttpOnly, hachage en base
      access.ts                # contexte GraphQL et gardes : requireUser, requireAdmin, requireProject(role)
    users/
      service.ts               # connexion Google, invitations et rôles par projet
    projects/
      service.ts               # création / édition, slug, préparation du workspace
      workspace.ts             # dossier du projet, clone git, infos de branche
    requests/
      service.ts               # demandes d'intervention humaine : création, attente de la réponse
    personal/
      service.ts               # espace personnel (un projet par personne, créé à la demande), chats, prompt de la portée
      scope.ts                 # portée d'une session personnelle : résolution d'un projet, droits, paramètre `project` des outils
      mcp.ts                   # serveur MCP `projects` (list, get) des sessions d'un espace personnel
    worksessions/
      names.ts                 # noms dérivés de la consigne (libellé, dossier, branche), uniques dans le projet
      service.ts               # work sessions (dossier de travail de chaque session) : création (git worktree ou dossier), tâche, archivage, suppression, cwd
      mcp.ts                   # serveur MCP `worksessions` (list, create, delete)
    terminals/
      service.ts               # shells pty (node-pty) par projet, relayés en WebSocket (/terminals/<id>)
    notifications/
      service.ts               # notifications (cloche) émises par les autres services
    schedules/
      cron.ts                  # expressions cron à cinq champs, fuseaux IANA, prochaine échéance
      service.ts               # planification des sessions : ordonnanceur, exécution, compte rendu et notification
    settings/
      userStore.ts             # réglages par personne (table user_settings)
      claude.ts                # réglages Claude d'une personne : mode, jetons du coffre, modèles, budgets, vérification
      login.ts                 # connexion d'un abonnement Claude depuis l'interface (claude setup-token piloté)
      opencode.ts              # réglages OpenCode d'une personne : modèle par défaut, clés des fournisseurs, modèles
      github.ts                # comptes GitHub d'une personne : jeton par dépôt, identité des commits, dépôts
      githubDevice.ts          # connexion GitHub par code (device flow)
      usage.ts                 # consommation (usage_ledger) par personne
      legacy.ts                # reprise des réglages Claude / GitHub d'application vers le premier administrateur
      server.ts / rateLimits.ts # réglages du serveur et limites de l'abonnement (administrateurs)
    workflows/
      graph.ts                 # définition d'un graphe : lecture, validation, prochains pas
      engine.ts                # exécution d'un workflow : nœuds, branches, journal, notification
      llm.ts / llmCall.ts      # nœud « appel de modèle » : appel direct (LiteLLM, OpenAI, Anthropic), clé du coffre, trace Langfuse
      template.ts              # modèles {{input.x}}, {{nodes.k.output}}, | default
      inputs.ts                # variables d'un déclencheur, valeurs d'une exécution, planification cron
      conditions.ts / expressions.ts / taskFilter.ts  # conditions visuelles, formules, filtres de tâches
      service.ts / triggers.ts / scheduler.ts         # file d'exécutions, déclencheur « tâche créée », planification
    tasks/
      service.ts               # tâches : création, mise à jour, personnes, champs, commentaires, résumé pour le prompt
      sessionFeed.ts           # changements et commentaires transmis à la session en charge
      mcp.ts                   # serveur MCP `tasks` (list, get, create, update, claim, comment, pr_list, pr_open, pr_register, pr_update)
      launch.ts                # confier une tâche à un nouvel agent
      api.ts                   # API REST /api/v1/tasks (clés d'API du projet)
    pullRequests/
      types.ts                 # pull request suivie : statut, étape dérivée (brouillon, à fusionner, à déployer, déployée, annulée), textes pour les agents
      repository.ts            # table pull_requests
      service.ts               # suivi : enregistrement, ouverture sur GitHub, mise à jour, déploiement, synchronisation GitHub, notifications
    vault/
      service.ts               # coffre : éléments, permissions, partages, liens, copie, révélation, tests, journal
      access.ts                # calcul des permissions (utiliser < lire < gérer)
      crypto.ts                # chiffrement par enveloppe, rotation de la clé maîtresse
      ssh.ts                   # client ssh2 : clés, exécution, SFTP, tunnels, clé d'hôte (TOFU)
      postgres.ts              # requêtes pg (lecture seule, tunnel, TLS), rendu des résultats, schéma
      api.ts / http.ts         # API HTTP : cible sous l'adresse de base, authentification, garde réseau, masquage
      website.ts               # sites web et secrets : champs, appartenance d'une page au site
      tokens.ts                # jetons applicatifs : services (claude, anthropic, github, openai…), forme des jetons
      llm.ts                   # proxy LiteLLM et projet Langfuse : adresses, clés, vérification
      aws.ts                   # comptes AWS : réglages, découpage et politique des commandes, OIDC et portail Identity Center, CLI en conteneur jetable
      awsService.ts            # comptes AWS : connexion par code, renouvellement des jetons, identifiants temporaires (cache), test
      scaleway.ts              # comptes Scaleway : réglages, découpage et politique des commandes scw, appels d'API, CLI en conteneur jetable
      scalewayService.ts       # comptes Scaleway : identifiants, exécution pour un agent, test (identité IAM)
      mcp.ts                   # serveur MCP `vault` (list, ssh_run, ssh_upload, ssh_download, sql_query, sql_schema, http_request, aws_run, scw_run, scw_api, browser_fill)
    google/
      service.ts               # comptes Google du coffre : OAuth hors ligne, jeton chiffré, appels d'API, vérification, prompt
      gmail.ts                 # client Gmail (recherche, lecture, téléchargement d'une pièce jointe, envoi / réponse)
      drive.ts                 # client Drive (recherche, lecture / export, téléchargement, dépôt, création de Docs)
      mcp.ts                   # serveur MCP `google` (outils selon les accès accordés)
    sharedPages/               # pages partagées : publication, versions, membres, route de lecture en bac à sable, MCP `pages`
    search/                    # recherche globale (projets, sessions, tâches, pages, coffre)
    apiKeys/                   # clés d'API des projets
    context/
      service.ts               # bibliothèque de contexte : dossiers, instructions, versions, journal
      mcp.ts                   # serveur MCP in-process exposé aux sessions Claude (tree, read, write...)
      skills.ts                # génération d'un plugin Claude Code (une skill par instruction)
    graphql/
      schema.graphql           # schéma (queries, mutations, subscriptions SSE)
      resolvers.ts
    sessions/
      types.ts                 # modèle Session / SessionEvent
      repository.ts            # accès SQL
      service.ts               # orchestration : création (avec le dossier de travail de la session), démarrage, arrêt, suivi des processus
      scheduledRuns.ts         # sessions dont l'exécution en cours vient de leur planification
      cleanup.ts               # nettoyage automatique : purge du transcript, compaction ou remise à zéro de la conversation
      mcp.ts                   # serveur MCP `sessions` (list, get, create, wait, send, end) : sessions lancées par un agent
      providers/
        provider.ts            # interface SessionProvider (à implémenter pour un nouvel agent)
        registry.ts            # enregistrement des providers disponibles
        process.ts             # utilitaire de spawn de processus (stdout/stderr ligne à ligne)
        claude.ts              # provider Claude Code (Claude Agent SDK)
        opencode.ts            # provider OpenCode (serveur dans le conteneur, API, autorisations, état miroir)
        opencodeBridge.ts      # ponts TCP vers les serveurs MCP de Skipper pour OpenCode
        shell.ts               # provider commande shell
frontend/
  src/
    apollo.ts                  # client GraphQL
    graphql/operations.ts      # queries / mutations + types TS (settings.ts, vault.ts, automation.ts…)
    pages/                     # projets, sessions, tâches, coffre, workflows, paramètres…
    components/                # layout, badge de statut, journal, carte de demande, dialogues (Dialogs.tsx)
    components/automation/     # workflows : éditeur de graphe (@xyflow/react), inspecteur des nœuds, exécutions
```

## Utilisateurs et droits

- **Connexion** : Google uniquement (`GET /auth/google` redirige vers Google, le retour ouvre une
  session de 30 jours dans un cookie `skipper_session` HttpOnly, `POST /auth/logout` la ferme).
  Configuration : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (console Google Cloud, identifiant
  OAuth « application Web », URI de redirection `API_URL/auth/google/callback`), `APP_URL` (front,
  cible des redirections et origine autorisée en CORS) et `API_URL`. Un compte Google dont l'adresse
  ne correspond à aucun utilisateur est refusé (`Aucune invitation pour …`) : il n'y a pas
  d'inscription libre.
- **User** : `email` (unique, minuscules), `name`, `avatarUrl`, `googleSub` (relié à la première
  connexion), `isAdmin` (administrateur de l'application : page Paramètres, liste des
  utilisateurs ; n'ouvre aucun projet), `lastLoginAt` (null = invité jamais connecté).
- **ProjectMember** : `(projectId, userId)`, `role` et qui a invité. Rôles, du plus au moins
  puissant :
  - `admin` : modifier / supprimer le projet, gérer les membres, et tout ce qui suit ;
  - `member` : sessions, terminaux, tâches, contexte, réponses aux demandes ;
  - `viewer` : lecture seule.
  Le créateur d'un projet en est administrateur. Un projet garde toujours au moins un
  administrateur. Inviter une adresse crée l'utilisateur s'il n'existe pas (« en attente » jusqu'à sa
  première connexion) ; réinviter change le rôle.
- **Contrôle d'accès** : chaque requête et mutation GraphQL vérifie le rôle sur le projet de l'objet
  visé (`backend/src/auth/access.ts`) ; les listes globales (projets, sessions, demandes, tâches,
  notifications) sont restreintes aux projets de l'utilisateur ; les subscriptions filtrent de même ;
  la WebSocket d'un terminal exige le cookie de session et le rôle `member`. Les notifications sont
  partagées entre les membres d'un projet (état lu / non lu commun).
- Première migration : `stan@toolso.io` est créé administrateur de l'application et de tous les
  projets existants.
## Coffre

Page « Coffre » (`/vault`, menu de la sidebar) : tout ce que l'utilisateur peut voir ; page « Coffre » d'un
projet (`/projects/:id/vault`, bouton sur la fiche du projet) : ce que les agents de ce projet peuvent
utiliser. Huit types offerts aux agents : **serveur SSH**, **base PostgreSQL** (éventuellement via un
serveur SSH du même coffre, en tunnel), **API HTTP**, **compte AWS**, **compte Scaleway**, **site web**, **secret** et **compte Google** ;
trois types **réservés à Skipper** : **jeton applicatif**, **proxy LiteLLM** et **projet Langfuse**.
Chaque élément a un nom court (`prod`, `rds-prod`, `stripe`, `admin-site`) que les agents emploient.

**Propriété, partage, ouverture aux projets.** Un élément appartient soit à une personne (coffre
personnel), soit à un projet (géré par ses administrateurs, utilisable par ses membres). Un élément
personnel se **partage** avec des collègues, avec une permission `utiliser` < `lire` (révéler les secrets)
< `gérer`, et s'**ouvre à des projets** : pour toutes les sessions du projet (il faut gérer l'élément et
administrer le projet) ou seulement pour les sessions que l'on lance soi-même. Les agents d'une session
voient les éléments du projet, ceux ouverts à tous ses agents, et ceux que l'auteur de la session a
ouverts pour ses propres sessions ; un nom ne peut pas désigner deux éléments dans une même portée. Un
élément se **copie** dans un projet (secrets compris) pour une migration, et se **duplique** dans son propre coffre
(bouton de la ligne, permission `gérer`) sous un nouveau nom, secrets compris, sans ses partages, liens ni journal :
la copie s'ouvre aussitôt dans l'éditeur pour en faire une variante.

**Chiffrement.** Les secrets d'un élément forment un document chiffré (AES-256-GCM) avec une clé de
données propre à l'élément, elle-même enveloppée par la clé maîtresse (`SKIPPER_SECRET_KEY` ou
`.secret-key`) ; les deux sont liés à l'identifiant de l'élément. `SKIPPER_SECRET_KEY_PREVIOUS` permet une
rotation : les clés de données sont ré-enveloppées au démarrage (`backend/src/vault/crypto.ts`). Les
secrets ne sont jamais renvoyés à l'interface, sauf « révéler » (permission `lire`, journalisé, limité en
fréquence, masqué après 30 s) ; la clé privée SSH et le jeton Google ne quittent jamais le serveur.

**Par type.** SSH : paire ed25519 générée (clé publique à installer dans `authorized_keys`, au besoin
avec `restrict,command="…"`), clé d'hôte mémorisée à la première connexion et vérifiée ensuite, liste
blanche de préfixes de commandes (qui désactive alors enchaînements et transferts). PostgreSQL : rôle
dédié recommandé, « lecture seule » force des transactions `READ ONLY`, TLS avec certificat d'autorité
optionnel (Cloud SQL), une seule instruction par appel, résultats tronqués à 200 lignes. Le champ « base de
données » est facultatif : vide, l'élément couvre **le serveur entier** et l'agent nomme la base à chaque
appel (paramètre `database` de `sql_query` et `sql_schema`, base de maintenance `postgres` par défaut ;
`sql_schema` sans base liste les bases du serveur). API : l'agent
donne un chemin relatif à l'adresse de base, la requête ne sort ni de l'origine ni du chemin, le serveur
ajoute l'authentification (Bearer, en-tête, Basic, paramètre), ne suit pas les redirections, masque le jeton
dans la réponse ; « lecture seule » limite à GET, HEAD et OPTIONS ; les adresses internes sont refusées
(`vault/http.ts`). Site web : une adresse et des champs publics ou secrets ; l'agent sélectionne un champ
de formulaire puis appelle `browser_fill(item, champ)` : le serveur vérifie que la page appartient au site,
demande l'accord s'il le faut, puis tape la valeur par CDP ; les outils qui liraient la page en retour
(`browser_evaluate`, `browser_run_code`) sont retirés quand le coffre a tapé quelque chose. Secret : des
champs sans site, chaque saisie est soumise à accord avec la page affichée. Google : connecté par OAuth
(`GET /auth/google/connect?projectId=…|personal=1&gmail=…&drive=…`), accès lecture ou écriture pour Gmail et
Drive, même serveur MCP `google` qu'auparavant (`account` = nom de l'élément) : `gmail_search`, `gmail_read`,
`gmail_attachment` (pièce jointe d'un mail téléchargée dans le dossier de travail), `gmail_send`, `drive_search`,
`drive_read`, `drive_download`, `drive_upload`, `drive_write`.

**Réservés à Skipper.** Un **jeton applicatif** (`backend/src/vault/tokens.ts`) est un identifiant
que Skipper utilise pour le compte d'une personne : jeton d'abonnement Claude (`claude`, obtenu par
la connexion de Paramètres → Claude, jamais révélable, renouvelé par Skipper), clé API Anthropic
(`anthropic`), jeton GitHub (`github`, collé ou obtenu par la connexion par code), clés des
fournisseurs de modèles d'OpenCode (`openai`, `google`, `openrouter`, `opencode`, `mistral`,
`deepseek`, `xai`, `groq`). Un **proxy LiteLLM** (adresse et clé) et un **projet Langfuse** (hôte, clé
publique, clé secrète) servent aux agents à appel direct de modèle. Ces éléments n'ont aucun outil
MCP, ne peuvent pas être ouverts à un projet, et les jetons OAuth ne se copient pas ; les réglages
d'une personne les **référencent** (identifiant de l'élément) et Skipper relit le secret à chaque
usage, après avoir vérifié qu'elle peut toujours s'en servir, en journalisant l'usage. Partager un
jeton (permission `utiliser`) permet à un collègue de le choisir dans ses réglages sans le voir. Le
test d'un élément vérifie le jeton auprès du service (Anthropic, GitHub, LiteLLM `/v1/models`,
Langfuse `/api/public/projects`).

**AWS.** Deux modes : **IAM Identity Center** (`sso` : adresse du portail d'accès et région ; connexion par
code depuis les détails de l'élément, flux OAuth « device » de l'API OIDC, jetons d'accès et de renouvellement
chiffrés dans l'élément et renouvelés par Skipper, puis choix du compte et du rôle parmi ceux de la personne)
ou **clés d'accès** (`keys` : identifiant et clé secrète d'un utilisateur IAM, rôle à endosser optionnel par
`sts assume-role`). L'agent dispose de l'outil `aws_run(item, command)` : la commande du CLI sans `aws`,
découpée sans shell (guillemets acceptés, ni tube ni substitution), refusée si elle use d'un profil local, du
mode `--debug`, de `configure`/`sso`/`login` ou d'une session interactive (`ssm start-session`), limitée
aux opérations de consultation (`describe-*`, `get-*`, `list-*`, `s3 ls`…) quand l'élément est en
« lecture seule » (défaut), et aux préfixes autorisés s'il en a. Le serveur obtient des identifiants
temporaires (rôle Identity Center par le portail d'accès, ou rôle endossé ; les clés seules sinon), gardés en
mémoire jusqu'à cinq minutes avant leur expiration, puis lance `aws …` dans un **conteneur jetable** de l'image
du runner (`runner.runIsolated`, `vault/aws.ts`) : même uid que l'hôte, dossier personnel en tmpfs, seul le
dossier de travail de la session monté (chemins relatifs des commandes `s3 cp`, `lambda update-function-code`…),
identifiants transmis par l'environnement du client `docker` (jamais sur sa ligne de commande), conteneur
supprimé à la fin ou au délai. Rien ne transite par le conteneur du projet : l'agent n'y voit ni clé ni jeton.
Le test de l'élément exécute `sts get-caller-identity` et mémorise l'identité (ARN) constatée.

**Scaleway.** Une **clé d'API IAM** (clé d'accès `SCW…` publique, clé secrète chiffrée), de préférence celle d'une
application IAM dédiée aux agents avec une politique aux droits limités ; organisation, projet, région (`fr-par`) et zone
(`fr-par-1`) par défaut. Deux outils. `scw_run(item, command)` : la commande du CLI `scw` sans `scw`, découpée sans shell,
refusée si elle use d'un profil ou d'un fichier de configuration local (`-p`, `-c`), du mode `--debug`, de `init`, `config`,
`login`, `info`, d'une connexion interactive (`instance server ssh`, `console`) ou d'un fichier qui contiendrait la clé
secrète (`object config`, `k8s kubeconfig`, `registry login`) ; limitée aux verbes `list`, `get` et `wait` quand l'élément
est en « lecture seule » (défaut), hors chemins qui livrent des secrets ou des accès (`secret version`, `iam api-key`,
`mnq … credentials`, `rdb user`) ; aux préfixes autorisés s'il en a. Elle tourne dans le même **conteneur jetable** que
le CLI AWS (`vault/scaleway.ts`), identifiants par l'environnement (`SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, organisation,
projet, région, zone). `scw_api(item, method, path, query, body)` : un appel à `https://api.scaleway.com` par le module
des API HTTP du coffre (chemin relatif sous l'origine, redirections non suivies, réponse tronquée à 2 Mo, clé masquée),
authentifié par le serveur (`X-Auth-Token`) ; en lecture seule, `GET` seulement et sans les chemins sensibles
(`…/versions/…/access`, `…/kubeconfig`, `iam/…/api-keys`, `…credentials`). Le test de l'élément interroge IAM
(`/iam/v1alpha1/api-keys/<clé>` puis l'application ou l'utilisateur), mémorise le principal constaté et complète
l'organisation et le projet par défaut s'ils manquent.

**Accès des agents.** Serveur MCP `vault` : `list`, `ssh_run`, `ssh_upload`, `ssh_download`,
`sql_query`, `sql_schema`, `http_request`, `aws_run`, `scw_run`, `scw_api`, `browser_fill`. Le backend déchiffre, exécute, tronque, et
journalise chaque usage dans le **journal** de l'élément (`vault_audit_events`, conservé 400 jours) et
comme événement `connection` de la session. « Demander l'accord avant chaque usage » est appliqué par le
serveur lui-même : le mode « tout autoriser » d'une session ne le contourne pas ; l'accord peut être
mémorisé par élément pour la session ou le projet.

**Migration.** Les anciennes tables `connections` et `project_google_accounts` sont reprises dans
`vault_items` (mêmes identifiants, même nom ; comptes Google nommés `google-<adresse>`), les règles
`mcp__connections__*` renommées `mcp__vault__*`, les anciens secrets convertis au démarrage. Le mode
« shell » (ssh-agent, PGSERVICEFILE, variables d'environnement) n'existe plus : rien n'atteint jamais le
conteneur de l'agent.

## Modèle

- **Project** : `name`, `slug` (nom du dossier, fixé à la création), `description`, `systemPrompt`,
  `gitUrl`, `gitBranch`. Le workspace est `WORKSPACES_ROOT/<slug>` ; il est créé (ou cloné) à la
  création du projet et au plus tard au démarrage d'une session. Supprimer un projet supprime ses
  sessions en base mais conserve le dossier sur disque.
- **VaultItem** : `ownerUserId` ou `ownerProjectId` (exactement l'un des deux), `name`, `kind` (ssh,
  postgres, api, aws, scaleway, website, secret, google, token, litellm, langfuse), `settings` (champs publics du type), secrets chiffrés par
  enveloppe (`secretCiphertext`, `wrappedKey`), `publicKey`, `hostKey`, `readOnly`, `requireApproval`,
  `commandAllowlist`, `expiresAt` (rappel de rotation), dernier test ; tables `vault_item_shares`,
  `vault_item_links` (portée `project` ou `personal`), `vault_audit_events`.
- **UserSettings** (`user_settings`, une ligne par personne et par clé : `claude`, `claude.verification`,
  `opencode`, `opencode.models`) et **UserGithubAccount** (`user_github_accounts` : `login`, `method`,
  `scopes`, `organizations`, `isDefault`, `vaultItemId` du jeton, expiration).
- **Workflow** (`workflows`) : `projectId`, `name`, `definition` (nœuds et arêtes), `enabled`,
  planification (`schedule`, `scheduleInputs`, `scheduleOwnerId`), `eventOwnerId`. **WorkflowRun**
  (`workflow_runs`, `workflow_run_nodes`, `workflow_run_logs`) : définition figée au lancement, entrées,
  état de chaque nœud (entrée, sortie, erreur), journal, sortie. Une session garde `workflowRunId` quand
  une exécution l'a ouverte. (Les tables `agents` et `agent_runs` ont disparu avec la migration 039.)
- **Work session** (`worksessions`) : `projectId`, `name` (dossier), `branch` (le nom du dossier pour un
  projet sans dépôt), `label` (libellé libre, sinon la branche), `taskId` (tâche à laquelle elle est
  consacrée), `archivedAt`. Dossier `WORKSPACES_ROOT/<slug>.worktrees/<name>` ; pour un projet git, créé
  par `git worktree add` depuis le checkout principal, après un `fetch` : branche locale ou distante
  existante extraite, sinon nouvelle branche depuis `baseRef` (défaut : la branche principale **sur origin**,
  `origin/<branche du projet>`, pas le HEAD du checkout principal qui n'avance qu'aux fusions faites depuis
  Skipper ; le checkout principal est au passage avancé sur origin si c'est une avance rapide) ; pour un
  projet sans dépôt, un dossier vide. La
  suppression retire le dossier et conserve la branche sauf demande contraire. Sessions et terminaux portent
  un `worksessionId`, obligatoire à la création, qui fixe leur dossier de travail ; une work session
  n'héberge qu'une session active (voir « Work session » plus haut).
- **Session** : `projectId`, `worksessionId`, `ownerId` (auteur ; hérité de la session parente pour une
  session lancée par un agent), `archivedAt`, `parentSessionId` (session d'agent qui l'a lancée, null
  pour une session humaine), `name`, `provider`, `status` (`pending`, `queued`, `running`, `completed`, `failed`,
  `stopped`, `interrupted`), `activity` pour une session en cours (`busy` : l'agent travaille, `idle` :
  il attend des instructions), `prompt` (première instruction), `config` (JSON propre au provider),
  `externalId` (ex. `session_id` Claude), `exitCode`, `error`, horodatages. Le provider Claude utilise
  le mode « streaming input » du SDK : la session reste ouverte entre les tours, `sendSessionMessage`
  envoie une instruction, `interruptSession` interrompt le tour en cours (échap dans l'interface),
  `endSession` termine proprement, `stopSession` tue le processus. `updateSessionConfig` modifie la
  configuration (fusion clé par clé) : une session Claude en cours change immédiatement de modèle
  (`setModel`) ou de mode d'autorisation (`setPermissionMode`) ; les autres clés valent pour le prochain
  lancement. Pour que « tout autoriser » reste accessible en cours de session, le CLI est toujours
  lancé avec `--allow-dangerously-skip-permissions` (rend ce mode disponible sans l'activer). Chaque
  changement est journalisé comme événement `config`. Une session créée sans `permissionMode` (session
  de tâche, notamment) reçoit le mode par défaut du projet (`defaultPermissionMode` : `default`,
  `acceptEdits`, `bypassPermissions` ou `plan`, réglable dans le formulaire du projet) ; les sessions
  planifiées gardent le mode de leur session. Le formulaire de nouvelle session propose le dernier mode
  choisi sur ce projet dans ce navigateur (localStorage), sinon celui du projet.
- **PermissionRule** : autorisation d'outil mémorisée pour un projet (`toolName`, `ruleContent`
  optionnel, ex. `Bash(git status *)`). Créée en répondant « ne plus demander dans ce projet » à une
  demande d'autorisation ou à la main sur la page du projet ; chaque session Claude du projet les
  reçoit dans `allowedTools`, donc ne redemande pas. Le prompt d'autorisation propose les règles
  suggérées par le SDK en généralisant les commandes Bash exactes par préfixe (`git checkout main` →
  `Bash(git checkout *)`, `sed -n '…' f` → `Bash(sed *)`, commandes dangereuses comme `rm` gardées
  telles quelles) dans un champ modifiable ; la réponse porte les règles relues (`rules`), qui
  remplacent les suggestions pour la session comme pour le projet. Les règles sont stockées sous forme
  canonique (`git add:*` ≡ `git add *`) et sans doublon : une règle déjà couverte par une règle plus
  large n'est pas ajoutée, une règle plus large retire les plus étroites (`permissions/rules.ts`). Le
  provider compte les appels d'outils autorisés d'office par chaque règle (`use_count`,
  `last_used_at`, suivi depuis `usage_tracked_since`) ; la page du projet permet de modifier une règle
  en place et de retirer d'un coup celles jamais utilisées. Retirer ou modifier une règle ne concerne
  que les prochaines sessions. Pour les modifications de fichiers
  (`Edit`, `Write`, `NotebookEdit`), le SDK ne suggère pas de règle mais le mode `acceptEdits` :
  « ne plus demander pour cette session » passe la session dans ce mode (appliqué par le SDK et
  enregistré dans sa configuration, événement `config`) ; « dans ce projet » mémorise en plus les
  règles `Edit`, `Write`, `MultiEdit`, `NotebookEdit`.
- **Request** : `sessionId`, `type` (`permission`, `question`, `input`, ... extensible), `status`
  (`pending`, `answered`, `cancelled`, `expired`), `title`, `message`, `payload`, `response`. Un
  provider appelle `ctx.ask(...)` et reçoit la réponse humaine sous forme de JSON libre. Le provider
  Claude convertit les demandes de permission du SDK (`canUseTool`) en demandes `permission`
  (réponse `{ decision: "allow" | "deny", scope?: "session" | "project", message? }` : `scope` applique
  les règles suggérées à la session ou les mémorise pour le projet) et l'outil `AskUserQuestion` en
  demandes `question` (réponse `{ answers: { "<question>": "<réponse>" } }`). Arrêter une session
  annule ses demandes en attente ; au redémarrage du serveur elles passent à `expired`.
- **SessionEvent** : journal ordonné d'une session (`stdout`, `stderr`, `system`, `status`,
  `claude.assistant`, `claude.result`, ...), avec un `payload` JSON.

- **Contexte** : `ContextFolder` (arborescence, slug par niveau) et `ContextInstruction` (nom,
  description, contenu Markdown, `version`). Chaque modification de nom, description ou contenu crée
  une `ContextInstructionVersion` (auteur `human` ou `agent` avec la session, note de version) et
  toute opération, structure comprise, est journalisée dans `ContextChange`. Une ancienne version se
  restaure en créant une nouvelle version. Les chemins sont des suites de slugs (`api/auth/regles-jwt`).

  Exposition aux agents Claude, à chaque démarrage de session :
  - **skills** : la bibliothèque est matérialisée en plugin Claude Code local
    (`WORKSPACES_ROOT/.context-plugins/<slug>/skills/<chemin--avec--tirets>/SKILL.md`), donc chaque
    instruction est un skill `context:<nom>` découvert nativement ;
  - **outils MCP** (serveur in-process `context`, toujours autorisé) : `tree`, `read`, `search`,
    `write` (crée ou met à jour, dossiers créés à la volée), `create_folder`, `move`, `delete`,
    `history`. Les écritures sont attribuées à la session ;
  - **prompt système** : un résumé de l'arborescence est ajouté au prompt du projet.

- **Terminal** : `projectId`, `name`, `status` (`running`, `closed`), `exitCode`. Le processus vit en
  mémoire du serveur ; la sortie récente est rejouée à chaque connexion WebSocket. Le menu « + » d'un
  projet dans la sidebar propose d'ouvrir une session d'agent ou un terminal.

- **Task** : `projectId`, `title`, `description`, `status` (`todo`, `in_progress`, `done`, `cancelled`),
  `priority` (`low`, `medium`, `high`, `urgent`), `sessionId` (session qui s'en occupe), auteur
  (`human` ou `agent` avec sa session), `dueDate`. Les sessions Claude reçoivent la liste des tâches
  ouvertes dans leur prompt système et le serveur MCP `tasks` (`list`, `get`, `create`, `update`,
  `claim`). `startTaskSession` crée une session dont la consigne est la tâche, l'assigne et la passe en
  cours ; l'agent la passe en `done` quand il a fini. Le serveur MCP `sessions` (voir « Lancer des
  sessions ») lui permet de déléguer du travail à d'autres sessions, chacune dans son dossier.

- **Runner** (`backend/src/runners/`) : un seul, Docker, pour tous les projets (`projects.runner_config`
  = `{ image, memory, cpus, browser }`). Le runner fournit l'exécutable Claude Code donné au SDK, la
  commande du terminal web et celle du provider shell ; aucun de ces processus ne tourne sur l'hôte.
  Un conteneur `skipper-<slug>` est créé à partir de `deploy/runner/Dockerfile` (image `skipper-runner:latest`,
  construite avec `docker build -t skipper-runner deploy/runner`) ; le dossier du projet, ses
  work sessions et ses skills y sont montés **aux mêmes chemins absolus que sur l'hôte**, avec l'uid/gid
  de l'utilisateur de Skipper, donc aucune traduction de chemin. Le dossier personnel est un tmpfs
  inscriptible (512 Mo) dans lequel `~/.claude` (propre au projet) et `~/.gitconfig` de l'hôte sont
  montés : Chromium (rapports de plantage, profil) et npm (cache) exigent un dossier personnel
  inscriptible. Le SDK reste dans le backend : il
  reçoit un script de relais (`WORKSPACES_ROOT/.runners/<slug>/claude`) qui exécute `docker exec -i`
  du CLI dans le conteneur, stdio relayés ; demandes d'autorisation, outils MCP (contexte, tâches)
  et skills fonctionnent donc sans changement. Les identifiants Claude et le jeton GitHub **du
  propriétaire de la session** sont transmis par variables d'environnement à chaque `docker exec` ;
  le `~/.claude` du conteneur est un dossier propre au projet (`WORKSPACES_ROOT/.runners/<slug>/claude-home`,
  ses conversations survivent à la recréation) et seul `~/.gitconfig` vient de l'hôte. Le
  conteneur joint le serveur Skipper par `host.docker.internal` (ponts MCP des sessions OpenCode). Le
  terminal web est un `docker exec -it … bash -l`. Le conteneur démarre à la demande et se pilote depuis la
  page du projet (démarrer, arrêter, recréer). Il est lancé avec `--init` (processus init en PID 1, sinon
  `sleep infinity` laisse s'accumuler des processus zombies à chaque commande d'agent ou lancement de
  Chromium) et porte un label `skipper.spec` : le JSON de sa configuration de création (image et
  identifiant de l'image, `--init`, limites, utilisateur, montages, tmpfs, commande ; `runners/spec.ts`).
  `runnerStatus` compare ce label à la configuration attendue aujourd'hui et à l'image locale :
  `outdated` et `outdatedReasons` (« option --init ajoutée », « image reconstruite le … », « montage
  ~/.claude ajouté », « conteneur créé avant le suivi de sa configuration »…) ; la page du projet affiche
  alors un badge « à recréer » avec les raisons. Un conteneur obsolète est **recréé de lui-même** : au
  démarrage du backend (rien n'y tourne encore), puis par `ensureReady` dès que le projet est inactif
  (aucune session dont le processus tourne, aucun terminal ouvert) ; sinon il reste signalé jusqu'au
  clic « Recréer ». **Recréer** et **Arrêter** (`runners/lifecycle.ts`) interrompent d'abord proprement
  les sessions du projet qui tournent (statut `interrupted`, sans erreur, événement `system` de raison
  `runner_reset` ou `runner_stop`, demandes expirées) : leur processus meurt avec le conteneur et cette mort
  ne doit pas passer pour un manque de mémoire (code 137). Après « Recréer », le nouveau conteneur est
  démarré aussitôt et **toutes** les sessions interrompues sont reprises (celle qui travaillait reprend
  son tour, celle qui attendait retrouve sa conversation ouverte), avec une instruction qui explique la
  recréation ; une reprise impossible laisse la session interrompue, avec l'explication dans son
  transcript. Après « Arrêter », elles restent interrompues (bouton « Reprendre »). Les terminaux
  ouverts sont fermés. La carte compte aussi les processus zombies du conteneur (`docker top`), à titre de
  diagnostic : un conteneur recréé avec `--init` n'en a pas.

- **Mémoire et CPU des conteneurs** (`runners/stats.ts`, `runners/monitor.ts`) : `Project.containerStats`
  lit le cgroup v2 du conteneur par un `docker exec` (`memory.current` moins `inactive_file`, comme
  `docker stats` ; `memory.max`, swap, `cpu.max`, deux lectures de `cpu.stat` à 0,5 s d'écart,
  pression CPU `cpu.pressure` (PSI `some`, moyenne sur 60 s : part du temps où un processus attendait
  le processeur), compteur `oom_kill` de `memory.events`) et liste les processus `claude` avec leur mémoire. Chaque CLI
  de session reçoit `SKIPPER_SESSION_ID` (transmis par le script de relais) : un processus est ainsi
  relié à sa session, et les commandes qu'il lance (même variable héritée) sont comptées avec elle. Mesure
  en cache 4 s. La carte « Environnement d'exécution » de la page projet l'affiche toutes les 10 s
  (jauges, processus par session avec leur activité, processus orphelins) ; un administrateur y
  modifie les limites, appliquées à chaud par `docker update` (swap = 2 × mémoire, comme `docker run`)
  comme depuis le formulaire du projet. Toutes les 30 s, la surveillance mesure chaque conteneur : au-delà
  de 90 % de la limite pendant plus d'une minute, notification `container.memory_high` au projet
  (réarmée sous 80 %) ; pression CPU au-dessus de 50 % pendant plus de cinq minutes, notification
  `container.cpu_saturated` (réarmée sous 25 %). Par défaut un conteneur n'a pas de plafond CPU
  (`SKIPPER_RUNNER_CPUS` vide ; `runner_config.cpus` en fixe un) : les cœurs du serveur sont partagés
  équitablement, et la carte affiche la pression CPU plutôt qu'un taux par rapport à un plafond. À la fin d'une session en erreur, `containerMonitor.explainFailure` regarde le
  code 137 (SIGKILL), la hausse de `oom_kill` depuis la dernière mesure et `State.OOMKilled` : l'erreur
  du transcript et de la notification devient « le conteneur du projet a dépassé sa limite mémoire… »,
  suivie du détail d'origine.

- **Navigateur headless** (option « Navigateur headless pour les agents » du projet,
  `runner_config.browser`) : au début de chaque session, Skipper lance un Chromium sans fenêtre dans
  le conteneur (`docker exec -d`, profil jetable dans `/tmp/skipper-session-<id>-browser/`, port CDP
  choisi par Chromium et lu dans `DevToolsActivePort`), puis déclare un serveur MCP Playwright
  (`@playwright/mcp`) sous le nom `playwright`, attaché à ce Chromium par `--cdp-endpoint`. C'est le
  CLI qui lance ce serveur, et le CLI tourne dans le conteneur : la commande est donc directement
  `playwright-mcp` (image `skipper-runner` : Playwright et Chromium sont dans `/opt/ms-playwright`),
  sans `docker exec`. En fin de session, Chromium est arrêté et son dossier supprimé. Sa configuration passe
  sur la ligne de commande du CLI et ne contient aucune variable d'environnement du backend. Les
  outils d'observation (instantané de la page,
  capture d'écran, console, réseau, attente) sont autorisés d'office ; navigation, clics et saisies
  passent par les demandes d'autorisation, avec « toujours » possible. Les captures vont dans
  `.playwright-mcp/` du dossier de travail. Compter 300 à 500 Mo de mémoire par session.

- **Vue en direct du navigateur** (`backend/src/browser/`) : dès que l'agent a utilisé un outil
  `mcp__playwright__*`, une entrée « Navigateur » apparaît sous la session dans la sidebar
  (`Session.browserActive`) ; elle ouvre `/sessions/<id>/browser`, qui affiche en direct l'onglet
  que pilote l'agent (URL, titre, nombre d'onglets), en lecture seule. Le navigateur n'écoute que sur
  la boucle locale du conteneur : le backend s'y relie par un tunnel `docker exec -i … node` (relais
  TCP ↔ stdio) et utilise le screencast CDP (`Page.startScreencast`) : Chromium n'envoie une image
  JPEG (≈ 10 Ko) que lorsque la page change. Les images passent par le WebSocket `/browsers/<session>`
  (cookie de session, membre du projet). La connexion CDP n'existe que tant que quelqu'un regarde
  (fermée 10 s après le départ du dernier spectateur) ; la vue suit l'onglet le plus récent. Ce que
  l'agent saisit dans un champ texte ordinaire est visible dans la vue, y compris la valeur d'un
  secret de site web (un champ mot de passe reste masqué).

**Arrêt et redémarrage du backend.** À la réception de SIGINT / SIGTERM, le backend note d'abord,
de façon synchrone, qu'il s'arrête : pm2 envoie le signal à tout l'arbre de processus, les agents
meurent donc en même temps que lui et la fin de leur flux ne doit pas passer pour une erreur. Les
sessions en cours passent alors à `interrupted` (ni `exitCode` ni erreur, `activity` conservée :
`busy` si l'agent était au milieu d'un tour), avec l'événement `system` « Session interrompue par un
redémarrage du serveur » dans le transcript ; leurs demandes en attente passent à `expired`, leurs
flux sont fermés, et aucune notification n'est émise. L'arrêt est borné à 1,2 s (pm2 tue le
processus au bout de 1,6 s par défaut). Au démarrage suivant, ce qui est encore `running` en base
(arrêt brutal) passe de même à `interrupted`, les demandes en attente à `expired` et les terminaux à
`closed`. Une session interrompue reprend sa conversation au prochain message, ou avec le bouton
**Reprendre** de sa page (barre d'état et en-tête déplié ; aussi sur l'accueil) (`resumeSession`) :
l'agent reprend son tour avec une instruction qui explique la coupure s'il travaillait, sinon la
conversation est rouverte et il attend la suite. L'instruction nomme la cause (redémarrage du serveur,
ou environnement d'exécution du projet recréé ou arrêté), mémorisée par le serveur pour les sessions
qu'il a lui-même interrompues ; après un redémarrage, la cause est le redémarrage. Le provider distingue
un flux fermé par le serveur (`RunResult.closedByServer`) d'un agent qui s'est arrêté au milieu d'un
tour (erreur).

**Paramètres → Serveur.** Le **mode maintenance** (mémoire seulement, levé par le redémarrage)
refuse tout démarrage de session (création, relance par un message, tâche confiée à un agent ;
erreur `MAINTENANCE`) et affiche le nombre de sessions encore actives, au travail ou en attente,
pour choisir le moment du redémarrage. La **reprise automatique** (activée par défaut, désactivable) relance au
démarrage les sessions interrompues au milieu d'un tour depuis moins d'une heure, trois au plus, avec
une instruction qui explique la coupure et signale que les demandes en attente ont été annulées (elles
ne sont pas rejouées : l'agent refait l'action s'il en a encore besoin). Les sessions qui attendaient
des instructions restent interrompues, sans occuper de mémoire, jusqu'au prochain message.

**Santé et sessions simultanées** (Paramètres → Serveur, `backend/src/health/service.ts`). Le bloc
**Santé** (query `serverHealth`, administrateurs) montre la mémoire disponible et le swap
(`/proc/meminfo`), la charge, les sessions en cours et en file, les terminaux ouverts, les processus du
CLI Claude (`ps`, conteneurs compris) avec leur mémoire, l'état de Docker et des conteneurs `skipper-*`
(`docker stats`), l'espace libre du disque des workspaces et la taille de chaque dossier (`du`, mesuré
en tâche de fond et gardé 10 minutes). Réglages (clé `server` de `app_settings`) :

- **Sessions simultanées au maximum** (`maxConcurrentSessions`, 0 : illimité), et par projet
  (`runnerConfig.maxSessions`, options avancées du formulaire). Toute session qui démarre passe par
  `sessionService.start` : lancement à la main, tâche confiée à un agent, planification, session lancée
  par un agent, relance par un message, reprise. Sans place libre, elle passe à `queued`
  (`queued_at`, et `queued_start` garde l'instruction de démarrage, donc la file survit à un
  redémarrage) avec un événement qui explique la limite atteinte. À chaque fin de session (et chaque
  minute, et quand une limite est relevée ou la maintenance levée), la file est servie dans l'ordre
  d'arrivée ; une session bloquée par la limite de son projet laisse passer celles des autres projets.
  Les places sont comptées en mémoire, réservées sans `await` entre la vérification et la réservation.
  Envoyer un message à une session en file est refusé (`SESSIONS_LIMIT`) ; l'arrêter la retire de la
  file. Une échéance planifiée d'une session déjà en file est ignorée. Au démarrage du serveur, la file
  est servie avant la reprise automatique.
- **Terminer une session inactive après** N minutes (`idleSessionTimeoutMinutes`, 60 par défaut, 0 :
  jamais) : une session en cours dont l'agent attend des instructions depuis ce délai est terminée
  proprement (`end`), sans notification, avec un événement `idle_timeout` dans le transcript ; sa place
  revient à la file. Un message la reprend.
- **Alerte mémoire** (`memoryAlertThresholdMb`, 200 Mo par défaut, 0 : jamais) : vérifiée chaque
  minute, une notification `server.memory_low` réservée aux administrateurs est émise au passage sous
  le seuil, puis plus rien tant que la mémoire n'est pas remontée à 1,5 fois le seuil.

`node-pty` a besoin que son binaire `spawn-helper` soit exécutable : le script `postinstall` s'en charge.

## Interface

Disposition façon Cursor (`frontend/src/workbench/`) : à gauche une sidebar avec les menus (Accueil,
Projets, Sessions, Tâches, Demandes, Pages, Coffre…) et un explorateur des projets ; à droite un
panneau à onglets. L'unité de navigation est la **session** : chaque session de premier niveau forme une
carte dans la sidebar (son état, sa tâche liée, l'icône de sa branche colorée selon l'état de la pull
request, « absent » si son dossier manque) avec des pastilles pour son navigateur, ses sous-agents qui
réclament l'attention et ses terminaux ; les sous-agents (sessions lancées par son agent) sont rangés
sous elle. Une session ouverte occupe **un seul onglet** dans la barre du haut (clé `/sessions/:id`,
`workbench/workspaces.ts`), et une **sous-barre** liste la session, son navigateur, ses fichiers
(`/sessions/:id/files`) et ses terminaux (`WorkspaceTabs`). Le checkout principal ne garde une carte
(« principal ») que pour les sessions et terminaux d'avant les work sessions. Les
pages restent montées quand on change d'onglet (React 19 `<Activity>`), les onglets ouverts sont
mémorisés dans le navigateur, un onglet fermé se rouvre (Alt+Maj+T), et la sidebar se replie. Le filtre
« Mes sessions / Tout le monde » cache les sessions des autres ; les pastilles portent les initiales de
leur auteur. Menu « ⋮ » d'une session : ouvrir, fichiers, nouveau terminal, arrêter, renommer,
archiver, supprimer. **Recherche** (⌘K ou Ctrl+K, `search`) sur les projets, sessions (nom et
conversation), tâches, pages et éléments du coffre ; **raccourcis** listés par « ? »
(`lib/shortcuts.ts`). Le panneau de droite a deux onglets : **Tâche** (la tâche liée à la session,
modifiable) et **Git** (état, branche comparée à sa base avec diff par fichier, commits, PR).
Les listes ne se rafraîchissent plus quand l'onglet du navigateur est caché (`usePollingQuery`).

Fluidité (30/10/2026) : le fil d'une session (`lib/sessionEvents.ts`) ne change d'état qu'à l'arrivée d'un
événement ou d'un brouillon différent, et garde son curseur quand l'onglet du workbench est caché (pas de
rechargement de l'historique au retour) ; le transcript mémoïse ses nœuds (`useMemo`) et `Markdown` est
mémoïsé : pendant qu'un agent écrit, seul le bloc « en direct » est re-rendu. Les pages lourdes ou rares
(éditeurs CodeMirror, terminal xterm, workflows, réglages, coffre…) sont chargées à la demande (`lazy` dans
`App.tsx`) : le bundle principal passe de 2,4 Mo à 1,1 Mo. Côté backend, les résolveurs de champ appelés une
fois par objet (propriétaire, work session, projet, tâche, demandes en attente) passent par des chargeurs
groupés par requête (`graphql/loaders.ts`, `loadersOf(ctx)`) : la sidebar coûte quelques requêtes SQL par
relevé au lieu de plusieurs centaines ; une opération GraphQL de plus de 500 ms est journalisée en `warn`
(`operationTimingPlugin`, toutes en `debug`). nginx compresse bundles et réponses GraphQL et sert en HTTP/2
(voir DEPLOY.md).

**Tableau de bord** (page d'accueil, `frontend/src/pages/DashboardPage.tsx`) : ce qui attend
l'utilisateur sur l'ensemble de ses projets. Quatre tuiles (demandes en attente, agents au travail
et en attente d'instructions, tâches ouvertes avec les retards, consommation du mois avec le
plafond), puis la liste « À traiter » (demandes, sessions qui attendent des instructions, sessions
en erreur depuis 24 h), les agents au travail, les tâches à surveiller (urgentes, hautes, en retard
ou à échéance proche), la consommation (par jour sur 30 jours, sessions les plus coûteuses du
mois), l'activité récente et une ligne par projet (espace personnel compris). Tout vient de la query `dashboard`
(`backend/src/dashboard/service.ts`), agrégée en SQL et restreinte aux projets de l'utilisateur ;
la page se rafraîchit toutes les dix secondes. En tête, la **zone de chat** (`components/ChatComposer.tsx`) :
une question, le mode d'autorisation et le modèle, et un chat de l'espace personnel s'ouvre sur sa page
(voir « Espace personnel et chats »). Sur mobile, le tableau des projets devient une
liste de cartes. Sans projet, la page redevient le parcours d'accueil en trois étapes, sous la zone de chat.

Sur les pages d'un projet ou d'une session (projet, session, terminal, fichiers, tâches, contexte),
un **panneau git** à droite (`frontend/src/workbench/GitPanel.tsx`) montre la branche courante et son
avance/retard, les fichiers indexés et modifiés (clic : diff coloré ; boutons indexer, désindexer,
abandonner), une zone de commit, les branches (bascule, création) et l'historique (clic : diff du
commit), avec fetch, pull et push. Backend : `backend/src/git/service.ts` (queries `gitStatus`,
`gitDiff`, `gitCommitDiff`, `gitBranches`, `gitLog` ; mutations `gitStage`, `gitUnstage`,
`gitDiscard`, `gitCommit`, `gitFetch`, `gitPull`, `gitPush`, `gitCheckout`).

**Pull requests GitHub** (section du panneau git, `backend/src/git/pullRequests.ts`), pour un projet
dont le dépôt est sur GitHub, avec le compte GitHub de la personne qui agit (Paramètres → GitHub ;
compte choisi d'après le propriétaire du dépôt, sinon le compte par défaut) : la PR de la branche courante, ou
« Créer une pull request » (titre et description pré-remplis avec la tâche liée à la branche et les
commits, base = branche du projet sinon celle du dépôt ; la branche est poussée au besoin), puis les
autres PR ouvertes avec l'état des checks, des conflits et des revues (API GraphQL de GitHub, une
requête, cache de 20 s). La fenêtre d'une PR la fusionne (squash, commit de fusion, rebase) et
propose le nettoyage : branche distante, dossier de travail et branche locale (sessions encore ouvertes
arrêtées au choix, archivées, historique conservé, terminaux fermés), tâches liées passées à « terminée » ; le
dossier principal est ensuite mis à jour (fetch, pull s'il est sur la base). API : queries
`githubPullRequests`, `githubPullRequest`, `githubPullRequestDraft` ; mutations `createPullRequest`,
`mergePullRequest`.

**Pull requests suivies** (`backend/src/pullRequests/`, table `pull_requests`) : l'objet qui matérialise une PR
dans Skipper, rattaché au projet et le plus souvent à une **tâche**, pour suivre ce qui est à fusionner, à
déployer, déployé ou annulé sans dépendre de GitHub à chaque affichage. Il porte le numéro, l'URL, le titre,
les branches, le **statut** (ouverte, fusionnée, fermée), le brouillon, un instantané GitHub (checks, revue,
conflits) rafraîchi à la synchronisation, une **note** libre, et le **déploiement** (`deployed_at`, par qui,
note). L'**étape** en découle : *brouillon*, *à fusionner*, *à déployer* (fusionnée, pas encore en production),
*déployée*, *annulée*. Il naît de trois façons : une session d'agent (outils `tasks.pr_open`, qui pousse la
branche courante et ouvre la PR sur GitHub avec le compte de la personne qui pilote la session, soumis à son
autorisation ; `tasks.pr_register`, qui déclare une PR ouverte par un autre moyen ; `tasks.pr_update` tient à jour
statut, note et déploiement ; `tasks.pr_list` liste par étape ; `tasks.get` montre les PR d'une tâche), l'interface
(création ou fusion depuis le panneau git, bouton « Suivre une PR » de la page des pull requests ou de la fiche
d'une tâche), ou la **synchronisation** (`trackedPullRequestService.sync`, à l'affichage de la page d'un projet, au
plus toutes les 30 s, forçable par « Rafraîchir ») qui recopie l'état GitHub des PR suivies, notifie une fusion ou
une fermeture faite ailleurs (`pull_request.merged`, `pull_request.closed`) et adopte les PR ouvertes du dépôt sur la
branche d'une tâche ou d'une work session. Un agent qui ouvre ou déclare une PR déclenche `pull_request.opened`.
Interfaces : onglet **Pull requests** d'un projet (`/projects/:id/pull-requests`, groupes par étape, filtres « À
traiter » / par étape / texte, menu d'actions : détail et fusion, déploiement, statut, note, détacher, ne plus
suivre), carte **Code** de la fiche d'une tâche, colonne PR de la grille et cartes du kanban (PR suivies d'abord, PR
GitHub en direct sinon), section « Pull requests à traiter » du tableau de bord (à fusionner, puis à déployer).
API : query `pullRequests(projectId, taskId, status, stage, limit)`, `pullRequest(id)`, `Task.pullRequests`,
`Dashboard.pullRequests` et compteurs `openPullRequests` / `toDeployPullRequests` ; mutations
`registerPullRequest`, `updatePullRequest`, `deletePullRequest`, `syncPullRequests`.

La page de session a un onglet **Modifications** (`frontend/src/components/SessionChanges.tsx`) : les
fichiers modifiés dans son dossier de travail depuis le début de la session, avec le nombre de lignes
et le diff coloré de chacun, un bouton pour l'ouvrir dans l'éditeur et un pour l'abandonner (retour à
l'état de départ, index et arbre de travail, sans toucher aux commits). La référence est le commit HEAD
enregistré au premier démarrage (`sessions.base_commit`), donc les commits faits par l'agent sont inclus ;
sans ce commit (session plus ancienne, commit disparu), la comparaison se fait avec HEAD ; dans un
dossier sans git, la liste vient des dates de modification, sans diff. La liste se recharge après
chaque résultat d'un outil Edit, Write ou Bash de la session. Backend : `backend/src/sessions/changes.ts`
et `gitService.changesSince` / `diffSince` / `restoreFromBase` (queries `sessionChanges`,
`sessionFileDiff` ; mutation `discardSessionFile`).

Thème sombre inspiré de Claude Code (`frontend/src/theme.css`). La page de session
(`frontend/src/components/Transcript.tsx`) reproduit son affichage : instructions préfixées par `>`,
réponses `⏺`, appels d'outils `⏺ Outil(arguments)` (`Bash(commande)`, `Update(fichier)`,
`Search(pattern: "x")`, `serveur - outil (MCP)(...)`) suivis de leur résultat `⎿` repliable : résumé
pour les lectures et recherches, diff numéroté pour les modifications, début de la sortie pour les
commandes. Les chemins sont relatifs au dossier de travail ; les messages internes des sous-agents
sont résumés sur l'appel qui les lance ; les autorisations accordées ne laissent pas de trace (un
refus apparaît comme l'erreur de l'outil). Pour rester lisible, les étapes d'un tour sont **repliées
en une ligne** (`⏺ 12 étapes · Read ×4 · Bash ×5`, dépliée au clic) : seuls le dernier message de
l'agent et ses questions restent en vue ; pendant un tour, la ligne nomme l'étape en cours. Une
commande sortie en code non nul avec une sortie est un avertissement (code en jaune), pas une erreur.
Côté serveur, `sessions/providers/claudeNoise.ts` n'enregistre pas les messages du SDK sans intérêt
pour l'historique (progression des outils, compteurs). « Afficher les détails techniques » montre
chaque étape et ajoute les lignes de service : démarrage, demandes d'autorisation, audit des
connexions, erreurs brutes. Les événements
sont chargés par pages puis au fil de l'eau (`frontend/src/lib/sessionEvents.ts`, curseur `after`) :
seuls les nouveaux sont demandés à chaque relevé. La réponse en cours d'écriture s'affiche avant d'être
complète : le provider Claude reçoit les événements de streaming du SDK (`includePartialMessages`), en
reconstitue le texte en mémoire (`sessions/live.ts`, jamais journalisé) et l'expose en `Session.liveDraft`,
relevé avec les événements toutes les 400 ms tant que l'agent écrit (1,5 s sinon) ; le transcript le montre
en bas avec un curseur, puis le message journalisé le remplace. Prompts d'autorisation et questions à
options numérotées (chiffres, flèches et Entrée au clavier), zone de saisie `>` en bas avec Entrée
pour envoyer, échap pour interrompre, flèche haut et flèche bas pour reprendre une instruction déjà
envoyée. La barre d'état propose deux listes déroulantes pour changer le modèle et les autorisations
de la session, y compris pendant qu'elle tourne.

Aucune alerte native du navigateur (`window.alert`, `confirm`, `prompt`) : les confirmations, saisies
courtes et messages d'erreur passent par les modales de `frontend/src/components/Dialogs.tsx`
(`useDialogs()` → `confirm`, `prompt`, `alert`, `showError`, toutes asynchrones, fournies par
`DialogProvider` dans `App.tsx`). Une confirmation peut porter une case à cocher (« Supprimer aussi la
branche locale »).

## Mobile

Sous 768 px (`workbench.css`, `terminal.css`) : la sidebar devient un tiroir ouvert par le bouton
menu de la barre du haut et refermé à chaque navigation ; les onglets défilent sans barre de
défilement (ombres de débordement, onglet actif ramené en vue, menu listant tous les onglets) ; les
en-têtes de page passent à la ligne ; la page de session a un bouton d'envoi ; sur écran tactile les
actions au survol de l'explorateur sont toujours visibles et les cibles sont agrandies.

## Application installable (PWA)

Skipper s'installe sur l'écran d'accueil d'un téléphone (Android : fenêtre d'installation ou
bouton « Installer l'application » en bas de la sidebar ; iPhone : Safari, Partager, « Sur l'écran
d'accueil ») et comme application de bureau (Chrome, Edge). `vite-plugin-pwa` (`vite.config.ts`)
génère le manifeste (`manifest.webmanifest`, icônes `frontend/public/icon-*.png` et
`apple-touch-icon.png`, produites depuis la rose des vents) et un service worker qui met en cache la
coquille de l'application et se met à jour seul ; l'API GraphQL, les WebSockets des terminaux et
l'authentification ne passent jamais par le cache. `frontend/src/lib/pwa.ts` enregistre le service
worker et garde l'événement d'installation d'Android pour le bouton. En mode plein écran, les zones
sûres d'iOS sont respectées (`env(safe-area-inset-*)`). Sur écran tactile, aucun champ ne reçoit le
focus automatiquement (`frontend/src/lib/device.ts`) : le clavier virtuel ne s'ouvre qu'au toucher.

## Identité visuelle

Le pictogramme est une rose des vents à huit pointes, héritière de l'astérisque ✻ de Claude Code,
pointe nord en couleur d'accent (`#d97757`). Composant React `frontend/src/components/Logo.tsx` ;
fichiers SVG dans `frontend/public/` : `favicon.svg` (pastille sombre), `logo-mark.svg` (fond
sombre), `logo-mark-dark.svg` (fond clair), `logo-mark-mono.svg` (masque CSS, utilisé devant les
titres `h1`). Mot-symbole : « Skipper » en Fraunces 600 pour les supports hors interface.

## Tâches et branches

« Confier à un agent » lance la session dans le **dossier de la tâche** : créé à sa première
session — dossier `task-<slug du titre>`, et branche `task/<slug>` à partir du checkout principal pour un
projet git (`backend/src/tasks/launch.ts`, suffixe numérique si le nom existe déjà) —, puis repris
par toutes ses sessions suivantes (colonne `worksessions.task_id`, restauré s'il était archivé) ; la
session précédente de la tâche, si elle est encore active, est arrêtée et archivée (une seule session par
dossier), ce que la modale annonce. La tâche affiche sa branche (colonne `tasks.branch`, conservée après
suppression du dossier) et sa pull request GitHub avec ses checks et revues ; un clic ouvre la fenêtre de
fusion. Cycle complet sans quitter Skipper : tâche → session sur sa branche → PR (panneau git) → fusion →
nettoyage du dossier et de la branche.

Une tâche porte aussi un **responsable** et un **rapporteur** (membre du projet, ou nom et/ou e-mail libres ;
une nouvelle tâche est rapportée par et assignée à sa créatrice ou son créateur), une **étiquette d'état**
(court libellé de l'avancement dans le statut, « en revue », « bloquée »…, affiché dans la pastille du statut
et tenu à jour par la session en charge), des **étiquettes** libres (filtre de la liste, `?tag=` de l'API),
des **champs personnalisés** (clé → valeur), des **fichiers joints** (captures collées ou fichiers déposés
dans la description ou un commentaire ; `WORKSPACES_ROOT/.task-attachments/`, route
`/api/task-attachments/<tâche>/<id>` ; la session à qui l'on confie la tâche les reçoit avec sa consigne,
`tasks.get` montre les images) et des **commentaires** (humains ou agents, via l'outil `tasks.comment`).
Les **consignes des sessions de tâches** du projet (fiche du projet) sont ajoutées après le texte de la tâche
dans l'instruction de toute session qui la réalise. Une tâche se **déplace** dans un autre projet (sa session
et sa branche restent dans l'ancien).
Chaque tâche a sa page (`/tasks/:id`). La liste des tâches (`/tasks`, `/projects/:id/tasks`) est par défaut une
**grille** (`components/TaskGrid.tsx`, logique pure dans `lib/taskTable.ts`) : une tâche par ligne, toujours sur une
seule ligne, colonnes que l'on réordonne (glisser l'en-tête), redimensionne (poignée, double clic pour la largeur par
défaut), trie et choisit (bouton « Colonnes », avec flèches pour l'ordre), filtres par colonne sous les en-têtes
(texte sans accents ni casse, listes pour statut, priorité, échéance, origine, projet) ; la disposition est mémorisée
dans `localStorage` (`skipper.tasks.table.v1`). Le kanban reste disponible (filtres de la barre d'outils : priorité,
responsable, rapporteur, étiquette), ainsi que « mes tâches ouvertes » et « voir les annulées » dans les deux vues. La session en charge d'une tâche reçoit les changements faits par d'autres
(`[Mise à jour de la tâche]`) et les nouveaux commentaires (`[Commentaire sur la tâche]`, qui relancent
une session terminée) ; son historique de sessions est conservé (`task_sessions`). « Confier à un agent »
montre la consigne envoyée à l'agent et permet de la modifier avant le lancement. Une **API REST**
(`/api/v1/tasks`, clés `skp_…` créées sur la fiche du projet, haché en base) permet à un outil externe de
lister et créer des tâches.

## Lancer des sessions

**Depuis l'interface.** « Nouvelle session » (sidebar, pages Projets, Sessions, projet, accueil) ouvre la
modale `frontend/src/components/SessionLauncher.tsx` (fournie à toute l'application par
`SessionLauncherProvider` dans le layout), qui pose une seule question : « que voulez-vous faire ? ». La
session reçoit son propre dossier de travail ; pour un projet git, la branche nommée d'après la consigne
est affichée sous la zone de texte, modifiable avec son point de départ. Type d'agent, modèle et
autorisations sont des options repliées. Sans consigne, la session est créée sans démarrer. Côté API,
`CreateSessionInput.newWorksession { name, branch, label, baseRef }` (ou `worksessionId`, pour une work
session existante et libre) est **obligatoire** : la work session est créée puis la session dans la même
mutation (la work session est retirée si la session ne peut pas être créée) ; sans nom, branche ni
libellé, elle est nommée d'après la consigne (`backend/src/worksessions/names.ts`, miroir côté front dans
`frontend/src/lib/worksessions.ts`). `createTerminal` exige aussi un `worksessionId` : l'interface ouvre
les terminaux depuis le menu d'une session, dans son dossier.

**Fichiers joints.** La consigne (modale de lancement) comme toute instruction envoyée ensuite (zone de
saisie de la session) peut être accompagnée de fichiers : bouton trombone, collage d'une image depuis le
presse-papiers (capture d'écran) ou dépôt dans la zone de texte. Limites : 10 fichiers, 10 Mo par fichier,
12 Mo par instruction, envoyés en base64 dans la mutation GraphQL (`AttachmentInput`). Le backend
(`backend/src/sessions/attachments.ts`) les enregistre dans `WORKSPACES_ROOT/<slug>.attachments/<session>/<id>/<nom>`
(dossier monté au même chemin dans le conteneur du runner docker) et complète l'instruction avec la liste
des fichiers et leur chemin, lisibles par l'agent avec `Read` ; les images (png, jpeg, gif, webp jusqu'à
5 Mo) et les PDF (jusqu'à 10 Mo) sont en plus transmis au modèle comme blocs `image` / `document`. Les
métadonnées sont conservées (`Session.promptAttachments` pour la consigne, payload `attachments` de
l'événement `instruction` ensuite) et le transcript les affiche (vignettes, liens) via la route
`GET /api/attachments/<session>/<id>` (cookie de session, accès au projet requis). Supprimer la session
supprime ses fichiers. Une instruction sans texte mais avec des fichiers reçoit le texte « Voir les
fichiers joints. ».

**Depuis un agent.** Chaque session Claude reçoit deux serveurs MCP supplémentaires, décrits dans son
prompt système :

- `worksessions` : `list` (dossiers de travail avec libellé, branche, commit et sessions en cours),
  `create(name?, branch?, label?, base_ref?)`, `delete(name, delete_branch?)`. Lister et créer sont toujours
  autorisés ; supprimer passe par la demande d'autorisation habituelle.
- `sessions` : `list`, `get(id)` (état et dernière réponse de l'agent), `create(prompt, name?,
  worksession? | new_branch?, base_ref?, permission_mode?, model?)` (même provider et même configuration
  que la session appelante par défaut ; sans `worksession` ni `new_branch`, une nouvelle work session nommée
  d'après la consigne ; `worksession` doit être libre : une work session n'héberge qu'une session active,
  jamais celle de l'appelant), `wait(id, timeout_seconds?)` (attend la fin du tour, 120 s par
  défaut, 600 s au plus, à rappeler si l'agent travaille encore), `send(id, text)`, `end(id)`. Un agent
  ne peut envoyer une instruction ou terminer que les sessions qu'il a lancées. `create` et `send`
  consomment du budget : ils passent par la demande d'autorisation (mode « me demander »), ou sont
  pré-autorisables avec `mcp__sessions` dans les outils autorisés de la session ; les autres outils
  sont libres.

Garde-fous (`backend/src/sessions/service.ts`) : une session lancée par un agent reste dans le projet de
l'agent, l'imbrication est limitée à deux niveaux (humain → agent → agent → stop), et au plus trois
sessions lancées par une même session tournent en même temps. Une session lancée par un agent déclenche
une notification `session.created`. Dans l'interface ces sessions sont des **sous-agents**, identifiables d'un
coup d'œil : dans la sidebar (et la sous-barre d'un dossier), une session parente porte un compteur
« robot N » et ses sous-agents sont repliés derrière une ligne « N sous-agents » (dépliée d'office quand on
est sur l'un d'eux ou qu'un sous-agent attend une réponse) ; dépliés, ils apparaissent indentés, reliés par
└ et marqués d'un robot ; un sous-agent dont la parente est dans un autre dossier reste au premier niveau avec
son robot. La page d'un sous-agent s'ouvre par un bandeau « Sous-agent · lancée par l'agent de la session
« … » » avec l'état de la parente et un bouton vers elle ; celle de la parente liste ses sous-agents avec leur
état, un lien et de quoi les terminer (`Session.parentSession`, `Session.childSessions`). Dans le transcript,
les identifiants de session cités par les outils `sessions` (dont celui renvoyé par `create`) sont des liens.
Rien ne change pour les sessions lancées par un humain.

## Espace personnel et chats

Chaque personne a un **espace personnel** (`backend/src/personal/`) : un projet ordinaire en base
(`projects.personal_owner_id`, un par personne, index unique), sans dépôt git, nommé « Espace
personnel », dossier `WORKSPACES_ROOT/moi-<partie locale de l'e-mail>`, créé à la première demande
(query `personalSpace`, route `/me` qui redirige vers `/projects/:id`). La personne en est l'unique
membre (administratrice) ; il ne se partage pas (`inviteProjectMember`, `updateProjectMemberRole`,
`removeProjectMember` et `deleteProject` le refusent), un super administrateur n'y a **pas** accès
(`roleFor` ne lui accorde pas le rôle administrateur sur l'espace personnel d'un autre), et il
n'apparaît pas dans la liste des projets (`projects(includePersonal: true)` pour l'obtenir, ce que fait
la modale de lancement) mais en tête de la sidebar (« Mon espace ») et dans le tableau de bord. Ses
pages sont celles d'un projet (`ProjectHeader` en mode personnel : Aperçu, Chats, Tâches, Contexte,
Coffre, Historique ; ni membres, ni clés d'API, ni suppression), avec son conteneur, les dossiers de ses
sessions (simples dossiers), sa bibliothèque de contexte et ses tâches. Les tâches et sessions de l'espace
figurent dans les listes globales (Tâches, Sessions) comme celles d'un projet.

**Portée d'une session personnelle** (`personal/scope.ts`). Toute session (ou chat) de l'espace
personnel reçoit une `ProjectScope` : les projets dont la personne est membre, résolus par nom,
dossier ou identifiant, avec ses droits (lecture dès le rôle lecteur, écriture à partir du rôle
membre). Les serveurs MCP `sessions`, `tasks` et `worksessions` acceptent alors un paramètre
`project` sur leurs outils de liste et de création (`withProjectParam` : le schéma des sessions
ordinaires ne change pas), et leurs outils par identifiant (`get`, `wait`, `update`, `claim`,
`comment`…) atteignent les objets de tous les projets de la portée ; un serveur `projects` (`list`,
`get`, lecture seule, toujours autorisé) décrit les projets et leur activité. Le prompt système
décrit la portée et liste les projets (`personalService.promptSummary`). Garde-fou côté service :
`sessionService.create` n'accepte une session lancée par un agent dans un autre projet que si la session
parente appartient à un espace personnel et que son propriétaire a le rôle membre sur le projet visé ;
la session créée appartient à cette personne et travaille avec ses comptes, dans une nouvelle work
session du projet par défaut.

**Chats.** Un chat est une session de l'espace personnel avec `sessions.kind = 'chat'` (migration
`040_personal_spaces.sql`) : même transcript, mêmes demandes d'autorisation, même coût relevé, mais
sans dossier de travail (`worksessionId` null, dossier = celui de l'espace) et **sans conteneur** :
le provider Claude lance le CLI du serveur (`CLAUDE_BIN`, sinon celui du SDK, comme la vérification des
identifiants) avec `tools: []` (aucun outil intégré : ni fichiers, ni commandes, ni web), `settingSources: []`
(aucun réglage lu sur le disque), un dossier de configuration propre à l'espace
(`CLAUDE_CONFIG_DIR = WORKSPACES_ROOT/.runners/<slug>/chat-home`, où ses conversations sont reprises) et
les serveurs MCP `context`, `tasks`, `sessions`, `worksessions`, `projects`, `vault` et `google`
(pas de `pages` ni de navigateur). Les chats sont exclus des listes de sessions (`SessionFilter.kind`,
« session » par défaut ; « all » pour une liste par identifiants ou par session parente), de la sidebar,
du tableau de bord et de la recherche ; ils se listent par `chats(limit)` (page `/chats`) et s'ouvrent
par `createChat(text, attachments, config)` (zone de chat du tableau de bord et de la page des chats :
mode d'autorisation « demander » ou « tout autoriser », modèle, fichiers joints, suggestions de départ).
La page d'un chat est celle d'une session (`/chats/:id`, `SessionDetailPage` en mode chat : pas de
panneau git, d'onglet Modifications ni de planification). Dans la sidebar, sous « Mon espace », une ligne
**Chats** ouvre la liste (et se replie) et montre les derniers chats avec leur état, un menu pour les arrêter
ou les supprimer, et un lien vers les autres (requête `Sidebar`, champ `chats`). Un chat relancé reste un chat ; l'arrêt des
sessions inactives le termine comme une session, un message le reprend.

## Sessions planifiées

Une session peut être **planifiée** : bouton « Planifier » sur sa page (`frontend/src/components/ScheduleModal.tsx`).
On choisit une fréquence simple (toutes les heures, tous les jours, du lundi au vendredi, toutes les
semaines, tous les mois, à une heure donnée) ou une expression cron à cinq champs (alias `@hourly`,
`@daily`, `@weekly`, `@monthly`), le fuseau horaire (celui du navigateur par défaut), et l'instruction
envoyée à chaque exécution. La modale montre les prochaines échéances (`scheduleNextRuns`).

À chaque échéance, l'ordonnanceur (`backend/src/schedules/service.ts`, vérification toutes les
trente secondes) envoie l'instruction à la session comme le ferait `sendSessionMessage` : une session
terminée est relancée en reprenant sa conversation, une session ouverte reçoit l'instruction. Par
défaut, la session est **terminée à la fin de chaque exécution** (option « Terminer la session à la
fin de chaque exécution ») pour ne pas garder un processus ouvert entre deux échéances. La fin d'une
exécution produit une notification `schedule.run` avec la durée et le coût (ou `schedule.failed`), et
les événements `schedule` jalonnent le transcript. « Exécuter maintenant » lance l'exécution sans
attendre l'échéance ; le compte rendu de la dernière exécution est visible dans la modale.

Garde-fous : une échéance est **ignorée** (notification `schedule.skipped`, raison dans le compte
rendu) si l'agent travaille encore ou si le plafond mensuel de budget est atteint. Le nombre de sessions
déjà en cours n'est pas limité : une échéance est lancée quel que soit ce nombre. Une planification
désactivée ne se lance pas. Les échéances manquées pendant un arrêt du serveur ne sont pas rattrapées : au
démarrage, seule une échéance de moins de dix minutes est encore exécutée, les autres sont recalculées
depuis maintenant. La réservation d'une échéance est atomique en base (`session_schedules.next_run_at`
avancé sous condition), donc une seule instance du backend l'exécute. L'analyseur cron
(`backend/src/schedules/cron.ts`) n'a pas de dépendance et gère les fuseaux IANA, changements d'heure
compris (une heure locale inexistante est sautée).

Modèle : `SessionSchedule` (`session_schedules`, une ligne par session au plus : `cron`, `timezone`,
`prompt`, `enabled`, `endAfterRun`, `nextRunAt`, `lastRunAt`, `lastResult`), exposée par
`Session.schedule` ; mutations `setSessionSchedule`, `clearSessionSchedule`, `runSessionScheduleNow`.

## Réglages et nettoyage d'une session

Bouton « Réglages » sur la page d'une session (`frontend/src/components/SessionSettingsModal.tsx`) : renommer
la session et configurer un **nettoyage automatique** de son historique, indispensable pour une session
planifiée qui tourne tous les jours. Deux réglages indépendants (`Session.cleanup`, colonne `sessions.cleanup`) :

- **Purge du transcript** : les événements de plus de N jours sont supprimés (`retentionDays`). La consommation
  enregistrée (`usage_ledger`) n'est pas touchée. Appliquée avant chaque exécution planifiée et par un balayage
  toutes les heures (`cleanupService.sweep`, lancé par l'ordonnanceur).
- **Conversation de l'agent** : **repartir d'une conversation neuve à chaque exécution planifiée**
  (`contextAction: fresh`, réglage par défaut d'une nouvelle planification : le contexte reste stable d'un jour à
  l'autre), ou, quand le contexte du modèle dépasse `contextMaxTokens`, soit **compacter** (`compact` : la
  commande `/compact` est envoyée à la session, relancée au besoin, et l'on attend la fin du tour), soit
  **repartir d'une conversation neuve** (`reset` : `externalId` remis à null, le prochain lancement ne reprend
  plus la conversation ; le transcript affiché est conservé). Appliqué avant chaque exécution planifiée ; une
  session qui attend des instructions est d'abord terminée, une session au travail est laissée tranquille (le
  nettoyage est reporté).

La modale de planification porte le même réglage (`SessionScheduleInput.cleanup`) : une nouvelle planification
part sur « nouvelle conversation à chaque exécution », une planification existante sans nettoyage affiche un
avertissement et un bouton « Activer le nettoyage par défaut » (rien n'est modifié sans l'accord de l'utilisateur ;
la migration `034` ne touche pas aux planifications existantes).

La taille du contexte (`Session.contextTokens`) est relevée par le provider Claude sur les messages assistant
(tokens d'entrée, cache compris, du dernier appel au modèle) et sur les frontières de compaction
(`compact_boundary`, `post_tokens`). Elle est **visible sans ouvrir les réglages** : jauge dans l'en-tête de la
page de session (`Session.context` : tokens, part de la fenêtre du modèle, coût approximatif de la relecture du
contexte à froid, d'après le dernier modèle facturé ; `sessions/context.ts`), pastille dans la sidebar et les
onglets au-delà du seuil de signalement. Ce seuil est **propre à chaque personne** (Paramètres › Claude ›
« Signaler le contexte d'une session à partir de », en milliers de tokens, `ClaudeSettings.contextWarnTokens`) :
150 000 tokens par défaut (`CONTEXT_WARN_TOKENS`), vide pour ne jamais être signalé. Au-delà de ce seuil, un bandeau dans l'onglet
« Session » du panneau de droite (dans la page elle-même pour un chat, qui n'a pas de panneau) propose
« Compacter » (`compactSessionContext`), « Repartir d'une conversation neuve » (`resetSessionContext`, avec ou
sans résumé des derniers échanges, transmis au modèle avec la prochaine instruction via `sessions.resume_digest`)
ou « Ignorer » (jusqu'à 50 000 tokens de plus) ; rien n'est fait automatiquement pour une session manuelle.
« Nettoyer maintenant » applique les réglages sans attendre (`applySessionCleanup`) ;
`updateSession(id, { name, cleanup })` renomme et enregistre les réglages. Les événements `cleanup` (purge,
compaction, remise à zéro, report) apparaissent dans le transcript.

## Explorateur de fichiers et éditeur

Chaque dossier de travail a une entrée « Fichiers » (`frontend/src/pages/FilesPage.tsx`) : à gauche
l'arborescence (dossiers chargés à la demande, création, renommage et suppression au survol), à droite
les fichiers ouverts dans des onglets internes mémorisés par dossier, le fichier actif étant dans l'URL
(`/…/files/chemin`). L'éditeur (`components/FileEditor.tsx`, CodeMirror 6, thème clair ou sombre) colore
selon l'extension, enregistre avec Ctrl/Cmd+S, marque d'un point orange ce qui n'est pas enregistré, et
offre pour un fichier HTML un **aperçu** rendu dans un bac à sable (`GET /api/files/view/…`, CSP
`sandbox`), le **téléchargement** et la **publication** comme page partagée. « Actualiser » recharge
l'arborescence et les fichiers non modifiés ; c'est aussi fait au retour sur l'onglet et quand l'état git
change. L'enregistrement transmet la date de modification lue à
l'ouverture : si le fichier a changé entre-temps (agent, autre onglet), le serveur refuse
(`FILE_CONFLICT`) et l'éditeur propose de recharger ou d'écraser.

Côté serveur (`backend/src/files/service.ts`), tout chemin est normalisé puis vérifié à l'intérieur
de la racine du workspace, liens symboliques résolus compris ; les fichiers de plus de 2 Mo ou
binaires ne sont pas ouverts. API : `workspaceEntries`, `workspaceFile`, `writeWorkspaceFile`,
`createWorkspaceEntry`, `renameWorkspaceEntry`, `deleteWorkspaceEntry` (arguments `projectId` et
`worksessionId` optionnel : sans lui, le dossier principal). L'explorateur d'une session est sous
`/sessions/:id/files` (`lib/files.ts` résout son dossier par la query `session`).

## Historique et archives

Une session s'**archive** (bouton sur sa page, menu de la sidebar, liste des sessions) : elle quitte la
sidebar et reste consultable, restaurable et relançable depuis l'**historique** du projet
(`/projects/:id/history`, recherche dans les noms, consignes et conversations). « Relancer » crée une
nouvelle session avec un résumé de la précédente (`<previous_conversation>`, 40 k caractères au plus).
La relance travaille dans le dossier et sur la branche de la session d'origine (restaurés si besoin ;
la session d'origine est archivée, arrêtée si elle tournait : une seule session par dossier), ou dans un
nouveau dossier si le sien a été supprimé. Archiver une session archive son dossier (terminaux fermés,
dossier et branche conservés) ; la restaurer le restaure ; un dossier disparu est recréé à la prochaine
utilisation. Une session se renomme depuis la sidebar ou ses réglages. Les mutations `archiveWorksession`,
`restoreWorksession`, `renameWorksession` et `deleteWorksession` restent dans l'API (sans interface).

## Pages partagées

Un agent (outil `pages.publish`) ou l'éditeur de fichiers publie un fichier HTML comme **page**
(`/shared/:id`, `backend/src/sharedPages/`), privée à son propriétaire jusqu'à ce qu'il la partage avec
des personnes ou l'ouvre à toute personne connectée disposant du lien. Chaque publication crée une
version ; la page est servie par `GET /api/shared/:id[?v=N][&download=1]` dans un bac à sable (CSP
`sandbox` sans `allow-same-origin` : la page ne lit ni les cookies ni l'API), l'accès étant revérifié
à chaque chargement. Être ajouté à une page envoie une notification.

## Notifications

Chaque notification vise soit tous les membres d'un projet, soit une personne (`notifications.user_id`).
La cloche propose d'activer les **notifications push** : l'appareil s'abonne (`push_subscriptions`,
clés VAPID générées au premier démarrage dans `app_settings`), le service worker (`frontend/src/sw.ts`,
`vite-plugin-pwa` en mode `injectManifest`) affiche la notification système même application fermée,
met à jour le badge de l'icône et ouvre la page concernée au clic. « Tester » envoie une notification
à tous ses appareils ; des conseils par système sont affichés quand elles sont bloquées.

## Apparence

Paramètres › Apparence : thème **Système**, **Clair** ou **Sombre**, mémorisé dans le navigateur
(`skipper.theme`), appliqué avant le premier rendu par un script de `index.html` (`data-bs-theme`),
suivi par le transcript, les terminaux (xterm) et l'éditeur (CodeMirror). Toutes les couleurs sont des
variables CSS définies pour chaque thème (`theme.css`). Les Paramètres sont ouverts à tout le monde ;
seul l'onglet Serveur est réservé aux administrateurs.

## Super administrateur

Un administrateur peut être **super administrateur** (page Utilisateurs, accordé par un super
administrateur seulement) : il administre tous les projets, membre ou non (rôle effectif `admin`,
projets listés avec un badge « non membre », recherche étendue). Les listes de membres et les sessions
« de tout le monde » restent fondées sur l'appartenance. La page Utilisateurs (`/users`) invite, change
les rôles et supprime des comptes.

## Paramètres par personne (Claude, OpenCode, GitHub)

Page « Paramètres » (menu du bas de la sidebar). Chaque personne a ses réglages (table
`user_settings`, `backend/src/settings/userStore.ts`) et ses identifiants, rangés dans son coffre
personnel comme **jetons applicatifs** (voir « Coffre ») ; les réglages ne gardent que l'identifiant de
l'élément choisi. Les réglages Claude et GitHub qu'une version antérieure gardait pour toute
l'application sont repris au démarrage dans le coffre et les réglages du premier administrateur
(`settings/legacy.ts`).

**Claude** (`settings/claude.ts`) :

- **Authentification** : deux modes. `oauth` : le jeton d'abonnement Claude de la personne, obtenu
  **depuis l'interface** (`settings/login.ts` pilote `claude setup-token` dans un pseudo-terminal, en
  extrait l'URL d'autorisation claude.com, transmet le code collé, et lit l'écran du CLI reconstitué
  par un terminal headless) et rangé dans son coffre (élément `claude`, jamais révélable, renouvelé
  par Skipper), ou un élément `claude` existant choisi dans le coffre. `api_key` : un élément `anthropic`
  du coffre (clé API collée dans le coffre). Le secret du mode actif est passé à chaque session de
  la personne via `env` (`CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY`), relu dans le coffre à
  chaque démarrage et journalisé sur l'élément ; sans identifiant utilisable, la session ne démarre pas.
- **Vérifier la connexion** : lance Claude Code sans prompt avec les identifiants du mode et lit
  `accountInfo()` (e-mail, abonnement) et `supportedModels()` ; le résultat est mémorisé
  (`claude.verification`) et alimente la liste des modèles de la personne.
- **Modèles** : modèles proposés à la création d'une session (`allowedModels`, vide = tous), modèle
  par défaut et modèle de repli. Le champ « Modèle » du formulaire de session devient une liste
  déroulante ; un modèle hors liste est refusé côté serveur.
- **Facturation** : plafond mensuel (USD, toutes les sessions de la personne), budget par défaut par
  session (`maxBudgetUsd` du SDK) et nombre d'étapes par défaut. À chaque fin de tour, le delta de
  `total_cost_usd` est enregistré dans `usage_ledger` (par session, projet et personne, ventilé par
  modèle) ; le plafond atteint bloque le démarrage des sessions et l'envoi d'instructions
  (`BUDGET_EXCEEDED`). Ce coût est une estimation au tarif API : avec un abonnement il n'est pas facturé.

**GitHub** (`settings/github.ts`, `settings/githubDevice.ts`) : une personne connecte **un ou plusieurs
comptes** (table `user_github_accounts`), par **connexion par code** (device flow de l'OAuth App
`GITHUB_CLIENT_ID`, sinon l'identifiant public du CLI GitHub ; `GITHUB_CLIENT_ID=none` la désactive) ou
en choisissant un **jeton personnel** déposé dans le coffre (élément `github`). Le jeton de chaque
compte est un jeton applicatif du coffre ; un jeton OAuth expirant est renouvelé par Skipper. Pour
chaque dépôt, le compte retenu est celui dont l'identifiant ou l'une des organisations possède le
dépôt, sinon le compte par défaut. Ce compte sert aux actions git de la personne (clone, fetch, pull,
push, création du dossier d'une session), à ses pull requests, et aux agents de ses sessions (credential helper
par variables d'environnement, jamais écrit sur disque ; identité des commits = celle du compte).

**OpenCode** (`settings/opencode.ts`) : modèle par défaut (`fournisseur/modèle`), budget par session,
et la clé de chaque fournisseur de modèles (OpenAI, Anthropic, Google, OpenRouter, OpenCode Zen,
Mistral, DeepSeek, xAI, Groq) choisie parmi les jetons applicatifs du coffre ; « Actualiser la liste
des modèles » exécute `opencode models` dans l'image Docker avec ces clés (`settings/opencodeCheck.ts`).

**Serveur** (administrateurs) : santé, sessions simultanées, mode maintenance, reprise des sessions
interrompues, limites d'utilisation de l'abonnement (voir « Modèle d'exécution »).

## OpenCode

Deuxième type de session d'agent (`backend/src/sessions/providers/opencode.ts`), au même rang que
Claude Code : mêmes options (mode d'autorisation, modèle, budget, outils pré-autorisés), même
transcript (les événements sont émis sous les types `claude.*` que l'interface sait afficher), mêmes
demandes d'autorisation et questions, mêmes outils MCP de Skipper (contexte, tâches, coffre,
worksessions, sessions, pages). Le serveur `opencode serve` tourne dans le conteneur du projet
(`docker exec`, image avec `opencode-ai` installé : reconstruire `deploy/runner`), joint par un tunnel
TCP ; ses serveurs MCP sont des **ponts** (`opencodeBridge.ts`) : Skipper écoute sur un port de l'hôte,
OpenCode lance par serveur un relais `node -e` qui s'annonce avec un jeton propre à la session, et
chaque connexion est servie par une instance neuve du serveur MCP in-process. La configuration et les
clés (`OPENCODE_CONFIG_CONTENT`, `OPENCODE_AUTH_CONTENT`, lues dans le coffre du propriétaire) ne
sont remises qu'au serveur OpenCode, et un plugin masque l'environnement aux outils de l'agent. L'état
de la conversation est reflété en base (`opencode_sessions`, `opencodeState.ts`) pour reprendre une
session après recréation du conteneur. Les décisions d'autorisation passent par les règles du projet
puis par les demandes humaines, comme pour Claude.

## Workflows

**Workflows** (`/workflows`, `/projects/:id/workflows`, `backend/src/workflows/`). Un workflow est un
**graphe** dessiné dans l'interface (canvas `@xyflow/react`, mise en page automatique) : un ou
plusieurs **déclencheurs** (manuel, avec ses **variables** déclarées — clé, libellé, obligatoire, valeur
par défaut, disponibles comme `{{input.ticket}}` ou `{{ticket | default: "…"}}` —, ou « tâche créée »
avec un filtre visuel sur la tâche), des nœuds **appel de modèle**, **tâche** (session qui traite une
tâche existante, dans le dossier de la tâche), **session** (session libre sur une branche donnée ou
propre à l'exécution — dossier repris s'il existe, sa session précédente archivée —, avec ou sans
attente du tour, terminée ou non ensuite), **créer une tâche**,
**condition** (règles visuelles imbriquées ou formule `nodes.review.json.approved and input.env ==
"prod"`, voir `expressions.ts`) et **fin** (sortie de l'exécution). Les arêtes d'une condition portent
sa branche oui / non ; un appel de modèle, une tâche, une session ou une création de tâche peuvent avoir
une branche « en cas d'erreur ». Le graphe est **validé** en continu (`graph.ts` : déclencheur absent,
arête orpheline, appel de modèle sans clé ni modèle, cycle, branches mal utilisées…) ; les erreurs
bloquent l'exécution, pas les avertissements.

**Appel de modèle** (nœud `callLlm`, `llm.ts`, `llmCall.ts`). Le nœud appelle **directement** un
modèle de langage, sans session ni outils : un **fournisseur** (proxy LiteLLM, OpenAI ou Anthropic) et la
**clé du coffre** correspondante (élément `litellm`, ou jeton applicatif OpenAI / Anthropic de la
personne), le **modèle**, la température et la longueur maximale de la réponse, un projet **Langfuse**
optionnel où tracer l'appel, des **instructions** (prompt système), le **prompt** (modèle rendu avec
`{{input.x}}` et `{{nodes.k.output}}`), une sortie **texte** ou **JSON** (forme attendue montrée au
modèle, réponse lue comme JSON dans `nodes.k.json`) et un délai (10 min par défaut). La clé est résolue
au nom du propriétaire de l'exécution ; l'enregistrement du nœud garde la sortie, le modèle qui a répondu
et les jetons consommés, le coût (rapporté par LiteLLM) s'ajoute à celui de l'exécution. Une réponse vide
ou non JSON met le nœud en échec (branche « en cas d'erreur » ou arrêt de l'exécution). Une **exécution** (`workflow_runs`) fige la définition,
avance nœud par nœud (`engine.ts`, journal détaillé, état de chaque nœud, coût cumulé, annulation),
et se lance à la main (choix du déclencheur, saisie des variables), en test, par planification
(`scheduler.ts`, toutes les 30 s), ou par une **tâche créée** dans le projet (`triggers.ts` : file
d'exécutions, au plus cinq actives par workflow, garde anti-boucle quand la tâche vient d'une session
du workflow lui-même). Les sessions ouvertes par une exécution appartiennent à la personne qui l'a
lancée (ou au propriétaire de la planification / du déclencheur) et travaillent avec ses comptes.
Notifications `workflow.run` et `workflow.failed` à la fin des exécutions.

## Ajouter un type d'agent

1. Implémenter `SessionProvider` (`backend/src/sessions/providers/provider.ts`) : `describe(ctx)` expose
   les champs de configuration au front (avec, si besoin, les réglages de la personne : modèles
   autorisés…), `start(ctx)` lance l'exécution dans `ctx.cwd` (workspace du projet), journalise via
   `ctx.emit` et sollicite l'humain via `ctx.ask` si besoin.
2. L'enregistrer dans `backend/src/sessions/providers/registry.ts`.

Le front génère automatiquement le formulaire de création à partir de `configFields`.

## API GraphQL

Toutes les opérations exigent une session (cookie), sauf `me`. Les erreurs de droits portent le code
`UNAUTHENTICATED` (pas connecté) ou `FORBIDDEN` (rôle insuffisant).

- `me` (utilisateur connecté, null sinon) ; `users` (administrateurs de l'application)
- `Project.permissionRules` ; `addProjectPermissionRule(projectId, toolName, ruleContent)`, `deleteProjectPermissionRule(id)` (membres)
- `Project.members`, `Project.myRole` ; `inviteProjectMember(projectId, email, role)`, `updateProjectMemberRole(projectId, userId, role)`, `removeProjectMember(projectId, userId)` (administrateurs du projet)
- `settings` (réglages Claude, statut d'authentification, modèles connus, consommation ; administrateurs de l'application) ; `updateClaudeSettings`, `setClaudeApiKey`, `clearClaudeOauthToken`, `verifyClaudeAuth(mode)`
- `AppSettings.server` (maintenance, sessions actives, reprise automatique) ; `setMaintenanceMode(enabled, message)`, `updateServerSettings(autoResumeInterrupted)`
- Connexion OAuth : `startClaudeLogin` (URL à ouvrir), `completeClaudeLogin(id, code)`, `cancelClaudeLogin`, `claudeLogin(id)`
- `providers` : types d'agents disponibles et leurs options
- `projects`, `project(id)` ; `createProject`, `updateProject`, `prepareProjectWorkspace`, `deleteProject`
- `sessions(projectId, status, provider, limit, offset)`, `session(id)` avec `events(after, limit)` et `requests(status)`
- `createSession(input)` (`input.newWorksession { name, branch, label, baseRef }` ou `input.worksessionId` d'une work session libre, l'un des deux obligatoire), `startSession(id)`, `stopSession(id)`, `archiveSession(id)` (avec son dossier), `unarchiveSession(id)`, `relaunchSession(id, { name, instruction })`, `deleteSession(id, deleteBranch)` (avec son dossier) ; `Session.parentSession`, `Session.childSessions`
- `sendSessionMessage(id, text, attachments)`, `resumeSession(id)`, `interruptSession(id)`, `endSession(id)`, `updateSessionConfig(id, config)` ; `CreateSessionInput.attachments` et `Session.promptAttachments` (fichiers joints, voir « Lancer des sessions »)
- `requests(status, sessionId, limit, newestFirst)` (statut à null = tout l'historique), `request(id)` ; `answerRequest(id, response)`, `cancelRequest(id)`
- `Project.contextFolders`, `Project.contextInstructions`, `Project.contextChanges(limit)`, `contextInstruction(id)` avec `versions`, `searchContext(projectId, query)`
- `createContextFolder`, `renameContextFolder`, `moveContextFolder`, `deleteContextFolder`, `createContextInstruction`, `updateContextInstruction`, `deleteContextInstruction`, `restoreContextInstructionVersion`
- `notifications(unreadOnly, limit)`, `unreadNotificationCount` ; `markNotificationRead(id)`, `markAllNotificationsRead` ; subscription `notificationCreated`
- `Project.tasks(status)`, `tasks(projectId, status, priority, limit)`, `task(id)` ; `createTask`, `updateTask`, `deleteTask`, `startTaskSession(id, provider, config)`
- `githubPullRequests(projectId, state, limit)`, `githubPullRequest(projectId, number)`, `githubPullRequestDraft(projectId, worksessionId)` ; `createPullRequest(projectId, worksessionId, title, body, base, draft)`, `mergePullRequest(projectId, number, method, cleanup)` ; `Task.branch`, `Task.pullRequest`
- Pull requests suivies : `pullRequests(projectId, taskId, status, stage, limit)`, `pullRequest(id)`, `Task.pullRequests`, `Dashboard.pullRequests` ; `registerPullRequest(projectId, url, number, taskId, note)`, `updatePullRequest(id, input { status, note, taskId, deployed, deployNote })`, `deletePullRequest(id)`, `syncPullRequests(projectId)`
- `Project.worksessions`, `worksession(id)` avec `sessions` et `terminals` ; `createWorksession(projectId, branch?, name?, baseRef?, label?)`, `deleteWorksession(id, deleteBranch)` ; `CreateSessionInput.worksessionId`, `createTerminal(..., worksessionId)` (API technique : l'interface ne manipule que des sessions)
- `Project.terminals`, `terminal(id)` ; `createTerminal(projectId, name)`, `closeTerminal(id)`, `deleteTerminal(id)` ; WebSocket `/terminals/<id>` (messages JSON `input`, `resize` / `data`, `exit`)
- Subscriptions SSE : `sessionEvents(sessionId)`, `sessionUpdated`, `requestCreated`, `requestUpdated`

## Scripts

| Commande              | Effet                                          |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | backend + frontend en mode développement       |
| `npm run build`       | build des deux packages                        |
| `npm run typecheck`   | vérification TypeScript des deux packages, du schéma GraphQL et des requêtes du front |
| `npm test`            | tests Vitest des deux packages (voir « Tests ») |
| `npm run db:up`       | démarre PostgreSQL (Docker)                    |
| `npm run db:down`     | arrête PostgreSQL                              |
| `npm run db:migrate`  | applique les migrations                        |
