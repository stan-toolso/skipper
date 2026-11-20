import { gql, type ApolloCache } from '@apollo/client';
import { TASK_PULL_REQUEST_FIELDS, TRACKED_PULL_REQUEST_FIELDS, type TrackedPullRequest, type TrackedPullRequestSummary } from './pullRequests';
import type { AttachmentRef } from '../lib/attachments';
import type { ClaudeRateLimits } from './settings';

export type SessionStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED' | 'INTERRUPTED';
export type RequestStatus = 'PENDING' | 'ANSWERED' | 'CANCELLED' | 'EXPIRED';
export type SessionActivity = 'BUSY' | 'IDLE';

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  description?: string | null;
  options?: { value: string; label: string; description?: string | null }[] | null;
  defaultValue?: string | null;
  advanced?: boolean | null;
}

/** Planification d'une session : l'instruction est envoyée à chaque échéance de l'expression cron. */
/** Nettoyage automatique de l'historique d'une session. */
export interface SessionCleanup {
  retentionDays: number | null;
  /** compact / reset : au-delà de contextMaxTokens ; fresh : conversation neuve à chaque exécution planifiée. */
  contextAction: 'compact' | 'reset' | 'fresh' | null;
  contextMaxTokens: number | null;
}

/** Taille du contexte de l'agent rapportée au modèle (jauge de l'en-tête, pastille de la sidebar, bandeau). */
export interface SessionContextInfo {
  tokens: number | null;
  /** Seuil au-delà duquel l'interface propose un nettoyage (réglages Claude de la personne connectée ; null : jamais). */
  warnTokens: number | null;
  overThreshold: boolean;
  model: string | null;
  windowTokens: number;
  share: number | null;
  /** Coût approximatif (dollars) de la relecture du contexte à froid au prochain tour. */
  coldTurnUsd: number | null;
}

/** Planification : objet du projet, distinct des sessions ; chaque exécution lance une session indépendante. */
export interface SessionSchedule {
  id: string;
  /** Nom affiché : celui de la planification, sinon le début de l'instruction. */
  name: string;
  /** Nom saisi pour la planification (null : déduit de l'instruction). */
  customName: string | null;
  /** Provider des sessions d'exécution. */
  provider: string;
  /** Réglages copiés dans chaque session d'exécution (permissionMode, model…). */
  config: Record<string, unknown>;
  /** Propriétaire des exécutions (ses comptes, son budget). */
  owner: { id: string; name: string } | null;
  /** Agent de projet au nom duquel tournent les exécutions (null : une personne). */
  agent?: { id: string; name: string; kind: string; avatar: { emoji: string; color: string } } | null;
  /** Personne qui a mis la planification au nom de l'agent. */
  requestedBy?: { id: string; name: string } | null;
  project: { id: string; name: string; myRole: 'ADMIN' | 'MEMBER' | 'VIEWER' | null; defaultPermissionMode: string; defaultModel?: string | null };
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  endAfterRun: boolean;
  /** Archivage automatique des sessions d'exécution (chaque exécution a sa propre session). */
  archivePolicy: ScheduleArchivePolicy;
  /** Délai avant archivage après la fin d'une exécution, en minutes (AFTER_DELAY). */
  archiveAfterMinutes: number | null;
  /** Outils pré-autorisés pour les seules exécutions de la planification (règles au format Claude Code). */
  allowedTools: string[];
  /** Plafond de coût d'une exécution (unité d'affichage ; null : aucun). */
  maxRunUsd?: number | null;
  /** Budget mensuel de la planification (unité d'affichage ; null : aucun). */
  monthlyBudgetUsd?: number | null;
  /** Consommation du mois de ses exécutions (unité d'affichage). */
  monthUsd?: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  updatedAt: string;
}

export type ScheduleArchivePolicy = 'ON_FINISH' | 'PREVIOUS_ON_RUN' | 'AFTER_DELAY' | 'NEVER';

export type ScheduleRunStatus = 'RUNNING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'TIMEOUT' | 'SKIPPED' | 'MISSED';

/** Une exécution d'une planification (historique). */
export interface ScheduleRun {
  id: string;
  trigger: 'SCHEDULE' | 'MANUAL';
  triggeredBy: { id: string; name: string } | null;
  status: ScheduleRunStatus;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  message: string | null;
  answer: string | null;
  /** Session créée pour cette exécution (null : ignorée, manquée, ou session non créée). */
  session: { id: string; name: string; archivedAt: string | null; status?: SessionStatus; activity?: SessionActivity | null; pendingRequestCount?: number } | null;
}

/** Planification telle que la liste la montre : avec ses dernières exécutions. */
export interface ScheduleListItem extends SessionSchedule {
  runs: ScheduleRun[];
}

export interface Provider {
  type: string;
  label: string;
  description: string;
  interactive: boolean;
  configFields: ConfigField[];
}

/** Rôles d'un projet ; GUEST (invité) : conversations et artefacts partagés seulement. */
export type ProjectRole = 'ADMIN' | 'MEMBER' | 'VIEWER' | 'GUEST';

export interface User {
  id: string;
  email: string;
  name: string;
  /** Une personne, ou un agent de projet (membre qui n'est pas une personne). */
  kind?: 'PERSON' | 'AGENT';
  avatarUrl: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** CTO : interventions sur les sessions et conversations comptées par tranches de 10 min et facturées. */
  isCto?: boolean;
  /** Invité des pages partagées : ne voit que les pages partagées avec lui (aucun projet, aucun menu). */
  isGuest?: boolean;
  /** N'a que des accès d'invité (projets avec le rôle invité) : conversations et artefacts partagés, sans espace personnel ; null pour les autres personnes. */
  conversationsOnly?: boolean | null;
  createdAt: string;
  lastLoginAt: string | null;
  /** Lu seulement par la page Utilisateurs (administrateurs) et pour soi-même. */
  hasPassword?: boolean | null;
}

export interface PermissionRule {
  id: string;
  projectId: string;
  toolName: string;
  ruleContent: string | null;
  rule: string;
  createdBySession: { id: string; name: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  usageTrackedSince: string;
}

export interface ProjectMember {
  user: Pick<User, 'id' | 'email' | 'name' | 'avatarUrl' | 'kind'>;
  role: ProjectRole;
  invitedBy: Pick<User, 'id' | 'name'> | null;
  pending: boolean;
  createdAt: string;
}

export interface RunnerStatus {
  kind: string;
  ready: boolean;
  state: string;
  containerName: string | null;
  image: string | null;
  memory: string | null;
  cpus: string | null;
  startedAt: string | null;
  error: string | null;
  /** Créé avec une autre configuration ou une image depuis reconstruite : à recréer. */
  outdated: boolean;
  outdatedReasons: string[];
  /** Processus zombies dans le conteneur (null s'il ne tourne pas). */
  zombies: number | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  /** Espace personnel : projet qui n'appartient qu'à la personne connectée (jamais partagé). */
  isPersonal: boolean;
  description: string | null;
  systemPrompt: string;
  taskInstructions: string;
  gitUrl: string | null;
  gitBranch: string | null;
  /** Dépôt hébergé par Skipper : gitUrl est alors son URL de clone. */
  gitHosted: boolean;
  runnerConfig: { image?: string; memory?: string; cpus?: string; browser?: boolean; maxSessions?: number };
  /** Mode d'autorisation des nouvelles sessions : default, acceptEdits, bypassPermissions ou plan. */
  defaultPermissionMode: string;
  /** Limite de contexte des nouvelles sessions (compact / reset au-delà d'un seuil) ; null : aucune. */
  defaultContextCleanup: Pick<SessionCleanup, 'contextAction' | 'contextMaxTokens'> | null;
  /** Modèle Claude des nouvelles sessions qui n'en choisissent pas ; null : celui du propriétaire. */
  defaultModel: string | null;
  /** Modèle des sessions de tâches par priorité ({ low: 'sonnet' }) ; null : aucun. */
  taskModels: TaskModels | null;
  /** Éléments du coffre soumis à approbation (requête PROJECT seulement). */
  approvalConnections?: string[];
  /** Faux quand le projet est atteint en tant que super administrateur sans en être membre. */
  isMember: boolean;
  runnerStatus: RunnerStatus;
  workspacePath: string;
  workspaceExists: boolean;
  git: { branch: string; commit: string } | null;
  myRole: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  name: string;
  /** Session d'agent ordinaire, ou chat (conversation légère de l'espace personnel, sans work session). */
  kind: 'SESSION' | 'CHAT';
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  prompt: string | null;
  promptAttachments: AttachmentRef[];
  config: Record<string, unknown>;
  /** Modèle de la session (sa configuration, sinon le défaut de son propriétaire) ; requête SIDEBAR seulement. */
  model?: string | null;
  externalId: string | null;
  exitCode: number | null;
  error: string | null;
  costUsd: number;
  cleanup: SessionCleanup;
  /** Taille du contexte de l'agent au dernier tour (tokens), null si inconnue. */
  contextTokens: number | null;
  context: SessionContextInfo;
  pendingRequestCount: number;
  /** Navigateur headless ouvert et utilisé par l'agent : vue en direct disponible. */
  browserActive: boolean;
  /** Mise en file d'attente (statut QUEUED), et rang dans la file (1 : la prochaine). */
  queuedAt: string | null;
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** `myRole` : requête Session seulement (un lecteur ne voit ni la saisie ni les actions). */
  project: Pick<Project, 'id' | 'name' | 'slug' | 'workspacePath' | 'approvalConnections'> & { myRole?: ProjectRole | null };
  /** Liens publics de lecture encore valables (requête Session seulement ; vide pour un lecteur). */
  shares?: SessionShare[];
  worksession: Pick<Worksession, 'id' | 'name' | 'branch' | 'label' | 'path'> | null;
  /** Session d'agent qui a lancé celle-ci (outil MCP sessions.create), null pour une session lancée par un humain. */
  parentSession: { id: string; name: string; status: SessionStatus; activity: SessionActivity | null } | null;
  /** Sessions lancées par l'agent de cette session (requête Session seulement). */
  childSessions?: ChildSession[];
  /** Exécution de workflow qui a ouvert la session ; null pour une session lancée à la main. */
  workflowRun: { id: string; workflow: { id: string; name: string } } | null;
  /** Utilisateur qui a lancé la session (null : session d'avant cette version). */
  owner: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl' | 'kind'> | null;
  /** Personne qui a demandé la session quand son propriétaire est un agent de projet. */
  requestedBy?: { id: string; name: string } | null;
  /** Personne qui a pris la main sur la session d'un agent : ses comptes et ses droits servent la session. */
  takenOverBy?: { id: string; name: string } | null;
  /** La personne connectée peut prendre ou rendre la main (requête Session seulement). */
  viewerCanTakeOver?: boolean;
  /** Agent de projet qui joue la session (null : session d'une personne). */
  agent?: { id: string; name: string; kind: 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM'; avatar: { emoji: string | null; color: string | null } } | null;
  /** Archivée : consultable en lecture seule, relançable. */
  archivedAt: string | null;
  /** Worksession supprimé dans lequel la session a travaillé (archivée avec lui) ; null sinon. */
  formerWorksession: { name: string; branch: string; label: string } | null;
  /** Tâche dont la session est en charge. */
  task: { id: string; title: string; status: TaskStatus } | null;
  /** Tâches dont la session est en charge, la plus récemment prise d'abord. */
  tasks: { id: string; title: string; status: TaskStatus }[];
  /** Planification (null si la session n'est pas planifiée). */
  schedule: SessionSchedule | null;
}

/** Session lancée par l'agent d'une autre session, telle que la page de la session parente la liste. */
export interface ChildSession {
  id: string;
  name: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  pendingRequestCount: number;
  archivedAt: string | null;
}

export interface ContextFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  slug: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextInstructionVersion {
  id: string;
  version: number;
  name: string;
  description: string;
  content: string;
  changeNote: string | null;
  authorType: 'human' | 'agent';
  authorSession: { id: string; name: string } | null;
  createdAt: string;
}

export interface ContextInstruction {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  slug: string;
  path: string;
  description: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  versions?: ContextInstructionVersion[];
}

export interface ContextChange {
  id: string;
  kind: string;
  path: string;
  details: Record<string, unknown>;
  authorType: 'human' | 'agent';
  authorSession: { id: string; name: string } | null;
  createdAt: string;
}

export type TerminalStatus = 'RUNNING' | 'CLOSED';

export interface Terminal {
  id: string;
  name: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
  closedAt: string | null;
  project: { id: string; name: string; workspacePath: string };
  worksession: { id: string; name: string; branch: string; label: string; path: string } | null;
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
/** Modèle des sessions de tâches d'un projet, par priorité (clés en minuscules, comme côté serveur). */
export type TaskModels = Partial<Record<'low' | 'medium' | 'high' | 'urgent', string>>;

export interface TaskField {
  key: string;
  value: string;
}

export interface TaskPerson {
  name: string | null;
  email: string | null;
}

/** Personne ou session mentionnée dans un message ; `text` est le fragment du corps qui la porte. */
export interface TaskMention {
  kind: 'user' | 'session';
  id: string;
  label: string;
  text: string;
}

/** Réactions d'un même emoji sur un message ou sur la tâche. */
export interface TaskReaction {
  emoji: string;
  count: number;
  actors: string[];
  mine: boolean;
}

/** Qui l'on peut mentionner dans le fil d'une tâche. */
export interface TaskMentionable {
  kind: 'user' | 'session';
  id: string;
  label: string;
  detail: string | null;
  text: string;
}

/** Message du fil d'une tâche : racine (`parentId` null) ou réponse dans le fil d'une racine. */
export interface TaskComment {
  id: string;
  parentId: string | null;
  authorType: 'human' | 'agent';
  authorName: string;
  author: { id: string; name: string } | null;
  /** Session qui a écrit le message ; `owner` est la personne (ou l'agent) qui la pilote. */
  authorSession: { id: string; name: string; owner: { id: string; name: string } | null } | null;
  /** Agent de projet dont la session a écrit le message. */
  agent?: { id: string; name: string; kind: 'PRODUCT_MANAGER' | 'DEVELOPER' | 'CUSTOM'; avatar: { emoji: string | null; color: string | null } } | null;
  body: string;
  mentions: TaskMention[];
  reactions: TaskReaction[];
  editable: boolean;
  deletable: boolean;
  attachments: { id: string; name: string; mediaType: string; size: number }[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  /** Coût attribué à la tâche (unité d'affichage). */
  costUsd: number;
  title: string;
  /** Une ou deux phrases sur l'objet de la tâche, montrées avant la description ; null : aucun. */
  summary: string | null;
  description: string;
  status: TaskStatus;
  /** Court libellé de l'avancement dans le statut (« en revue », « bloquée »…). */
  statusTag: string | null;
  /** Étiquettes libres. */
  tags: string[];
  priority: TaskPriority;
  dueDate: string | null;
  createdByType: 'human' | 'agent';
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Passage en cours (le premier ; effacé au retour à « à faire »), null si jamais démarrée. */
  startedAt: string | null;
  /** Passage en annulée, null hors de ce statut. */
  cancelledAt: string | null;
  customFields: TaskField[];
  assignee: TaskPerson | null;
  reporter: TaskPerson | null;
  commentCount: number;
  /** Fichiers joints à la tâche elle-même. */
  attachmentCount: number;
  attachments: { id: string; name: string; mediaType: string; size: number }[];
  branch: string | null;
  /** Dossier de travail de la tâche (notion technique : seule sa branche est montrée), actif ou le dernier archivé. */
  worksession: { id: string; branch: string; archivedAt: string | null } | null;
  project: { id: string; name: string };
  session: { id: string; name: string; status: SessionStatus; activity: SessionActivity | null; worksession: { id: string; branch: string } | null } | null;
  /** `owner` (personne ou agent qui pilote la session) n'est demandé que par TASK_PAGE. */
  createdBySession: { id: string; name: string; owner?: { id: string; name: string } | null } | null;
  /** Présent seulement dans la query TASKS. */
  pullRequest?: PullRequestSummary | null;
  /** Pull requests suivies de la tâche (objets Skipper) ; présentes dans TASKS et TASK_PAGE. */
  pullRequests?: TrackedPullRequestSummary[];
  /** Sessions en charge (TASK_PAGE). */
  sessionsInCharge?: { id: string }[];
  /** Tâches dont celle-ci dépend (« bloquée par »). */
  dependsOn: TaskRef[];
  /** Celles de dependsOn qui ne sont pas terminées : la tâche ne peut pas être confiée à un agent tant qu'il en reste. */
  blockedBy: TaskRef[];
  /** Tâches qui dépendent de celle-ci. */
  dependents: TaskRef[];
  /** Confiée automatiquement à une session quand sa dernière dépendance est terminée. */
  autoStartWhenUnblocked: boolean;
  autoStartBy: { id: string; name: string } | null;
  /** « Agent arrêté » (à traiter) : en cours, aucune session en charge ne tourne plus (ni PR ouverte), et rien ne dit qu'elle attend. */
  stalledSince: string | null;
  /** « En attente » : même situation, mais l'agent a dit ce qu'il attendait (réveil daté, étiquette d'état, compte rendu). */
  waitingSince: string | null;
  /** Date de réveil : l'agent qui la tenait est alors reconvoqué. */
  wakeAt: string | null;
  /** Ce qu'il faudra vérifier au réveil. */
  wakeNote: string | null;
}

/** Tâche citée par une autre (dépendance). */
export interface TaskRef {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  project: { id: string; name: string } | null;
}

export interface SearchHit {
  kind: 'PROJECT' | 'SESSION' | 'TERMINAL' | 'TASK' | 'VAULT_ITEM';
  id: string;
  title: string;
  detail: string | null;
  projectId: string | null;
  projectName: string | null;
  outsideProjects: boolean;
  worksessionBranch: string | null;
  status: string | null;
  activity: string | null;
  updatedAt: string;
}

export interface Worksession {
  id: string;
  name: string;
  branch: string;
  /** Libellé affiché : le libellé choisi, sinon la branche. */
  label: string;
  customLabel: string | null;
  path: string;
  exists: boolean;
  git: { branch: string; commit: string } | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}
export interface GitFileChange {
  path: string;
  origPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}
export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  changes: GitFileChange[];
  headCommit: GitCommit | null;
  /** Opération git interrompue (merge, rebase, cherry-pick, revert) ; null sinon. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
}
export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  commit: GitCommit | null;
}
export interface GitDiff {
  path: string;
  staged: boolean;
  text: string;
  binary: boolean;
  truncated: boolean;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface HumanRequest {
  id: string;
  type: string;
  status: RequestStatus;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  createdAt: string;
  answeredAt: string | null;
  session: { id: string; name: string; project: { id: string; name: string } };
}

export const PROJECT_FIELDS = gql`
  fragment ProjectFields on Project {
    id
    name
    slug
    isPersonal
    description
    systemPrompt
    taskInstructions
    gitUrl
    gitBranch
    gitHosted
    runnerConfig
    defaultPermissionMode
    defaultContextCleanup {
      contextAction
      contextMaxTokens
    }
    defaultModel
    taskModels
    runnerStatus {
      kind
      ready
      state
      containerName
      image
      memory
      cpus
      startedAt
      error
      outdated
      outdatedReasons
      zombies
    }
    workspacePath
    workspaceExists
    git {
      branch
      commit
    }
    myRole
    isPersonal
    isMember
    createdAt
    updatedAt
  }
`;

export const USER_FIELDS = gql`
  fragment UserFields on User {
    id
    email
    name
    avatarUrl
    isAdmin
    isSuperAdmin
    isCto
    isGuest
    conversationsOnly
    createdAt
    lastLoginAt
  }
`;

export const ME = gql`
  ${USER_FIELDS}
  query Me {
    me {
      ...UserFields
    }
  }
`;

export const PROJECT_MEMBERS = gql`
  query ProjectMembers($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      members {
        role
        pending
        createdAt
        user {
          id
          email
          name
          avatarUrl
          kind
        }
        invitedBy {
          id
          name
        }
      }
    }
  }
`;

export const INVITE_PROJECT_MEMBER = gql`
  mutation InviteProjectMember($projectId: ID!, $email: String!, $role: ProjectRole, $message: String, $notify: Boolean) {
    inviteProjectMember(projectId: $projectId, email: $email, role: $role, message: $message, notify: $notify) {
      role
      user {
        id
        email
      }
    }
  }
`;

export const UPDATE_PROJECT_MEMBER_ROLE = gql`
  mutation UpdateProjectMemberRole($projectId: ID!, $userId: ID!, $role: ProjectRole!) {
    updateProjectMemberRole(projectId: $projectId, userId: $userId, role: $role) {
      role
      user {
        id
      }
    }
  }
`;

export const REMOVE_PROJECT_MEMBER = gql`
  mutation RemoveProjectMember($projectId: ID!, $userId: ID!) {
    removeProjectMember(projectId: $projectId, userId: $userId)
  }
`;

export const SESSION_FIELDS = gql`
  fragment SessionFields on Session {
    id
    name
    kind
    provider
    status
    activity
    prompt
    promptAttachments {
      id
      name
      mediaType
      size
    }
    config
    externalId
    exitCode
    error
    costUsd
    cleanup {
      retentionDays
      contextAction
      contextMaxTokens
    }
    contextTokens
    context {
      tokens
      warnTokens
      overThreshold
      model
      windowTokens
      share
      coldTurnUsd
    }
    pendingRequestCount
    queuedAt
    queuePosition
    createdAt
    updatedAt
    startedAt
    endedAt
    project {
      id
      name
      slug
      workspacePath
    }
    worksession {
      id
      name
      branch
      label
      path
    }
    parentSession {
      id
      name
      status
      activity
    }
    workflowRun {
      id
      workflow {
        id
        name
      }
    }
    owner {
      id
      name
      email
      avatarUrl
      kind
    }
    requestedBy {
      id
      name
    }
    takenOverBy {
      id
      name
    }
    agent {
      id
      name
      kind
      avatar {
        emoji
        color
      }
    }
    archivedAt
    formerWorksession {
      name
      branch
      label
    }
    task {
      id
      title
      status
    }
    tasks {
      id
      title
      status
    }
    schedule {
      id
      name
      customName
      provider
      config
      owner {
        id
        name
      }
      project {
        id
        name
        myRole
        defaultPermissionMode
        defaultModel
      }
      cron
      timezone
      prompt
      enabled
      endAfterRun
      archivePolicy
      archiveAfterMinutes
      allowedTools
      maxRunUsd
      monthlyBudgetUsd
      monthUsd
      nextRunAt
      lastRunAt
      lastResult
      updatedAt
    }
  }
`;

export const REQUEST_FIELDS = gql`
  fragment RequestFields on Request {
    id
    type
    status
    title
    message
    payload
    response
    createdAt
    answeredAt
    session {
      id
      name
      project {
        id
        name
      }
    }
  }
`;

export const PROVIDERS = gql`
  query Providers {
    providers {
      type
      label
      description
      interactive
      configFields {
        key
        label
        type
        required
        description
        options {
          value
          label
          description
        }
        defaultValue
        advanced
      }
    }
  }
`;

/**
 * Oublie toutes les listes de projets du cache Apollo (une entrée par jeu de variables : includePersonal, all…),
 * après une création ou une suppression de projet : chaque écran qui les lit les recharge à son prochain affichage.
 */
export function evictProjectLists(cache: ApolloCache<unknown>): void {
  cache.evict({ id: 'ROOT_QUERY', fieldName: 'projects' });
  cache.gc();
}

export const PROJECTS = gql`
  ${PROJECT_FIELDS}
  query Projects($all: Boolean, $includePersonal: Boolean) {
    projects(all: $all, includePersonal: $includePersonal) {
      ...ProjectFields
    }
  }
`;

export const PROJECT = gql`
  ${PROJECT_FIELDS}
  ${SESSION_FIELDS}
  query Project($id: ID!) {
    project(id: $id) {
      ...ProjectFields
      approvalConnections
      sessions {
        ...SessionFields
      }
    }
  }
`;

export const CREATE_PROJECT = gql`
  ${PROJECT_FIELDS}
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      ...ProjectFields
    }
  }
`;

export const UPDATE_PROJECT = gql`
  ${PROJECT_FIELDS}
  mutation UpdateProject($id: ID!, $input: UpdateProjectInput!) {
    updateProject(id: $id, input: $input) {
      ...ProjectFields
    }
  }
`;

export const PREPARE_PROJECT_WORKSPACE = gql`
  ${PROJECT_FIELDS}
  mutation PrepareProjectWorkspace($id: ID!) {
    prepareProjectWorkspace(id: $id) {
      ...ProjectFields
    }
  }
`;

export const START_PROJECT_RUNNER = gql`
  ${PROJECT_FIELDS}
  mutation StartProjectRunner($id: ID!) {
    startProjectRunner(id: $id) {
      ...ProjectFields
    }
  }
`;

export const STOP_PROJECT_RUNNER = gql`
  ${PROJECT_FIELDS}
  mutation StopProjectRunner($id: ID!) {
    stopProjectRunner(id: $id) {
      ...ProjectFields
    }
  }
`;

export const RESET_PROJECT_RUNNER = gql`
  ${PROJECT_FIELDS}
  mutation ResetProjectRunner($id: ID!) {
    resetProjectRunner(id: $id) {
      ...ProjectFields
    }
  }
`;

export const DELETE_PROJECT = gql`
  mutation DeleteProject($id: ID!, $deleteHostedRepo: Boolean) {
    deleteProject(id: $id, deleteHostedRepo: $deleteHostedRepo)
  }
`;

export interface ProjectImportReport {
  foldersCreated: number;
  instructionsCreated: number;
  instructionsSkipped: string[];
  tasksCreated: number;
  commentsCreated: number;
  settingsUpdated: boolean;
  connections: string[];
}

export const IMPORT_PROJECT_ARCHIVE = gql`
  mutation ImportProjectArchive($projectId: ID!, $archive: String!, $context: Boolean, $tasks: Boolean, $settings: Boolean) {
    importProjectArchive(projectId: $projectId, archive: $archive, context: $context, tasks: $tasks, settings: $settings) {
      foldersCreated
      instructionsCreated
      instructionsSkipped
      tasksCreated
      commentsCreated
      settingsUpdated
      connections
    }
  }
`;

export const SESSIONS = gql`
  ${SESSION_FIELDS}
  query Sessions($projectId: ID, $status: SessionStatus, $provider: String, $ownerId: ID, $limit: Int) {
    sessions(projectId: $projectId, status: $status, provider: $provider, ownerId: $ownerId, limit: $limit) {
      ...SessionFields
    }
  }
`;

/** Lien public de lecture d'une session (/share/<token>), valable jusqu'à `expiresAt`. */
export interface SessionShare {
  id: string;
  url: string;
  expiresAt: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

const SESSION_SHARE_FIELDS = gql`
  fragment SessionShareFields on SessionShare {
    id
    url
    expiresAt
    createdAt
    createdBy {
      id
      name
    }
  }
`;

export const CREATE_SESSION_SHARE = gql`
  ${SESSION_SHARE_FIELDS}
  mutation CreateSessionShare($sessionId: ID!, $expiresInDays: Float!) {
    createSessionShare(sessionId: $sessionId, expiresInDays: $expiresInDays) {
      ...SessionShareFields
    }
  }
`;

export const REVOKE_SESSION_SHARE = gql`
  mutation RevokeSessionShare($id: ID!) {
    revokeSessionShare(id: $id)
  }
`;

export const SESSION = gql`
  ${SESSION_FIELDS}
  ${SESSION_SHARE_FIELDS}
  ${REQUEST_FIELDS}
  ${TASK_PULL_REQUEST_FIELDS}
  query Session($id: ID!) {
    session(id: $id) {
      ...SessionFields
      viewerCanTakeOver
      # Commandes de fond que l'agent attend (barre d'état : « attend la fin de … »).
      subagents {
        id
        kind
        description
        startedAt
      }
      worksession {
        id
        # PR suivie du dossier de travail : carte « à fusionner » de la page (mise à jour aussi par watchPullRequests).
        trackedPullRequest {
          ...TaskPullRequestFields
        }
      }
      project {
        id
        approvalConnections
        myRole
      }
      shares {
        ...SessionShareFields
      }
      review {
        branch
        baseBranch
        commits
        reportedAt
        report
        error
        githubCommentUrl
        githubError
        task {
          id
          title
        }
        pullRequest {
          id
          number
          url
        }
      }
      requests(status: PENDING) {
        ...RequestFields
      }
      childSessions {
        id
        name
        status
        activity
        pendingRequestCount
        archivedAt
      }
    }
  }
`;

/** Une page d'événements d'une session, dans l'ordre, après l'événement `after` (voir useSessionEvents). */
export const SESSION_EVENTS = gql`
  query SessionEvents($id: ID!, $after: ID, $limit: Int, $toolUseId: ID) {
    session(id: $id) {
      id
      events(after: $after, limit: $limit, toolUseId: $toolUseId) {
        id
        sessionId
        type
        payload
        createdAt
      }
      liveDraft {
        text
        thinking
      }
    }
  }
`;

/** Réponse en cours d'écriture par l'agent (voir useSessionEvents). */
export interface SessionLiveDraft {
  text: string;
  thinking: boolean;
}

export const CREATE_SESSION = gql`
  ${SESSION_FIELDS}
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      ...SessionFields
    }
  }
`;

export const START_SESSION = gql`
  ${SESSION_FIELDS}
  mutation StartSession($id: ID!) {
    startSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const STOP_SESSION = gql`
  ${SESSION_FIELDS}
  mutation StopSession($id: ID!) {
    stopSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const SEND_SESSION_MESSAGE = gql`
  ${SESSION_FIELDS}
  mutation SendSessionMessage($id: ID!, $text: String!, $attachments: [AttachmentInput!]) {
    sendSessionMessage(id: $id, text: $text, attachments: $attachments) {
      ...SessionFields
    }
  }
`;

export const END_SESSION = gql`
  ${SESSION_FIELDS}
  mutation EndSession($id: ID!) {
    endSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const RESUME_SESSION = gql`
  ${SESSION_FIELDS}
  mutation ResumeSession($id: ID!) {
    resumeSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const RESTART_SESSION = gql`
  ${SESSION_FIELDS}
  mutation RestartSession($id: ID!) {
    restartSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const TAKE_OVER_SESSION = gql`
  ${SESSION_FIELDS}
  mutation TakeOverSession($id: ID!) {
    takeOverSession(id: $id) {
      ...SessionFields
      viewerCanTakeOver
    }
  }
`;

export const HAND_BACK_SESSION = gql`
  ${SESSION_FIELDS}
  mutation HandBackSession($id: ID!) {
    handBackSession(id: $id) {
      ...SessionFields
      viewerCanTakeOver
    }
  }
`;

export const INTERRUPT_SESSION = gql`
  ${SESSION_FIELDS}
  mutation InterruptSession($id: ID!) {
    interruptSession(id: $id) {
      ...SessionFields
    }
  }
`;

export const UPDATE_SESSION_CONFIG = gql`
  ${SESSION_FIELDS}
  mutation UpdateSessionConfig($id: ID!, $config: JSON!) {
    updateSessionConfig(id: $id, config: $config) {
      ...SessionFields
    }
  }
`;

export const DELETE_SESSION = gql`
  mutation DeleteSession($id: ID!, $deleteBranch: Boolean) {
    deleteSession(id: $id, deleteBranch: $deleteBranch)
  }
`;

export const UPDATE_SESSION = gql`
  ${SESSION_FIELDS}
  mutation UpdateSession($id: ID!, $input: UpdateSessionInput!) {
    updateSession(id: $id, input: $input) {
      ...SessionFields
    }
  }
`;

export const APPLY_SESSION_CLEANUP = gql`
  ${SESSION_FIELDS}
  mutation ApplySessionCleanup($id: ID!) {
    applySessionCleanup(id: $id) {
      ...SessionFields
    }
  }
`;

export const COMPACT_SESSION_CONTEXT = gql`
  ${SESSION_FIELDS}
  mutation CompactSessionContext($id: ID!) {
    compactSessionContext(id: $id) {
      ...SessionFields
    }
  }
`;

export const RESET_SESSION_CONTEXT = gql`
  ${SESSION_FIELDS}
  mutation ResetSessionContext($id: ID!, $keepSummary: Boolean) {
    resetSessionContext(id: $id, keepSummary: $keepSummary) {
      ...SessionFields
    }
  }
`;

export const SCHEDULE_RUN_FIELDS = gql`
  fragment ScheduleRunFields on ScheduleRun {
    id
    trigger
    triggeredBy {
      id
      name
    }
    status
    scheduledFor
    startedAt
    finishedAt
    durationMs
    costUsd
    message
    answer
    session {
      id
      name
      archivedAt
      status
      activity
      pendingRequestCount
    }
  }
`;

const SCHEDULE_FIELDS = gql`
  fragment ScheduleFields on SessionSchedule {
    id
    name
    customName
    provider
    config
    owner {
      id
      name
    }
    agent {
      id
      name
      kind
      avatar {
        emoji
        color
      }
    }
    requestedBy {
      id
      name
    }
    project {
      id
      name
      myRole
      defaultPermissionMode
      defaultModel
    }
    cron
    timezone
    prompt
    enabled
    endAfterRun
    archivePolicy
    archiveAfterMinutes
    allowedTools
    maxRunUsd
    monthlyBudgetUsd
    monthUsd
    nextRunAt
    lastRunAt
    lastResult
    updatedAt
  }
`;

/** Planifications d'un projet, ou de tous les projets accessibles (page Planifications). */
export const SESSION_SCHEDULES = gql`
  ${SCHEDULE_RUN_FIELDS}
  ${SCHEDULE_FIELDS}
  query SessionSchedules($projectId: ID, $runs: Int) {
    sessionSchedules(projectId: $projectId) {
      ...ScheduleFields
      runs(limit: $runs) {
        ...ScheduleRunFields
      }
    }
  }
`;

/** Une planification et ses dernières exécutions (modale). */
export const SESSION_SCHEDULE = gql`
  ${SCHEDULE_RUN_FIELDS}
  ${SCHEDULE_FIELDS}
  query SessionSchedule($id: ID!, $limit: Int) {
    sessionSchedule(id: $id) {
      ...ScheduleFields
      runs(limit: $limit) {
        ...ScheduleRunFields
      }
    }
  }
`;

export const CREATE_SCHEDULE = gql`
  ${SCHEDULE_FIELDS}
  mutation CreateSchedule($input: CreateScheduleInput!) {
    createSchedule(input: $input) {
      ...ScheduleFields
    }
  }
`;

export const UPDATE_SCHEDULE = gql`
  ${SCHEDULE_FIELDS}
  mutation UpdateSchedule($id: ID!, $input: SessionScheduleInput!) {
    updateSchedule(id: $id, input: $input) {
      ...ScheduleFields
    }
  }
`;

export const DELETE_SCHEDULE = gql`
  mutation DeleteSchedule($id: ID!) {
    deleteSchedule(id: $id)
  }
`;

export const SET_SCHEDULE_ENABLED = gql`
  ${SCHEDULE_FIELDS}
  mutation SetScheduleEnabled($id: ID!, $enabled: Boolean!) {
    setScheduleEnabled(id: $id, enabled: $enabled) {
      ...ScheduleFields
    }
  }
`;

/** Exécute une planification tout de suite ; renvoie la session de l'exécution. */
export const RUN_SCHEDULE_NOW = gql`
  mutation RunScheduleNow($id: ID!) {
    runScheduleNow(id: $id) {
      id
      name
    }
  }
`;

export type ScheduleToolSuggestionSource = 'DENIED' | 'ASKED' | 'PROMPT';

export interface ScheduleToolSuggestion {
  rule: string;
  source: ScheduleToolSuggestionSource;
  count: number;
  lastSeenAt: string | null;
}

/** Outils à pré-autoriser pour une planification (exécutions passées, éléments du coffre cités par l'instruction). */
export const SCHEDULE_PERMISSION_SUGGESTIONS = gql`
  query SchedulePermissionSuggestions($projectId: ID!, $scheduleId: ID, $prompt: String) {
    schedulePermissionSuggestions(projectId: $projectId, scheduleId: $scheduleId, prompt: $prompt) {
      rule
      source
      count
      lastSeenAt
    }
  }
`;

export const SCHEDULE_NEXT_RUNS = gql`
  query ScheduleNextRuns($cron: String!, $timezone: String, $count: Int) {
    scheduleNextRuns(cron: $cron, timezone: $timezone, count: $count)
  }
`;

export const REQUESTS = gql`
  ${REQUEST_FIELDS}
  query Requests($status: RequestStatus, $sessionId: ID, $limit: Int, $newestFirst: Boolean) {
    requests(status: $status, sessionId: $sessionId, limit: $limit, newestFirst: $newestFirst) {
      ...RequestFields
    }
  }
`;

export const ANSWER_REQUEST = gql`
  ${REQUEST_FIELDS}
  mutation AnswerRequest($id: ID!, $response: JSON!) {
    answerRequest(id: $id, response: $response) {
      ...RequestFields
    }
  }
`;

/** Saisie des secrets demandés par un agent (vault.request_secrets) : rangés dans le coffre, jamais dans la réponse. */
export const PROVIDE_SECRETS = gql`
  ${REQUEST_FIELDS}
  mutation ProvideSecrets($requestId: ID!, $input: ProvideSecretsInput!) {
    provideSecrets(requestId: $requestId, input: $input) {
      ...RequestFields
    }
  }
`;

export const CANCEL_REQUEST = gql`
  ${REQUEST_FIELDS}
  mutation CancelRequest($id: ID!) {
    cancelRequest(id: $id) {
      ...RequestFields
    }
  }
`;

export const CONTEXT_INSTRUCTION_FIELDS = gql`
  fragment ContextInstructionFields on ContextInstruction {
    id
    projectId
    folderId
    name
    slug
    path
    description
    content
    version
    createdAt
    updatedAt
  }
`;

export const PROJECT_CONTEXT = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  query ProjectContext($id: ID!, $agentId: ID) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      agents {
        id
        name
        kind
        avatar {
          emoji
          color
        }
        inheritContext
      }
      contextFolders(agentId: $agentId) {
        id
        projectId
        parentId
        name
        slug
        path
        createdAt
        updatedAt
      }
      contextInstructions(agentId: $agentId) {
        ...ContextInstructionFields
      }
      contextChanges(limit: 100, agentId: $agentId) {
        id
        kind
        path
        details
        authorType
        authorSession {
          id
          name
        }
        createdAt
      }
    }
  }
`;

export const CONTEXT_INSTRUCTION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  query ContextInstruction($id: ID!) {
    contextInstruction(id: $id) {
      ...ContextInstructionFields
      versions {
        id
        version
        name
        description
        content
        changeNote
        authorType
        authorSession {
          id
          name
        }
        createdAt
      }
    }
  }
`;

export const CREATE_CONTEXT_FOLDER = gql`
  mutation CreateContextFolder($projectId: ID!, $parentId: ID, $name: String!, $agentId: ID) {
    createContextFolder(projectId: $projectId, parentId: $parentId, name: $name, agentId: $agentId) {
      id
      path
    }
  }
`;

export const RENAME_CONTEXT_FOLDER = gql`
  mutation RenameContextFolder($id: ID!, $name: String!) {
    renameContextFolder(id: $id, name: $name) {
      id
      path
    }
  }
`;

export const DELETE_CONTEXT_FOLDER = gql`
  mutation DeleteContextFolder($id: ID!) {
    deleteContextFolder(id: $id)
  }
`;

export const CREATE_CONTEXT_INSTRUCTION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  mutation CreateContextInstruction($input: CreateContextInstructionInput!) {
    createContextInstruction(input: $input) {
      ...ContextInstructionFields
    }
  }
`;

export const UPDATE_CONTEXT_INSTRUCTION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  mutation UpdateContextInstruction($id: ID!, $input: UpdateContextInstructionInput!) {
    updateContextInstruction(id: $id, input: $input) {
      ...ContextInstructionFields
    }
  }
`;

export const DELETE_CONTEXT_INSTRUCTION = gql`
  mutation DeleteContextInstruction($id: ID!) {
    deleteContextInstruction(id: $id)
  }
`;

export const RESTORE_CONTEXT_INSTRUCTION_VERSION = gql`
  ${CONTEXT_INSTRUCTION_FIELDS}
  mutation RestoreContextInstructionVersion($id: ID!, $version: Int!) {
    restoreContextInstructionVersion(id: $id, version: $version) {
      ...ContextInstructionFields
    }
  }
`;

/**
 * Explorateur de la sidebar : projets, leurs sessions (chacune avec son dossier de travail — la work session, notion
 * technique que l'interface ne montre pas) et leurs terminaux.
 */
export const SIDEBAR = gql`
  query Sidebar($open: OpenItemsInput) {
    chats(limit: 12) {
      ...SidebarSession
    }
    guestProjects {
      id
      name
      unreadMessages
    }
    projects: sidebarProjects(open: $open) {
      id
      name
      slug
      gitUrl
      gitBranch
      isMember
      isPersonal
      myRole
      sessions(limit: 50) {
        ...SidebarSession
        worksession {
          id
          name
          branch
          exists
          task {
            id
            title
            status
            statusTag
          }
        }
      }
      terminals {
        id
        name
        status
        worksession {
          id
        }
      }
    }
  }
  fragment SidebarSession on Session {
    id
    name
    costUsd
    schedule {
      id
      name
      enabled
    }
    status
    activity
    pendingRequestCount
    browserActive
    subagents {
      id
      kind
      toolUseId
      description
      agentType
      background
      startedAt
      toolUses
      lastTool
      summary
    }
    pages {
      id
      title
      openComments
    }
    model
    context {
      tokens
      overThreshold
    }
    owner {
      id
      name
      avatarUrl
      kind
    }
    requestedBy {
      id
    }
    agent {
      id
      name
      avatar {
        emoji
        color
      }
    }
    parentSession {
      id
    }
  }
`;

/** Pull requests des branches des sessions (requête lente : GitHub), interrogée moins souvent que la sidebar. */
/** PR suivie de chaque dossier de travail (base de Skipper, en préparation comprise ; aucun appel GitHub). */
export const SIDEBAR_PULL_REQUESTS = gql`
  ${TASK_PULL_REQUEST_FIELDS}
  query SidebarPullRequests($open: OpenItemsInput) {
    projects: sidebarProjects(open: $open) {
      id
      worksessions {
        id
        trackedPullRequest {
          ...TaskPullRequestFields
        }
      }
    }
  }
`;

/** En-tête de la vue en direct du navigateur d'une session. */
export const SESSION_BROWSER = gql`
  query SessionBrowser($id: ID!) {
    session(id: $id) {
      id
      name
      status
      browserActive
      project {
        id
        name
      }
    }
  }
`;

/** Ce que la modale de lancement doit savoir d'un projet : dépôt, branche principale, autorisations par défaut. */
export const PROJECT_LAUNCH_INFO = gql`
  query ProjectLaunchInfo($id: ID!) {
    project(id: $id) {
      id
      gitUrl
      defaultPermissionMode
      defaultContextCleanup {
        contextAction
        contextMaxTokens
      }
      defaultModel
      approvalConnections
      git {
        branch
        commit
      }
    }
  }
`;

export const TERMINAL = gql`
  query Terminal($id: ID!) {
    terminal(id: $id) {
      id
      name
      status
      exitCode
      createdAt
      closedAt
      project {
        id
        name
        workspacePath
      }
      worksession {
        id
        name
        branch
        label
        path
      }
    }
  }
`;

export const CREATE_TERMINAL = gql`
  mutation CreateTerminal($projectId: ID!, $name: String, $worksessionId: ID!) {
    createTerminal(projectId: $projectId, name: $name, worksessionId: $worksessionId) {
      id
      name
      status
    }
  }
`;

export const CLOSE_TERMINAL = gql`
  mutation CloseTerminal($id: ID!) {
    closeTerminal(id: $id) {
      id
      status
      exitCode
    }
  }
`;

export const DELETE_TERMINAL = gql`
  mutation DeleteTerminal($id: ID!) {
    deleteTerminal(id: $id)
  }
`;

export const TASK_FIELDS = gql`
  fragment TaskFields on Task {
    id
    title
    summary
    description
    status
    statusTag
    tags
    priority
    dueDate
    createdByType
    createdAt
    updatedAt
    completedAt
    startedAt
    cancelledAt
    customFields {
      key
      value
    }
    assignee {
      name
      email
    }
    reporter {
      name
      email
    }
    commentCount
    attachmentCount
    costUsd
    attachments {
      id
      name
      mediaType
      size
    }
    branch
    worksession {
      id
      branch
      archivedAt
    }
    project {
      id
      name
    }
    session {
      id
      name
      status
      activity
      worksession {
        id
        branch
      }
    }
    createdBySession {
      id
      name
    }
    dependsOn {
      id
      title
      status
    }
    blockedBy {
      id
      title
      status
    }
    dependents {
      id
      title
      status
    }
    autoStartWhenUnblocked
    autoStartBy {
      id
      name
    }
    stalledSince
    waitingSince
    wakeAt
    wakeNote
  }
`;

export const TASKS = gql`
  ${TASK_FIELDS}
  ${TASK_PULL_REQUEST_FIELDS}
  query Tasks($projectId: ID, $status: [TaskStatus!], $priority: TaskPriority, $assignee: String, $reporter: String, $tag: String, $mine: Boolean, $closedSince: DateTime, $limit: Int) {
    tasks(projectId: $projectId, status: $status, priority: $priority, assignee: $assignee, reporter: $reporter, tag: $tag, mine: $mine, closedSince: $closedSince, limit: $limit) {
      ...TaskFields
      pullRequest {
        number
        title
        url
        state
        isDraft
        mergeable
        reviewDecision
        checksState
        headRefName
        baseRefName
      }
      pullRequests {
        ...TaskPullRequestFields
      }
    }
  }
`;

export const CREATE_TASK = gql`
  ${TASK_FIELDS}
  mutation CreateTask($input: CreateTaskInput!) {
    createTask(input: $input) {
      ...TaskFields
    }
  }
`;

export const UPDATE_TASK = gql`
  ${TASK_FIELDS}
  mutation UpdateTask($id: ID!, $input: UpdateTaskInput!) {
    updateTask(id: $id, input: $input) {
      ...TaskFields
    }
  }
`;

/** Déplace une tâche dans un autre projet. */
export const MOVE_TASK = gql`
  ${TASK_FIELDS}
  mutation MoveTask($id: ID!, $projectId: ID!) {
    moveTask(id: $id, projectId: $projectId) {
      ...TaskFields
    }
  }
`;

export const DELETE_TASK = gql`
  mutation DeleteTask($id: ID!) {
    deleteTask(id: $id)
  }
`;

export const START_TASK_SESSION = gql`
  mutation StartTaskSession($id: ID!, $provider: String, $config: JSON, $prompt: String, $agentId: ID) {
    startTaskSession(id: $id, provider: $provider, config: $config, prompt: $prompt, agentId: $agentId) {
      id
    }
  }
`;

/** Reprend la tâche dans la conversation de sa session (`Task.resumableSession`), au lieu d'en lancer une nouvelle. */
export const RESUME_TASK_SESSION = gql`
  mutation ResumeTaskSession($id: ID!, $text: String!) {
    resumeTaskSession(id: $id, text: $text) {
      id
    }
  }
`;

/** Où une tâche peut être confiée : projets reliés à git et leurs work sessions existantes. */
export const TASK_LAUNCH_TARGETS = gql`
  query TaskLaunchTargets {
    projects {
      id
      myRole
      gitUrl
      defaultPermissionMode
      approvalConnections
    }
  }
`;

export const NOTIFICATIONS = gql`
  query Notifications($limit: Int, $projectId: ID) {
    notifications(limit: $limit, projectId: $projectId) {
      id
      type
      title
      message
      link
      readAt
      createdAt
      project {
        id
        name
      }
    }
    unreadNotificationCount(projectId: $projectId)
  }
`;

export const MARK_NOTIFICATION_READ = gql`
  mutation MarkNotificationRead($id: ID!) {
    markNotificationRead(id: $id) {
      id
      readAt
    }
  }
`;

export const MARK_ALL_NOTIFICATIONS_READ = gql`
  mutation MarkAllNotificationsRead($projectId: ID) {
    markAllNotificationsRead(projectId: $projectId)
  }
`;

// ---- Paramètres (voir settings.ts, ré-exporté ici pour les importeurs existants) -------------
export * from './settings';

// ---- Explorateur de fichiers ---------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
  size: number | null;
  modifiedAt: string | null;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  binary: boolean;
  content: string | null;
}

/** Dossier de travail d'une session (explorateur de fichiers). */
export const SESSION_WORKSPACE = gql`
  query SessionWorkspace($id: ID!) {
    session(id: $id) {
      id
      name
      project {
        id
        name
        slug
        workspacePath
        gitUrl
      }
      worksession {
        id
        name
        branch
        path
        exists
      }
    }
  }
`;

const FILE_ENTRY_FIELDS = gql`
  fragment FileEntryFields on FileEntry {
    name
    path
    kind
    size
    modifiedAt
  }
`;

const FILE_CONTENT_FIELDS = gql`
  fragment FileContentFields on FileContent {
    path
    name
    size
    modifiedAt
    binary
    content
  }
`;

export const WORKSPACE_ENTRIES = gql`
  ${FILE_ENTRY_FIELDS}
  query WorkspaceEntries($projectId: ID!, $worksessionId: ID, $path: String) {
    workspaceEntries(projectId: $projectId, worksessionId: $worksessionId, path: $path) {
      ...FileEntryFields
    }
  }
`;

export const WORKSPACE_FILE = gql`
  ${FILE_CONTENT_FIELDS}
  query WorkspaceFile($projectId: ID!, $worksessionId: ID, $path: String!) {
    workspaceFile(projectId: $projectId, worksessionId: $worksessionId, path: $path) {
      ...FileContentFields
    }
  }
`;

export const WRITE_WORKSPACE_FILE = gql`
  ${FILE_CONTENT_FIELDS}
  mutation WriteWorkspaceFile($projectId: ID!, $worksessionId: ID, $path: String!, $content: String!, $expectedModifiedAt: DateTime) {
    writeWorkspaceFile(projectId: $projectId, worksessionId: $worksessionId, path: $path, content: $content, expectedModifiedAt: $expectedModifiedAt) {
      ...FileContentFields
    }
  }
`;

export const CREATE_WORKSPACE_ENTRY = gql`
  ${FILE_ENTRY_FIELDS}
  mutation CreateWorkspaceEntry($projectId: ID!, $worksessionId: ID, $path: String!, $kind: FileEntryKind!) {
    createWorkspaceEntry(projectId: $projectId, worksessionId: $worksessionId, path: $path, kind: $kind) {
      ...FileEntryFields
    }
  }
`;

export const RENAME_WORKSPACE_ENTRY = gql`
  ${FILE_ENTRY_FIELDS}
  mutation RenameWorkspaceEntry($projectId: ID!, $worksessionId: ID, $path: String!, $newPath: String!) {
    renameWorkspaceEntry(projectId: $projectId, worksessionId: $worksessionId, path: $path, newPath: $newPath) {
      ...FileEntryFields
    }
  }
`;

export const DELETE_WORKSPACE_ENTRY = gql`
  mutation DeleteWorkspaceEntry($projectId: ID!, $worksessionId: ID, $path: String!) {
    deleteWorkspaceEntry(projectId: $projectId, worksessionId: $worksessionId, path: $path)
  }
`;

export const GIT_STATUS_FIELDS = gql`
  fragment GitStatusFields on GitStatus {
    branch
    upstream
    ahead
    behind
    detached
    changes {
      path
      origPath
      indexStatus
      worktreeStatus
      staged
      unstaged
      untracked
      conflicted
    }
    headCommit {
      hash
      shortHash
      subject
      author
      date
    }
    operation
  }
`;

export const GIT_STATUS = gql`
  ${GIT_STATUS_FIELDS}
  query GitStatus($projectId: ID!, $worksessionId: ID) {
    gitStatus(projectId: $projectId, worksessionId: $worksessionId) {
      ...GitStatusFields
    }
  }
`;

export const GIT_DIFF = gql`
  query GitDiff($projectId: ID!, $worksessionId: ID, $path: String!, $staged: Boolean) {
    gitDiff(projectId: $projectId, worksessionId: $worksessionId, path: $path, staged: $staged) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export const GIT_COMMIT_DIFF = gql`
  query GitCommitDiff($projectId: ID!, $worksessionId: ID, $hash: String!) {
    gitCommitDiff(projectId: $projectId, worksessionId: $worksessionId, hash: $hash) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export const GIT_BRANCHES = gql`
  query GitBranches($projectId: ID!, $worksessionId: ID) {
    gitBranches(projectId: $projectId, worksessionId: $worksessionId) {
      name
      current
      remote
      upstream
      commit {
        hash
        shortHash
        subject
        author
        date
      }
    }
  }
`;

export const GIT_LOG = gql`
  query GitLog($projectId: ID!, $worksessionId: ID, $limit: Int) {
    gitLog(projectId: $projectId, worksessionId: $worksessionId, limit: $limit) {
      hash
      shortHash
      subject
      author
      date
    }
  }
`;

const gitMutation = (name: string, args: string, call: string) => gql`
  ${GIT_STATUS_FIELDS}
  mutation ${name}($projectId: ID!, $worksessionId: ID${args}) {
    ${call} {
      ...GitStatusFields
    }
  }
`;
export const GIT_STAGE = gitMutation('GitStage', ', $paths: [String!]!', 'gitStage(projectId: $projectId, worksessionId: $worksessionId, paths: $paths)');
export const GIT_UNSTAGE = gitMutation('GitUnstage', ', $paths: [String!]!', 'gitUnstage(projectId: $projectId, worksessionId: $worksessionId, paths: $paths)');
export const GIT_DISCARD = gitMutation('GitDiscard', ', $paths: [String!]!', 'gitDiscard(projectId: $projectId, worksessionId: $worksessionId, paths: $paths)');
export const GIT_COMMIT = gitMutation('GitCommit', ', $message: String!, $stageAll: Boolean', 'gitCommit(projectId: $projectId, worksessionId: $worksessionId, message: $message, stageAll: $stageAll)');
export const GIT_FETCH = gitMutation('GitFetch', '', 'gitFetch(projectId: $projectId, worksessionId: $worksessionId)');
export const GIT_PULL = gitMutation('GitPull', '', 'gitPull(projectId: $projectId, worksessionId: $worksessionId)');
export const GIT_PUSH = gitMutation('GitPush', '', 'gitPush(projectId: $projectId, worksessionId: $worksessionId)');
export const GIT_MERGE_BASE = gitMutation('GitMergeBase', '', 'gitMergeBase(projectId: $projectId, worksessionId: $worksessionId)');
export const GIT_ABORT_OPERATION = gitMutation('GitAbortOperation', '', 'gitAbortOperation(projectId: $projectId, worksessionId: $worksessionId)');
export const RESOLVE_GIT_CONFLICTS = gql`
  mutation ResolveGitConflicts($projectId: ID!, $worksessionId: ID!) {
    resolveGitConflicts(projectId: $projectId, worksessionId: $worksessionId) {
      id
      name
      status
    }
  }
`;
export const GIT_CHECKOUT = gitMutation('GitCheckout', ', $branch: String!, $create: Boolean', 'gitCheckout(projectId: $projectId, worksessionId: $worksessionId, branch: $branch, create: $create)');

// ---- Pull requests GitHub -----------------------------------------------------------------------

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
export type PullRequestMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

/** Champs d'une PR affichés sur une carte de tâche. */
export interface PullRequestSummary {
  /** Dépôt GitHub « owner/name ». */
  repo?: string;
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  checksState: string | null;
  headRefName: string;
  baseRefName: string;
}

export interface PullRequest extends PullRequestSummary {
  /** « GitHub » ou « Forgejo » (dépôt hébergé par Skipper). */
  forgeName: string;
  body: string;
  author: string | null;
  authorAvatarUrl: string | null;
  isCrossRepository: boolean;
  mergeStateStatus: string;
  checks: { name: string; state: string; url: string | null }[];
  reviews: { author: string; state: string }[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  worksession: { id: string; name: string; sessions: { id: string; name: string; status: SessionStatus }[] } | null;
  tasks: { id: string; title: string; status: TaskStatus }[];
}

export interface PullRequestDraft {
  branch: string;
  base: string;
  title: string;
  body: string;
  commits: { hash: string; subject: string }[];
  needsPush: boolean;
  existing: PullRequest | null;
}

export const PULL_REQUEST_FIELDS = gql`
  fragment PullRequestFields on PullRequest {
    repo
    forgeName
    number
    title
    body
    url
    state
    isDraft
    author
    authorAvatarUrl
    headRefName
    baseRefName
    isCrossRepository
    mergeable
    mergeStateStatus
    reviewDecision
    checksState
    checks {
      name
      state
      url
    }
    reviews {
      author
      state
    }
    additions
    deletions
    changedFiles
    commitCount
    createdAt
    updatedAt
    mergedAt
    worksession {
      id
      name
      sessions {
        id
        name
        status
      }
    }
    tasks {
      id
      title
      status
    }
  }
`;

export const GITHUB_PULL_REQUESTS = gql`
  ${PULL_REQUEST_FIELDS}
  query GithubPullRequests($projectId: ID!, $state: PullRequestFilter, $limit: Int) {
    githubPullRequests(projectId: $projectId, state: $state, limit: $limit) {
      ...PullRequestFields
    }
  }
`;

export const GITHUB_PULL_REQUEST = gql`
  ${PULL_REQUEST_FIELDS}
  query GithubPullRequest($projectId: ID!, $number: Int!, $repo: String) {
    githubPullRequest(projectId: $projectId, number: $number, repo: $repo) {
      ...PullRequestFields
    }
  }
`;

export const GITHUB_PULL_REQUEST_DRAFT = gql`
  ${PULL_REQUEST_FIELDS}
  query GithubPullRequestDraft($projectId: ID!, $worksessionId: ID) {
    githubPullRequestDraft(projectId: $projectId, worksessionId: $worksessionId) {
      branch
      base
      title
      body
      commits {
        hash
        subject
      }
      needsPush
      existing {
        ...PullRequestFields
      }
    }
  }
`;

export const CREATE_PULL_REQUEST = gql`
  ${PULL_REQUEST_FIELDS}
  mutation CreatePullRequest($projectId: ID!, $worksessionId: ID, $title: String!, $body: String, $base: String, $draft: Boolean) {
    createPullRequest(projectId: $projectId, worksessionId: $worksessionId, title: $title, body: $body, base: $base, draft: $draft) {
      ...PullRequestFields
    }
  }
`;

export const MERGE_PULL_REQUEST = gql`
  ${PULL_REQUEST_FIELDS}
  mutation MergePullRequest($projectId: ID!, $number: Int!, $method: PullRequestMergeMethod, $cleanup: MergePullRequestCleanup, $repo: String) {
    mergePullRequest(projectId: $projectId, number: $number, method: $method, cleanup: $cleanup, repo: $repo) {
      sha
      deletedWorksessionIds
      completedTaskIds
      warnings
      pullRequest {
        ...PullRequestFields
      }
    }
  }
`;

// ---- Tableau de bord ----------------------------------------------------------------------------

export interface DashboardCounts {
  pendingRequests: number;
  busySessions: number;
  idleSessions: number;
  failedSessions24h: number;
  endedSessions24h: number;
  todoTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
  doneTasks7d: number;
  unreadNotifications: number;
  openPullRequests: number;
  pendingPullRequests: number;
}

export interface DashboardUsage {
  monthStart: string;
  monthUsd: number;
  globalMonthUsd: number;
  monthlyBudgetUsd: number | null;
  todayUsd: number;
  last7DaysUsd: number;
  previous7DaysUsd: number;
  byDay: { day: string; usd: number }[];
  topSessions: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
  rateLimits: ClaudeRateLimits | null;
}

export interface DashboardProject {
  project: Pick<Project, 'id' | 'name' | 'slug' | 'gitUrl' | 'myRole'> & { git: { branch: string } | null };
  busySessions: number;
  idleSessions: number;
  pendingRequests: number;
  todoTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
  monthUsd: number;
  lastActivityAt: string | null;
}

export interface Dashboard {
  generatedAt: string;
  counts: DashboardCounts;
  usage: DashboardUsage;
  projects: DashboardProject[];
  pendingRequests: HumanRequest[];
  runningSessions: Session[];
  recentSessions: Session[];
  attentionTasks: Task[];
  /** Tâches « agent arrêté ». */
  staleTasks: Task[];
  pullRequests: TrackedPullRequest[];
}

export const DASHBOARD = gql`
  ${SESSION_FIELDS}
  ${REQUEST_FIELDS}
  ${TASK_FIELDS}
  ${TRACKED_PULL_REQUEST_FIELDS}
  query Dashboard {
    dashboard {
      generatedAt
      counts {
        pendingRequests
        busySessions
        idleSessions
        failedSessions24h
        endedSessions24h
        todoTasks
        inProgressTasks
        overdueTasks
        doneTasks7d
        unreadNotifications
        openPullRequests
        pendingPullRequests
      }
      usage {
        monthStart
        monthUsd
        globalMonthUsd
        monthlyBudgetUsd
        todayUsd
        last7DaysUsd
        previous7DaysUsd
        byDay {
          day
          usd
        }
        topSessions {
          sessionId
          sessionName
          projectName
          usd
        }
        rateLimits {
          updatedAt
          status
          rateLimitType
          rateLimitLabel
          resetsAt
          overageStatus
          overageDisabledReason
          isUsingOverage
          windows {
            type
            label
            utilization
            resetsAt
            observedAt
          }
        }
      }
      projects {
        project {
          id
          name
          slug
          gitUrl
          myRole
          isPersonal
          git {
            branch
          }
        }
        busySessions
        idleSessions
        pendingRequests
        todoTasks
        inProgressTasks
        overdueTasks
        monthUsd
        lastActivityAt
      }
      pendingRequests {
        ...RequestFields
      }
      runningSessions {
        ...SessionFields
      }
      recentSessions {
        ...SessionFields
      }
      attentionTasks {
        ...TaskFields
      }
      staleTasks {
        ...TaskFields
      }
      pullRequests {
        ...TrackedPullRequestFields
      }
    }
  }
`;

export const PROJECT_PERMISSION_RULES = gql`
  query ProjectPermissionRules($id: ID!) {
    project(id: $id) {
      id
      permissionRules {
        id
        projectId
        toolName
        ruleContent
        rule
        createdAt
        lastUsedAt
        useCount
        usageTrackedSince
        createdBySession {
          id
          name
        }
      }
    }
  }
`;

export const ADD_PROJECT_PERMISSION_RULE = gql`
  mutation AddProjectPermissionRule($projectId: ID!, $toolName: String!, $ruleContent: String) {
    addProjectPermissionRule(projectId: $projectId, toolName: $toolName, ruleContent: $ruleContent) {
      id
      rule
    }
  }
`;

export const UPDATE_PROJECT_PERMISSION_RULE = gql`
  mutation UpdateProjectPermissionRule($id: ID!, $rule: String!) {
    updateProjectPermissionRule(id: $id, rule: $rule) {
      id
      toolName
      ruleContent
      rule
    }
  }
`;

export const DELETE_PROJECT_PERMISSION_RULES = gql`
  mutation DeleteProjectPermissionRules($projectId: ID!, $ids: [ID!]!) {
    deleteProjectPermissionRules(projectId: $projectId, ids: $ids)
  }
`;

export const DELETE_PROJECT_PERMISSION_RULE = gql`
  mutation DeleteProjectPermissionRule($id: ID!) {
    deleteProjectPermissionRule(id: $id)
  }
`;

// ---- Modifications d'une session ----------------------------------------------------------------

export type SessionChangesMode = 'COMMIT' | 'HEAD' | 'MTIME';

export interface SessionFileChange {
  path: string;
  origPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  untracked: boolean;
}

export interface SessionChanges {
  mode: SessionChangesMode;
  baseCommit: string | null;
  files: SessionFileChange[];
  truncated: boolean;
}

const SESSION_CHANGES_FIELDS = gql`
  fragment SessionChangesFields on SessionChanges {
    mode
    baseCommit
    truncated
    files {
      path
      origPath
      status
      additions
      deletions
      untracked
    }
  }
`;

export const SESSION_CHANGES = gql`
  ${SESSION_CHANGES_FIELDS}
  query SessionChanges($sessionId: ID!) {
    sessionChanges(sessionId: $sessionId) {
      ...SessionChangesFields
    }
  }
`;

export const SESSION_FILE_DIFF = gql`
  query SessionFileDiff($sessionId: ID!, $path: String!, $origPath: String) {
    sessionFileDiff(sessionId: $sessionId, path: $path, origPath: $origPath) {
      path
      staged
      text
      binary
      truncated
    }
  }
`;

export const DISCARD_SESSION_FILE = gql`
  ${SESSION_CHANGES_FIELDS}
  mutation DiscardSessionFile($sessionId: ID!, $path: String!, $origPath: String) {
    discardSessionFile(sessionId: $sessionId, path: $path, origPath: $origPath) {
      ...SessionChangesFields
    }
  }
`;

/** Nom déjà en cache (chargé par la sidebar ou une liste) : affiché pendant le chargement d'une page. */
export const SESSION_NAME = gql`
  fragment CachedSessionName on Session {
    name
  }
`;

export const TERMINAL_NAME = gql`
  fragment CachedTerminalName on Terminal {
    name
  }
`;

export const PROJECT_NAME = gql`
  fragment CachedProjectName on Project {
    name
  }
`;

export interface ContainerProcess {
  pid: number;
  rssMb: number;
  elapsedSeconds: number;
  sessionId: string | null;
  session: { id: string; name: string; status: SessionStatus; activity: SessionActivity | null; updatedAt: string } | null;
  childrenRssMb: number;
  cwd: string | null;
}

export interface ContainerStats {
  sampledAt: string;
  memoryUsedMb: number;
  memoryLimitMb: number | null;
  memoryPercent: number | null;
  swapUsedMb: number | null;
  cpuPercent: number | null;
  cpuLimit: number | null;
  hostCpus: number;
  cpuPressurePercent: number | null;
  oomKills: number;
  memoryHighSince: string | null;
  claudeProcesses: ContainerProcess[];
}

export const PROJECT_CONTAINER_STATS = gql`
  query ProjectContainerStats($id: ID!) {
    project(id: $id) {
      id
      containerStats {
        sampledAt
        memoryUsedMb
        memoryLimitMb
        memoryPercent
        swapUsedMb
        cpuPercent
        cpuLimit
        hostCpus
        cpuPressurePercent
        oomKills
        memoryHighSince
        claudeProcesses {
          pid
          rssMb
          elapsedSeconds
          sessionId
          childrenRssMb
          cwd
          session {
            id
            name
            status
            activity
            updatedAt
          }
        }
      }
    }
  }
`;

// ---- Aperçus des work sessions ----------------------------------------------------------------------

export const PREVIEW_FIELDS = gql`
  fragment PreviewFields on Preview {
    worksessionId
    enabled
    status
    configured
    configSource
    configError
    command
    url
    error
    startedAt
    readyAt
    depsMode
    installCommand
    installMs
    readyMs
  }
`;

export const PREVIEW = gql`
  ${PREVIEW_FIELDS}
  query Preview($worksessionId: ID!) {
    preview(worksessionId: $worksessionId) {
      ...PreviewFields
    }
  }
`;

export const PREVIEW_LOG = gql`
  query PreviewLog($worksessionId: ID!) {
    previewLog(worksessionId: $worksessionId)
  }
`;

export const START_PREVIEW = gql`
  ${PREVIEW_FIELDS}
  mutation StartPreview($worksessionId: ID!) {
    startPreview(worksessionId: $worksessionId) {
      ...PreviewFields
    }
  }
`;

export const STOP_PREVIEW = gql`
  ${PREVIEW_FIELDS}
  mutation StopPreview($worksessionId: ID!) {
    stopPreview(worksessionId: $worksessionId) {
      ...PreviewFields
    }
  }
`;

export const PREVIEW_ACCESS_URL = gql`
  mutation PreviewAccessUrl($worksessionId: ID!, $path: String) {
    previewAccessUrl(worksessionId: $worksessionId, path: $path)
  }
`;

// ---- File « À traiter » -------------------------------------------------------------------------

export interface InboxCounts {
  requests: number;
  failedSessions: number;
  interruptedSessions: number;
  stalledTasks: number;
  pullRequests: number;
  /** Ce qui est à traiter (sans les tâches en attente). */
  total: number;
  /** Tâches mises en attente par leur agent, hors du total. */
  waitingTasks: number;
}

export interface Inbox {
  generatedAt: string;
  counts: InboxCounts;
  requests: HumanRequest[];
  sessions: Session[];
  /** Tâches « agent arrêté » : en cours, sans session qui tourne. */
  tasks: Task[];
  pullRequests: TrackedPullRequest[];
  /** Tâches en attente (pas à traiter), le réveil le plus proche d'abord. */
  waitingTasks: Task[];
}

/** Compteurs seuls, sondés par la sidebar (badge de « À traiter »). */
export const INBOX_COUNTS = gql`
  query InboxCounts($projectId: ID) {
    inboxCounts(projectId: $projectId) {
      requests
      failedSessions
      interruptedSessions
      stalledTasks
      pullRequests
      total
      waitingTasks
    }
  }
`;

export const INBOX = gql`
  ${SESSION_FIELDS}
  ${REQUEST_FIELDS}
  ${TRACKED_PULL_REQUEST_FIELDS}
  ${TASK_FIELDS}
  query Inbox($projectId: ID) {
    inbox(projectId: $projectId) {
      generatedAt
      counts {
        requests
        failedSessions
        interruptedSessions
        pullRequests
        total
        waitingTasks
      }
      requests {
        ...RequestFields
      }
      sessions {
        ...SessionFields
      }
      tasks {
        ...TaskFields
      }
      pullRequests {
        ...TrackedPullRequestFields
      }
      waitingTasks {
        ...TaskFields
      }
    }
  }
`;

/** Contrôle du navigateur headless d'un projet (carte « Navigateur headless » des réglages). */
export interface BrowserCheck {
  ok: boolean;
  enabled: boolean;
  image: string | null;
  probe: {
    arch: string | null;
    chromiumPath: string | null;
    chromiumVersion: string | null;
    browsers: string[];
    mcpPath: string | null;
    mcpVersion: string | null;
    memoryLimitMb: number | null;
    memoryUsedMb: number | null;
    memoryAvailableMb: number | null;
  } | null;
  problems: { level: 'error' | 'warning'; code: string; message: string }[];
  steps: { label: string; ok: boolean; detail: string | null; durationMs: number }[];
  screenshot: string | null;
  durationMs: number;
}

export const TEST_PROJECT_BROWSER = gql`
  mutation TestProjectBrowser($id: ID!) {
    testProjectBrowser(id: $id) {
      ok
      enabled
      image
      probe {
        arch
        chromiumPath
        chromiumVersion
        browsers
        mcpPath
        mcpVersion
        memoryLimitMb
        memoryUsedMb
        memoryAvailableMb
      }
      problems {
        level
        code
        message
      }
      steps {
        label
        ok
        detail
        durationMs
      }
      screenshot
      durationMs
    }
  }
`;
