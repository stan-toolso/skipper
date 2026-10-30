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
  description: string;
  status: TaskStatus;
  /** Court libellé de l'avancement dans le statut (« en revue », « bloquée »…), affiché à côté. */
  statusTag: string | null;
  /** Étiquettes libres (uniques sans tenir compte de la casse, dans l'ordre d'affichage). */
  tags: string[];
  priority: TaskPriority;
  /** Session en charge actuellement (l'historique complet est dans task_sessions). */
  sessionId: string | null;
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
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
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
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus | null;
  sessionId?: string | null;
  dueDate?: string | null;
  customFields?: TaskField[] | null;
  statusTag?: string | null;
  tags?: string[] | null;
  assignee?: TaskPersonInput | null;
  reporter?: TaskPersonInput | null;
  /** Fichiers joints à la tâche (images collées dans la description, documents…). */
  attachments?: AttachmentInput[] | null;
}

export interface UpdateTaskInput {
  title?: string | null;
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus | null;
  sessionId?: string | null;
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
}

export interface TaskFilter {
  projectId?: string;
  projectIds?: string[];
  status?: TaskStatus[];
  priority?: TaskPriority;
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

export interface ProjectApiKey {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdById: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}
