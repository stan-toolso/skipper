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
- **Environnement d'exécution (runner)** : par projet, `local` (les agents, terminaux et commandes
  tournent sur le serveur avec l'utilisateur de Skipper) ou `docker` (un conteneur dédié au projet,
  avec limites de mémoire et de CPU, qui ne voit que le code de ce projet).
- **Worktree** : pour un projet relié à un dépôt git, le dossier principal est un checkout de la branche
  par défaut ; on peut y ajouter des worktrees (`git worktree`), un dossier par branche, dans lesquels
  on lance sessions et terminaux sans toucher au dossier principal. Créer un worktree propose par
  défaut d'y lancer aussitôt une session d'agent.
- **Session** : une conversation interactive avec un agent, rattachée à un projet et lancée dans son
  workspace (ou dans l'un de ses worktrees, existant ou créé pour l'occasion). On peut lui envoyer des instructions à tout moment, comme dans Claude Code ; une session
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
  contexte par un agent. Notifications natives du navigateur activables en option.
- **Connexion** : accès d'un projet à un système externe (serveur SSH, base PostgreSQL) que les agents
  peuvent utiliser. Les identifiants sont chiffrés en base ; par défaut l'agent passe par des outils
  MCP et ne les voit jamais. Voir « Connexions » plus bas.
- **Tâche** : élément de travail d'un projet avec priorité (basse, moyenne, haute, urgente) et statut
  (à faire, en cours, terminée, annulée). Créée et mise à jour par les humains (tableau dans
  l'application) comme par les agents (outils MCP). « Confier à un agent » lance une session avec la
  tâche comme consigne.

## Stack

- **Backend** : Node.js 20, TypeScript, GraphQL ([graphql-yoga](https://the-guild.dev/graphql/yoga-server)), PostgreSQL (`pg`, migrations SQL), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), Google OAuth (sans dépendance)
- **Frontend** : React 18, Vite, Bootstrap 5 (react-bootstrap), Apollo Client, React Router
- **Infra locale** : Docker Compose (PostgreSQL 16)

## Démarrage rapide

Mise en production (serveur, nginx, base RDS, pm2) : voir `DEPLOY.md`.

Paramètres (menu en bas de la sidebar) : une section par service. **Claude** (authentification,
modèles, budgets et consommation) et **GitHub** (jeton d'accès personnel collé, ou OAuth App et device flow ;
jeton chiffré en base, dépôts privés en https sans clé de déploiement, liste des dépôts dans le
formulaire de projet).

```bash
cp .env.example .env        # renseigner GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (voir « Utilisateurs »)
npm install
npm run db:up               # lance PostgreSQL dans Docker
npm run dev                 # backend (http://localhost:4000/graphql) + frontend (http://localhost:5173)
```

Les migrations SQL (`backend/src/db/migrations/*.sql`) sont appliquées automatiquement au démarrage
du backend, ou à la main avec `npm run db:migrate`.

Le provider Claude s'appuie sur le [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
(`@anthropic-ai/claude-agent-sdk`), qui embarque son propre binaire Claude Code : chaque message du
flux `query()` est journalisé comme événement `claude.<type>`. L'authentification est celle de
Claude Code sur la machine qui héberge le backend (connexion `claude` ou `ANTHROPIC_API_KEY`).
`CLAUDE_BIN` permet, si besoin, d'imposer un binaire Claude Code spécifique.

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
    tasks/
      service.ts               # tâches : création, mise à jour, résumé pour le prompt des agents
      mcp.ts                   # serveur MCP `tasks` (list, get, create, update, claim)
      launch.ts                # confier une tâche à un nouvel agent
    connections/
      service.ts               # connexions SSH / PostgreSQL d'un projet : CRUD, secrets chiffrés, test, prompt
      ssh.ts                   # client ssh2 : clés, exécution, SFTP, tunnels, clé d'hôte (TOFU)
      postgres.ts              # requêtes pg (lecture seule, tunnel), rendu des résultats, schéma
      mcp.ts                   # serveur MCP `connections` (list, ssh_run, ssh_upload, ssh_download, sql_query, sql_schema)
      runtime.ts               # mode « shell » : ssh-agent, enveloppes ssh/scp, pg_service.conf, tunnels par session
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
      mcp.ts                   # serveur MCP `sessions` (list, get, create, wait, send, end) : sessions lancées par un agent
      providers/
        provider.ts            # interface SessionProvider (à implémenter pour un nouvel agent)
        registry.ts            # enregistrement des providers disponibles
        process.ts             # utilitaire de spawn de processus (stdout/stderr ligne à ligne)
        claude.ts              # provider Claude Code (Claude Agent SDK)
        shell.ts               # provider commande shell
frontend/
  src/
    apollo.ts                  # client GraphQL
    graphql/operations.ts      # queries / mutations + types TS
    pages/                     # projets, sessions, demandes en attente
    components/                # layout, badge de statut, journal, carte de demande
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
## Connexions

Page « Connexions » d'un projet (bouton sur la fiche du projet, ou menu « + » de la sidebar). Deux types
pour l'instant : **serveur SSH** et **base PostgreSQL** (éventuellement atteinte à travers une connexion
SSH du projet, en tunnel). Chaque connexion a un nom court (`prod`, `rds-prod`) que les agents emploient.

**Identifiants.** Les champs publics (hôte, port, utilisateur, base) sont en clair ; la clé privée ou le
mot de passe sont chiffrés (AES-256-GCM, même clé que les jetons des Paramètres) et jamais renvoyés à
l'interface. Pour un serveur SSH, Skipper **génère une paire de clés ed25519** : on installe la clé
publique dans `authorized_keys` du serveur (au besoin avec `restrict,command="…"`), la clé privée ne
quitte pas le serveur Skipper. Importer une clé existante reste possible. La clé d'hôte est mémorisée à
la première connexion réussie (test depuis l'interface) et vérifiée ensuite ; « oublier » la réapprend.
Pour une base, on recommande un rôle dédié aux agents ; l'option « lecture seule » force en plus des
transactions `READ ONLY`.

**Accès des agents**, au choix par connexion :

- **Outils** (par défaut) : serveur MCP `connections`, exposé aux sessions Claude comme `context` et
  `tasks`. Outils `list`, `ssh_run`, `ssh_upload`, `ssh_download`, `sql_query`, `sql_schema`. Le backend
  déchiffre, exécute, tronque les sorties, et journalise chaque usage comme événement `connection` de la
  session (visible dans le transcript). Une liste blanche de préfixes de commandes peut limiter `ssh_run`.
- **Shell de la session** : `ssh <nom>`, `scp`, `sftp` et `psql service=<nom>` fonctionnent dans le Bash
  de l'agent. Pour la durée de la session, le backend lance un `ssh-agent` dédié (la clé est utilisable,
  pas lisible), place des enveloppes `ssh`/`scp`/`sftp` en tête du `PATH` qui imposent un fichier de
  configuration et un `known_hosts` propres à la session, ouvre les tunnels nécessaires, et écrit
  `PGSERVICEFILE` / `PGPASSFILE`. Le mot de passe d'une base est donc lisible par l'agent dans ce mode.
  Tout est détruit à la fin de la session (`/tmp/skipper-session-<id>`), et les restes d'un arrêt
  brutal sont balayés au démarrage suivant. Ce mode nécessite `ssh`, `ssh-agent`, `ssh-add` et, pour les
  bases, `psql` sur la machine du backend.
- **Les deux**.

**Approbation.** Par défaut, chaque appel d'outil sur une connexion devient une demande d'intervention
humaine (comme les autres permissions) ; on peut la désactiver par connexion (« sans approbation »).
`list` est toujours libre. En mode d'autorisation « tout autoriser » de la session, aucune demande n'est
faite ; en mode « ne jamais demander », les outils des connexions avec approbation sont refusés. L'accès
shell suit le mode d'autorisation de la session (permission Bash).

**Runner et isolation.** Avec le runner local, les sessions tournent sur la machine du backend, sous le
même utilisateur système : un agent à qui l'on a tout autorisé peut lire ce que le backend lit. Le mode
« outils » et les demandes d'approbation réduisent la surface ; le runner Docker isole réellement la
session, mais l'accès « shell » n'y est pas disponible (pas d'agent SSH ni de tunnels dans le conteneur) :
seuls les outils restent utilisables. La gestion des connexions est réservée aux administrateurs du
projet ; les autres membres les voient sans les modifier.

## Modèle

- **Project** : `name`, `slug` (nom du dossier, fixé à la création), `description`, `systemPrompt`,
  `gitUrl`, `gitBranch`. Le workspace est `WORKSPACES_ROOT/<slug>` ; il est créé (ou cloné) à la
  création du projet et au plus tard au démarrage d'une session. Supprimer un projet supprime ses
  sessions en base mais conserve le dossier sur disque.
- **Connection** : `projectId`, `name`, `kind` (ssh, postgres), `settings` (hôte, port, utilisateur, base, ssl,
  tunnel), `secrets` (chiffrés), `publicKey`, `hostKey`, `exposure` (mcp, direct, both), `readOnly`,
  `requireApproval`, `commandAllowlist`, dernier test.
- **Worktree** : `projectId`, `name` (dossier), `branch`. Dossier `WORKSPACES_ROOT/<slug>.worktrees/<name>`,
  créé par `git worktree add` depuis le checkout principal : branche locale ou distante existante
  extraite, sinon nouvelle branche depuis `baseRef` (défaut : HEAD). La suppression retire le dossier et
  conserve la branche sauf demande contraire. Sessions et terminaux portent un `worktreeId` optionnel
  qui fixe leur dossier de travail.
- **Session** : `projectId`, `worktreeId`, `parentSessionId` (session d'agent qui l'a lancée, null
  pour une session humaine), `name`, `provider`, `status` (`pending`, `running`, `completed`, `failed`,
  `stopped`, `interrupted`), `activity` pour une session en cours (`busy` : l'agent travaille, `idle` :
  il attend des instructions), `prompt` (première instruction), `config` (JSON propre au provider),
  `externalId` (ex. `session_id` Claude), `exitCode`, `error`, horodatages. Le provider Claude utilise
  le mode « streaming input » du SDK : la session reste ouverte entre les tours, `sendSessionMessage`
  envoie une instruction, `interruptSession` interrompt le tour en cours (échap dans l'interface),
  `endSession` termine proprement, `stopSession` tue le processus.
- **Request** : `sessionId`, `type` (`permission`, `question`, `input`, ... extensible), `status`
  (`pending`, `answered`, `cancelled`, `expired`), `title`, `message`, `payload`, `response`. Un
  provider appelle `ctx.ask(...)` et reçoit la réponse humaine sous forme de JSON libre. Le provider
  Claude convertit les demandes de permission du SDK (`canUseTool`) en demandes `permission`
  (réponse `{ decision: "allow" | "deny", always?, message? }`) et l'outil `AskUserQuestion` en
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

- **Runner** (`backend/src/runners/`) : `local` ou `docker` par projet (`projects.runner`,
  `projects.runner_config` = `{ image, memory, cpus }`). Le runner fournit l'exécutable Claude Code
  donné au SDK, la commande du terminal web et celle du provider shell. En mode docker, un conteneur
  `skipper-<slug>` est créé à partir de `deploy/runner/Dockerfile` (image `skipper-runner:latest`,
  construite avec `docker build -t skipper-runner deploy/runner`) ; le dossier du projet, ses
  worktrees et ses skills y sont montés **aux mêmes chemins absolus que sur l'hôte**, avec l'uid/gid
  de l'utilisateur de Skipper, donc aucune traduction de chemin. Le SDK reste dans le backend : il
  reçoit un script de relais (`WORKSPACES_ROOT/.runners/<slug>/claude`) qui exécute `docker exec -i`
  du CLI dans le conteneur, stdio relayés ; demandes d'autorisation, outils MCP (contexte, tâches)
  et skills fonctionnent donc sans changement. L'authentification Claude (jeton OAuth ou clé API des
  Paramètres) et le jeton GitHub sont transmis par variables d'environnement à chaque `docker exec` ;
  le dossier `~/.claude` de l'hôte est monté s'il existe (mode « compte du serveur »). Le terminal
  web est un `docker exec -it … bash -l`. Le conteneur démarre à la demande et se pilote depuis la
  page du projet (démarrer, arrêter, recréer).

Au redémarrage du backend, les sessions encore `running` en base passent à `interrupted`, les
demandes en attente à `expired` et les terminaux à `closed`.

`node-pty` a besoin que son binaire `spawn-helper` soit exécutable : le script `postinstall` s'en charge.

## Interface

Disposition façon Cursor (`frontend/src/workbench/`) : à gauche une sidebar avec les menus (Projets,
Sessions, Demandes) et un explorateur des projets dépliables avec leurs sessions (état en couleur,
demandes en attente) ; à droite un panneau à onglets où chaque page ouverte (session, projet,
contexte, listes) est un onglet fermable. Les onglets ouverts sont mémorisés dans le navigateur.

Sur les pages d'un projet ou d'un worktree (projet, session, terminal, fichiers, tâches, contexte),
un **panneau git** à droite (`frontend/src/workbench/GitPanel.tsx`) montre la branche courante et son
avance/retard, les fichiers indexés et modifiés (clic : diff coloré ; boutons indexer, désindexer,
abandonner), une zone de commit, les branches (bascule, création) et l'historique (clic : diff du
commit), avec fetch, pull et push. Backend : `backend/src/git/service.ts` (queries `gitStatus`,
`gitDiff`, `gitCommitDiff`, `gitBranches`, `gitLog` ; mutations `gitStage`, `gitUnstage`,
`gitDiscard`, `gitCommit`, `gitFetch`, `gitPull`, `gitPush`, `gitCheckout`).

Thème sombre inspiré de Claude Code (`frontend/src/theme.css`). La page de session
(`frontend/src/components/Transcript.tsx`) reprend ses conventions : instructions préfixées par `>`,
réponses `⏺`, appels d'outils avec leur résultat `⎿` repliable, prompts d'autorisation et questions à
options numérotées (chiffres, flèches et Entrée au clavier), zone de saisie `>` en bas avec Entrée
pour envoyer et échap pour interrompre.

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
tâche affiche sa branche. Il reste après la tâche : fusion ou suppression depuis le panneau git.

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

## Explorateur de fichiers et éditeur

Chaque projet (et chaque worktree) a une entrée « Fichiers » dans la sidebar : un onglet
explorateur (`frontend/src/pages/FilesPage.tsx`) montre l'arborescence du workspace, dossiers
dépliables chargés à la demande, avec création, renommage et suppression au survol. Un clic sur un
fichier l'ouvre dans son propre onglet d'éditeur (`FileEditorPage.tsx`, CodeMirror 6 : coloration
selon l'extension chargée à la demande, Ctrl/Cmd+S ou bouton pour enregistrer, point orange dans
l'onglet tant que ce n'est pas enregistré). L'enregistrement transmet la date de modification lue à
l'ouverture : si le fichier a changé entre-temps (agent, autre onglet), le serveur refuse
(`FILE_CONFLICT`) et l'éditeur propose de recharger ou d'écraser.

Côté serveur (`backend/src/files/service.ts`), tout chemin est normalisé puis vérifié à l'intérieur
de la racine du workspace, liens symboliques résolus compris ; les fichiers de plus de 2 Mo ou
binaires ne sont pas ouverts. API : `workspaceEntries`, `workspaceFile`, `writeWorkspaceFile`,
`createWorkspaceEntry`, `renameWorkspaceEntry`, `deleteWorkspaceEntry` (arguments `projectId` et
`worktreeId` optionnel).

## Paramètres généraux (Claude)

Page « Paramètres » (menu du bas de la sidebar), stockée en base (`app_settings`) et chargée en
mémoire au démarrage (`backend/src/settings/`) :

- **Authentification** : trois modes. `server` (recommandé) : Claude Code utilise le compte
  connecté dans son magasin pour l'utilisateur système qui fait tourner le backend (ou
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` de son environnement) ; la connexion se fait
  **depuis l'interface** en pilotant `claude auth login` (identifiants avec jeton de
  rafraîchissement, renouvelés seuls ; statut via `claude auth status --json`, déconnexion via
  `claude auth logout`, `settings/cli.ts`). `oauth` : un jeton longue durée (un an) obtenu de la
  même façon via `claude setup-token`, chiffré et stocké par Skipper. `api_key` : clé API Anthropic
  saisie dans l'interface. Les deux parcours de connexion (`settings/login.ts`) lancent le CLI dans
  un pseudo-terminal, en extraient l'URL d'autorisation claude.com, transmettent le code collé par
  l'utilisateur, et lisent l'écran du CLI **reconstitué par un terminal headless** (le flux brut est
  incomplet à cause des redessins avec déplacements de curseur). Le secret du mode actif est passé
  au processus Claude Code via `env` (`CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY`). Les
  secrets sont chiffrés (AES-256-GCM, `settings/crypto.ts`, clé `SKIPPER_SECRET_KEY` ou fichier
  `WORKSPACES_ROOT/.secret-key`) et ne sont jamais renvoyés par l'API.
- **Vérifier la connexion** : lance Claude Code sans prompt et lit `accountInfo()` (e-mail,
  abonnement) et `supportedModels()` ; le résultat est mémorisé et alimente la liste des modèles.
- **Modèles** : modèles proposés à la création d'une session (`allowedModels`, vide = tous),
  modèle par défaut et modèle de repli. Le champ « Modèle » du formulaire de session devient une
  liste déroulante ; un modèle hors liste est refusé côté serveur.
- **Facturation** : plafond mensuel (USD, toutes sessions), budget par défaut par session
  (`maxBudgetUsd` du SDK) et nombre d'étapes par défaut. À chaque fin de tour, le delta de
  `total_cost_usd` est enregistré dans `usage_ledger` (ventilé par modèle via `modelUsage`) ; le
  plafond atteint bloque le démarrage des sessions et l'envoi d'instructions (`BUDGET_EXCEEDED`).
  Ce coût est une estimation au tarif API : avec un abonnement Claude (OAuth) il n'est pas facturé.

## Ajouter un type d'agent

1. Implémenter `SessionProvider` (`backend/src/sessions/providers/provider.ts`) : `describe()` expose
   les champs de configuration au front, `start(ctx)` lance l'exécution dans `ctx.cwd` (workspace du
   projet), journalise via `ctx.emit` et sollicite l'humain via `ctx.ask` si besoin.
2. L'enregistrer dans `backend/src/sessions/providers/registry.ts`.

Le front génère automatiquement le formulaire de création à partir de `configFields`.

## API GraphQL

Toutes les opérations exigent une session (cookie), sauf `me`. Les erreurs de droits portent le code
`UNAUTHENTICATED` (pas connecté) ou `FORBIDDEN` (rôle insuffisant).

- `me` (utilisateur connecté, null sinon) ; `users` (administrateurs de l'application)
- `Project.members`, `Project.myRole` ; `inviteProjectMember(projectId, email, role)`, `updateProjectMemberRole(projectId, userId, role)`, `removeProjectMember(projectId, userId)` (administrateurs du projet)
- `settings` (réglages Claude, statut d'authentification, modèles connus, consommation ; administrateurs de l'application) ; `updateClaudeSettings`, `setClaudeApiKey`, `clearClaudeOauthToken`, `verifyClaudeAuth(mode)`
- Connexion OAuth : `startClaudeLogin` (URL à ouvrir), `completeClaudeLogin(id, code)`, `cancelClaudeLogin`, `claudeLogin(id)`
- `providers` : types d'agents disponibles et leurs options
- `projects`, `project(id)` ; `createProject`, `updateProject`, `prepareProjectWorkspace`, `deleteProject`
- `sessions(projectId, status, provider, limit, offset)`, `session(id)` avec `events(after, limit)` et `requests(status)`
- `createSession(input)` (`input.worktreeId` ou `input.newWorktree { branch, name, baseRef }`), `startSession(id)`, `stopSession(id)`, `deleteSession(id)` ; `Session.parentSession`, `Session.childSessions`
- `sendSessionMessage(id, text)`, `interruptSession(id)`, `endSession(id)`
- `requests(status, sessionId, limit, newestFirst)` (statut à null = tout l'historique), `request(id)` ; `answerRequest(id, response)`, `cancelRequest(id)`
- `Project.contextFolders`, `Project.contextInstructions`, `Project.contextChanges(limit)`, `contextInstruction(id)` avec `versions`, `searchContext(projectId, query)`
- `createContextFolder`, `renameContextFolder`, `moveContextFolder`, `deleteContextFolder`, `createContextInstruction`, `updateContextInstruction`, `deleteContextInstruction`, `restoreContextInstructionVersion`
- `notifications(unreadOnly, limit)`, `unreadNotificationCount` ; `markNotificationRead(id)`, `markAllNotificationsRead` ; subscription `notificationCreated`
- `Project.tasks(status)`, `tasks(projectId, status, priority, limit)`, `task(id)` ; `createTask`, `updateTask`, `deleteTask`, `startTaskSession(id, provider, config)`
- `Project.worktrees`, `worktree(id)` avec `sessions` et `terminals` ; `createWorktree(projectId, branch, name, baseRef)`, `deleteWorktree(id, deleteBranch)` ; `CreateSessionInput.worktreeId`, `createTerminal(..., worktreeId)`, `startTaskSession(..., worktreeId)`
- `Project.terminals`, `terminal(id)` ; `createTerminal(projectId, name)`, `closeTerminal(id)`, `deleteTerminal(id)` ; WebSocket `/terminals/<id>` (messages JSON `input`, `resize` / `data`, `exit`)
- Subscriptions SSE : `sessionEvents(sessionId)`, `sessionUpdated`, `requestCreated`, `requestUpdated`

## Scripts

| Commande              | Effet                                          |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | backend + frontend en mode développement       |
| `npm run build`       | build des deux packages                        |
| `npm run typecheck`   | vérification TypeScript des deux packages      |
| `npm run db:up`       | démarre PostgreSQL (Docker)                    |
| `npm run db:down`     | arrête PostgreSQL                              |
| `npm run db:migrate`  | applique les migrations                        |
