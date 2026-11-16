/**
 * Agents de projet (Product Manager, Developer…) : un agent est un utilisateur (`users.kind = 'agent'`) membre de
 * son projet, avec ses propres comptes (réglages Claude, GitHub, coffre, consommation, indexés par son identifiant
 * comme pour une personne) et un profil (rôle, instructions, déclencheurs, actions). Tout ce qu'il fait est une
 * session dont il est le propriétaire (`sessions.owner_id`).
 */

export type AgentKind = 'product_manager' | 'developer' | 'custom';
export const AGENT_KINDS: AgentKind[] = ['product_manager', 'developer', 'custom'];
/** Types de session (providers) qu'un agent peut jouer : les sessions de code interactives, pas le terminal. */
export const AGENT_PROVIDERS = ['claude', 'opencode'];
export const AGENT_KIND_LABELS: Record<AgentKind, string> = { product_manager: 'Product Manager', developer: 'Developer', custom: 'Agent' };

export interface AgentAvatar {
  /** Emoji affiché dans l'avatar (sinon l'initiale du nom). */
  emoji: string | null;
  /** Couleur de fond (hex), sinon une couleur dérivée du nom. */
  color: string | null;
}

/** Interrupteurs : ce qui convoque l'agent sans qu'une personne le mentionne. */
export interface AgentTriggers {
  /** Une tâche créée par une personne (ou par l'API) dans le projet : l'agent intervient pour la cadrer. */
  taskCreated: boolean;
  /** Restreint `taskCreated` aux tâches portant cette étiquette (vide : toutes). */
  taskCreatedTag: string | null;
  /** Une réponse humaine dans le fil d'une tâche où l'agent est intervenu lui revient comme une instruction. */
  threadFollowed: boolean;
  /** La pull request d'une tâche est fusionnée : l'agent est prévenu (étiquette « à livrer », rapporteur informé…). */
  prMerged: boolean;
  /**
   * Un déploiement réussi du projet (lancé par Skipper ou déclaré par une session) : l'agent est prévenu avec les pull
   * requests et tâches qu'il met en production, et les met à jour selon les conventions du projet (étiquette « livrée »…).
   */
  deployed: boolean;
  /** Une tâche passée par une personne à l'étiquette d'état `taskReadyTag` : l'agent démarre dessus. */
  taskReady: boolean;
  taskReadyTag: string | null;
}

export const DEFAULT_TRIGGERS: AgentTriggers = { taskCreated: false, taskCreatedTag: null, threadFollowed: true, prMerged: false, deployed: false, taskReady: false, taskReadyTag: null };

/** Action nommée : une instruction jouée par l'agent, à la demande ou à heures fixes (planification dédiée). */
export interface AgentAction {
  key: string;
  label: string;
  instruction: string;
  /** Expression cron à cinq champs (null : à la demande seulement). */
  cron: string | null;
  timezone: string | null;
  /** Planification de l'action quand elle a un `cron` (créée et tenue à jour par le service). */
  scheduleId: string | null;
  /** Avant la refonte des planifications : session qui portait la planification (lue une fois, puis remplacée par `scheduleId`). */
  scheduleSessionId?: string | null;
}

export interface AgentProfile {
  /** Identifiant de l'utilisateur agent (clé du profil). */
  userId: string;
  projectId: string;
  kind: AgentKind;
  avatar: AgentAvatar;
  description: string;
  /** Markdown ajouté au prompt système de ses sessions, après le prompt du projet. */
  instructions: string;
  /** Ses sessions sur une tâche travaillent dans le dossier de la tâche (branche task/…) ; sinon un dossier par session. */
  taskFolder: boolean;
  /** Réglages par défaut de ses sessions (même forme que `sessions.config`, plus `provider` : le type de session). */
  defaults: Record<string, unknown>;
  /** Modèles que ses sessions peuvent utiliser (vide : tous) ; le modèle par défaut (`defaults.model`) en fait partie. */
  allowedModels: string[];
  /** En plus de sa propre bibliothèque de contexte, l'agent lit (et ses sessions reçoivent) celle du projet. */
  inheritContext: boolean;
  /** Personne qui prête son compte Claude à l'agent (null : les réglages Claude propres de l'agent). */
  claudeDelegateId: string | null;
  /** Personne qui prête son compte GitHub à l'agent (null : les comptes GitHub propres de l'agent). */
  githubDelegateId: string | null;
  /** Compte GitHub prêté en lecture seule : ni push, ni pull request (sauf `githubDelegatePullRequests`). */
  githubDelegateReadOnly: boolean;
  /** Compte GitHub prêté en lecture seule, mais l'agent peut ouvrir des pull requests (`tasks.pr_open`). */
  githubDelegatePullRequests: boolean;
  /** Compte GitHub prêté en écriture, fusion permise : l'agent fusionne les pull requests avec ce compte (`tasks.pr_merge`) sans demander d'accord. */
  githubDelegateMerge: boolean;
  /** Personne qui prête son compte GitLab à l'agent (null : les comptes GitLab propres de l'agent). */
  gitlabDelegateId: string | null;
  /** Compte GitLab prêté en lecture seule : ni push, ni merge request (sauf `gitlabDelegatePullRequests`). */
  gitlabDelegateReadOnly: boolean;
  /** Compte GitLab prêté en lecture seule, mais l'agent peut ouvrir des merge requests (`tasks.pr_open`). */
  gitlabDelegatePullRequests: boolean;
  /** Compte GitLab prêté en écriture, fusion permise (merge requests). */
  gitlabDelegateMerge: boolean;
  triggers: AgentTriggers;
  actions: AgentAction[];
  enabled: boolean;
  archivedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Un agent : son profil et ce qui vient de l'utilisateur (`id` = `userId`). */
export interface Agent extends AgentProfile {
  id: string;
  name: string;
  email: string;
}

export type AgentManagerRole = 'owner' | 'manager';

export interface AgentManager {
  agentId: string;
  userId: string;
  role: AgentManagerRole;
  createdAt: Date;
}

export interface AgentActionInput {
  /** Absent : dérivé du libellé. */
  key?: string | null;
  label: string;
  instruction: string;
  cron?: string | null;
  timezone?: string | null;
}

export interface AgentInput {
  name?: string | null;
  kind?: AgentKind | null;
  avatar?: Partial<AgentAvatar> | null;
  description?: string | null;
  instructions?: string | null;
  taskFolder?: boolean | null;
  defaults?: Record<string, unknown> | null;
  allowedModels?: string[] | null;
  triggers?: Partial<AgentTriggers> | null;
  /** Remplace la liste complète (les sessions planifiées des actions retirées sont supprimées). */
  actions?: AgentActionInput[] | null;
  inheritContext?: boolean | null;
}

/** Comptes qui servent aux sessions d'un propriétaire : les siens, ou ceux qu'une personne lui a prêtés (agent). */
export interface OwnerAccounts {
  /** Dont les réglages Claude (identifiants, modèle par défaut, budgets) font tourner la session. */
  claudeUserId: string;
  /** Dont les comptes GitHub servent les dépôts GitHub. */
  githubUserId: string;
  /** Compte GitHub prêté en lecture seule : la session ne pousse pas vers GitHub et n'y ouvre pas de pull request. */
  githubReadOnly: boolean;
  /** La session peut ouvrir des pull requests GitHub par `tasks.pr_open` (Skipper pousse sa branche), même en lecture seule. */
  githubPullRequests: boolean;
  /** La session fusionne les pull requests GitHub avec ce compte (`tasks.pr_merge`) sans demander l'accord d'une personne (prêt en écriture, fusion permise). */
  githubMerge: boolean;
  /** Dont les comptes GitLab servent les dépôts GitLab. */
  gitlabUserId: string;
  /** Compte GitLab prêté en lecture seule. */
  gitlabReadOnly: boolean;
  /** La session peut ouvrir des merge requests GitLab par `tasks.pr_open`, même en lecture seule. */
  gitlabPullRequests: boolean;
  /** La session fusionne les merge requests GitLab avec ce compte sans demander d'accord. */
  gitlabMerge: boolean;
  /** Dont le compte de la forge de Skipper (dépôt hébergé) sert le dépôt : toujours le propriétaire lui-même. */
  forgeUserId: string;
}

/** Comptes d'une personne : les siens partout, en écriture ; la fusion par `tasks.pr_merge` reste soumise à l'accord d'une personne. */
export const ownAccounts = (userId: string): OwnerAccounts => ({ claudeUserId: userId, githubUserId: userId, githubReadOnly: false, githubPullRequests: true, githubMerge: false, gitlabUserId: userId, gitlabReadOnly: false, gitlabPullRequests: true, gitlabMerge: false, forgeUserId: userId });

/** Ce qu'un agent peut emprunter : le compte Claude, le compte GitHub ou le compte GitLab d'une personne. */
export type AgentAccountKind = 'claude' | 'github' | 'gitlab';

export interface AgentStats {
  activeSessions: number;
  sessions: number;
  tasks: number;
  monthCostUsd: number;
  totalCostUsd: number;
  lastActivityAt: Date | null;
}

/** Modèle de départ d'un agent (préremplissage du formulaire). */
export interface AgentTemplate {
  kind: AgentKind;
  label: string;
  description: string;
  instructions: string;
  taskFolder: boolean;
  defaults: Record<string, unknown>;
  triggers: AgentTriggers;
  actions: AgentActionInput[];
  /** Nom proposé. */
  suggestedName: string;
  avatar: AgentAvatar;
}

export const normalizeTriggers = (t: Partial<AgentTriggers> | null | undefined): AgentTriggers => ({
  taskCreated: Boolean(t?.taskCreated),
  taskCreatedTag: t?.taskCreatedTag?.trim() || null,
  threadFollowed: t?.threadFollowed ?? DEFAULT_TRIGGERS.threadFollowed,
  prMerged: Boolean(t?.prMerged),
  deployed: Boolean(t?.deployed),
  taskReady: Boolean(t?.taskReady),
  taskReadyTag: t?.taskReadyTag?.trim() || null,
});

export const normalizeAvatar = (a: Partial<AgentAvatar> | null | undefined): AgentAvatar => ({ emoji: a?.emoji?.trim() || null, color: a?.color?.trim() || null });
