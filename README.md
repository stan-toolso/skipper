# Skipper

Interface de gestion de sessions d'agents tournant en arrière-plan. Claude Code est le premier type
supporté, mais l'architecture est générique : un « provider » par type d'agent (`shell` est fourni
comme second exemple).

Trois notions :

- **Projet** : prompt système, dépôt git optionnel, et un dossier de travail (workspace) dédié dans
  `WORKSPACES_ROOT`. Le dépôt y est cloné à la création du projet.
- **Worktree** : pour un projet relié à un dépôt git, le dossier principal est un checkout de la branche
  par défaut ; on peut y ajouter des worktrees (`git worktree`), un dossier par branche, dans lesquels
  on lance sessions et terminaux sans toucher au dossier principal.
- **Session** : une conversation interactive avec un agent, rattachée à un projet et lancée dans son
  workspace (ou dans l'un de ses worktrees). On peut lui envoyer des instructions à tout moment, comme dans Claude Code ; une session
  terminée est relancée (reprise de la conversation) par un simple message.
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
- **Tâche** : élément de travail d'un projet avec priorité (basse, moyenne, haute, urgente) et statut
  (à faire, en cours, terminée, annulée). Créée et mise à jour par les humains (tableau dans
  l'application) comme par les agents (outils MCP). « Confier à un agent » lance une session avec la
  tâche comme consigne.

## Stack

- **Backend** : Node.js 20, TypeScript, GraphQL ([graphql-yoga](https://the-guild.dev/graphql/yoga-server)), PostgreSQL (`pg`, migrations SQL), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
- **Frontend** : React 18, Vite, Bootstrap 5 (react-bootstrap), Apollo Client, React Router
- **Infra locale** : Docker Compose (PostgreSQL 16)

## Démarrage rapide

Mise en production (serveur, nginx, base RDS, pm2) : voir `DEPLOY.md`.

Paramètres (menu en bas de la sidebar) : une section par service. **Claude** (authentification,
modèles, budgets et consommation) et **GitHub** (connexion OAuth par device flow avec une OAuth App à
vous, jeton chiffré en base, dépôts privés en https sans clé de déploiement, liste des dépôts dans le
formulaire de projet).

```bash
cp .env.example .env        # ajuster si besoin
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
    index.ts                   # serveur HTTP + GraphQL
    config.ts                  # variables d'environnement
    errors.ts                  # erreurs métier renvoyées au client
    pubsub.ts                  # canaux temps réel (subscriptions)
    db/                        # pool pg, runner de migrations, migrations SQL
    projects/
      service.ts               # création / édition, slug, préparation du workspace
      workspace.ts             # dossier du projet, clone git, infos de branche
    requests/
      service.ts               # demandes d'intervention humaine : création, attente de la réponse
    worktrees/
      service.ts               # worktrees git : création (branche existante ou nouvelle), suppression, cwd
    terminals/
      service.ts               # shells pty (node-pty) par projet, relayés en WebSocket (/terminals/<id>)
    notifications/
      service.ts               # notifications (cloche) émises par les autres services
    tasks/
      service.ts               # tâches : création, mise à jour, résumé pour le prompt des agents
      mcp.ts                   # serveur MCP `tasks` (list, get, create, update, claim)
      launch.ts                # confier une tâche à un nouvel agent
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
      service.ts               # orchestration : création, démarrage, arrêt, suivi des processus
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

## Modèle

- **Project** : `name`, `slug` (nom du dossier, fixé à la création), `description`, `systemPrompt`,
  `gitUrl`, `gitBranch`. Le workspace est `WORKSPACES_ROOT/<slug>` ; il est créé (ou cloné) à la
  création du projet et au plus tard au démarrage d'une session. Supprimer un projet supprime ses
  sessions en base mais conserve le dossier sur disque.
- **Worktree** : `projectId`, `name` (dossier), `branch`. Dossier `WORKSPACES_ROOT/<slug>.worktrees/<name>`,
  créé par `git worktree add` depuis le checkout principal : branche locale ou distante existante
  extraite, sinon nouvelle branche depuis `baseRef` (défaut : HEAD). La suppression retire le dossier et
  conserve la branche sauf demande contraire. Sessions et terminaux portent un `worktreeId` optionnel
  qui fixe leur dossier de travail.
- **Session** : `projectId`, `worktreeId`, `name`, `provider`, `status` (`pending`, `running`, `completed`, `failed`,
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
  cours ; l'agent la passe en `done` quand il a fini.

Au redémarrage du backend, les sessions encore `running` en base passent à `interrupted`, les
demandes en attente à `expired` et les terminaux à `closed`.

`node-pty` a besoin que son binaire `spawn-helper` soit exécutable : le script `postinstall` s'en charge.

## Interface

Disposition façon Cursor (`frontend/src/workbench/`) : à gauche une sidebar avec les menus (Projets,
Sessions, Demandes) et un explorateur des projets dépliables avec leurs sessions (état en couleur,
demandes en attente) ; à droite un panneau à onglets où chaque page ouverte (session, projet,
contexte, listes) est un onglet fermable. Les onglets ouverts sont mémorisés dans le navigateur.

Thème sombre inspiré de Claude Code (`frontend/src/theme.css`). La page de session
(`frontend/src/components/Transcript.tsx`) reprend ses conventions : instructions préfixées par `>`,
réponses `⏺`, appels d'outils avec leur résultat `⎿` repliable, prompts d'autorisation et questions à
options numérotées (chiffres, flèches et Entrée au clavier), zone de saisie `>` en bas avec Entrée
pour envoyer et échap pour interrompre.

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

- `settings` (réglages Claude, statut d'authentification, modèles connus, consommation) ; `updateClaudeSettings`, `setClaudeApiKey`, `clearClaudeOauthToken`, `verifyClaudeAuth(mode)`
- Connexion OAuth : `startClaudeLogin` (URL à ouvrir), `completeClaudeLogin(id, code)`, `cancelClaudeLogin`, `claudeLogin(id)`
- `providers` : types d'agents disponibles et leurs options
- `projects`, `project(id)` ; `createProject`, `updateProject`, `prepareProjectWorkspace`, `deleteProject`
- `sessions(projectId, status, provider, limit, offset)`, `session(id)` avec `events(after, limit)` et `requests(status)`
- `createSession(input)`, `startSession(id)`, `stopSession(id)`, `deleteSession(id)`
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
