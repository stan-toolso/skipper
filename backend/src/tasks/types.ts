import type { Actor } from '../context/types.js';
import type { AttachmentInput } from '../sessions/types.js';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
export const TASK_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
/** Statuts « ouverts » : filtre par défaut de toutes les listes. */
export const OPEN_STATUSES: TaskStatus[] = ['todo', 'in_progress'];

/** Champ libre d'une tâche (lien du ticket, environnement...). La clé est unique dans la tâche, sans tenir compte de la casse. */
export interface TaskField {
  key: string;
  value: string;
}

/** Personne désignée librement sur une tâche : nom et/ou e-mail (au moins l'un des deux). */
export interface TaskPerson {
  name: string | null;
  email: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  /** Une ou deux phrases qui disent l'objet de la tâche, lues avant la description ; null : pas de résumé. */
  summary: string | null;
  description: string;
  status: TaskStatus;
  /**
   * Statut de la tâche dans son projet (clé, voir tasks/statuses.ts) tel qu'enregistré ; `status` en est la catégorie.
   * Null : le statut par défaut de la catégorie. Lire le statut effectif avec `effectiveStatus`.
   */
  state: string | null;
  /** Court libellé de l'avancement dans le statut (« en revue », « bloquée »…), affiché à côté. */
  statusTag: string | null;
  /** Étiquettes libres (uniques sans tenir compte de la casse, dans l'ordre d'affichage). */
  tags: string[];
  priority: TaskPriority;
  /** La plus récente des sessions en charge (null : aucune) ; l'historique complet est dans task_sessions. */
  sessionId: string | null;
  /** Toutes les sessions en charge actuellement, la plus récente d'abord (plusieurs agents peuvent se partager une tâche). */
  sessionIds: string[];
  /** Branche git de la tâche (work session dédiée), conservée après suppression de la work session. */
  branch: string | null;
  createdByType: Actor['type'];
  createdBySessionId: string | null;
  dueDate: string | null;
  customFields: TaskField[];
  assignee: TaskPerson | null;
  reporter: TaskPerson | null;
  commentCount: number;
  /** Fichiers joints à la tâche elle-même (ceux de ses commentaires ne comptent pas). */
  attachmentCount: number;
  /** Tâches dont celle-ci dépend (« bloquée par »), du même projet. */
  dependsOnIds: string[];
  /** Celles de `dependsOnIds` qui ne sont pas terminées (une annulée bloque encore) : tant qu'il en reste, la tâche est bloquée. */
  blockedByIds: string[];
  /** Tâches qui dépendent de celle-ci. */
  dependentIds: string[];
  /** Confiée automatiquement à une session quand sa dernière dépendance se termine (option consommée au lancement). */
  autoStartWhenUnblocked: boolean;
  /** Personne (ou agent) au nom de qui la session sera lancée : celle qui a armé l'option. */
  autoStartById: string | null;
  /**
   * « Agent arrêté » : la tâche est en cours, des sessions en ont la charge mais aucune ne tourne plus (et aucune pull
   * request n'est ouverte), et rien ne dit qu'elle attend quelque chose (voir `ATTENTION_JOIN`) : à traiter. Date de
   * fin de la plus récente (ou du réveil passé). Null : rien à signaler.
   */
  stalledSince: Date | null;
  /**
   * « En attente » : même situation, mais l'agent a dit qu'il attendait (date de réveil future, étiquette d'état ou
   * compte rendu dans le fil) ; pas à traiter avant le réveil. Null sinon.
   */
  waitingSince: Date | null;
  /** Date de réveil posée par l'agent (ou une personne) : la tâche revient alors à l'agent qui la tenait, ou dans « À traiter ». */
  wakeAt: Date | null;
  /** Ce qu'il faudra vérifier au réveil (transmis à l'agent réveillé). */
  wakeNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  /** Passage en cours (premier, effacé au retour à « à faire ») ; null si jamais démarrée. */
  startedAt: Date | null;
  /** Passage en annulée ; null hors du statut annulée. */
  cancelledAt: Date | null;
}

/** Entrée d'une personne : `undefined` = inchangé, `null` ou deux champs vides = retirée. */
export interface TaskPersonInput {
  name?: string | null;
  email?: string | null;
}

/** Fichier joint à une tâche (`commentId` null) ou à l'un de ses commentaires : les métadonnées ; le contenu est sur disque (tasks/attachments.ts). */
export interface TaskAttachment {
  id: string;
  taskId: string;
  commentId: string | null;
  name: string;
  mediaType: string;
  size: number;
  createdAt: Date;
}

/** Fichiers d'un commentaire : ajoutés (base64) et retirés (identifiants), en plus de son texte. */
export interface CommentFiles {
  attachments?: AttachmentInput[] | null;
  removeAttachmentIds?: string[] | null;
}

export interface CreateTaskInput {
  title: string;
  /** Résumé de l'objet de la tâche (vide : aucun). */
  summary?: string | null;
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus | null;
  /** Statut du projet (clé ou libellé) ; fixe la catégorie `status`. Résolu en clé par le service. */
  state?: string | null;
  sessionId?: string | null;
  dueDate?: string | null;
  customFields?: TaskField[] | null;
  statusTag?: string | null;
  tags?: string[] | null;
  assignee?: TaskPersonInput | null;
  reporter?: TaskPersonInput | null;
  /** Fichiers joints à la tâche (images collées dans la description, documents…). */
  attachments?: AttachmentInput[] | null;
  /** Tâches du même projet dont celle-ci dépend. */
  dependsOn?: string[] | null;
  /** Lancer automatiquement quand la dernière dépendance se termine ; armée au nom de l'acteur (`autoStartById`). */
  autoStartWhenUnblocked?: boolean | null;
  /** Rempli par le service d'après l'acteur. */
  autoStartById?: string | null;
}

export interface UpdateTaskInput {
  title?: string | null;
  /** `undefined` : inchangé ; null ou vide : retiré. */
  summary?: string | null;
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus | null;
  /** Statut du projet (clé ou libellé) ; fixe la catégorie `status`. Résolu en clé par le service. */
  state?: string | null;
  /** Session qui prend la charge (s'ajoute aux sessions déjà en charge) ; null : plus aucune session en charge. */
  sessionId?: string | null;
  /** Sessions qui cessent d'être en charge (passation, fin de travail). */
  releaseSessionIds?: string[] | null;
  branch?: string | null;
  dueDate?: string | null;
  /** Remplace la liste complète. */
  customFields?: TaskField[] | null;
  /** Absent : inchangée ; null ou vide : retirée. */
  statusTag?: string | null;
  /** Remplace la liste complète. */
  tags?: string[] | null;
  assignee?: TaskPersonInput | null;
  reporter?: TaskPersonInput | null;
  /** Fichiers ajoutés aux pièces jointes de la tâche (celles déjà là restent). */
  attachments?: AttachmentInput[] | null;
  /** Pièces jointes de la tâche (pas de ses commentaires) à retirer. */
  removeAttachmentIds?: string[] | null;
  /** Remplace la liste complète des dépendances (tâches du même projet). */
  dependsOn?: string[] | null;
  /** Arme ou désarme le lancement automatique quand la tâche est débloquée. */
  autoStartWhenUnblocked?: boolean | null;
  /** Rempli par le service d'après l'acteur. */
  autoStartById?: string | null;
  /** Date de réveil (null : retirée ; absente : inchangée). Une nouvelle date sera traitée même si une précédente l'a été. */
  wakeAt?: Date | string | null;
  /** Ce qu'il faudra vérifier au réveil (null : retirée). */
  wakeNote?: string | null;
}

export interface TaskFilter {
  projectId?: string;
  projectIds?: string[];
  status?: TaskStatus[];
  priority?: TaskPriority;
  /** Tâches dont cette session est en charge. */
  sessionId?: string;
  /** Texte cherché dans le nom ou l'e-mail du responsable / du rapporteur. */
  assignee?: string;
  reporter?: string;
  /** Tâches dont le responsable a cet e-mail (« mes tâches »). */
  assigneeEmail?: string;
  /** Tâches traitées sur cette branche. */
  branch?: string;
  /** Tâches portant cette étiquette (sans tenir compte de la casse). */
  tag?: string;
  /** Seulement les tâches « agent arrêté » (`stalledSince` non nul). */
  stalled?: boolean;
  /** Seulement les tâches « en attente » (`waitingSince` non nul). */
  waiting?: boolean;
  /** Tâches fermées (terminées ou annulées) seulement si elles l'ont été depuis cette date ; les ouvertes passent toujours. */
  closedSince?: Date;
  limit?: number;
}

/** Personne ou session mentionnée dans un message (`@Nom`, `@session:<id>`), résolue à l'écriture ; `text` : le fragment du corps qui la porte. */
export interface TaskMention {
  kind: 'user' | 'session';
  id: string;
  label: string;
  text: string;
}

/** Message du fil d'une tâche (commentaire) : racine, ou réponse à une racine (`parentId`), comme un fil Slack. */
export interface TaskComment {
  id: string;
  taskId: string;
  /** Commentaire racine auquel celui-ci répond, null pour un message de premier niveau. */
  parentId: string | null;
  authorType: Actor['type'];
  authorUserId: string | null;
  authorSessionId: string | null;
  /** Nom au moment de l'écriture (utilisateur ou session), conservé ensuite. */
  authorName: string;
  body: string;
  mentions: TaskMention[];
  createdAt: Date;
  updatedAt: Date;
}

/** Réaction (emoji) d'une personne ou d'une session sur un message (`commentId`) ou sur la tâche elle-même (`commentId` null). */
export interface TaskReaction {
  id: string;
  taskId: string;
  commentId: string | null;
  emoji: string;
  actorType: Actor['type'];
  userId: string | null;
  sessionId: string | null;
  actorName: string;
  createdAt: Date;
}

/** Qui modifie ou commente une tâche, pour prévenir la session en charge et attribuer les commentaires. */
export interface TaskActor extends Actor {
  userId?: string | null;
  /** Nom affiché : utilisateur, session d'agent ou intégration (clé d'API). */
  name?: string | null;
  /** Tâche créée par un nœud « créer une tâche » d'une exécution de workflow (garde anti-boucle du déclencheur). */
  workflowRunId?: string | null;
}

/** Changement de tâche diffusé aux écouteurs (session en charge, notamment). */
export type TaskChange =
  | { kind: 'updated'; before: Task; task: Task; actor: TaskActor | null; addedAttachments: TaskAttachment[] }
  | { kind: 'commented'; task: Task; comment: TaskComment; attachments: TaskAttachment[]; parent: TaskComment | null }
  | { kind: 'reacted'; task: Task; reaction: TaskReaction; comment: TaskComment | null; added: boolean };

/**
 * Portées d'une clé d'API : `tasks:read` / `tasks:write` pour l'API REST des tâches, `inbound:task` pour créer une tâche
 * par le point d'entrée entrant, `inbound:triage` pour y convoquer un agent du projet (triage).
 */
export const API_KEY_SCOPES = ['tasks:read', 'tasks:write', 'inbound:task', 'inbound:triage'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ProjectApiKey {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdById: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  scopes: ApiKeyScope[];
  /** Un secret de signature est défini : les appels à /api/v1/inbound doivent être signés (HMAC-SHA256). */
  signed: boolean;
  /** Agent convoqué par défaut pour un triage reçu par cette clé (null : le Product Manager du projet). */
  triageAgentId: string | null;
}
