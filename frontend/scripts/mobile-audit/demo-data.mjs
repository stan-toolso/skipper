// Données de démonstration du serveur factice (MOCK_DEMO=1, utilisé par l'aperçu de Skipper) : un monde cohérent —
// une personne connectée, son espace personnel, quatre projets d'équipe, leurs sessions, tâches, demandes, pull
// requests, coffre et contexte — au lieu des textes longs de l'audit mobile. Les champs absents des objets sont
// complétés par le générateur du serveur, avec des valeurs courtes (demoScalar).
//
// Chaque champ d'un objet peut être une valeur ou une fonction (args) => valeur : les relations sont paresseuses et
// les champs à arguments (Project.sessions(status), Session.events(after)…) filtrent leurs résultats.

const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const inDays = (days) => new Date(NOW + days * 86_400_000).toISOString();
const day = (offset) => new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);

// ---- Personnes et agents ------------------------------------------------------------------------------------------

const user = (id, name, email, extra = {}) => ({ __typename: 'User', id, name, email, avatarUrl: null, isAdmin: false, isSuperAdmin: false, isCto: false, isGuest: false, conversationsOnly: false, kind: 'PERSON', agent: null, createdAt: ago(60 * 24 * 120), lastLoginAt: ago(30), ...extra });
const U = {
  me: user('u-camille', 'Camille Laurent', 'camille.laurent@toolso.io', { isAdmin: true, lastLoginAt: ago(2) }),
  hugo: user('u-hugo', 'Hugo Bernard', 'hugo.bernard@toolso.io', { lastLoginAt: ago(45) }),
  lea: user('u-lea', 'Léa Fontaine', 'lea.fontaine@toolso.io', { lastLoginAt: ago(60 * 5) }),
  thomas: user('u-thomas', 'Thomas Petit', 'thomas.petit@toolso.io', { lastLoginAt: ago(60 * 24 * 2) }),
  chris: user('u-chris', 'Chris', 'chris@agents.toolso.io', { kind: 'AGENT' }),
  max: user('u-max', 'Max', 'max@agents.toolso.io', { kind: 'AGENT' }),
  nora: user('u-nora', 'Nora', 'nora@agents.toolso.io', { kind: 'AGENT' }),
  // Invitée sur le site vitrine (rôle invité : conversations seulement), cliente de l'agence.
  claire: user('u-claire-guest', 'Claire Martin', 'claire.martin@client.fr', { lastLoginAt: ago(60 * 7), guestOf: 'p-site' }),
};
const people = [U.me, U.hugo, U.lea, U.thomas];
const person = (u) => ({ __typename: 'TaskPerson', name: u.name, email: u.email });

// ---- Projets ------------------------------------------------------------------------------------------------------

const P = {};
const project = (id, name, slug, description, gitUrl, extra = {}) => ({
  __typename: 'Project',
  id,
  name,
  slug,
  description,
  gitUrl,
  pages: () => projectPagesDemo.filter((pg) => pg.projectId === id),
  tabs: () => projectTabsDemo.get(id) ?? { hidden: [], order: [] },
  gitBranch: gitUrl ? 'main' : null,
  systemPrompt: '',
  taskInstructions: '',
  runnerConfig: {},
  defaultPermissionMode: 'default',
  defaultModel: null,
  taskModels: null,
  approvalConnections: [],
  isMember: true,
  isPersonal: false,
  myRole: 'ADMIN',
  gitHosted: false,
  hostedGit: null,
  workspacePath: `/home/skipper/skipper-workspaces/${slug}`,
  workspaceExists: true,
  git: gitUrl ? { __typename: 'WorkspaceGit', branch: 'main', commit: '8b7bff3' } : null,
  runnerStatus: { __typename: 'RunnerStatus', kind: 'docker', ready: true, state: 'running', containerName: `skipper-${slug}`, image: 'skipper-runner:latest', memory: '4g', cpus: null, startedAt: ago(60 * 26), error: null, outdated: false, outdatedReasons: [] },
  containerStats: null,
  createdAt: ago(60 * 24 * 90),
  updatedAt: ago(20),
  sessions: (args = {}) => sessionsOf(id, args),
  tasks: (args = {}) => filterTasks({ projectId: id, ...args, status: args.status ?? null }),
  worksessions: () => sessions.filter((s) => s.project === P[key(id)] && s.worksession && !s.archivedAt).map((s) => s.worksession),
  archivedWorksessions: [],
  terminals: [],
  members: () => (id === 'p-perso' ? [member(U.me, 'ADMIN')] : [member(U.me, 'ADMIN'), member(U.hugo, 'MEMBER'), member(U.lea, 'MEMBER'), ...(id === 'p-data' || id === 'p-api' ? [member(U.thomas, 'VIEWER')] : []), ...(id === 'p-site' || id === 'p-client' ? [member(U.claire, 'GUEST')] : []), ...agents.filter((a) => a.project.id === id).map((a) => member(a.user, 'MEMBER'))]),
  agents: () => agents.filter((a) => a.project === P[key(id)]),
  contextFolders: () => contextFolders.filter((f) => f.projectId === id),
  contextInstructions: () => contextInstructions.filter((i) => i.projectId === id),
  contextChanges: [],
  vaultItems: () => (id === 'p-perso' ? [] : vaultItems.filter((v) => v.ownerProject === P[key(id)] || v.shared).map((item) => ({ __typename: 'ProjectVaultItem', item, via: item.ownerProject ? 'PROJECT' : 'OWN', link: null, forAgents: true }))),
  apiKeys: () =>
    id === 'p-perso'
      ? []
      : [
          { __typename: 'ProjectApiKey', id: `${id}-key-1`, name: 'Formulaire du site', prefix: 'skp_Ab12Cd34', createdAt: ago(60 * 24 * 30), lastUsedAt: ago(90), scopes: ['tasks:read', 'tasks:write'], signed: false, triageAgent: null, createdBy: U.me },
          { __typename: 'ProjectApiKey', id: `${id}-key-2`, name: 'Curso', prefix: 'skp_Zx98Yw76', createdAt: ago(60 * 24 * 2), lastUsedAt: ago(12), scopes: ['inbound:task', 'inbound:triage'], signed: true, triageAgent: null, createdBy: U.me },
        ],
  inboundEvents: () => {
    if (id === 'p-perso') return [];
    const t = filterTasks({ projectId: id, status: null }).slice(0, 2);
    return t.map((task, i) => ({ __typename: 'InboundEvent', id: `${id}-in-${i}`, keyName: 'Curso', externalId: `evt-${1042 - i}`, source: 'curso', status: i === 0 ? 'done' : 'failed', error: i === 0 ? null : 'L’agent Chris est en pause', triage: true, createdAt: ago(12 + i * 60), task: { __typename: 'Task', id: task.id, title: task.title }, session: null, agent: null }));
  },
  conversations: () => conversations.filter((c) => c.project.id === id),
  unreadMessages: () => conversations.filter((c) => c.project.id === id).reduce((n, c) => n + c.unreadCount, 0),
  // Fils de tâches suivis : les tâches du projet qui ont des messages, la plus récemment commentée d'abord.
  followedTaskThreads: () =>
    tasks
      .filter((t) => t.project.id === id && comments.some((c) => c.taskId === t.id))
      .map((t) => {
        const own = comments.filter((c) => c.taskId === t.id);
        const last = own.map((c) => c.createdAt).sort().at(-1) ?? null;
        return { __typename: 'TaskThreadSummary', id: `cv-${t.id}`, slug: `task-${t.id}`, task: t, messageCount: own.length, lastMessageAt: last };
      })
      .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt))),
  permissionRules: [],
  ...extra,
});
const key = (id) => id.slice(2);
const member = (u, role) => ({ __typename: 'ProjectMember', user: u, role, invitedBy: null, createdAt: ago(60 * 24 * 60), pending: false });

P.perso = project('p-perso', 'Espace de Camille', 'perso-camille', 'Mon espace personnel : chats et brouillons.', null, { isPersonal: true });
P.site = project('p-site', 'Site vitrine Toolso', 'site-vitrine', 'Le site public toolso.io : pages produit, tarifs, blog et formulaire de contact (Astro).', 'https://github.com/toolso/site-vitrine', { taskModels: { low: 'claude-sonnet-5-5' } });
P.api = project('p-api', 'API Facturation', 'api-facturation', 'Service de facturation : abonnements Stripe, factures PDF, relances et exports comptables.', 'https://github.com/toolso/api-facturation');
P.mobile = project('p-mobile', 'Appli Scouts', 'appli-scouts', 'Application mobile des groupes scouts : inscriptions aux camps, cotisations et messagerie des parents.', 'https://github.com/toolso/appli-scouts');
// Camille n'y est que lectrice : ses sessions s'ouvrent en lecture seule (ni saisie, ni actions).
P.data = project('p-data', 'Data & reporting', 'data-reporting', 'Tableaux de bord et rapports hebdomadaires (dbt, Metabase).', 'https://github.com/toolso/data-reporting', { myRole: 'VIEWER' });
// Camille n'y est qu'invitée (rôle invité) : seules les conversations lui sont ouvertes (sidebar « Conversations », onglet unique).
P.client = project('p-client', 'Agence Horizon', 'agence-horizon', 'Refonte du site de l’agence Horizon, menée par leur équipe ; nous y sommes invités pour suivre les échanges.', 'https://github.com/horizon/site', { myRole: 'GUEST', isMember: true });
const teamProjects = [P.site, P.api, P.mobile, P.data];
/** Projets où Camille n'est qu'invitée (requête guestProjects). */
const guestProjects = [P.client];
// Budgets mensuels (page Consommation) : l'API Facturation a passé 80 %, l'appli Scouts est loin du sien.
const PROJECT_MONTH = { 'p-perso': 3.1, 'p-site': 38.4, 'p-api': 104.2, 'p-mobile': 27.5, 'p-data': 12.9 };
for (const p of [P.perso, ...teamProjects]) {
  p.monthUsd = PROJECT_MONTH[p.id];
  p.monthlyBudgetUsd = p.id === 'p-api' ? 120 : p.id === 'p-mobile' ? 150 : null;
}

// ---- Agents de projet ---------------------------------------------------------------------------------------------

const agent = (id, u, p, kind, emoji, color, description) => {
  const a = {
    __typename: 'Agent', id, user: u, name: u.name, project: p, kind, avatar: { __typename: 'AgentAvatar', emoji, color }, description,
    instructions: description, taskFolder: true, defaults: {}, contextFolder: null, enabled: true, archivedAt: null, canManage: true,
    triggers: { __typename: 'AgentTriggers', taskCreated: kind === 'PRODUCT_MANAGER', taskCreatedTag: null, threadFollowed: true, prMerged: false, deployed: kind === 'PRODUCT_MANAGER', taskReady: kind === 'DEVELOPER', taskReadyTag: null },
    actions: kind === 'PRODUCT_MANAGER' ? [{ __typename: 'AgentAction', key: 'release', label: 'Préparer une release', instruction: 'Prépare une release.', cron: null, timezone: null, schedule: null }] : [], managers: [],
    stats: () => ({ __typename: 'AgentStats', activeSessions: sessions.filter((s) => s.owner === u && !s.archivedAt).length, sessions: 14, tasks: 9, monthCostUsd: 18.4, totalCostUsd: 61.2, lastActivityAt: ago(12) }),
    sessions: () => sessions.filter((s) => s.owner === u),
    tasks: () => tasks.filter((t) => t.assignee?.email === u.email),
    createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24),
  };
  u.agent = a;
  return a;
};
const agents = [
  agent('a-chris', U.chris, P.site, 'PRODUCT_MANAGER', '🧭', '#7c5cff', 'Cadre les demandes, anime les tâches et prépare les releases.'),
  agent('a-max', U.max, P.mobile, 'DEVELOPER', '🛠️', '#d97757', 'Développe les tâches prêtes, ouvre les pull requests et répond aux revues.'),
  agent('a-nora', U.nora, P.api, 'CUSTOM', '🔎', '#2f9e8f', 'Relit les pull requests : sécurité, tests manquants, cas limites.'),
];
// Comptes prêtés : mon compte GitHub prêté à Chris en écriture avec fusion permise, GitLab en lecture seule.
agents[0].delegations = { __typename: 'AgentDelegations', claude: null, github: U.me, githubReadOnly: false, githubPullRequests: true, githubMerge: true, gitlab: U.me, gitlabReadOnly: true, gitlabPullRequests: false, gitlabMerge: false, git: U.me, gitReadOnly: true };

// ---- Sessions -----------------------------------------------------------------------------------------------------

const sessions = [];
function session(id, p, name, opts = {}) {
  const branch = opts.branch === undefined ? id.replace(/^s-/, '') : opts.branch;
  const s = {
    __typename: 'Session',
    id,
    kind: opts.kind ?? 'SESSION',
    project: p,
    name,
    provider: 'claude',
    status: opts.status ?? 'RUNNING',
    activity: opts.activity ?? (opts.status && opts.status !== 'RUNNING' ? null : 'IDLE'),
    owner: opts.owner ?? U.me,
    requestedBy: opts.requestedBy ?? null,
    takenOverBy: opts.takenOverBy ?? null,
    viewerCanTakeOver: Boolean(opts.owner?.agent && opts.requestedBy === U.me),
    agent: opts.owner?.agent ?? null,
    archivedAt: opts.archivedAt ?? null,
    formerWorksession: null,
    parentSession: opts.parent ?? null,
    childSessions: [],
    workflowRun: null,
    prompt: opts.prompt ?? name,
    promptAttachments: [],
    config: { model: opts.model ?? 'default', permissionMode: opts.permissionMode ?? 'default' },
    model: opts.model ?? 'claude-opus-5-5',
    externalId: null,
    exitCode: opts.status === 'FAILED' ? 1 : null,
    error: opts.error ?? null,
    costUsd: opts.cost ?? 0.42,
    createdAt: ago(opts.age ?? 90),
    updatedAt: ago(opts.updated ?? 3),
    startedAt: ago(opts.age ?? 90),
    endedAt: opts.status && opts.status !== 'RUNNING' ? ago(opts.updated ?? 30) : null,
    browserActive: false,
    subagents: opts.subagents ?? [],
    pages: [],
    liveDraft: null,
    queuedAt: null,
    queuePosition: null,
    review: null,
    shares: [],
    schedule: null,
    cleanup: { __typename: 'SessionCleanup', retentionDays: null, contextAction: null, contextMaxTokens: null },
    contextTokens: opts.tokens ?? 38_000,
    context: { __typename: 'SessionContext', tokens: opts.tokens ?? 38_000, warnTokens: 150_000, overThreshold: false, model: 'claude-opus-5-5', windowTokens: 200_000, share: (opts.tokens ?? 38_000) / 200_000, coldTurnUsd: 0.21 },
    task: () => tasks.find((t) => t.sessionIds?.includes(id)) ?? null,
    tasks: () => tasks.filter((t) => t.sessionIds?.includes(id)),
    requests: (args = {}) => requests.filter((r) => r.session === s && (!args.status || r.status === args.status)),
    pendingRequestCount: () => requests.filter((r) => r.session === s && r.status === 'PENDING').length,
    events: (args = {}) => {
      const every = (eventsBySession[id] ?? defaultEvents)(s);
      // toolUseId : le fil d'un sous-agent du CLI (ses messages et l'appel qui l'a lancé), comme le serveur.
      const all = args.toolUseId ? every.filter((e) => e.payload.parent_tool_use_id === args.toolUseId || (Array.isArray(e.payload.message?.content) && e.payload.message.content.some((b) => b.id === args.toolUseId))) : every;
      const start = args.after ? all.findIndex((e) => e.id === args.after) + 1 : 0;
      return start <= 0 && args.after ? [] : all.slice(start, args.limit ? start + args.limit : undefined);
    },
  };
  s.worksession =
    branch && opts.kind !== 'CHAT'
      ? {
          __typename: 'Worksession', id: `w-${id.slice(2)}`, project: p, name: branch, branch, label: name, customLabel: null,
          path: `/home/skipper/skipper-workspaces/${p.slug}.worktrees/${branch}`, exists: true,
          git: { __typename: 'WorkspaceGit', branch, commit: 'a41c9e2' }, archivedAt: null, pullRequest: null,
          trackedPullRequest: () => pullRequests.find((pr) => pr.headBranch === branch) ?? null,
          task: () => s.task(), createdAt: s.createdAt, sessions: [s], terminals: [],
        }
      : null;
  sessions.push(s);
  return s;
}
const sessionsOf = (projectId, args = {}) =>
  sessions
    .filter((s) => s.project.id === projectId && s.kind === 'SESSION' && !s.archivedAt && (!args.status || s.status === args.status))
    .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));

const S = {
  tarifs: session('s-page-tarifs', P.site, 'Refonte de la page tarifs', { activity: 'BUSY', age: 70, updated: 0, cost: 1.86, tokens: 64_000,
    // Sous-agents du CLI en cours (outil Agent) : puce sur la carte repliée, une ligne chacun dépliée.
    subagents: [
      { __typename: 'SessionSubagent', id: 'task-cards', toolUseId: 'tu-cards', description: 'Cartes des trois offres', agentType: 'fork', background: true, startedAt: ago(14), toolUses: 23, lastTool: 'Edit', summary: null },
      { __typename: 'SessionSubagent', id: 'task-compare', toolUseId: 'tu-compare', description: 'Tableau comparatif détaillé', agentType: 'fork', background: true, startedAt: ago(9), toolUses: 11, lastTool: 'Read', summary: null },
      { __typename: 'SessionSubagent', id: 'task-explore', toolUseId: 'tu-explore', description: 'Explore les styles du site', agentType: 'Explore', background: false, startedAt: ago(2), toolUses: 4, lastTool: 'Grep', summary: null },
    ],
    prompt: 'Refonds la page /tarifs : trois offres en cartes, un comparatif détaillé dessous et une FAQ. Garde le style du site.' }),
  // Sous-agent lancé par l'agent de la session « page tarifs » (sessions.create) : son propre dossier, rangé sous sa parente.
  tarifsFaq: session('s-tarifs-faq', P.site, 'Rédiger la FAQ des tarifs', { activity: 'BUSY', age: 20, updated: 0, cost: 0.38, model: 'claude-sonnet-5-5', prompt: 'Rédige la FAQ de la page /tarifs (8 questions).' }),
  contact: session('s-formulaire-contact', P.site, 'Formulaire de contact sur mobile', { model: 'claude-sonnet-5-5', age: 60 * 5, updated: 25, cost: 0.74 }),
  blog: session('s-chris-tri-blog', P.site, 'Tri des demandes du blog', { owner: U.chris, requestedBy: U.me, age: 60 * 3, updated: 40, cost: 0.31, branch: null }),
  pdf: session('s-export-pdf', P.api, 'Export des factures en PDF', { owner: U.hugo, activity: 'BUSY', age: 50, updated: 1, cost: 1.12 }),
  revuePdf: session('s-nora-revue-118', P.api, 'Revue de la PR #118', { model: 'claude-haiku-5-5', owner: U.nora, requestedBy: U.hugo, age: 25, updated: 4, cost: 0.22, branch: null }),
  stripe: session('s-stripe-2026-10', P.api, 'Migration vers l’API Stripe 2026-10', { status: 'COMPLETED', age: 60 * 28, updated: 60 * 22, cost: 3.4 }),
  relances: session('s-relances-impayes', P.api, 'Relances automatiques des impayés', { status: 'INTERRUPTED', age: 60 * 30, updated: 60 * 20, cost: 0.95 }),
  push: session('s-notifs-camps', P.mobile, 'Notifications push des camps', { owner: U.lea, status: 'FAILED', age: 60 * 6, updated: 60 * 2, cost: 0.58, error: 'npm run test : 2 tests en échec (CampReminder.test.ts)' }),
  revue: session('s-max-cotisations', P.mobile, 'Paiement des cotisations en trois fois', { owner: U.max, requestedBy: U.lea, takenOverBy: U.lea, activity: 'BUSY', age: 35, updated: 0, cost: 0.66 }),
  hebdo: session('s-rapport-hebdo', P.data, 'Rapport du lundi · 03/11 08:00', { owner: U.hugo, model: 'claude-sonnet-5-5', status: 'COMPLETED', age: 60 * 24 * 4, updated: 60 * 24 * 4 - 12, cost: 2.1 }),
  revueBases: session('s-revue-bases-0711', P.site, 'Revue des bases · 07/11 12:35', { activity: 'BUSY', age: 12, updated: 0, cost: 0.31, model: 'claude-sonnet-5-5' }),
  revueBasesHier: session('s-revue-bases-0611', P.site, 'Revue des bases · 06/11 12:35', { status: 'COMPLETED', age: 60 * 24, updated: 60 * 24 - 9, cost: 0.27, model: 'claude-sonnet-5-5' }),
  // Session de travail de l'espace personnel (projet sans dépôt git) : son explorateur montre aussi le dossier du projet.
  budget: session('s-budget-camp', P.perso, 'Budget du camp d’été', { status: 'COMPLETED', age: 60 * 30, updated: 60 * 29, cost: 0.61 }),
  chat1: session('c-idees-blog', P.perso, 'Idées d’articles pour le blog', { kind: 'CHAT', age: 60 * 2, updated: 50, cost: 0.08 }),
  chat2: session('c-compte-rendu', P.perso, 'Résumé du comité de pilotage', { kind: 'CHAT', age: 60 * 26, updated: 60 * 25, cost: 0.05 }),
  chat3: session('c-mail-client', P.perso, 'Réponse à un client mécontent', { kind: 'CHAT', age: 60 * 50, updated: 60 * 49, cost: 0.03 }),
};
// Planifications : objets du projet ; chaque exécution lance sa propre session (rangées sous la planification dans la sidebar).
const schedule = (id, p, name, owner, over = {}) => ({
  __typename: 'SessionSchedule', id, name, customName: name, project: p, owner, agent: null, requestedBy: null, provider: 'claude',
  config: { permissionMode: 'bypassPermissions', model: 'claude-sonnet-5-5' }, cron: '0 8 * * 1', timezone: 'Europe/Paris',
  prompt: 'Prépare le rapport hebdomadaire des inscriptions et publie-le.', enabled: true, endAfterRun: true, archivePolicy: 'PREVIOUS_ON_RUN',
  archiveAfterMinutes: null, allowedTools: [], maxRunUsd: null, monthlyBudgetUsd: null, monthUsd: 0, nextRunAt: inDays(5), lastRunAt: ago(60 * 9), lastResult: null, createdAt: ago(60 * 24 * 30), updatedAt: ago(60 * 24), runs: [], activeSessions: [], ...over,
});
const scheduleRun = (id, s, status, startedMin, over = {}) => ({
  __typename: 'ScheduleRun', id, trigger: 'SCHEDULE', triggeredBy: null, status, scheduledFor: ago(startedMin), startedAt: ago(startedMin),
  finishedAt: status === 'RUNNING' ? null : ago(startedMin - 9), durationMs: status === 'RUNNING' ? null : 9 * 60_000, costUsd: s ? s.costUsd : null,
  message: null, answer: status === 'DONE' ? 'Aucune anomalie : 12 tables vérifiées, index à jour.' : null, session: s, ...over,
});
// Pages partagées : une à moi (fenêtre « Partager »), une partagée avec moi avec un message (bandeau du message).
const demoSharedPage = (id, title, owner, members, extra = {}) => ({
  __typename: 'SharedPage', id, title, description: null, owner, linkAccess: false, projectAccess: false, version: 1, createdAt: ago(60 * 24), updatedAt: ago(60 * 3),
  members: members.map(([u, message]) => ({ __typename: 'SharedPageMember', user: u, addedBy: owner, addedAt: ago(60 * 20), message })),
  versions: [{ __typename: 'SharedPageVersion', version: 1, size: 18_400, createdBy: owner, createdAt: ago(60 * 24), kind: extra.kind ?? 'PAGE', refreshMinutes: extra.refreshMinutes ?? null, sourceCount: extra.kind === 'DATA' ? (extra.sources ?? []).length : null }],
  project: null, session: null, sourcePath: null, comments: [], openComments: 0, agentHandoff: 'MANUAL', historyEnabled: true, kind: 'PAGE', refreshMinutes: null, dataRefreshedAt: null, sources: [], alerts: [], favorite: false,
  viewerAccess: { __typename: 'SharedPageViewerAccess', owner: owner === U.me, member: owner !== U.me, admin: owner === U.me },
  ...extra,
});
const sharedPagesDemo = [
  demoSharedPage('page-offre', 'Proposition commerciale 2027', U.me, [[U.hugo, null], [user('u-claire', 'claire.martin@client.fr', 'claire.martin@client.fr', { isGuest: false, lastLoginAt: null }), 'Bonjour Claire, voici notre proposition.']]),
  demoSharedPage('page-audit', 'Audit des performances du portail', U.lea, [[U.me, "Camille, voici l'audit dont on a parlé ce matin.\nJ'aimerais ton avis sur la partie cache avant jeudi : commente directement sur la page."]]),
];
// Le sous-agent rattaché à sa parente (référence posée après la création des deux sessions).
S.tarifsFaq.parentSession = S.tarifs;
S.tarifs.childSessions = [S.tarifsFaq];
// Pages publiées depuis une session : onglets de la sous-barre de son dossier (au-delà de 3, un onglet « Pages » à menu).
S.tarifs.pages = [
  demoSharedPage('page-maquette-tarifs', 'Maquette des trois offres', U.me, [], { version: 3, openComments: 2, session: S.tarifs, project: P.site }),
  sharedPagesDemo[0],
];
S.hebdo.pages = ['Inscriptions de la semaine', 'Camps les plus demandés', 'Désinscriptions', 'Comparatif 2025'].map((t, i) =>
  demoSharedPage(`page-hebdo-${i + 1}`, t, U.hugo, [[U.me, null]], { linkAccess: i === 0, openComments: i === 1 ? 1 : 0, session: S.hebdo, project: P.data }),
);
// Artefact de données : sources SQL et script, l'une en erreur, rafraîchi toutes les heures.
const dataSourcesDemo = [
  { __typename: 'SharedPageSource', id: 'src-inscriptions', name: 'inscriptions', kind: 'sql', item: 'base', database: null, query: "SELECT date_trunc('day', created_at)::date AS jour, count(*) AS n\nFROM inscriptions\nWHERE created_at > now() - interval '30 days'\nGROUP BY 1 ORDER BY 1", interpreter: null, code: null, timeoutSeconds: null, status: 'ok', error: null, rowCount: 30, durationMs: 412, refreshedAt: ago(12), attemptedAt: ago(12) },
  { __typename: 'SharedPageSource', id: 'src-camps', name: 'camps', kind: 'sql', item: 'base', database: null, query: 'SELECT camp, count(*) AS n FROM inscriptions GROUP BY 1 ORDER BY 2 DESC LIMIT 8', interpreter: null, code: null, timeoutSeconds: null, status: 'error', error: 'relation « inscriptions_v2 » inexistante', rowCount: 8, durationMs: 35, refreshedAt: ago(60 * 25), attemptedAt: ago(12) },
  { __typename: 'SharedPageSource', id: 'src-meteo', name: 'meteo', kind: 'script', item: null, database: null, query: null, interpreter: 'node', code: "const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=45.9&longitude=6.1&daily=temperature_2m_max');\nconsole.log(JSON.stringify(await r.json()));", timeoutSeconds: 60, status: 'ok', error: null, rowCount: null, durationMs: 1210, refreshedAt: ago(12), attemptedAt: ago(12) },
];
// Alertes des sources : une déclenchée (convoque un agent), une normale avec anti-rebond, une sur l'échec d'une source.
const demoAlert = (extra) => ({ __typename: 'SharedPageAlert', path: '', value: null, match: 'any', for: 1, notify: 'owner', notifyResolved: true, agent: null, launchesSession: false, prompt: null, message: null, streak: 0, lastValue: null, evaluatedAt: ago(12), triggeredAt: null, resolvedAt: null, fireCount: 0, sessionId: null, error: null, ...extra });
const dataAlertsDemo = [
  demoAlert({ id: 'alert-baisse', name: 'baisse_inscriptions', source: 'inscriptions', path: 'rows.*.n', op: '<', value: 5, condition: 'inscriptions.rows.*.n < 5 (au moins une valeur)', message: 'Moins de 5 inscriptions sur une journée', state: 'firing', lastValue: 3, triggeredAt: ago(12), fireCount: 2, agent: 'Ben', launchesSession: true, prompt: 'Regarde ce qui a freiné les inscriptions ce jour-là et ouvre une tâche.', sessionId: S.hebdo.id }),
  demoAlert({ id: 'alert-pic', name: 'pic_inscriptions', source: 'inscriptions', path: 'rows.*.n', op: '>', value: 200, for: 2, condition: 'inscriptions.rows.*.n > 200 (au moins une valeur), 2 fois de suite', notify: 'project', state: 'ok', lastValue: [42, 38, 51], resolvedAt: ago(60 * 30), fireCount: 1 }),
  demoAlert({ id: 'alert-camps', name: 'camps_en_panne', source: 'camps', op: 'failed', condition: 'source camps en erreur', state: 'unknown', evaluatedAt: null }),
];
S.hebdo.pages.unshift(demoSharedPage('page-data-inscriptions', 'Inscriptions : tableau de bord', U.me, [[U.hugo, null]], { kind: 'DATA', refreshMinutes: 60, dataRefreshedAt: ago(12), sources: dataSourcesDemo, alerts: dataAlertsDemo, session: S.hebdo, project: P.data, version: 4 }));
// Chaque version d'un artefact garde son type et ses sources : quatre versions du tableau de bord, la première en page simple.
S.hebdo.pages[0].versions = [4, 3, 2, 1].map((v) => ({ __typename: 'SharedPageVersion', version: v, size: 21_000 - v * 600, createdBy: U.me, createdAt: ago(60 * 24 * (5 - v)), kind: v === 1 ? 'PAGE' : 'DATA', refreshMinutes: v >= 3 ? 60 : null, sourceCount: v === 1 ? null : v === 2 ? 2 : 3 }));
S.tarifs.pages.push(demoSharedPage('page-slides-offres', 'Présentation des trois offres', U.me, [[U.hugo, null]], { kind: 'SLIDES', session: S.tarifs, project: P.site, version: 2 }));
sharedPagesDemo.push(...S.tarifs.pages.slice(0, 1), ...S.hebdo.pages, S.tarifs.pages[2]);
// Artefact de données épinglé en tuile du tableau de bord du site (servi compact par le serveur factice : /api/shared/page-data-ca).
sharedPagesDemo.push(demoSharedPage('page-data-ca', 'Chiffre d’affaires projeté', U.me, [], { kind: 'DATA', refreshMinutes: 360, dataRefreshedAt: ago(30), project: P.site, projectAccess: true, version: 1 }));
// Favoris (section « Favoris » de la sidebar) : le tableau de bord des inscriptions et la présentation des offres.
for (const pg of sharedPagesDemo) if (pg.id === 'page-data-inscriptions' || pg.id === 'page-slides-offres') pg.favorite = true;

export const schedules = [
  schedule('sch-rapport-lundi', P.data, 'Rapport du lundi', U.hugo, { allowedTools: ['Bash(npm run report *)'], lastRunAt: ago(60 * 24 * 4) }),
  // Planification au nom d'un agent : ses comptes et son budget, mise par moi.
  schedule('sch-tri-chris', P.site, 'Tri des nouvelles tâches', U.chris, { agent: agents[0], requestedBy: U.me, cron: '0 9 * * 1-5', prompt: 'Trie les tâches créées depuis hier : priorité, étiquettes, et passe à « prête » celles qui sont cadrées.', nextRunAt: inDays(1), lastRunAt: null }),
  schedule('sch-revue-bases', P.site, 'Revue des bases', U.me, { cron: '35 12 * * *', prompt: 'Passe en revue les bases de production : tailles, index inutilisés, requêtes lentes. Signale ce qui mérite une action.', nextRunAt: inDays(1), lastRunAt: ago(12), maxRunUsd: 2, monthlyBudgetUsd: 30, monthUsd: 11.4 }),
];
schedules[0].runs = [scheduleRun('run-lundi-1', S.hebdo, 'DONE', 60 * 24 * 4)];
schedules[2].runs = [scheduleRun('run-bases-2', S.revueBases, 'RUNNING', 12), scheduleRun('run-bases-1', S.revueBasesHier, 'DONE', 60 * 24)];
for (const sc of schedules) {
  sc.activeSessions = sc.runs.map((r) => r.session).filter(Boolean);
  for (const s of sc.activeSessions) s.schedule = sc;
}
const chats = sessions.filter((s) => s.kind === 'CHAT');
// Lien public de lecture de la session « page tarifs » (/share/<DEMO_SHARE_TOKEN>, servi par le mock).
export const DEMO_SHARE_TOKEN = 'demo-partage-page-tarifs-0123456789abcdefgh';
S.tarifs.shares = [{ __typename: 'SessionShare', id: 'sh-1', url: `${'http://localhost'}/share/${DEMO_SHARE_TOKEN}`, expiresAt: inDays(6), createdAt: ago(60 * 24), createdBy: U.me }];

// ---- Transcripts --------------------------------------------------------------------------------------------------

let eventSeq = 0;
const ev = (s, minutesAgo, type, payload) => ({ __typename: 'SessionEvent', id: `${s.id}-e${++eventSeq}`, sessionId: s.id, type, payload, createdAt: ago(minutesAgo) });
const said = (s, m, text) => ev(s, m, 'claude.assistant', { message: { content: [{ type: 'text', text }] } });
const tool = (s, m, id, name, input, result) => [
  ev(s, m, 'claude.assistant', { message: { content: [{ type: 'tool_use', id, name, input }] } }),
  ev(s, m, 'claude.user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } }),
];
const done = (s, m, turns, usd) => ev(s, m, 'claude.result', { subtype: 'success', is_error: false, num_turns: turns, duration_ms: turns * 9_000, total_cost_usd: usd });
const memo = (fn) => {
  let cache;
  return (s) => (cache ??= fn(s));
};
const eventsBySession = {
  'c-idees-blog': memo((s) => [
    ev(s, 120, 'instruction', { text: 'Propose-moi cinq idées d’articles pour le blog de Toolso, pour des dirigeants de PME.' }),
    said(s, 119, 'Voici cinq pistes :\n\n1. **Confier une tâche à un agent sans perdre la main** : ce qu’on délègue, ce qu’on valide.\n2. **Trois semaines avec un Product Manager agent** : retour d’expérience chiffré.\n3. **Le coût réel d’une fonctionnalité** livrée par des agents, en jours-homme.\n4. **Sécurité : ce que l’agent voit (et ne voit pas)** de vos accès.\n5. **De l’idée à la mise en production en une journée** : un cas client.\n\nJe peux développer le plan de l’une d’elles.'),
    done(s, 119, 1, 0.04),
    ev(s, 52, 'instruction', { text: 'Développe la 3.' }),
    said(s, 50, '## Le coût réel d’une fonctionnalité\n\n- **Accroche** : « combien coûte ce bouton ? » — la question que tout dirigeant pose.\n- **Méthode** : temps humain de cadrage et de revue + travail des agents en crédits.\n- **Exemple** : export PDF des factures, 2 h de cadrage, 1,1 crédit d’agent, une revue de 20 min.\n- **Conclusion** : le coût se déplace vers le cadrage et la revue.'),
    done(s, 50, 1, 0.04),
  ]),
  's-page-tarifs': memo((s) => [
    ev(s, 70, 'instruction', { text: s.prompt }),
    said(s, 69, 'Je commence par regarder la page actuelle et les composants disponibles.'),
    ...tool(s, 69, 't1', 'Glob', { pattern: 'src/pages/**/*.astro' }, 'src/pages/index.astro\nsrc/pages/tarifs.astro\nsrc/pages/blog/[slug].astro\nsrc/pages/contact.astro'),
    ...tool(s, 68, 't2', 'Read', { file_path: '/workspace/src/pages/tarifs.astro' }, '---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="Tarifs">\n  <h1>Nos tarifs</h1>\n  …'),
    said(s, 66, 'La page tient en un tableau unique. Je crée un composant `PricingCard` et je réécris la page en trois sections : offres, comparatif, FAQ.'),
    ...tool(s, 64, 't3', 'Write', { file_path: '/workspace/src/components/PricingCard.astro', content: '---\nconst { name, price, features, highlighted } = Astro.props;\n---\n<article class:list={["card", { highlighted }]}>…</article>' }, 'File created successfully'),
    ...tool(s, 60, 't4', 'Edit', { file_path: '/workspace/src/pages/tarifs.astro', old_string: '<h1>Nos tarifs</h1>', new_string: '<h1>Des offres simples, sans engagement</h1>\n<section class="offers">…</section>' }, 'The file has been updated.'),
    said(s, 58, 'Les trois offres (Découverte, Équipe, Entreprise) sont en place, l’offre Équipe est mise en avant. Je vérifie le build avant de passer au comparatif.'),
    ...tool(s, 57, 't5', 'Bash', { command: 'npm run build', description: 'Build du site' }, '> astro build\n\n 14 page(s) built in 6.21s\n Complete!'),
    done(s, 56, 9, 0.92),
    ev(s, 20, 'instruction', { text: 'Super. Ajoute la FAQ avec les questions du support, et un interrupteur mensuel / annuel (-20 %).', author: { type: 'user', id: U.hugo.id, name: U.hugo.name, email: U.hugo.email } }),
    ...tool(s, 18, 't6', 'Read', { file_path: '/workspace/docs/faq-support.md' }, '## Puis-je changer d’offre ?\nOui, à tout moment…\n## Les agents ont-ils accès à mes données ?\n…'),
    said(s, 12, 'J’ajoute l’interrupteur de période : les prix annuels sont calculés à partir des prix mensuels (-20 %), et la FAQ reprend les six questions du support en accordéon.'),
    ...tool(s, 9, 't7', 'Edit', { file_path: '/workspace/src/pages/tarifs.astro', old_string: '<section class="offers">', new_string: '<BillingToggle />\n<section class="offers">' }, 'The file has been updated.'),
    ...tool(s, 8, 't8', 'mcp__tasks__create', { title: 'Traduire la page tarifs en anglais', priority: 'low' }, 'Tâche créée'),
    ev(s, 8, 'task', { action: 'created', taskId: 't-3', projectId: 'p-site', title: 'Traduire la page tarifs en anglais', status: 'todo', priority: 'low' }),
    ...tool(s, 7, 't9', 'mcp__context__write', { path: 'conventions/tarifs', content: '…' }, 'Mise à jour : conventions/tarifs (version 2)'),
    ev(s, 7, 'context', { action: 'updated', projectId: 'p-site', instructionId: 'i-tarifs', path: 'conventions/tarifs', description: 'Prix annuels = prix mensuels −20 %, arrondis à l’euro', version: 2, agentId: null, library: null, changeNote: 'Remise annuelle' }),
    // Sous-agents du CLI (outil Agent) : l'appel dans le fil de la session, leurs messages marqués parent_tool_use_id.
    ev(s, 14, 'claude.assistant', { message: { content: [{ type: 'tool_use', id: 'tu-cards', name: 'Agent', input: { description: 'Cartes des trois offres', subagent_type: 'fork', run_in_background: true, prompt: 'Peaufine le composant PricingCard : badge « recommandé » sur l’offre Équipe, alignement des listes de fonctionnalités, rendu mobile en une colonne.' } }] } }),
    ev(s, 9, 'claude.assistant', { message: { content: [{ type: 'tool_use', id: 'tu-compare', name: 'Agent', input: { description: 'Tableau comparatif détaillé', subagent_type: 'fork', run_in_background: true, prompt: 'Construis le tableau comparatif des trois offres sous les cartes.' } }] } }),
    ev(s, 2, 'claude.assistant', { message: { content: [{ type: 'tool_use', id: 'tu-explore', name: 'Agent', input: { description: 'Explore les styles du site', subagent_type: 'Explore', prompt: 'Liste les variables CSS et composants de mise en forme réutilisables.' } }] } }),
    ev(s, 13, 'claude.assistant', { parent_tool_use_id: 'tu-cards', message: { content: [{ type: 'text', text: 'Je relis le composant actuel avant de le modifier.' }] } }),
    ...tool(s, 13, 'tc1', 'Read', { file_path: '/workspace/src/components/PricingCard.astro' }, '---\nconst { name, price, features, highlighted } = Astro.props;\n---').map((e) => ({ ...e, payload: { ...e.payload, parent_tool_use_id: 'tu-cards' } })),
    ...tool(s, 11, 'tc2', 'Edit', { file_path: '/workspace/src/components/PricingCard.astro', old_string: '<article', new_string: '{highlighted && <span class="badge">Recommandé</span>}\n<article' }, 'The file has been updated.').map((e) => ({ ...e, payload: { ...e.payload, parent_tool_use_id: 'tu-cards' } })),
    ev(s, 10, 'claude.assistant', { parent_tool_use_id: 'tu-cards', message: { content: [{ type: 'text', text: 'Badge ajouté. Je passe au rendu mobile : une colonne sous 640 px.' }] } }),
    said(s, 1, 'Il me reste à relancer le build et à pousser la branche : j’ai besoin de ton accord pour la commande.'),
  ]),
};
const defaultEvents = (s) => {
  const list = eventsBySession[s.id];
  if (list) return list(s);
  eventsBySession[s.id] = memo((x) => [
    ev(x, 60, 'instruction', { text: x.prompt }),
    said(x, 58, `Je regarde le code concerné par « ${x.name} » et je reviens avec un plan.`),
    ...tool(x, 55, `${x.id}-t1`, 'Grep', { pattern: x.name.split(' ')[0].toLowerCase(), path: 'src' }, 'src/index.ts\nsrc/services/main.ts'),
    said(x, 40, 'Plan :\n\n1. isoler la logique dans un service dédié ;\n2. ajouter les tests ;\n3. brancher l’interface.\n\nJe commence.'),
    done(x, 39, 4, 0.3),
  ]);
  return eventsBySession[s.id](s);
};

// ---- Tâches -------------------------------------------------------------------------------------------------------

let taskSeq = 0;
const tasks = [];
function task(p, title, status, priority, opts = {}) {
  const idleSince = () => {
    const own = opts.sessions ?? [];
    if (status !== 'IN_PROGRESS' || !own.length || own.some((s) => ['RUNNING', 'PENDING', 'QUEUED'].includes(s.status))) return null;
    if (pullRequests.some((pr) => pr.task === t && pr.status === 'OPEN')) return null;
    return own.map((s) => s.endedAt ?? s.updatedAt).sort().at(-1) ?? null;
  };
  const t = {
    __typename: 'Task',
    id: `t-${++taskSeq}`,
    project: p,
    title,
    summary: opts.summary ?? null,
    description: opts.description ?? `${title}.\n\nCritères d’acceptation : le comportement est couvert par un test et la documentation est à jour.`,
    status,
    statusTag: opts.statusTag ?? null,
    tags: opts.tags ?? [],
    priority,
    sessionIds: opts.sessions?.map((s) => s.id) ?? [],
    session: () => opts.sessions?.[0] ?? null,
    sessionsInCharge: () => (status === 'IN_PROGRESS' ? opts.sessions ?? [] : []),
    // La conversation que « Reprendre » relance : la première session de la tâche, s'il y en a une.
    resumableSession: () => opts.sessions?.[0] ?? null,
    sessions: () => opts.sessions ?? [],
    costUsd: (opts.sessions ?? []).reduce((n, s) => n + s.costUsd, 0),
    sessionCosts: () => (opts.sessions ?? []).map((s) => ({ __typename: 'TaskSessionCost', session: s, usd: s.costUsd })),
    createdByType: opts.byAgent ? 'session' : 'user',
    createdBySession: null,
    dueDate: opts.due ?? null,
    customFields: [],
    assignee: opts.assignee ? person(opts.assignee) : null,
    reporter: person(opts.reporter ?? U.me),
    attachmentCount: 0,
    attachments: [],
    reactions: [],
    mentionables: () => [...people, U.chris, U.max, U.nora].map((u) => ({ __typename: 'TaskMentionable', kind: 'person', id: u.id, label: u.name, detail: u.email, text: `@${u.name}` })),
    branch: opts.sessions?.[0]?.worksession?.branch ?? null,
    worksession: () => opts.sessions?.[0]?.worksession ?? null,
    pullRequest: null,
    pullRequests: () => pullRequests.filter((pr) => pr.task === t),
    // Sans agent au travail (backend : ATTENTION_JOIN) : en cours, des sessions en charge, aucune ne tourne, pas de PR
    // ouverte. « En attente » avec une date de réveil future (opts.wakeAt), « agent arrêté » sinon (simplifié : le
    // backend tient aussi compte de l'étiquette d'état, d'un compte rendu dans le fil et des sessions en erreur).
    stalledSince: () => (opts.wakeAt ? null : idleSince()),
    waitingSince: () => (opts.wakeAt ? idleSince() : null),
    wakeAt: opts.wakeAt ?? null,
    wakeNote: opts.wakeNote ?? null,
    // Sans dépendance (sinon le serveur factice invente des « bloquée par » sur toutes les tâches).
    dependsOn: opts.blockedBy ?? [],
    blockedBy: opts.blockedBy ?? [],
    dependents: [],
    autoStartWhenUnblocked: false,
    autoStartBy: null,
    createdAt: ago(opts.age ?? 60 * 24 * 3),
    updatedAt: ago(opts.updated ?? 60 * 2),
    completedAt: status === 'DONE' ? ago(opts.updated ?? 60 * 24) : null,
    // Passage en cours : aux deux tiers de la vie de la tâche, avant sa fin pour une terminée.
    startedAt: status === 'IN_PROGRESS' || status === 'DONE' ? ago(Math.min(opts.age ?? 60 * 24 * 3, Math.max((status === 'DONE' ? (opts.updated ?? 60 * 24) : 0) + 60, Math.round((opts.age ?? 60 * 24 * 3) * 0.66)))) : null,
    cancelledAt: status === 'CANCELLED' ? ago(opts.updated ?? 60 * 2) : null,
  };
  t.comments = () => comments.filter((c) => c.taskId === t.id);
  t.commentCount = () => comments.filter((c) => c.taskId === t.id).length;
  tasks.push(t);
  return t;
}
const T = {
  tarifs: task(P.site, 'Refondre la page tarifs (offres, comparatif, FAQ)', 'IN_PROGRESS', 'HIGH', { sessions: [S.tarifs], assignee: U.me, tags: ['site', 'design'], due: day(3), statusTag: 'en revue', summary: 'Rendre la page tarifs lisible en un coup d’œil : trois offres en cartes, un comparatif détaillé et une FAQ, pour réduire les questions au support avant achat.' }),
  contact: task(P.site, 'Le formulaire de contact déborde sur iPhone SE', 'IN_PROGRESS', 'MEDIUM', { sessions: [S.contact], assignee: U.me, tags: ['mobile', 'bug'], summary: 'Sur les petits écrans (iPhone SE), le formulaire de contact sort de la page : le ramener dans la largeur de l’écran.' }),
  seo: task(P.site, 'Balises Open Graph pour les articles du blog', 'TODO', 'LOW', { tags: ['seo'], byAgent: true, reporter: U.chris }),
  cas: task(P.site, 'Page « Cas clients » avec trois témoignages', 'TODO', 'MEDIUM', { tags: ['contenu'], assignee: U.lea, due: day(10) }),
  perf: task(P.site, 'Score Lighthouse mobile au-dessus de 90', 'DONE', 'MEDIUM', { tags: ['perf'], updated: 60 * 24 * 2 }),
  pdf: task(P.api, 'Export des factures en PDF depuis l’espace client', 'IN_PROGRESS', 'URGENT', { sessions: [S.pdf], assignee: U.hugo, tags: ['factures'], due: day(1) }),
  stripe: task(P.api, 'Passer à l’API Stripe 2026-10', 'DONE', 'HIGH', { sessions: [S.stripe], assignee: U.me, tags: ['stripe'], updated: 60 * 22, statusTag: 'à livrer' }),
  relances: task(P.api, 'Relances automatiques des factures impayées (J+7, J+15, J+30)', 'IN_PROGRESS', 'HIGH', { sessions: [S.relances], assignee: U.me, tags: ['factures'], statusTag: 'bloquée', due: day(-1) }),
  tva: task(P.api, 'TVA intracommunautaire sur les factures B2B', 'TODO', 'MEDIUM', { tags: ['compta'] }),
  push: task(P.mobile, 'Rappel push la veille du départ en camp', 'IN_PROGRESS', 'HIGH', { sessions: [S.push], assignee: U.lea, tags: ['notifications'], statusTag: 'surveillance', wakeAt: ago(-60 * 14), wakeNote: 'vérifier que le rappel de 18 h est bien parti et compter les ouvertures' }),
  cotis: task(P.mobile, 'Paiement des cotisations en trois fois', 'IN_PROGRESS', 'MEDIUM', { sessions: [S.revue], assignee: U.max, tags: ['paiement'], reporter: U.lea }),
  hors: task(P.mobile, 'Mode hors ligne pour la fiche sanitaire', 'TODO', 'LOW', { tags: ['offline'] }),
  ios: task(P.mobile, 'Publier la version 2.4 sur l’App Store', 'CANCELLED', 'MEDIUM', { updated: 60 * 24 * 5 }),
  hebdo: task(P.data, 'Rapport hebdomadaire des inscriptions par groupe', 'DONE', 'MEDIUM', { sessions: [S.hebdo], assignee: U.me, tags: ['rapport'], updated: 60 * 9 }),
  churn: task(P.data, 'Tableau de bord du churn mensuel dans Metabase', 'TODO', 'HIGH', { tags: ['metabase'], assignee: U.hugo, due: day(7) }),
};
// Une dépendance : le mode hors ligne attend le paiement en trois fois (groupe « Bloquées » de la liste).
T.hors.dependsOn = T.hors.blockedBy = [T.cotis];
T.cotis.dependents = [T.hors];
// Une tâche « agent arrêté » bloquée (dans À traiter) : « Reprendre » ouvre la modale avec l'avis « En attente d'une autre tâche ».
T.relances.dependsOn = T.relances.blockedBy = [T.tva];
T.tva.dependents = [T.relances];

let commentSeq = 0;
const comments = [];
const comment = (t, author, minutesAgo, body, extra = {}) => {
  const c = {
    __typename: 'TaskComment', id: `tc-${++commentSeq}`, taskId: t.id, parentId: null, authorType: author.kind === 'AGENT' ? 'session' : 'user',
    authorName: author.name, author, authorSession: null, agent: author.agent ?? null, body, mentions: [], reactions: [], attachments: [], editable: author === U.me,
    deletable: author === U.me, attachments: [], createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo), ...extra,
  };
  comments.push(c);
  return c;
};
comment(T.tarifs, U.lea, 60 * 26, 'Le support reçoit beaucoup de questions sur l’offre annuelle : on peut l’afficher directement sur la page ?');
comment(T.tarifs, U.chris, 60 * 25, 'J’ai ajouté l’interrupteur mensuel / annuel aux critères d’acceptation. @Camille Laurent, tu valides la remise de 20 % ?', { authorType: 'agent', authorSession: S.blog });
comment(T.tarifs, U.me, 60 * 24, 'Oui, 20 % sur l’annuel. Go.', { reactions: [{ __typename: 'TaskReaction', emoji: '👍', count: 2, actors: ['Léa Fontaine', 'Chris'], mine: false }] });
// Message écrit par une session pilotée par une personne : signé par la personne, avec un lien discret vers la session.
comment(T.tarifs, U.me, 60 * 23, 'Interrupteur mensuel / annuel en place, remise de 20 % appliquée. Capture mobile jointe à la PR.', { authorType: 'agent', authorName: S.tarifs.name, author: null, authorSession: S.tarifs, editable: false });
comment(T.pdf, U.hugo, 90, 'Le rendu des montants négatifs (avoirs) est à vérifier avec la compta.');
comment(T.relances, U.me, 60 * 20, 'Bloqué tant qu’on n’a pas le modèle d’e-mail validé par le juridique.');
comment(T.pdf, U.nora, 20, 'Revue de la PR #118 : le calcul des totaux arrondit ligne par ligne, ce qui peut décaler d’un centime le total TTC. Voir `InvoicePdf.ts:84`.');
comment(T.cotis, U.max, 30, 'PR ouverte : échéancier calculé côté serveur, trois prélèvements Stripe programmés. Les tests passent.');

// ---- Conversations d'équipe (canaux) ------------------------------------------------------------------------------

let msgSeq = 0;
const messages = [];
const conversations = [];
const channel = (p, slug, name, topic, extra = {}) => {
  const c = {
    __typename: 'Conversation', id: `c-${p.id}-${slug}`, slug, name, topic, archivedAt: null, createdAt: ago(60 * 24 * 40), lastMessageAt: null, lastReadAt: ago(60 * 24 * 3),
    project: p, unreadCount: 0, messageCount: () => messages.filter((m) => m.conversationId === c.id).length,
    mentionables: () => [...people, ...agents.map((a) => a.user)].map((u) => ({ __typename: 'TaskMentionable', kind: 'user', id: u.id, label: u.name, detail: u.kind === 'AGENT' ? 'agent' : u.email, text: `@${u.name}` })),
    // Du plus ancien au plus récent, comme le backend (les séparateurs de jour et le repère « Nouveaux messages » en dépendent).
    messages: () => messages.filter((m) => m.conversationId === c.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    ...extra,
  };
  conversations.push(c);
  return c;
};
const message = (c, author, minutesAgo, body, extra = {}) => {
  const m = {
    __typename: 'Message', id: `msg-${++msgSeq}`, conversationId: c.id, parentId: null, authorType: author.kind === 'AGENT' ? 'agent' : 'human',
    authorName: author.name, author, authorSession: null, agent: author.agent ?? null, body, mentions: [], reactions: [], attachments: [], editable: author === U.me,
    deletable: author === U.me, replyCount: () => messages.filter((r) => r.parentId === m.id).length, lastReplyAt: () => messages.filter((r) => r.parentId === m.id).at(-1)?.createdAt ?? null,
    respondingSessions: [], authorRole: author.kind === 'AGENT' ? 'MEMBER' : author.guestOf ? 'GUEST' : 'MEMBER', createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo), ...extra,
  };
  if (!c.lastMessageAt || m.createdAt > c.lastMessageAt) c.lastMessageAt = m.createdAt;
  messages.push(m);
  return m;
};
const C = {
  siteGeneral: channel(P.site, 'general', 'général', 'Pilotage du site vitrine', { unreadCount: 2 }),
  siteLivraisons: channel(P.site, 'livraisons', 'livraisons', 'Mises en production et releases'),
  siteIdees: channel(P.site, 'idees', 'idées', ''),
  apiGeneral: channel(P.api, 'general', 'général', ''),
  mobileGeneral: channel(P.mobile, 'general', 'général', ''),
  dataGeneral: channel(P.data, 'general', 'général', ''),
  clientGeneral: channel(P.client, 'general', 'général', 'Suivi de la refonte avec l’agence', { unreadCount: 1, lastReadAt: ago(60 * 2) }),
};
const mention = (u) => ({ __typename: 'TaskMention', kind: 'user', id: u.id, label: u.name, text: `@${u.name}` });
const m1 = message(C.siteGeneral, U.me, 60 * 3, '@Chris @Léa Fontaine on vise la mise en ligne de la nouvelle page tarifs ce soir. Qu’est-ce qui bloque encore ?', {
  mentions: [mention(U.chris), mention(U.lea)], reactions: [{ __typename: 'TaskReaction', emoji: '👀', count: 2, actors: ['Chris', 'Léa Fontaine'], mine: false }],
  respondingSessions: () => [S.tarifs],
});
message(C.siteGeneral, U.chris, 60 * 3 - 2, 'Trois choses : la PR #142 attend une relecture, la tâche « Formulaire de contact sur mobile » n’est pas cadrée, et le test de la FAQ échoue sur Safari. Je propose de livrer sans le formulaire : je le cadre pour la suite.', { parentId: m1.id });
message(C.siteGeneral, U.lea, 60 * 3 - 20, 'OK pour moi. @Chris tu passes la tâche à « prête » une fois cadrée ?', { parentId: m1.id, mentions: [mention(U.chris)] });
message(C.siteGeneral, U.chris, 60 * 9, 'Point du matin : 2 PR fusionnées hier, 1 à relire (#142), aucune tâche bloquée. Les demandes du blog sont triées.', {
  reactions: [{ __typename: 'TaskReaction', emoji: '👍', count: 1, actors: ['Camille Laurent'], mine: true }],
});
message(C.siteGeneral, U.hugo, 60 * 26, 'Le support signale que la page tarifs n’affiche pas l’offre annuelle sur mobile. Quelqu’un peut jeter un œil ?', {
  attachments: [{ __typename: 'MessageAttachment', id: 'msg-att-1', name: 'ticket-support-4521.pdf', mediaType: 'application/pdf', size: 184_320, createdAt: ago(60 * 26) }],
});
message(C.siteGeneral, U.claire, 60 * 1, 'Bonjour à tous ! Merci pour l’invitation. Est-ce que la nouvelle page tarifs sera visible sur notre environnement de test avant la mise en ligne ?');
message(C.siteGeneral, U.claire, 60 * 1 - 1, 'Et si oui, à quelle adresse ?');
message(C.clientGeneral, U.hugo, 60 * 24 + 15, 'Bienvenue Camille ! On vous a invitée pour suivre les échanges sur la refonte : n’hésitez pas à poser vos questions ici.');
message(C.clientGeneral, U.me, 60 * 24, 'Merci ! Première question : la maquette de la page d’accueil est-elle figée, ou peut-on encore proposer des retouches ?');
message(C.clientGeneral, U.lea, 60 * 1.5, 'Elle est figée depuis hier, mais les retouches de contenu restent possibles jusqu’à vendredi.');
message(C.siteLivraisons, U.me, 60 * 24 * 2, 'v1.7 en production. Rien à signaler sur les métriques.', { reactions: [{ __typename: 'TaskReaction', emoji: '🎉', count: 3, actors: ['Hugo Bernard', 'Léa Fontaine', 'Chris'], mine: false }] });
message(C.siteLivraisons, U.chris, 60 * 24 * 2 + 30, 'Notes de version préparées dans le contexte (`releases/v1.7`).');
message(C.apiGeneral, U.hugo, 60 * 5, '@Nora peux-tu relire la PR #118 ? Le calcul des totaux me semble fragile.', { mentions: [mention(U.nora)] });
message(C.apiGeneral, U.nora, 60 * 5 - 10, 'Relecture faite : l’arrondi ligne par ligne peut décaler le total TTC d’un centime. Détail dans la tâche « Export des factures en PDF ».', { parentId: messages.at(-1).id });

const filterTasks = (a = {}) =>
  tasks.filter(
    (t) =>
      (!a.projectId || t.project.id === a.projectId) &&
      (a.status === null || (a.status ?? ['TODO', 'IN_PROGRESS']).includes(t.status)) &&
      (!a.priority || t.priority === a.priority) &&
      (!a.tag || t.tags.some((x) => x.toLowerCase() === a.tag.toLowerCase())) &&
      (!a.mine || t.assignee?.email === U.me.email) &&
      (!a.assignee || (t.assignee?.name ?? '').toLowerCase().includes(a.assignee.toLowerCase())),
  ).slice(0, a.limit ?? 500);

// ---- Demandes -----------------------------------------------------------------------------------------------------

const requests = [
  {
    __typename: 'Request', id: 'r-build-tarifs', session: S.tarifs, type: 'permission', status: 'PENDING', title: 'Bash : npm run build && git push',
    message: null, payload: { toolName: 'Bash', input: { command: 'npm run build && git push -u origin page-tarifs', description: 'Build puis push de la branche' }, suggestions: [] },
    response: null, answeredBy: null, createdAt: ago(1), answeredAt: null,
  },
  {
    __typename: 'Request', id: 'r-question-pdf', session: S.pdf, type: 'question', status: 'PENDING', title: 'Question de l’agent', message: null,
    payload: {
      questions: [
        {
          header: 'Avoirs', question: 'Comment afficher les avoirs dans le PDF ?', multiSelect: false,
          options: [
            { label: 'Montants négatifs', description: 'Une ligne « Avoir » avec un montant en négatif, comme aujourd’hui à l’écran.' },
            { label: 'Document séparé', description: 'Un PDF « Avoir » distinct, rattaché à la facture d’origine.' },
          ],
        },
      ],
    },
    response: null, answeredBy: null, createdAt: ago(6), answeredAt: null,
  },
  {
    __typename: 'Request', id: 'r-old', session: S.stripe, type: 'permission', status: 'ANSWERED', title: 'Bash : npm test', message: null,
    payload: { toolName: 'Bash', input: { command: 'npm test' } }, response: { behavior: 'allow' }, answeredBy: U.me, createdAt: ago(60 * 23), answeredAt: ago(60 * 23 - 1),
  },
];

// ---- Pull requests ------------------------------------------------------------------------------------------------

let prSeq = 0;
const pr = (p, t, number, title, headBranch, stage, opts = {}) => ({
  __typename: 'TrackedPullRequest', id: `pr-${++prSeq}`, project: p, task: t, repo: p.gitUrl.replace('https://github.com/', ''), foreignRepo: false,
  number, url: number ? `${p.gitUrl}/pull/${number}` : '', worksession: () => sessions.find((s) => s.worksession?.branch === headBranch)?.worksession ?? null,
  localCommits: stage === 'PENDING' ? 3 : 0, localChanges: stage === 'PENDING' ? 2 : 0, title, headBranch, baseBranch: 'main',
  status: { PENDING: 'PENDING', DRAFT: 'OPEN', TO_MERGE: 'OPEN', MERGED: 'MERGED', CANCELLED: 'CLOSED' }[stage], isDraft: stage === 'DRAFT', stage,
  checksState: opts.checks ?? (stage === 'TO_MERGE' ? 'SUCCESS' : stage === 'DRAFT' ? 'PENDING' : null), reviewDecision: opts.review ?? null, mergeable: 'MERGEABLE',
  syncedAt: ago(1), mergeSha: stage === 'MERGED' ? '3d5e9cb' : null, note: opts.note ?? '', createdByType: 'session', createdBy: U.me, createdBySession: null,
  openedAt: ago(opts.age ?? 60 * 5), mergedAt: stage === 'MERGED' ? ago(60 * 22) : null, closedAt: null, createdAt: ago(opts.age ?? 60 * 5), updatedAt: ago(10),
  github: null, session: () => sessions.find((s) => s.worksession?.branch === headBranch) ?? null,
});
const pullRequests = [
  pr(P.site, T.tarifs, null, 'Refonte de la page tarifs', 'page-tarifs', 'PENDING'),
  pr(P.mobile, T.cotis, 42, 'Paiement des cotisations en trois fois', 'max-cotisations', 'TO_MERGE', { review: 'APPROVED', age: 40 }),
  pr(P.api, T.pdf, 118, 'Export PDF des factures', 'export-pdf', 'DRAFT', { age: 45 }),
  pr(P.api, T.stripe, 115, 'Migration vers l’API Stripe 2026-10', 'stripe-2026-10', 'MERGED', { age: 60 * 27 }),
  pr(P.site, T.contact, 87, 'Formulaire de contact : champs empilés sous 400 px', 'formulaire-contact', 'TO_MERGE', { checks: 'FAILURE', age: 60 * 4 }),
];

// ---- Livraisons (bouton « Livrer », déploiements) -----------------------------------------------------------------

const qualitySettings = { __typename: 'DeliveryQualitySettings', tags: ['bug', 'regression', 'qualite'], windowHours: 48, custom: false, updatedBy: null, updatedAt: null };
let deliverySeq = 0;
const step = (minutesAgo, message, level = 'info') => ({ __typename: 'DeliveryStep', at: ago(minutesAgo), message, level });
const delivery = (p, kind, status, by, minutesAgo, durationSeconds, opts = {}) => ({
  __typename: 'Delivery', id: `dl-${++deliverySeq}`, projectId: p.id, kind, status, requestedBy: by, joinedBy: opts.joinedBy ?? [], session: opts.session ?? null, task: opts.task ?? null,
  worksessionId: opts.session?.worksession?.id ?? null, branch: opts.branch ?? 'main', prNumber: opts.prNumber ?? null, prUrl: opts.prNumber ? `${p.gitUrl}/pull/${opts.prNumber}` : null,
  sha: opts.sha ?? null, steps: opts.steps ?? [], output: opts.output ?? null, error: opts.error ?? null, cancellable: status === 'QUEUED' || status === 'RUNNING',
  createdAt: ago(minutesAgo), startedAt: ago(minutesAgo), finishedAt: status === 'RUNNING' || status === 'QUEUED' ? null : ago(minutesAgo - Math.max(1, Math.round(durationSeconds / 60))), durationSeconds,
  // Tâches qualité (bug, régression…) créées dans les 48 h qui ont suivi la livraison.
  qualityTasks: (opts.qualityTasks ?? []).map((t) => ({ __typename: 'DeliveryQualityTask', task: t, delivery: null, source: 'AUTO', linkedBy: null, linkedAt: t.createdAt })),
});
const deliveries = [
  delivery(P.api, 'MERGE', 'FAILED', U.me, 60 * 2, 4, { session: S.relances, branch: 'relances-impayes', sha: '7d3e1a90bc', error: 'les checks de la pull request sont en échec : Tests', steps: [step(60 * 2, 'fusion de la branche de base dans relances-impayes'), step(60 * 2, 'push de la branche'), step(60 * 2, 'pull request #52 ouverte'), step(60 * 2 - 3, 'les checks de la pull request sont en échec : Tests', 'error')] }),
  delivery(P.site, 'MERGE', 'RUNNING', U.me, 3, 170, { task: T.contact, session: S.contact, branch: 'formulaire-contact', prNumber: 87, sha: '4f2a9c1e7b', steps: [step(3, 'fusion de la branche de base dans formulaire-contact'), step(3, 'push de la branche'), step(3, 'pull request #87 reprise'), step(2, 'attente des checks de la pull request'), step(1, 'CI en cours · en cours : Tests')] }),
  delivery(P.site, 'DEPLOY', 'SUCCEEDED', U.me, 60 * 5, 214, { sha: '9b1e3d0a2c', joinedBy: [U.hugo], qualityTasks: [T.contact], steps: [step(60 * 5, 'déploiement demandé'), step(60 * 5, 'vérification de la CI de main'), step(60 * 5 - 1, 'CI verte sur main (9b1e3d0)', 'success'), step(60 * 5 - 1, 'commande lancée sur « site-prod » : ./deploy.sh --ref 9b1e3d0a2c'), step(60 * 5 - 4, 'déployé (9b1e3d0, 214 s)', 'success')], output: 'build… ok\npublication… ok\ndéployé 9b1e3d0a2c' }),
  delivery(P.site, 'MERGE', 'SUCCEEDED', U.hugo, 60 * 5 + 10, 340, { task: T.tarifs, branch: 'page-tarifs-v1', prNumber: 84, sha: '9b1e3d0a2c', steps: [step(60 * 5 + 10, 'fusion de la branche de base dans page-tarifs-v1'), step(60 * 5 + 9, 'pull request #84 ouverte'), step(60 * 5 + 5, 'checks verts', 'success'), step(60 * 5 + 4, 'pull request #84 fusionnée (9b1e3d0)', 'success')] }),
  delivery(P.site, 'DEPLOY', 'FAILED', U.lea, 60 * 26, 12, { sha: '1c0ffee42b', error: "CI rouge sur main (1c0ffee) : CI rouge · en échec : Tests ; rien n'est déployé", steps: [step(60 * 26, 'déploiement demandé'), step(60 * 26, "CI rouge sur main (1c0ffee) : CI rouge · en échec : Tests ; rien n'est déployé", 'error')] }),
  delivery(P.site, 'MERGE', 'CONFLICT', U.me, 60 * 27, 25, { branch: 'blog-rss', error: 'Conflit avec la branche de base', steps: [step(60 * 27, 'fusion de la branche de base dans blog-rss'), step(60 * 27, "conflit en fusionnant la branche de base : résolution confiée à l'agent de la session ; relancez « Livrer » une fois la résolution poussée", 'warn')] }),
];
// Politique de livraison du site : les tâches « auto » sont fusionnées après relecture favorable et CI verte.
const deliveryPolicies = { [P.site.id]: { __typename: 'DeliveryPolicy', rules: [{ __typename: 'DeliveryPolicyRule', tag: 'auto', mode: 'AUTO_MERGE' }, { __typename: 'DeliveryPolicyRule', tag: 'securite', mode: 'MANUAL' }], mergeUser: U.me, updatedAt: ago(60 * 24 * 2) } };
// Tâche qualité rattachée au dernier déploiement du site (créée dans les 48 h qui l'ont suivi).
for (const t of tasks) t.qualityDelivery = null;
T.contact.qualityDelivery = { __typename: 'DeliveryQualityTask', task: T.contact, delivery: deliveries.find((d) => d.kind === 'DEPLOY' && d.status === 'SUCCEEDED'), source: 'AUTO', linkedBy: null, linkedAt: ago(60 * 4) };

const deployConfigs = { [P.site.id]: { __typename: 'DeployConfig', vaultItem: 'site-prod', command: './deploy.sh --ref {sha}', branch: null, timeoutMinutes: 30, updatedBy: U.me, updatedAt: ago(60 * 24 * 3) } };

// ---- Notifications ------------------------------------------------------------------------------------------------

let notifSeq = 0;
const notif = (type, title, message, link, p, s, minutesAgo, read) => ({
  __typename: 'Notification', id: `n-${++notifSeq}`, type, title, message, link, project: p, session: s, payload: {}, user: U.me,
  readAt: read ? ago(minutesAgo - 1) : null, createdAt: ago(minutesAgo),
});
const notifications = [
  notif('request', 'Autorisation demandée', 'Refonte de la page tarifs : npm run build && git push', `/sessions/${S.tarifs.id}`, P.site, S.tarifs, 1, false),
  notif('request', 'Question de l’agent', 'Export des factures en PDF : comment afficher les avoirs ?', `/sessions/${S.pdf.id}`, P.api, S.pdf, 6, false),
  notif('task_mention', 'Chris vous a mentionné', 'Refondre la page tarifs : « tu valides la remise de 20 % ? »', `/tasks/${T.tarifs.id}`, P.site, null, 60 * 25, false),
  notif('session_failed', 'Session en erreur', 'Notifications push des camps : 2 tests en échec', `/sessions/${S.push.id}`, P.mobile, S.push, 60 * 2, true),
  notif('pull_request', 'PR fusionnée', 'api-facturation #115 : Migration vers l’API Stripe 2026-10', `/projects/${P.api.id}/pull-requests`, P.api, null, 60 * 22, true),
];

// ---- Coffre -------------------------------------------------------------------------------------------------------

const vault = (id, name, kind, description, extra = {}) => ({
  __typename: 'VaultItem', id, name, kind, description, ownerUser: extra.ownerProject ? null : U.me, ownerProject: null, ownerProjectName: extra.ownerProject?.name ?? null,
  myPermission: 'MANAGE', myShare: null, host: null, port: null, username: null, url: null, langfusePublicKey: null, token: null, fields: [], database: null,
  ssl: null, sslCa: null, via: null, authScheme: null, authName: null, google: null, aws: null, scaleway: null, readOnly: true, requireApproval: false,
  envExport: false, commandAllowlist: [], publicKey: null, hostFingerprint: null, hostKeySeenAt: null, hasSecret: true, revealableFields: [],
  secretUpdatedAt: ago(60 * 24 * 30), expiresAt: null, lastTestAt: ago(60 * 3), lastTestOk: true, lastTestError: null, shares: [], links: [], audit: [],
  createdBy: U.me, createdAt: ago(60 * 24 * 40), updatedAt: ago(60 * 24 * 2), ...extra,
});
const vaultItems = [
  vault('v-prod-ssh', 'serveur-prod', 'ssh', 'Serveur de production (Scaleway), utilisateur deploy.', { ownerProject: P.api, host: 'prod.toolso.io', port: 22, username: 'deploy', requireApproval: true, readOnly: false }),
  vault('v-db', 'base-facturation', 'postgres', 'Base PostgreSQL de la facturation, en lecture seule.', { ownerProject: P.api, host: 'db.toolso.io', port: 5432, username: 'lecture', database: 'facturation', ssl: true }),
  vault('v-stripe', 'stripe-test', 'api', 'Clé Stripe du mode test.', { ownerProject: P.api, url: 'https://api.stripe.com', authScheme: 'BEARER' }),
  vault('v-metabase', 'metabase', 'website', 'Compte de service Metabase.', { ownerProject: P.data, url: 'https://metabase.toolso.io', username: 'agents@toolso.io' }),
  vault('v-gmail', 'gmail-camille', 'google', 'Boîte Gmail de Camille, lecture seule.', { shared: true }),
];
for (const v of vaultItems) v.ownerProject = teamProjects.find((p) => p.name === v.ownerProjectName) ?? null;

// ---- Contexte -----------------------------------------------------------------------------------------------------

const contextFolders = [];
const contextInstructions = [];
const folder = (p, id, name) => {
  const f = { __typename: 'ContextFolder', id, projectId: p.id, parentId: null, name, slug: name.toLowerCase(), path: name.toLowerCase(), createdAt: ago(60 * 24 * 30), updatedAt: ago(60 * 24) };
  contextFolders.push(f);
  return f;
};
const instruction = (p, f, slug, name, description, content) => {
  const i = {
    __typename: 'ContextInstruction', id: `ci-${p.slug}-${slug}`, projectId: p.id, folderId: f?.id ?? null, name, slug, path: `${f ? `${f.slug}/` : ''}${slug}`, description,
    content, version: 2, createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24 * 2),
  };
  i.versions = () => [2, 1].map((version) => ({ __typename: 'ContextInstructionVersion', version, name, description, content, createdAt: ago(60 * 24 * (version === 2 ? 2 : 20)), author: U.me, authorSession: null }));
  contextInstructions.push(i);
  return i;
};
for (const p of teamProjects) {
  const dev = folder(p, `cf-${p.slug}-dev`, 'Dev');
  const produit = folder(p, `cf-${p.slug}-produit`, 'Produit');
  instruction(p, dev, 'conventions', 'Conventions de code', 'Style, nommage, tests et revue des pull requests.', `# Conventions de code — ${p.name}\n\n- TypeScript strict, pas de \`any\`.\n- Un test par comportement, à côté du fichier testé.\n- Messages de commit en français, à l’impératif.\n\n| Dossier | Contenu |\n|---|---|\n| \`src/\` | code applicatif |\n| \`tests/\` | tests d’intégration |\n\n\`\`\`bash\nnpm run lint && npm test\n\`\`\`\n`);
  instruction(p, dev, 'deploiement', 'Déploiement', 'Comment livrer en production (jamais sans accord explicite).', '# Déploiement\n\n1. PR verte et relue.\n2. Fusion sur `main`.\n3. Le déploiement part tout seul ; vérifier les journaux.\n');
  instruction(p, produit, 'vocabulaire', 'Vocabulaire métier', 'Les mots du métier et leur sens.', '# Vocabulaire\n\n- **Groupe** : unité locale.\n- **Camp** : séjour de plusieurs jours.\n- **Cotisation** : adhésion annuelle.\n');
}

// ---- Tableau de bord, file « À traiter » ------------------------------------------------------------------------

const live = () => sessions.filter((s) => s.kind === 'SESSION' && !s.archivedAt);
const pending = () => requests.filter((r) => r.status === 'PENDING');
const usageDays = Array.from({ length: 30 }, (_, i) => ({ __typename: 'DashboardUsageDay', day: day(i - 29), usd: Math.round((4 + 6 * Math.abs(Math.sin(i * 1.7)) + (i % 7 < 5 ? 3 : 0)) * 100) / 100 }));
const stalledTasks = () => tasks.filter((t) => t.stalledSince());
const waitingTasks = () => tasks.filter((t) => t.waitingSince());
const inboxCounts = () => {
  const c = {
    __typename: 'InboxCounts', requests: pending().length,
    failedSessions: live().filter((s) => s.status === 'FAILED').length, interruptedSessions: live().filter((s) => s.status === 'INTERRUPTED').length,
    stalledTasks: stalledTasks().length,
    pullRequests: pullRequests.filter((x) => x.stage === 'TO_MERGE').length,
    waitingTasks: waitingTasks().length,
  };
  c.total = c.requests + c.failedSessions + c.interruptedSessions + c.stalledTasks + c.pullRequests;
  return c;
};
const dashboard = () => ({
  __typename: 'Dashboard',
  generatedAt: new Date().toISOString(),
  counts: {
    __typename: 'DashboardCounts', pendingRequests: pending().length, busySessions: live().filter((s) => s.activity === 'BUSY').length,
    idleSessions: live().filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE').length, failedSessions24h: 1, endedSessions24h: 3,
    todoTasks: tasks.filter((t) => t.status === 'TODO').length, inProgressTasks: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    overdueTasks: tasks.filter((t) => t.dueDate && t.dueDate < day(0) && t.status !== 'DONE').length, doneTasks7d: tasks.filter((t) => t.status === 'DONE').length,
    unreadNotifications: notifications.filter((n) => !n.readAt).length, openPullRequests: pullRequests.filter((x) => x.status === 'OPEN').length,
    pendingPullRequests: pullRequests.filter((x) => x.stage === 'PENDING').length,
  },
  usage: {
    __typename: 'DashboardUsage', monthStart: new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), 1).toISOString(), monthUsd: 84.6, globalMonthUsd: 212.3,
    monthlyBudgetUsd: 300, todayUsd: 6.4, last7DaysUsd: 51.2, previous7DaysUsd: 43.8, byDay: usageDays, rateLimits: null,
    topSessions: [S.stripe, S.hebdo, S.tarifs, S.pdf].map((s) => ({ __typename: 'UsageBySession', sessionId: s.id, sessionName: s.name, projectName: s.project.name, usd: s.costUsd })),
  },
  projects: teamProjects.map((p, i) => {
    const ps = live().filter((s) => s.project === p);
    return {
      __typename: 'DashboardProject', project: p, busySessions: ps.filter((s) => s.activity === 'BUSY').length, idleSessions: ps.filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE').length,
      pendingRequests: pending().filter((r) => r.session.project === p).length, todoTasks: tasks.filter((t) => t.project === p && t.status === 'TODO').length,
      inProgressTasks: tasks.filter((t) => t.project === p && t.status === 'IN_PROGRESS').length, overdueTasks: p === P.api ? 1 : 0, monthUsd: [24.1, 31.7, 18.2, 10.6][i], lastActivityAt: ago(i * 30 + 1),
    };
  }),
  pendingRequests: pending(),
  runningSessions: live().filter((s) => s.status === 'RUNNING'),
  recentSessions: [...live()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 6),
  attentionTasks: [T.relances, T.pdf, T.tarifs],
  staleTasks: stalledTasks(),
  pullRequests: pullRequests.filter((x) => x.stage !== 'MERGED'),
});

// ---- Git ---------------------------------------------------------------------------------------------------------

const commit = (hash, subject, author, minutesAgo) => ({ __typename: 'GitCommit', hash: `${hash}0000000000000000000000000000000000`.slice(0, 40), shortHash: hash.slice(0, 7), subject, author, date: ago(minutesAgo) });
const commits = [
  commit('a41c9e2', 'Page tarifs : interrupteur mensuel / annuel', 'Camille Laurent', 9),
  commit('7d03b1f', 'Page tarifs : composant PricingCard et trois offres', 'Camille Laurent', 62),
  commit('8b7bff3', 'Blog : balises canoniques', 'Léa Fontaine', 60 * 26),
  commit('3d5e9cb', 'Contact : validation côté serveur', 'Hugo Bernard', 60 * 50),
];
const branchFiles = [
  { path: 'src/pages/tarifs.astro', status: 'M', additions: 148, deletions: 41 },
  { path: 'src/components/PricingCard.astro', status: 'A', additions: 62, deletions: 0 },
  { path: 'src/components/BillingToggle.astro', status: 'A', additions: 37, deletions: 0 },
  { path: 'src/styles/pricing.css', status: 'M', additions: 24, deletions: 6 },
].map((f) => ({ __typename: 'SessionFileChange', origPath: null, untracked: false, ...f }));
const worksessionOf = (id) => (id ? sessions.map((s) => s.worksession).find((w) => w?.id === id) ?? null : null);
const gitStatus = (a) => {
  const w = worksessionOf(a.worksessionId);
  const dirty = w?.branch === 'page-tarifs';
  return {
    __typename: 'GitStatus', branch: w?.branch ?? 'main', upstream: `origin/${w?.branch ?? 'main'}`, ahead: w ? 2 : 0, behind: 0, detached: false, operation: null,
    headCommit: w ? commits[0] : commits[2],
    changes: dirty ? [{ __typename: 'GitFileChange', path: 'src/pages/tarifs.astro', origPath: null, indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false, conflicted: false }] : [],
  };
};

// ---- Cockpit configurable ---------------------------------------------------------------------------------------

const ckBlock = (widget, region, params) => ({ id: `d-${widget.replace(/[._]/g, '-')}`, kind: 'builtin', widget, region, ...(params ? { params } : {}) });
const COCKPIT_HOME = { v: 1, blocks: [ckBlock('tile.requests', 'tiles'), ckBlock('tile.agents', 'tiles'), ckBlock('tile.tasks', 'tiles'), ckBlock('tile.usage', 'tiles'), ckBlock('list.todo', 'main'), ckBlock('list.running_sessions', 'main'), ckBlock('list.attention_tasks', 'main'), ckBlock('list.pull_requests', 'main'), ckBlock('usage.card', 'side'), ckBlock('list.activity', 'side'), ckBlock('projects.table', 'full')] };
const COCKPIT_PROJECT = { v: 1, blocks: [ckBlock('tile.requests', 'tiles'), ckBlock('tile.agents', 'tiles'), ckBlock('tile.tasks', 'tiles'), ckBlock('tile.usage', 'tiles'), ckBlock('tile.pull_requests', 'tiles'), ckBlock('channel', 'main'), ckBlock('list.todo', 'main'), ckBlock('list.team', 'main'), ckBlock('list.attention_tasks', 'main'), ckBlock('tasks.stages', 'side'), ckBlock('tasks.weekly', 'side'), ckBlock('list.upcoming', 'side'), ckBlock('list.activity', 'side'), ckBlock('usage.top_sessions', 'side')] };
const COCKPIT_TASKS = { v: 1, blocks: [
  ...['open', 'in_progress', 'done_week', 'overdue', 'throughput', 'lead_time', 'cycle_time', 'forecast', 'net_flow'].map((k) => ckBlock(`pilot.tile.${k}`, 'tiles')),
  ...['burnup', 'flow', 'by_priority', 'watchlist', 'next'].map((k) => ckBlock(`pilot.${k}`, 'main')),
  ...['throughput', 'aging', 'by_assignee', 'in_progress', 'done'].map((k) => ckBlock(`pilot.${k}`, 'side')),
] };
const COCKPIT_AGENT = { v: 1, blocks: [ckBlock('agent.tile.active', 'tiles'), ckBlock('agent.tile.sessions', 'tiles'), ckBlock('agent.tile.tasks', 'tiles'), ckBlock('agent.tile.cost', 'tiles'), ckBlock('agent.sessions', 'main'), ckBlock('agent.tasks', 'side')] };
const COCKPIT_PERSONAL = { v: 1, blocks: [ckBlock('tile.requests', 'tiles'), ckBlock('tile.agents', 'tiles'), ckBlock('tile.tasks', 'tiles'), ckBlock('tile.usage', 'tiles'), ckBlock('list.todo', 'main'), ckBlock('list.attention_tasks', 'main'), ckBlock('tasks.stages', 'side'), ckBlock('list.upcoming', 'side'), ckBlock('list.activity', 'side'), ckBlock('usage.top_sessions', 'side')] };
const ckParam = (key, label, type, extra = {}) => ({ __typename: 'CockpitWidgetParam', key, label, type, description: null, min: null, max: null, options: null, default: null, ...extra });
const ckLimit = (d, max = 20) => ckParam('limit', 'Nombre de lignes', 'int', { min: 1, max, default: d });
const ckTags = ckParam('tags', 'Étiquettes', 'tags', { description: 'Ne garder que les tâches portant une de ces étiquettes' });
const ckWidget = (key, label, description, scopes, region, regions, singleton, params = []) => ({ __typename: 'CockpitWidget', key, label, description, scopes, region, regions, singleton, params });
const COCKPIT_CATALOG = [
  ckWidget('tile.requests', 'Demandes en attente', 'Demandes des agents qui attendent une réponse.', ['home', 'project'], 'tiles', ['tiles'], true),
  ckWidget('tile.agents', 'Agents au travail', 'Sessions au travail et en attente.', ['home', 'project'], 'tiles', ['tiles'], true),
  ckWidget('tile.tasks', 'Tâches ouvertes', 'Tâches à faire et en cours, retards.', ['home', 'project'], 'tiles', ['tiles'], true),
  ckWidget('tile.usage', 'Consommation du mois', 'Coût du mois, plafond et limites Claude.', ['home', 'project'], 'tiles', ['tiles'], true),
  ckWidget('tile.pull_requests', 'Pull requests', 'Pull requests à fusionner et branches en préparation.', ['project'], 'tiles', ['tiles'], true),
  ckWidget('list.todo', 'À traiter', 'Demandes, sessions en erreur, tâches à l’agent arrêté, PR à fusionner.', ['home', 'project'], 'main', ['main', 'side', 'full'], true),
  ckWidget('list.running_sessions', 'Agents au travail', 'Sessions dont l’agent travaille.', ['home', 'project'], 'main', ['main', 'side', 'full'], false, [ckLimit(10, 30)]),
  ckWidget('list.team', 'L’équipe en ce moment', 'Chaque membre, ses sessions et ses tâches.', ['project'], 'main', ['main', 'side', 'full'], true, [ckParam('onlyAgents', 'Agents seulement', 'bool', { default: false })]),
  ckWidget('list.attention_tasks', 'Tâches à surveiller', 'Tâches urgentes, hautes ou en retard.', ['home', 'project'], 'main', ['main', 'side', 'full'], false, [ckTags, ckLimit(10, 30)]),
  ckWidget('list.pull_requests', 'Pull requests à traiter', 'Pull requests à fusionner et brouillons.', ['home', 'project'], 'main', ['main', 'side', 'full'], false, [ckLimit(10, 30)]),
  ckWidget('list.upcoming', 'Prochainement', 'Prochaines planifications et échéances.', ['project'], 'side', ['main', 'side', 'full'], false, [ckLimit(6, 20)]),
  ckWidget('list.activity', 'Activité récente', 'Sessions terminées, PR fusionnées, tâches terminées.', ['home', 'project'], 'side', ['main', 'side', 'full'], false, [ckLimit(8, 30)]),
  ckWidget('usage.top_sessions', 'Sessions les plus coûteuses du mois', 'Les sessions qui ont le plus consommé.', ['home', 'project'], 'side', ['main', 'side', 'full'], false, [ckLimit(5, 20)]),
  ckWidget('tasks.stages', 'Flux des tâches', 'Tâches ouvertes par étiquette d’état.', ['project'], 'side', ['main', 'side', 'full'], false, [ckTags]),
  ckWidget('tasks.weekly', 'Débit hebdomadaire', 'Tâches créées et terminées par semaine.', ['project'], 'side', ['main', 'side', 'full'], false, [ckParam('weeks', 'Semaines', 'int', { min: 2, max: 26, default: 8 }), ckTags]),
  ckWidget('usage.card', 'Consommation', 'Consommation par jour, limites Claude, sessions coûteuses.', ['home', 'project'], 'side', ['main', 'side', 'full'], true),
  ckWidget('projects.table', 'Projets', 'Une ligne par projet.', ['home'], 'full', ['main', 'side', 'full'], true),
  ckWidget('channel', 'Canal #général', 'Le canal général du projet.', ['project'], 'main', ['main', 'side', 'full'], true, [ckLimit(6, 20)]),
  ckWidget('text', 'Texte', 'Un texte libre en Markdown.', ['home', 'project', 'tasks', 'agent'], 'main', ['main', 'side', 'full'], false, [ckParam('markdown', 'Texte (Markdown)', 'markdown', { default: '' })]),
  ...[['open', 'Ouvertes'], ['in_progress', 'En cours'], ['done_week', 'Terminées sur 7 jours'], ['overdue', 'En retard'], ['throughput', 'Débit'], ['lead_time', 'Délai de traitement'], ['cycle_time', 'Cycle time'], ['forecast', 'Fin estimée du reste à faire'], ['net_flow', 'Flux net sur la période']].map(([k, l]) => ckWidget(`pilot.tile.${k}`, l, `Indicateur « ${l} » du pilotage.`, ['tasks'], 'tiles', ['tiles'], true)),
  ...[['burnup', 'Avancement cumulé', 'main'], ['throughput', 'Flux par semaine', 'side'], ['flow', 'Flux cumulé', 'main'], ['aging', 'Vieillissement des tâches en cours', 'side'], ['by_priority', 'Ouvertes par priorité', 'main'], ['by_assignee', 'Charge par responsable', 'side'], ['watchlist', 'À surveiller', 'main'], ['in_progress', 'En cours', 'side'], ['next', 'Prochaines à lancer', 'main'], ['done', 'Terminées récemment', 'side']].map(([k, l, r]) => ckWidget(`pilot.${k}`, l, `Bloc « ${l} » du pilotage.`, ['tasks'], r, ['main', 'side', 'full'], true, k === 'watchlist' || k === 'in_progress' || k === 'next' || k === 'done' ? [ckLimit(10, 30)] : [])),
  ...[['tile.active', 'Sessions en cours', 'tiles'], ['tile.sessions', 'Sessions au total', 'tiles'], ['tile.tasks', 'Tâches touchées', 'tiles'], ['tile.cost', 'Consommation', 'tiles'], ['sessions', 'Sessions', 'main'], ['tasks', 'Tâches', 'side']].map(([k, l, r]) => ckWidget(`agent.${k}`, l, `Bloc « ${l} » de la fiche d’un agent.`, ['agent'], r, r === 'tiles' ? ['tiles'] : ['main', 'side', 'full'], true, r === 'tiles' ? [] : [ckLimit(20, 50)])),
];
const cockpitState = { layouts: new Map(), versions: [] };
// Le tableau de bord du site a une tuile artefact (CA projeté du mois) après les tuiles natives.
cockpitState.layouts.set('project:p-site', { layout: { v: 1, blocks: [...COCKPIT_PROJECT.blocks.filter((b) => b.region === 'tiles'), { id: 'd-ca', kind: 'artifact', artifact: 'page-data-ca', region: 'tiles', title: 'CA projeté du mois' }, ...COCKPIT_PROJECT.blocks.filter((b) => b.region !== 'tiles')] }, version: 1 });
const projectPagesDemo = [{ __typename: 'ProjectPage', id: 'pp-1', projectId: 'p-site', slug: 'reporting', title: 'Reporting', icon: 'bi-graph-up', position: 0, createdAt: ago(60 * 24 * 3) }];
const projectTabsDemo = new Map([['p-site', { hidden: ['workflows'], order: [] }]]);
const cockpitKind = (scope) => (scope.startsWith('home') ? 'home' : scope.endsWith(':tasks') ? 'tasks' : scope.startsWith('agent:') ? 'agent' : scope.includes(':page:') ? 'page' : 'project');
const cockpitDefault = (scope) => { const k = cockpitKind(scope); return k === 'home' ? COCKPIT_HOME : k === 'tasks' ? COCKPIT_TASKS : k === 'agent' ? COCKPIT_AGENT : k === 'page' ? { v: 1, blocks: [] } : byId(allProjects, scope.replace(/^project:/, ''))?.isPersonal ? COCKPIT_PERSONAL : COCKPIT_PROJECT; };
const cockpitLayout = (scope) => {
  const st = cockpitState.layouts.get(scope);
  const kind = cockpitKind(scope);
  return {
    __typename: 'CockpitLayout', scope, kind, projectId: kind === 'project' || kind === 'tasks' || kind === 'page' ? scope.replace(/^project:/, '').replace(/:tasks$/, '').replace(/:page:.*$/, '') : null,
    layout: st?.layout ?? cockpitDefault(scope), version: st?.version ?? 0, isDefault: !st?.layout, canEdit: true,
    updatedAt: st ? ago(0) : null, updatedBy: st ? U.me : null, catalog: COCKPIT_CATALOG.filter((w) => w.scopes.includes(kind === 'page' ? 'project' : kind)),
    artifacts: (st?.layout ?? cockpitDefault(scope)).blocks.filter((b) => b.kind === 'artifact').map((b) => {
      const pg = sharedPagesDemo.find((x) => x.id === b.artifact);
      return pg
        ? { __typename: 'CockpitArtifact', id: pg.id, viewable: true, title: pg.title, kind: pg.kind, version: pg.version, dataRefreshedAt: pg.dataRefreshedAt, linkAccess: pg.linkAccess, projectAccess: pg.projectAccess, owner: pg.owner, canManage: pg.owner === U.me, refreshMinutes: pg.refreshMinutes ?? null, refreshing: false, failingSources: (pg.sources ?? []).filter((s) => s.status === 'error' || s.status === 'skipped').length }
        : { __typename: 'CockpitArtifact', id: b.artifact, viewable: false, title: null, kind: null, version: null, dataRefreshedAt: null, linkAccess: null, projectAccess: null, owner: null, canManage: false, refreshMinutes: null, refreshing: false, failingSources: 0 };
    }),
    warnings: st?.warnings ?? [],
  };
};

// ---- Requêtes racine ----------------------------------------------------------------------------------------------

const byId = (list, id) => list.find((x) => x.id === id) ?? null;
const allProjects = [P.perso, ...teamProjects];
/** Tous les projets atteignables par leur identifiant, projets invités compris. */
const everyProject = [...allProjects, ...guestProjects];
const providers = [
  {
    __typename: 'Provider', type: 'claude', label: 'Claude Code', description: 'Agent de code Claude, dans le conteneur du projet.', interactive: true,
    configFields: [
      { __typename: 'ConfigField', key: 'model', label: 'Modèle', type: 'select', required: false, description: null, defaultValue: 'default', advanced: false, options: [
        { __typename: 'ConfigOption', value: 'default', label: 'Mon modèle par défaut (Opus 5.5)', description: null },
        { __typename: 'ConfigOption', value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: null },
        { __typename: 'ConfigOption', value: 'claude-haiku-5-5', label: 'Haiku 5.5', description: null },
      ] },
      { __typename: 'ConfigField', key: 'permissionMode', label: 'Autorisations', type: 'select', required: false, description: null, defaultValue: 'default', advanced: false, options: [
        { __typename: 'ConfigOption', value: 'default', label: 'Demander avant d’agir', description: null },
        { __typename: 'ConfigOption', value: 'acceptEdits', label: 'Accepter les modifications', description: null },
        { __typename: 'ConfigOption', value: 'plan', label: 'Planifier seulement', description: null },
        { __typename: 'ConfigOption', value: 'bypassPermissions', label: 'Tout autoriser', description: null },
      ] },
    ],
  },
];


/** Tableau de bord d'un projet : la vue d'ensemble restreinte au projet, plus l'équipe, le canal général, les planifications. */
const projectDashboard = (id) => {
  const p = byId(allProjects, id);
  const d = dashboard();
  const ps = live().filter((s) => s.project === p);
  const members = p.members();
  return {
    __typename: 'ProjectDashboard',
    generatedAt: d.generatedAt,
    counts: { ...d.counts, pendingRequests: pending().filter((r) => r.session.project === p).length, busySessions: ps.filter((s) => s.activity === 'BUSY').length, idleSessions: ps.filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE').length, todoTasks: tasks.filter((t) => t.project === p && t.status === 'TODO').length, inProgressTasks: tasks.filter((t) => t.project === p && t.status === 'IN_PROGRESS').length },
    usage: { ...d.usage, monthUsd: 24.1 },
    pendingRequests: pending().filter((r) => r.session.project === p),
    runningSessions: ps.filter((s) => s.status === 'RUNNING'),
    recentSessions: [...ps].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 5),
    attentionTasks: tasks.filter((t) => t.project === p && ['URGENT', 'HIGH'].includes(t.priority) && t.status !== 'DONE'),
    pullRequests: pullRequests.filter((x) => x.project === p && x.stage !== 'MERGED'),
    mergedPullRequests: pullRequests.filter((x) => x.project === p && x.stage === 'MERGED'),
    staleTasks: stalledTasks().filter((t) => t.project === p),
    schedules: schedules.filter((sc) => sc.project === p),
    general: conversations.find((c) => c.project === p && c.slug === 'general') ?? null,
    team: members.map((m) => {
      const ms = ps.filter((s) => s.status === 'RUNNING' && s.owner === m.user);
      return { __typename: 'ProjectTeamMember', user: m.user, agent: m.user.agent ?? null, sessions: ms, tasks: tasks.filter((t) => t.project === p && (t.sessionIds ?? []).some((sid) => ms.some((s) => s.id === sid))), lastActivityAt: ms[0]?.updatedAt ?? m.user.lastLoginAt };
    }),
    tasks: tasks.filter((t) => t.project === p),
  };
};

/** Réponse de GET /api/share/<token> (backend/src/sessionShares/route.ts) pour le lien de démo ; null sinon (404). */
export function demoSharedSession(token) {
  if (token !== DEMO_SHARE_TOKEN) return null;
  const s = S.tarifs;
  const events = s.events().map(({ __typename, ...e }) => (e.type === 'claude.result' ? { ...e, payload: { ...e.payload, total_cost_usd: undefined } } : e));
  return { session: { name: s.name, projectName: s.project.name, ownerName: s.owner?.name ?? null, status: 'running', createdAt: s.createdAt }, expiresAt: inDays(6), truncated: false, events };
}

/** Relevé de consommation cohérent : jours → semaines, parts fixes par projet et par modèle, sessions existantes. */
const usageReport = (a = {}) => {
  const days = a.days ?? 30;
  const projects = a.projectId ? allProjects.filter((p) => p.id === a.projectId) : allProjects;
  const share = { 'p-perso': 0.03, 'p-site': 0.3, 'p-api': 0.42, 'p-mobile': 0.17, 'p-data': 0.08 };
  const k = projects.reduce((n, p) => n + share[p.id], 0);
  const round = (v) => Math.round(v * 100) / 100;
  const byDay = Array.from({ length: days }, (_, i) => {
    const usd = round((4 + 6 * Math.abs(Math.sin(i * 1.7)) + (i % 7 < 5 ? 3 : 0)) * k);
    return { __typename: 'UsageReportDay', day: day(i - days + 1), usd, turns: Math.round(usd * 9) };
  });
  const weeks = new Map();
  for (const d of byDay) {
    const dt = new Date(`${d.day}T00:00:00`);
    const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7));
    const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const w = weeks.get(key) ?? { __typename: 'UsageReportDay', day: key, usd: 0, turns: 0 };
    w.usd = round(w.usd + d.usd);
    w.turns += d.turns;
    weeks.set(key, w);
  }
  const usd = round(byDay.reduce((n, d) => n + d.usd, 0));
  const turns = byDay.reduce((n, d) => n + d.turns, 0);
  const top = sessions.filter((s) => projects.includes(s.project) && s.costUsd > 0).sort((x, y) => y.costUsd - x.costUsd).slice(0, 15);
  return {
    __typename: 'UsageReport', from: ago(60 * 24 * days), to: new Date().toISOString(), days, usd, turns, sessions: Math.max(top.length, Math.round(turns / 40)),
    byProject: projects.map((p) => ({ __typename: 'UsageReportProject', projectId: p.id, projectName: p.name, isPersonal: p.isPersonal, usd: round((usd * share[p.id]) / k), turns: Math.round((turns * share[p.id]) / k), sessions: Math.max(1, Math.round((turns * share[p.id]) / k / 40)), monthUsd: p.monthUsd, monthlyBudgetUsd: p.monthlyBudgetUsd })).sort((x, y) => y.usd - x.usd),
    byModel: [['claude-opus-5-5', 0.71], ['claude-sonnet-5-5', 0.24], ['claude-haiku-5-5', 0.05]].map(([model, f]) => ({ __typename: 'UsageReportModel', model, usd: round(usd * f), turns: Math.round(turns * f) })),
    byDay,
    byWeek: [...weeks.values()],
    topSessions: top.map((s) => ({ __typename: 'UsageReportSession', sessionId: s.id, sessionName: s.name, projectId: s.project.id, projectName: s.project.name, ownerName: s.owner?.name ?? null, usd: s.costUsd, turns: Math.round(s.costUsd * 9) })),
  };
};

// ---- Journal d'audit (page Journal d'un projet) -----------------------------------------------------------------

const audit = (n, minutes, actorKind, actor, actorLabel, action, actionLabel, targetType, targetTypeLabel, targetId, targetLabel, details = {}, sessionId = null) => ({
  __typename: 'AuditEntry', id: String(1000 - n), createdAt: ago(minutes), action, actionLabel, targetType, targetTypeLabel, targetId, targetLabel, details, actorKind, actor, sessionId, actorLabel,
});
const auditEntries = [
  audit(1, 3, 'HUMAN', U.me, 'Camille Laurent', 'request.answer', 'a répondu à la demande', 'request', 'Demande', 'r-1', 'Autoriser Bash : npm run build ?', { type: 'permission', decision: 'allow', always: true, scope: 'project', rules: ['Bash(npm run build *)'] }),
  audit(2, 12, 'AGENT', U.max, 'Refonte de la page tarifs', 'task.status', 'a changé le statut de la tâche', 'task', 'Tâche', 't-1', 'Refondre la page tarifs', { from: 'todo', to: 'in_progress' }, 's-page-tarifs'),
  audit(3, 25, 'HUMAN', U.hugo, 'Hugo Bernard', 'git.commit', 'a commité', 'git', 'Git', 'w-1', 'page-tarifs (task/page-tarifs)', { message: 'Corrige le comparatif des offres', stageAll: true }),
  audit(4, 26, 'HUMAN', U.hugo, 'Hugo Bernard', 'git.push', 'a poussé', 'git', 'Git', 'w-1', 'page-tarifs (task/page-tarifs)'),
  audit(5, 40, 'HUMAN', U.me, 'Camille Laurent', 'session.stop', 'a arrêté la session', 'session', 'Session', 's-page-tarifs', 'Refonte de la page tarifs'),
  audit(6, 95, 'AGENT', U.chris, 'Cadrage du formulaire de contact', 'task.create', 'a créé la tâche', 'task', 'Tâche', 't-2', 'Formulaire de contact : anti-spam', { status: 'todo', priority: 'medium' }, 's-page-tarifs'),
  audit(7, 60 * 3, 'HUMAN', U.me, 'Camille Laurent', 'member.role', 'a changé le rôle de', 'member', 'Membre', 'u-thomas', 'thomas.petit@toolso.io', { role: 'VIEWER' }),
  audit(8, 60 * 5, 'HUMAN', U.lea, 'Léa Fontaine', 'vault.update', 'a modifié l’élément du coffre', 'vault', 'Coffre', 'v-1', 'base-staging', { fields: ['host', 'password'] }),
  audit(9, 60 * 26, 'SYSTEM', null, null, 'task.status', 'a changé le statut de la tâche', 'task', 'Tâche', 't-3', 'Mettre à jour Astro', { from: 'in_progress', to: 'done' }),
  audit(10, 60 * 30, 'HUMAN', U.me, 'Camille Laurent', 'session.create', 'a lancé la session', 'session', 'Session', 's-page-tarifs', 'Refonte de la page tarifs', { provider: 'claude' }),
];
const auditFacets = {
  __typename: 'AuditFacets',
  actors: [U.me, U.hugo, U.lea, U.max, U.chris],
  targetTypes: [['git', 'Git'], ['member', 'Membre'], ['request', 'Demande'], ['session', 'Session'], ['task', 'Tâche'], ['vault', 'Coffre']].map(([value, label]) => ({ __typename: 'AuditOption', value, label })),
  actions: [['git.commit', 'a commité'], ['git.push', 'a poussé'], ['member.role', 'a changé le rôle de'], ['request.answer', 'a répondu à la demande'], ['session.create', 'a lancé la session'], ['session.stop', 'a arrêté la session'], ['task.create', 'a créé la tâche'], ['task.status', 'a changé le statut de la tâche'], ['vault.update', 'a modifié l’élément du coffre']].map(([value, label]) => ({ __typename: 'AuditOption', value, label })),
};
const auditLog = (a = {}) => {
  const f = a.filter ?? {};
  return auditEntries.filter((e) => (!f.actorKind || e.actorKind === f.actorKind) && (!f.actorUserId || e.actor?.id === f.actorUserId) && (!f.targetType || e.targetType === f.targetType) && (!f.action || e.action === f.action) && (!f.from || e.createdAt >= f.from) && (!f.to || e.createdAt < f.to) && (!a.before || Number(e.id) < Number(a.before)));
};

const sharedPageState = { agentHandoff: 'MANUAL', historyEnabled: true };
const sharedPageVersionsDemo = [3, 2, 1].map((version) => ({ __typename: 'SharedPageVersion', version, size: 14_000 + version * 1_200, createdBy: U.me, createdAt: ago(60 * 24 * (4 - version)) }));
const sharedPageDemo = (id) => ({
  __typename: 'SharedPage',
  id,
  title: 'Maquette de la page tarifs',
  description: null,
  owner: U.me,
  linkAccess: true,
  projectAccess: false,
  members: [],
  project: P.site,
  session: S.tarifs,
  sourcePath: 'maquette-tarifs.html',
  viewerAccess: { __typename: 'SharedPageViewerAccess', owner: true, member: false, admin: true },
  agentHandoff: sharedPageState.agentHandoff,
  version: 3,
  historyEnabled: sharedPageState.historyEnabled,
  versions: sharedPageState.historyEnabled ? sharedPageVersionsDemo : sharedPageVersionsDemo.slice(0, 1),
  kind: 'PAGE', refreshMinutes: null, dataRefreshedAt: null, sources: [],
});

/** Arborescence factice de l'explorateur (dossier d'une session, dossier principal du projet). */
const DEMO_TREE = {
  session: { '': [['resultat-camp.html', 'file', 3200]] },
  project: {
    '': [['previsionnel', 'dir'], ['factures', 'dir'], ['notes.md', 'file', 920]],
    previsionnel: [['model3.js', 'file', 1840], ['build3.js', 'file', 29684], ['Previsionnel_2026-2027.xlsx', 'file', 71186]],
    factures: [],
  },
};
function demoFiles(root, dir) {
  return (DEMO_TREE[root][dir] ?? []).map(([name, kind, size]) => ({ __typename: 'FileEntry', name, path: dir ? `${dir}/${name}` : name, kind, size: size ?? null, modifiedAt: ago(60 * 24 * 36) }));
}

export const demoRoot = {
  usageReport,
  auditLog,
  auditFacets: () => auditFacets,
  me: U.me,
  users: Object.values(U),
  sidebarProjects: allProjects,
  projects: (a = {}) => (a.includePersonal ? allProjects : teamProjects),
  project: (a) => byId(everyProject, a.id),
  guestProjects,
  personalSpace: P.perso,
  chats: (a = {}) => chats.slice(0, a.limit ?? 50),
  sessions: (a = {}) =>
    sessions
      .filter((s) => s.kind === (a.kind ?? 'SESSION') && !s.archivedAt && (!a.projectId || s.project.id === a.projectId) && (!a.status || s.status === a.status) && (!a.ownerId || s.owner.id === a.ownerId))
      .slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 100)),
  session: (a) => byId(sessions, a.id),
  archivedSessions: [],
  sessionOwners: () => [U.me, U.hugo, U.lea, U.chris, U.max, U.nora],
  tasks: (a = {}) => filterTasks({ ...a, status: a.status ?? undefined }),
  task: (a) => byId(tasks, a.id),
  conversation: (a) => byId(conversations, a.id),
  conversationBySlug: (a) => conversations.find((c) => c.project.id === a.projectId && c.slug === a.slug) ?? null,
  taskTags: () => [...new Set(tasks.flatMap((t) => t.tags))],
  taskPeople: () => people.map(person),
  requests: (a = {}) => requests.filter((r) => (a.status === null || r.status === (a.status ?? 'PENDING')) && (!a.sessionId || r.session.id === a.sessionId)),
  request: (a) => byId(requests, a.id),
  notifications: (a = {}) => notifications.filter((n) => !a.unreadOnly || !n.readAt).slice(0, a.limit ?? 50),
  unreadNotificationCount: () => notifications.filter((n) => !n.readAt).length,
  dashboard,
  projectDashboard: (a) => projectDashboard(a.id),
  // Cockpit configurable : agencements par défaut (copie de backend/src/cockpit/defaults.ts) et catalogue abrégé.
  createProjectPage: (a) => {
    const slug = (a.slug || a.title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    const page = { __typename: 'ProjectPage', id: `pp-${projectPagesDemo.length + 1}`, projectId: a.projectId, slug, title: a.title, icon: a.icon ?? null, position: projectPagesDemo.length, createdAt: ago(0) };
    projectPagesDemo.push(page);
    return page;
  },
  updateProjectPage: (a) => {
    const page = projectPagesDemo.find((p) => p.id === a.id);
    if (page) Object.assign(page, a.title != null ? { title: a.title } : {}, a.icon !== undefined ? { icon: a.icon } : {}, a.position != null ? { position: a.position } : {});
    return page;
  },
  deleteProjectPage: (a) => {
    const i = projectPagesDemo.findIndex((p) => p.id === a.id);
    if (i >= 0) projectPagesDemo.splice(i, 1);
    return true;
  },
  updateProjectTabs: (a) => {
    projectTabsDemo.set(a.projectId, a.tabs);
    return byId(allProjects, a.projectId);
  },
  cockpitLayout: (a) => cockpitLayout(a.scope),
  cockpitLayoutHistory: (a) => cockpitState.versions.filter((v) => v.scope === a.scope).map(({ scope: _s, ...v }) => v).reverse(),
  updateCockpitLayout: (a) => {
    const v = (cockpitState.layouts.get(a.scope)?.version ?? 0) + 1;
    cockpitState.layouts.set(a.scope, { layout: a.layout, version: v });
    cockpitState.versions.push({ __typename: 'CockpitLayoutVersion', scope: a.scope, version: v, layout: a.layout, reset: false, author: U.me, sessionId: null, note: a.note ?? null, createdAt: ago(0) });
    return cockpitLayout(a.scope);
  },
  resetCockpitLayout: (a) => {
    const v = (cockpitState.layouts.get(a.scope)?.version ?? 0) + 1;
    cockpitState.layouts.set(a.scope, { layout: null, version: v });
    cockpitState.versions.push({ __typename: 'CockpitLayoutVersion', scope: a.scope, version: v, layout: cockpitDefault(a.scope), reset: true, author: U.me, sessionId: null, note: null, createdAt: ago(0) });
    return cockpitLayout(a.scope);
  },
  pinArtifactToCockpit: (a) => {
    const cur = cockpitState.layouts.get(a.scope)?.layout ?? cockpitDefault(a.scope);
    const pg = sharedPagesDemo.find((x) => x.id === a.artifactId);
    const layout = { v: 1, blocks: [...cur.blocks, { id: `b${cockpitState.versions.length + 1}`, kind: 'artifact', artifact: a.artifactId, region: a.region ?? 'full', ...(a.title ? { title: a.title } : {}) }] };
    const v = (cockpitState.layouts.get(a.scope)?.version ?? 0) + 1;
    const warnings = a.scope !== 'home' && pg && !pg.linkAccess && !pg.projectAccess ? [`« ${pg.title} » n'est ouvert ni aux membres du projet ni par le lien : les autres membres ne le verront pas.`] : [];
    cockpitState.layouts.set(a.scope, { layout, version: v, warnings });
    cockpitState.versions.push({ __typename: 'CockpitLayoutVersion', scope: a.scope, version: v, layout, reset: false, author: U.me, sessionId: null, note: 'Artefact épinglé', createdAt: ago(0) });
    return cockpitLayout(a.scope);
  },
  restoreCockpitLayout: (a) => {
    const old = cockpitState.versions.find((v) => v.scope === a.scope && v.version === a.version);
    const v = (cockpitState.layouts.get(a.scope)?.version ?? 0) + 1;
    cockpitState.layouts.set(a.scope, { layout: old?.layout ?? null, version: v });
    cockpitState.versions.push({ __typename: 'CockpitLayoutVersion', scope: a.scope, version: v, layout: old?.layout ?? cockpitDefault(a.scope), reset: false, author: U.me, sessionId: null, note: `Restauration de la version ${a.version}`, createdAt: ago(0) });
    return cockpitLayout(a.scope);
  },
  inbox: () => ({
    __typename: 'Inbox', generatedAt: new Date().toISOString(), counts: inboxCounts(), requests: pending(),
    sessions: live().filter((s) => ['FAILED', 'INTERRUPTED'].includes(s.status)),
    tasks: stalledTasks(),
    waitingTasks: waitingTasks(),
    pullRequests: pullRequests.filter((x) => x.stage === 'TO_MERGE'),
  }),
  inboxCounts,
  unreadMessagesByProject: () => [...teamProjects, ...guestProjects].map((p) => ({ __typename: 'ProjectUnreadMessages', project: p, count: typeof p.unreadMessages === 'function' ? p.unreadMessages() : 0 })),
  pullRequests: (a = {}) => pullRequests.filter((x) => (!a.projectId || x.project.id === a.projectId) && (!a.taskId || x.task?.id === a.taskId) && (!a.stage || a.stage.includes(x.stage)) && (!a.status || a.status.includes(x.status))),
  pullRequest: (a) => byId(pullRequests, a.id),
  deliveries: (a = {}) => deliveries.filter((d) => d.projectId === a.projectId && (!a.worksessionId || d.worksessionId === a.worksessionId) && (!a.taskId || d.task?.id === a.taskId) && (!a.kind || d.kind === a.kind.toUpperCase())).slice(0, a.limit ?? 50),
  delivery: (a) => byId(deliveries, a.id),
  deployConfig: (a) => deployConfigs[a.projectId] ?? null,
  deliveryPolicy: (a) => deliveryPolicies[a.projectId] ?? null,
  deliveryQualitySettings: () => qualitySettings,
  deliveryQualityReport: () => ({
    __typename: 'DeliveryQualityReport', since: ago(60 * 24 * 90), settings: qualitySettings, deliveries: 12, deliveriesWithQualityTasks: 3, qualityTasks: 4, regressionRate: 0.25,
    byAuthor: [
      { __typename: 'DeliveryQualityAuthor', user: U.chris, isAgent: true, pullRequests: 9, deliveries: 7, deliveriesWithQualityTasks: 2, qualityTasks: 3, regressionRate: 2 / 7 },
      { __typename: 'DeliveryQualityAuthor', user: U.hugo, isAgent: false, pullRequests: 5, deliveries: 4, deliveriesWithQualityTasks: 1, qualityTasks: 1, regressionRate: 0.25 },
      { __typename: 'DeliveryQualityAuthor', user: U.me, isAgent: false, pullRequests: 2, deliveries: 2, deliveriesWithQualityTasks: 0, qualityTasks: 0, regressionRate: 0 },
    ],
  }),
  ciStatus: (a) => ({ __typename: 'CiStatus', ref: a.ref ?? 'main', sha: '9b1e3d0a2c4f', state: 'SUCCESS', verdict: 'success', checks: [{ __typename: 'PullRequestCheck', name: 'Tests', state: 'SUCCESS', url: null }, { __typename: 'PullRequestCheck', name: 'Typecheck et build', state: 'SUCCESS', url: null }] }),
  worksession: (a) => sessions.map((s) => s.worksession).find((w) => w?.id === a.id) ?? null,
  // Explorateur de fichiers : un dossier de session presque vide, des fichiers dans le dossier principal.
  workspaceEntries: (a = {}) => demoFiles(a.worksessionId ? 'session' : 'project', a.path ?? ''),
  workspaceFile: (a) => ({ __typename: 'FileContent', path: a.path, name: a.path.split('/').pop(), size: 1840, modifiedAt: ago(60 * 24 * 36), binary: false, content: `// ${a.path}\nconst hypotheses = { hausse: 0.02, effectifs: 64 };\nmodule.exports = { hypotheses };\n` }),
  vaultItems: (a = {}) => vaultItems.filter((v) => !a.kind || v.kind === a.kind),
  vaultItem: (a) => byId(vaultItems, a.id),
  vaultShareCandidates: [U.hugo, U.lea],
  contextInstruction: (a) => byId(contextInstructions, a.id),
  searchContext: (a) => contextInstructions.filter((i) => i.projectId === a.projectId && `${i.name} ${i.content}`.toLowerCase().includes(a.query.toLowerCase())),
  schedulePermissionSuggestions: (a = {}) => [
    ...(a.scheduleId ? [{ __typename: 'ScheduleToolSuggestion', rule: 'mcp__vault__sql_query(production)', source: 'DENIED', count: 2, lastSeenAt: ago(60 * 9) }, { __typename: 'ScheduleToolSuggestion', rule: 'Bash(git log *)', source: 'ASKED', count: 1, lastSeenAt: ago(60 * 24 * 7) }] : []),
    ...(/production/i.test(a.prompt ?? '') ? [{ __typename: 'ScheduleToolSuggestion', rule: 'mcp__vault__sql_query(production)', source: 'PROMPT', count: 0, lastSeenAt: null }] : []),
  ].filter((x, i, all) => all.findIndex((y) => y.rule === x.rule) === i),
  sessionSchedules: (a = {}) => schedules.filter((sc) => !a.projectId || sc.project.id === a.projectId),
  sessionSchedule: (a) => byId(schedules, a.id),
  providers,
  myAgents: agents,
  agent: (a) => byId(agents, a.id),
  costDisplay: { __typename: 'CostDisplay', unit: 'USD', creditPriceEur: null },
  // Paramètres › Connexion : Google relié, GitHub relié, Microsoft configuré mais pas relié, pas de mot de passe.
  myLoginMethods: {
    __typename: 'MyLoginMethods',
    email: U.me.email,
    hasPassword: false,
    passwordSetAt: null,
    passwordLoginEnabled: true,
    googleLinked: true,
    identities: [{ __typename: 'LoginIdentity', provider: 'github', email: U.me.email, createdAt: ago(60 * 24 * 12), lastUsedAt: ago(60 * 26) }],
    providers: [
      { __typename: 'LoginProviderInfo', id: 'google', label: 'Google', configured: true },
      { __typename: 'LoginProviderInfo', id: 'microsoft', label: 'Microsoft', configured: true },
      { __typename: 'LoginProviderInfo', id: 'github', label: 'GitHub', configured: true },
    ],
  },
  workflows: [],
  workflowRuns: [],
  // Pages partagées : « page-offre » et « page-audit » (message du partage) ; toute autre adresse donne la page à moi
  // publiée par la session « Refonte de la page tarifs », dont le réglage de la transmission des commentaires à
  // l'agent (panneau Commentaires) se change et reste en mémoire.
  // Onglet Artefacts d'un projet : ceux du projet (le mock ne gère pas la visibilité).
  sharedPages: (a = {}) => (a.projectId ? sharedPagesDemo.filter((pg) => pg.project?.id === a.projectId) : sharedPagesDemo),
  favoriteSharedPages: () => sharedPagesDemo.filter((pg) => pg.favorite),
  setSharedPageFavorite: (a) => {
    const pg = sharedPagesDemo.find((x) => x.id === a.id) ?? sharedPageDemo(a.id);
    pg.favorite = Boolean(a.favorite);
    return pg;
  },
  sharedPage: (a = {}) => sharedPagesDemo.find((pg) => pg.id === a.id) ?? sharedPageDemo(a.id),
  updateSharedPage: (a) => {
    const mine = sharedPagesDemo.find((pg) => pg.id === a.id);
    if (mine) {
      if (a.input && 'refreshMinutes' in a.input) mine.refreshMinutes = a.input.refreshMinutes || null;
      return mine;
    }
    if (a.input?.agentHandoff) sharedPageState.agentHandoff = a.input.agentHandoff;
    return sharedPageDemo(a.id);
  },
  setSharedPageHistory: (a) => {
    const mine = sharedPagesDemo.find((pg) => pg.id === a.id);
    if (mine) return { ...mine, historyEnabled: a.enabled };
    sharedPageState.historyEnabled = a.enabled;
    return sharedPageDemo(a.id);
  },
  deleteAllSharedPageComments: () => 3,
  refreshSharedPageData: (a) => {
    const mine = sharedPagesDemo.find((pg) => pg.id === a.id);
    if (mine) {
      mine.dataRefreshedAt = ago(0);
      for (const src of mine.sources) {
        src.attemptedAt = mine.dataRefreshedAt;
        if (src.status === 'ok') src.refreshedAt = mine.dataRefreshedAt;
      }
    }
    return mine ?? sharedPageDemo(a.id);
  },
  duplicateSharedPage: (a) => {
    const src = sharedPagesDemo.find((pg) => pg.id === a.id) ?? sharedPageDemo(a.id);
    const copy = { ...src, id: `${src.id}-copie-${sharedPagesDemo.length}`, title: a.title || `Copie de ${src.title}`, version: 1, versions: (src.versions ?? []).slice(0, 1).map((v) => ({ ...v, version: 1 })), linkAccess: false, members: [], comments: [], openComments: 0, createdAt: ago(0), updatedAt: ago(0), viewerAccess: { owner: true, member: false, admin: true } };
    sharedPagesDemo.unshift(copy);
    return copy;
  },
  githubPullRequests: [],
  gitStatus,
  gitLog: (a = {}) => (worksessionOf(a.worksessionId) ? commits : commits.slice(2)).slice(0, a.limit ?? 50),
  gitBranches: (a = {}) => {
    const w = worksessionOf(a.worksessionId);
    return [{ name: 'main', current: !w }, ...(w ? [{ name: w.branch, current: true }] : [])].map((b) => ({ __typename: 'GitBranch', remote: false, upstream: `origin/${b.name}`, commit: commits[b.current && w ? 0 : 2], ...b }));
  },
  gitBranchChanges: (a = {}) => {
    const w = worksessionOf(a.worksessionId);
    return { __typename: 'GitBranchChanges', branch: w?.branch ?? 'main', baseBranch: 'main', mergeBase: commits[2].hash, commits: w ? 2 : 0, files: w ? branchFiles : [] };
  },
  sessionChanges: (a) => ({ __typename: 'SessionChanges', mode: 'COMMIT', baseCommit: commits[2].hash, truncated: false, files: a.sessionId === S.tarifs.id ? branchFiles : [] }),
  terminal: null,
  // « Tester » de la carte « Navigateur headless » (réglages du projet) : un contrôle réussi sur skipper-runner arm64.
  testProjectBrowser: (a) => {
    const step = (label, detail, durationMs) => ({ __typename: 'BrowserCheckStep', label, ok: true, detail, durationMs });
    const page = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="100%" height="100%" fill="white"/><text x="40" y="80" font-family="sans-serif" font-size="32" font-weight="bold">Navigateur opérationnel</text><text x="40" y="130" font-family="sans-serif" font-size="20">Page de test de Skipper.</text></svg>';
    return {
      __typename: 'BrowserCheck', ok: true, enabled: Boolean(byId(allProjects, a.id)?.runnerConfig?.browser), image: 'skipper-runner:latest', problems: [], durationMs: 2840,
      screenshot: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(page)}`,
      probe: {
        __typename: 'BrowserProbe', arch: 'aarch64', chromiumVersion: 'Google Chrome for Testing 156.0.7000.0', mcpPath: '/usr/local/bin/playwright-mcp', mcpVersion: 'Version 0.0.84',
        chromiumPath: '/opt/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux-arm64/chrome-headless-shell', browsers: ['chromium-1247', 'chromium_headless_shell-1247', 'ffmpeg-1013'],
        memoryLimitMb: 1536, memoryUsedMb: 612, memoryAvailableMb: 924,
      },
      steps: [
        step('Conteneur du projet', 'image skipper-runner:latest', 40),
        step('Navigateur dans l’image', 'Google Chrome for Testing 156.0.7000.0 · playwright-mcp Version 0.0.84 · aarch64', 910),
        step('Lancement de Chromium', 'port CDP 41233', 520),
        step('Démarrage de playwright-mcp', 'Playwright 1.65.0 · 25 outils', 1010),
        step('Ouverture d’une page locale', 'data:text/html (page de test, sans réseau)', 230),
        step('Capture de la page', '7 Ko', 130),
      ],
    };
  },
};

// ---- Valeurs générées pour les champs absents ---------------------------------------------------------------------

const WORDS = ['Préparation', 'Synthèse', 'Vérification', 'Mise à jour', 'Revue', 'Suivi'];
const FALSE_FLAGS = /^(isPersonal|isSuperAdmin|isCto|isGuest|overThreshold|maintenance|foreignRepo|isDraft|isUsingOverage|pending|browserActive|outdated|advanced|isError|conflicted|truncated|binary)$/;

/** Valeur courte et plausible d'un scalaire absent des données ; undefined : laisser le générateur de l'audit. */
export function demoScalar(type, field, parentType, n) {
  const f = field.toLowerCase();
  switch (type.name) {
    case 'Boolean':
      return FALSE_FLAGS.test(field) ? false : undefined;
    case 'Int':
      if (f.includes('tokens')) return f.includes('window') ? 200_000 : 42_000;
      return f.includes('count') || f.includes('total') ? 4 : f.includes('percent') ? 38 : 2;
    case 'Float':
      return f.includes('cost') || f.includes('usd') ? 0.84 : f.includes('percent') ? 24.5 : 0.4;
    case 'DateTime':
      return ago(n * 37);
    case 'String': {
      if (f === 'email' || f.endsWith('email')) return people[n % people.length].email;
      if (f.includes('avatar')) return null;
      if (f.includes('url') || f.includes('link')) return 'https://github.com/toolso/site-vitrine';
      if (f === 'path' || f.endsWith('path') || f === 'cwd' || f.includes('dir')) return 'src/components/PricingCard.astro';
      if (f.includes('branch')) return 'main';
      if (f.includes('model')) return 'claude-opus-5-5';
      if (f === 'name' || f === 'label' || f === 'title' || f === 'subject') return `${WORDS[n % WORDS.length]} ${(n % 9) + 1}`;
      if (/content|text|body|description|message|summary|markdown|notes/.test(f)) return 'Mise à jour des composants et des tests.';
      if (/prompt|instruction/.test(f)) return 'Prépare la synthèse de la semaine.';
      if (/error|reason|stderr/.test(f)) return null;
      if (/output|stdout|answer|question|command/.test(f)) return 'ok';
      if (f.includes('kind') || f.includes('type') || f.includes('state') || f.includes('status') || f.includes('role')) return 'ok';
      return undefined;
    }
    default:
      return undefined;
  }
}
