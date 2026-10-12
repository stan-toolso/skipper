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
- **Environnement d'exécution** : chaque projet a son conteneur Docker (limites de mémoire et de CPU,
  ne voit que le code de ce projet). Agents, terminaux et commandes y tournent **toujours** : rien ne
  s'exécute directement sur le serveur avec l'utilisateur de Skipper.
- **Worktree** : pour un projet relié à un dépôt git, le dossier principal est un checkout de la branche
  par défaut ; on peut y ajouter des worktrees (`git worktree`), un dossier par branche, dans lesquels
  on lance sessions et terminaux sans toucher au dossier principal. Créer un worktree propose par
  défaut d'y lancer aussitôt une session d'agent ; supprimer la dernière session ou le dernier terminal
  d'un worktree propose (case à cocher) de supprimer aussi le worktree, qui resterait vide.
- **Session** : une conversation interactive avec un agent, rattachée à un projet et lancée dans son
  workspace (ou dans l'un de ses worktrees, existant ou créé pour l'occasion). La consigne de départ est
  facultative : sans consigne, la session est créée sans démarrer et la première instruction envoyée
  depuis sa page la lance. On peut lui envoyer des instructions à tout moment, comme dans Claude Code ; une session
  terminée est relancée (reprise de la conversation) par un simple message. Un agent peut lui-même
  lancer d'autres sessions (outils MCP `sessions` et `worktrees`) ; elles gardent la trace de la
  session qui les a lancées.
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
- **Coffre** : serveurs SSH, bases PostgreSQL, API HTTP, sites web, secrets et comptes Google que les
  agents utilisent sans jamais voir les identifiants : le serveur agit pour eux (outils MCP, saisie dans le
  navigateur headless). Un élément appartient à une personne (coffre personnel, partageable et ouvrable à
  des projets) ou à un projet. Le coffre garde aussi ce que Skipper utilise **lui-même** pour une
  personne, jamais offert aux agents : jetons applicatifs (abonnement Claude, clé API Anthropic, comptes
  GitHub, fournisseurs de modèles d'OpenCode), proxy LiteLLM, projet Langfuse. Voir « Coffre » plus bas.
- **Tâche** : élément de travail d'un projet avec priorité (basse, moyenne, haute, urgente) et statut
  (à faire, en cours, terminée, annulée). Créée et mise à jour par les humains (tableau dans
  l'application) comme par les agents (outils MCP). « Confier à un agent » lance une session avec la
  tâche comme consigne.
- **Agent** : configuration réutilisable et paramétrée d'un projet — un appel direct de modèle (LiteLLM,
  OpenAI, Anthropic, tracé dans Langfuse) ou un type de session (Claude, OpenCode, shell) et ses options,
  un prompt système, un modèle d'instruction à variables, une sortie texte ou JSON. Exécuté à la main,
  par planification ou par un workflow ; chaque exécution d'un agent de session est une session dédiée.
- **Workflow** : graphe d'un projet (déclencheur, agents, sessions, tâches, créations de tâche,
  conditions, fins) avec des branches oui / non et « en cas d'erreur », lancé à la main, par
  planification ou par une tâche créée. Voir « Agents et workflows » plus bas.

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
worktrees) sont simulées avec `vi.mock`.

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
    worktrees/
      service.ts               # worktrees git : création (branche existante ou nouvelle), suppression, cwd
      mcp.ts                   # serveur MCP `worktrees` (list, create, delete)
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
    agents/
      service.ts               # agents : création, entrées, prompt rendu, planification
      execution.ts             # exécutions : session dédiée ou appel direct, attente, sortie, annulation
      llm.ts                   # appel direct d'un modèle (LiteLLM, OpenAI, Anthropic) et trace Langfuse
      template.ts              # modèles {{input.x}}, {{nodes.k.output}}, | default
    workflows/
      graph.ts                 # définition d'un graphe : lecture, validation, prochains pas
      engine.ts                # exécution d'un workflow : nœuds, branches, journal, notification
      conditions.ts / expressions.ts / taskFilter.ts  # conditions visuelles, formules, filtres de tâches
      service.ts / triggers.ts / scheduler.ts         # file d'exécutions, déclencheur « tâche créée », planification
    tasks/
      service.ts               # tâches : création, mise à jour, personnes, champs, commentaires, résumé pour le prompt
      sessionFeed.ts           # changements et commentaires transmis à la session en charge
      mcp.ts                   # serveur MCP `tasks` (list, get, create, update, claim, comment)
      launch.ts                # confier une tâche à un nouvel agent
      api.ts                   # API REST /api/v1/tasks (clés d'API du projet)
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
      mcp.ts                   # serveur MCP `vault` (list, ssh_exec, ssh_upload, ssh_download, sql_query, sql_schema, http_request, browser_fill)
    google/
      service.ts               # comptes Google du coffre : OAuth hors ligne, jeton chiffré, appels d'API, vérification, prompt
      gmail.ts                 # client Gmail (recherche, lecture, envoi / réponse)
      drive.ts                 # client Drive (recherche, lecture / export, téléchargement, dépôt, création de Docs)
      mcp.ts                   # serveur MCP `google` (outils selon les accès accordés)
    sharedPages/               # pages partagées : publication, versions, membres, route de lecture en bac à sable, MCP `pages`
    search/                    # recherche globale (projets, sessions, tâches, worktrees, pages, coffre)
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
      service.ts               # orchestration : création (avec worktree neuf au besoin), démarrage, arrêt, suivi des processus
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
    pages/                     # projets, sessions, tâches, coffre, agents, workflows, paramètres…
    components/                # layout, badge de statut, journal, carte de demande, dialogues (Dialogs.tsx)
    components/automation/     # agents et workflows : éditeurs, canvas (@xyflow/react), exécutions
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
  - `member` : sessions, terminaux, worktrees, tâches, contexte, réponses aux demandes ;
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
utiliser. Six types offerts aux agents : **serveur SSH**, **base PostgreSQL** (éventuellement via un
serveur SSH du même coffre, en tunnel), **API HTTP**, **site web**, **secret** et **compte Google** ;
trois types **réservés à Skipper** : **jeton applicatif**, **proxy LiteLLM** et **projet Langfuse**.
Chaque élément a un nom court (`prod`, `rds-prod`, `stripe`, `admin-site`) que les agents emploient.

**Propriété, partage, ouverture aux projets.** Un élément appartient soit à une personne (coffre
personnel), soit à un projet (géré par ses administrateurs, utilisable par ses membres). Un élément
personnel se **partage** avec des collègues, avec une permission `utiliser` < `lire` (révéler les secrets)
< `gérer`, et s'**ouvre à des projets** : pour toutes les sessions du projet (il faut gérer l'élément et
administrer le projet) ou seulement pour les sessions que l'on lance soi-même. Les agents d'une session
voient les éléments du projet, ceux ouverts à tous ses agents, et ceux que l'auteur de la session a
ouverts pour ses propres sessions ; un nom ne peut pas désigner deux éléments dans une même portée. Un
élément se **copie** dans un projet (secrets compris) pour une migration.

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
optionnel (Cloud SQL), une seule instruction par appel, résultats tronqués à 200 lignes. API : l'agent
donne un chemin relatif à l'adresse de base, la requête ne sort ni de l'origine ni du chemin, le serveur
ajoute l'authentification (Bearer, en-tête, Basic, paramètre), ne suit pas les redirections, masque le jeton
dans la réponse ; « lecture seule » limite à GET, HEAD et OPTIONS ; les adresses internes sont refusées
(`vault/http.ts`). Site web : une adresse et des champs publics ou secrets ; l'agent sélectionne un champ
de formulaire puis appelle `browser_fill(item, champ)` : le serveur vérifie que la page appartient au site,
demande l'accord s'il le faut, puis tape la valeur par CDP ; les outils qui liraient la page en retour
(`browser_evaluate`, `browser_run_code`) sont retirés quand le coffre a tapé quelque chose. Secret : des
champs sans site, chaque saisie est soumise à accord avec la page affichée. Google : connecté par OAuth
(`GET /auth/google/connect?projectId=…|personal=1&gmail=…&drive=…`), accès lecture ou écriture pour Gmail et
Drive, même serveur MCP `google` qu'auparavant (`account` = nom de l'élément).

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

**Accès des agents.** Serveur MCP `vault` : `list`, `ssh_exec`, `ssh_upload`, `ssh_download`,
`sql_query`, `sql_schema`, `http_request`, `browser_fill`. Le backend déchiffre, exécute, tronque, et
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
  postgres, api, website, secret, google, token, litellm, langfuse), `settings` (champs publics du type), secrets chiffrés par
  enveloppe (`secretCiphertext`, `wrappedKey`), `publicKey`, `hostKey`, `readOnly`, `requireApproval`,
  `commandAllowlist`, `expiresAt` (rappel de rotation), dernier test ; tables `vault_item_shares`,
  `vault_item_links` (portée `project` ou `personal`), `vault_audit_events`.
- **UserSettings** (`user_settings`, une ligne par personne et par clé : `claude`, `claude.verification`,
  `opencode`, `opencode.models`) et **UserGithubAccount** (`user_github_accounts` : `login`, `method`,
  `scopes`, `organizations`, `isDefault`, `vaultItemId` du jeton, expiration).
- **Agent** (`agents`) : `projectId`, `name`, `provider` (`llm`, `claude`, `opencode`, `shell`), `config`,
  `systemPrompt`, `promptTemplate`, `inputs`, `outputFormat`, `outputSchema`, `worktreeId`,
  `timeoutMinutes`, planification (`schedule`, `scheduleInputs`, `scheduleOwnerId`). **AgentRun**
  (`agent_runs`) : déclencheur, statut, entrées, prompt rendu, sortie (et JSON), erreur, coût, session.
- **Workflow** (`workflows`) : `projectId`, `name`, `definition` (nœuds et arêtes), `enabled`,
  planification, `eventOwnerId`. **WorkflowRun** (`workflow_runs`, `workflow_run_nodes`,
  `workflow_run_logs`) : définition figée au lancement, entrées, état de chaque nœud, journal, sortie.
  Une session garde `agentId`, `agentRunId` et `workflowRunId` quand une exécution l'a ouverte.
- **Worktree** : `projectId`, `name` (dossier), `branch`, `label` (libellé libre, sinon la branche),
  `archivedAt`. Dossier `WORKSPACES_ROOT/<slug>.worktrees/<name>`,
  créé par `git worktree add` depuis le checkout principal : branche locale ou distante existante
  extraite, sinon nouvelle branche depuis `baseRef` (défaut : HEAD). La suppression retire le dossier et
  conserve la branche sauf demande contraire. Sessions et terminaux portent un `worktreeId` optionnel
  qui fixe leur dossier de travail.
- **Session** : `projectId`, `worktreeId`, `ownerId` (auteur ; hérité de la session parente pour une
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
  cours ; l'agent la passe en `done` quand il a fini. Les serveurs MCP `worktrees` et `sessions`
  (voir « Lancer des sessions et des worktrees ») lui permettent de déléguer du travail à d'autres
  sessions, dans des worktrees séparés.

- **Runner** (`backend/src/runners/`) : un seul, Docker, pour tous les projets (`projects.runner_config`
  = `{ image, memory, cpus, browser }`). Le runner fournit l'exécutable Claude Code donné au SDK, la
  commande du terminal web et celle du provider shell ; aucun de ces processus ne tourne sur l'hôte.
  Un conteneur `skipper-<slug>` est créé à partir de `deploy/runner/Dockerfile` (image `skipper-runner:latest`,
  construite avec `docker build -t skipper-runner deploy/runner`) ; le dossier du projet, ses
  worktrees et ses skills y sont montés **aux mêmes chemins absolus que sur l'hôte**, avec l'uid/gid
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
  clic « Recréer ». La carte compte aussi les processus zombies du conteneur (`docker top`), à titre de
  diagnostic : un conteneur recréé avec `--init` n'en a pas.

- **Mémoire et CPU des conteneurs** (`runners/stats.ts`, `runners/monitor.ts`) : `Project.containerStats`
  lit le cgroup v2 du conteneur par un `docker exec` (`memory.current` moins `inactive_file`, comme
  `docker stats` ; `memory.max`, swap, `cpu.max`, deux lectures de `cpu.stat` à 0,5 s d'écart,
  compteur `oom_kill` de `memory.events`) et liste les processus `claude` avec leur mémoire. Chaque CLI
  de session reçoit `SKIPPER_SESSION_ID` (transmis par le script de relais) : un processus est ainsi
  relié à sa session, et les commandes qu'il lance (même variable héritée) sont comptées avec elle. Mesure
  en cache 4 s. La carte « Environnement d'exécution » de la page projet l'affiche toutes les 10 s
  (jauges, processus par session avec leur activité, processus orphelins) ; un administrateur y
  modifie les limites, appliquées à chaud par `docker update` (swap = 2 × mémoire, comme `docker run`)
  comme depuis le formulaire du projet. Toutes les 30 s, la surveillance mesure chaque conteneur : au-delà
  de 90 % de la limite pendant plus d'une minute, notification `container.memory_high` au projet
  (réarmée sous 80 %). À la fin d'une session en erreur, `containerMonitor.explainFailure` regarde le
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
**Reprendre** de sa page (`resumeSession`) : l'agent reprend son tour avec une instruction qui explique
la coupure s'il travaillait, sinon la conversation est rouverte et il attend la suite. Le provider distingue
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
panneau à onglets. L'unité de navigation est le **dossier de travail** : le checkout principal d'un
projet et chacun de ses worktrees forment une carte dans la sidebar (état de ses sessions, tâche liée,
pull request colorée selon son état, « absent » si le dossier manque) avec des pastilles pour ses
sessions, terminaux et navigateurs ; un dossier ouvert occupe **un seul onglet** dans la barre du haut,
et une **sous-barre** liste ses fichiers, sessions, navigateurs et terminaux (`WorkspaceTabs`). Les
pages restent montées quand on change d'onglet (React 19 `<Activity>`), les onglets ouverts sont
mémorisés dans le navigateur, un onglet fermé se rouvre (Alt+Maj+T), et la sidebar se replie. Le filtre
« Mes sessions / Tout le monde » cache les sessions des autres ; les pastilles portent les initiales de
leur auteur. Menu « ⋮ » d'un dossier : fichiers, nouvelle session, terminal, worktree, renommer,
archiver, supprimer. **Recherche** (⌘K ou Ctrl+K, `search`) sur les projets, sessions (nom et
conversation), tâches, worktrees, pages et éléments du coffre ; **raccourcis** listés par « ? »
(`lib/shortcuts.ts`). Le panneau de droite a deux onglets : **Tâche** (la tâche liée à la session ou au
worktree, modifiable) et **Git** (état, branche comparée à sa base avec diff par fichier, commits, PR).
Les listes ne se rafraîchissent plus quand l'onglet du navigateur est caché (`usePollingQuery`).

**Tableau de bord** (page d'accueil, `frontend/src/pages/DashboardPage.tsx`) : ce qui attend
l'utilisateur sur l'ensemble de ses projets. Quatre tuiles (demandes en attente, agents au travail
et en attente d'instructions, tâches ouvertes avec les retards, consommation du mois avec le
plafond), puis la liste « À traiter » (demandes, sessions qui attendent des instructions, sessions
en erreur depuis 24 h), les agents au travail, les tâches à surveiller (urgentes, hautes, en retard
ou à échéance proche), la consommation (par jour sur 30 jours, sessions les plus coûteuses du
mois), l'activité récente et une ligne par projet. Tout vient de la query `dashboard`
(`backend/src/dashboard/service.ts`), agrégée en SQL et restreinte aux projets de l'utilisateur ;
la page se rafraîchit toutes les dix secondes. Sur mobile, le tableau des projets devient une
liste de cartes. Sans projet, la page redevient le parcours d'accueil en trois étapes.

Sur les pages d'un projet ou d'un worktree (projet, session, terminal, fichiers, tâches, contexte),
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
propose le nettoyage : branche distante, worktree et branche locale (sessions encore ouvertes
arrêtées au choix, historique conservé, terminaux fermés), tâches liées passées à « terminée » ; le
dossier principal est ensuite mis à jour (fetch, pull s'il est sur la base). API : queries
`githubPullRequests`, `githubPullRequest`, `githubPullRequestDraft` ; mutations `createPullRequest`,
`mergePullRequest`.

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
seuls les nouveaux sont demandés à chaque relevé. Prompts d'autorisation et questions à
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

## Tâches et worktrees

« Confier à un agent » lance la session dans un **worktree créé pour la tâche** quand le projet est
relié à un dépôt git : dossier `task-<slug du titre>` et branche `task/<slug>` à partir du checkout
principal (`backend/src/tasks/launch.ts`, suffixe numérique si le nom existe déjà). Le menu du
bouton permet de préférer le dossier principal ou un worktree existant ; un projet sans dépôt git
travaille dans son dossier principal. Le worktree apparaît dans la sidebar avec sa session, et la
tâche affiche sa branche (colonne `tasks.branch`, conservée après suppression du worktree) et sa pull
request GitHub avec ses checks et revues ; un clic ouvre la fenêtre de fusion. Cycle complet sans
quitter Skipper : tâche → worktree → PR (panneau git) → fusion → nettoyage du worktree et de la branche.

Une tâche porte aussi un **responsable** et un **rapporteur** (nom et/ou e-mail libres), des **champs
personnalisés** (clé → valeur), et des **commentaires** (humains ou agents, via l'outil `tasks.comment`).
Chaque tâche a sa page (`/tasks/:id`, vue tableau ou kanban sur la liste, filtres par statut, priorité,
responsable, « mes tâches »). La session en charge d'une tâche reçoit les changements faits par d'autres
(`[Mise à jour de la tâche]`) et les nouveaux commentaires (`[Commentaire sur la tâche]`, qui relancent
une session terminée) ; son historique de sessions est conservé (`task_sessions`). « Confier à un agent »
montre la consigne envoyée à l'agent et permet de la modifier avant le lancement. Une **API REST**
(`/api/v1/tasks`, clés `skp_…` créées sur la fiche du projet, haché en base) permet à un outil externe de
lister et créer des tâches.

## Lancer des sessions et des worktrees

**Depuis l'interface.** « Nouvelle session » (sidebar, pages Projets, Sessions, projet, accueil) ouvre une
modale (`frontend/src/components/SessionLauncher.tsx`, fournie à toute l'application par
`SessionLauncherProvider` dans le layout) : projet, branche de travail (dossier principal, worktree
existant ou « Nouveau worktree… » avec branche et point de départ), consigne, nom, options de l'agent.
« Nouveau worktree » (menu « + » d'un projet git, fiche du projet) ouvre la même modale en mode
worktree : branche à créer, puis, par défaut, une session d'agent lancée dans ce worktree avec les
mêmes options ; décocher l'interrupteur crée seulement le worktree. Côté API,
`CreateSessionInput.newWorktree { branch, name, baseRef }` crée le worktree puis la session dans une
même mutation (le worktree est retiré si la session ne peut pas être créée).

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

- `worktrees` : `list` (branche du dossier principal, worktrees avec commit et sessions en cours),
  `create(branch, name?, base_ref?)`, `delete(name, delete_branch?)`. Lister et créer sont toujours
  autorisés ; supprimer passe par la demande d'autorisation habituelle.
- `sessions` : `list`, `get(id)` (état et dernière réponse de l'agent), `create(prompt, name?,
  worktree? | new_branch?, base_ref?, permission_mode?, model?)` (même provider et même configuration
  que la session appelante par défaut), `wait(id, timeout_seconds?)` (attend la fin du tour, 120 s par
  défaut, 600 s au plus, à rappeler si l'agent travaille encore), `send(id, text)`, `end(id)`. Un agent
  ne peut envoyer une instruction ou terminer que les sessions qu'il a lancées. `create` et `send`
  consomment du budget : ils passent par la demande d'autorisation (mode « me demander »), ou sont
  pré-autorisables avec `mcp__sessions` dans les outils autorisés de la session ; les autres outils
  sont libres.

Garde-fous (`backend/src/sessions/service.ts`) : une session lancée par un agent reste dans le projet de
l'agent, l'imbrication est limitée à deux niveaux (humain → agent → agent → stop), et au plus trois
sessions lancées par une même session tournent en même temps. Une session lancée par un agent déclenche
une notification `session.created` ; sa page indique « lancée par » avec un lien vers la session parente
(`Session.parentSession`, `Session.childSessions`).

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
onglets au-delà du seuil serveur (`CONTEXT_WARN_TOKENS`, 150 000 tokens). Au-delà de ce seuil, un bandeau propose
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
`worktreeId` optionnel).

## Historique et archives

Une session s'**archive** (bouton sur sa page, menu de la sidebar, liste des sessions) : elle quitte la
sidebar et reste consultable, restaurable et relançable depuis l'**historique** du projet
(`/projects/:id/history`, recherche dans les noms, consignes et conversations). « Relancer » crée une
nouvelle session avec un résumé de la précédente (`<previous_conversation>`, 40 k caractères au plus).
Un worktree s'archive de même (ses sessions sont archivées, ses terminaux fermés, dossier et branche
conservés) et se restaure avec ses sessions ; un dossier de worktree disparu est recréé à la prochaine
utilisation. Un worktree se renomme (libellé libre, et dossier par `git worktree move`).

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
push, création de worktree), à ses pull requests, et aux agents de ses sessions (credential helper
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
worktrees, sessions, pages). Le serveur `opencode serve` tourne dans le conteneur du projet
(`docker exec`, image avec `opencode-ai` installé : reconstruire `deploy/runner`), joint par un tunnel
TCP ; ses serveurs MCP sont des **ponts** (`opencodeBridge.ts`) : Skipper écoute sur un port de l'hôte,
OpenCode lance par serveur un relais `node -e` qui s'annonce avec un jeton propre à la session, et
chaque connexion est servie par une instance neuve du serveur MCP in-process. La configuration et les
clés (`OPENCODE_CONFIG_CONTENT`, `OPENCODE_AUTH_CONTENT`, lues dans le coffre du propriétaire) ne
sont remises qu'au serveur OpenCode, et un plugin masque l'environnement aux outils de l'agent. L'état
de la conversation est reflété en base (`opencode_sessions`, `opencodeState.ts`) pour reprendre une
session après recréation du conteneur. Les décisions d'autorisation passent par les règles du projet
puis par les demandes humaines, comme pour Claude.

## Agents et workflows

**Agents** (`/agents`, `/projects/:id/agents`, `backend/src/agents/`). Un agent est une configuration
réutilisable d'un projet : un **fournisseur** — `llm` pour un appel direct de modèle via un proxy
LiteLLM, OpenAI ou Anthropic (clé du coffre, température, longueur maximale, trace envoyée à un projet
Langfuse), ou un type de session (`claude`, `opencode`, `shell`) et ses options —, un prompt système,
un **modèle d'instruction** à variables (`{{input.ticket}}`, `{{ticket | default: "…"}}`), des
**entrées** déclarées (clé, libellé, obligatoire, valeur par défaut), une sortie **texte** ou **JSON**
(schéma montré à l'agent, réponse lue comme JSON), un worktree de travail et un délai. Une
**exécution** (`agent_runs`) se lance à la main, en test, par planification (cron et fuseau, entrées
mémorisées, comptes de la personne qui l'a réglée) ou par un workflow : pour un agent de session, une
session dédiée est créée avec l'instruction rendue, attendue jusqu'à la fin du tour (ou du délai), sa
réponse lue, puis terminée — sauf quand l'agent résout une tâche, sa session reste ouverte dans le
worktree de la tâche. Coût, durée, sortie et erreur sont conservés ; les exécutions perdues au
redémarrage sont marquées en échec (`failStaleAgentRuns`).

**Workflows** (`/workflows`, `/projects/:id/workflows`, `backend/src/workflows/`). Un workflow est un
**graphe** dessiné dans l'interface (canvas `@xyflow/react`, mise en page automatique) : un ou
plusieurs **déclencheurs** (manuel, avec ses variables, ou « tâche créée » avec un filtre visuel sur
la tâche), des nœuds **agent** (entrées remplies par des modèles), **tâche** (session qui traite une
tâche existante, dans un nouveau worktree, un worktree choisi ou le dossier principal), **session**
(session libre, avec ou sans attente du tour, terminée ou non ensuite), **créer une tâche**,
**condition** (règles visuelles imbriquées ou formule `nodes.review.json.approved and input.env ==
"prod"`, voir `expressions.ts`) et **fin** (sortie de l'exécution). Les arêtes d'une condition portent
sa branche oui / non ; un agent, une tâche, une session ou une création de tâche peuvent avoir une
branche « en cas d'erreur ». Le graphe est **validé** en continu (`graph.ts` : déclencheur absent,
arête orpheline, agent inconnu, entrée obligatoire vide, cycle, branches mal utilisées…) ; les erreurs
bloquent l'exécution, pas les avertissements. Une **exécution** (`workflow_runs`) fige la définition,
avance nœud par nœud (`engine.ts`, journal détaillé, état de chaque nœud, coût cumulé, annulation),
et se lance à la main (choix du déclencheur, saisie des variables), en test, par planification
(`scheduler.ts`, toutes les 30 s), ou par une **tâche créée** dans le projet (`triggers.ts` : file
d'exécutions, au plus cinq actives par workflow, garde anti-boucle quand la tâche vient d'une session
du workflow lui-même). Les sessions ouvertes par une exécution appartiennent à la personne qui l'a
lancée (ou au propriétaire de la planification / du déclencheur) et travaillent avec ses comptes.
Notifications `agent.run`, `agent.failed`, `workflow.run`, `workflow.failed` à la fin des exécutions.

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
- `createSession(input)` (`input.worktreeId` ou `input.newWorktree { branch, name, baseRef }`), `startSession(id)`, `stopSession(id)`, `deleteSession(id)` ; `Session.parentSession`, `Session.childSessions`
- `sendSessionMessage(id, text, attachments)`, `resumeSession(id)`, `interruptSession(id)`, `endSession(id)`, `updateSessionConfig(id, config)` ; `CreateSessionInput.attachments` et `Session.promptAttachments` (fichiers joints, voir « Lancer des sessions et des worktrees »)
- `requests(status, sessionId, limit, newestFirst)` (statut à null = tout l'historique), `request(id)` ; `answerRequest(id, response)`, `cancelRequest(id)`
- `Project.contextFolders`, `Project.contextInstructions`, `Project.contextChanges(limit)`, `contextInstruction(id)` avec `versions`, `searchContext(projectId, query)`
- `createContextFolder`, `renameContextFolder`, `moveContextFolder`, `deleteContextFolder`, `createContextInstruction`, `updateContextInstruction`, `deleteContextInstruction`, `restoreContextInstructionVersion`
- `notifications(unreadOnly, limit)`, `unreadNotificationCount` ; `markNotificationRead(id)`, `markAllNotificationsRead` ; subscription `notificationCreated`
- `Project.tasks(status)`, `tasks(projectId, status, priority, limit)`, `task(id)` ; `createTask`, `updateTask`, `deleteTask`, `startTaskSession(id, provider, config)`
- `githubPullRequests(projectId, state, limit)`, `githubPullRequest(projectId, number)`, `githubPullRequestDraft(projectId, worktreeId)` ; `createPullRequest(projectId, worktreeId, title, body, base, draft)`, `mergePullRequest(projectId, number, method, cleanup)` ; `Task.branch`, `Task.pullRequest`
- `Project.worktrees`, `worktree(id)` avec `sessions` et `terminals` ; `createWorktree(projectId, branch, name, baseRef)`, `deleteWorktree(id, deleteBranch)` ; `CreateSessionInput.worktreeId`, `createTerminal(..., worktreeId)`, `startTaskSession(..., worktreeId)`
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
