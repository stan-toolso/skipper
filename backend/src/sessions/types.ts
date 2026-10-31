export type SessionStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
/**
 * Session d'agent ordinaire, ou « chat » : session légère d'un espace personnel, sans work session ni
 * conteneur (le CLI tourne sur le serveur sans outil de fichiers ni de commande, avec les seuls outils MCP de Skipper).
 */
export type SessionKind = 'session' | 'chat';
/** Pour une session en cours : l'agent travaille ('busy') ou attend des instructions ('idle'). */
export type SessionActivity = 'busy' | 'idle';

/** Fichier joint à une instruction, enregistré sur le disque du serveur. */
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** Chemin absolu du fichier (le même dans un conteneur runner). */
  path: string;
}

/** Fichier envoyé par l'interface : contenu encodé en base64. */
export interface AttachmentInput {
  name: string;
  mediaType: string;
  data: string;
}

/** Nettoyage automatique de l'historique d'une session. */
export interface SessionCleanup {
  /** Les événements du transcript plus vieux que N jours sont supprimés (null : jamais). */
  retentionDays?: number | null;
  /**
   * Conversation de l'agent avant une exécution planifiée : « compact » (compacter) ou « reset » (repartir d'une
   * conversation neuve) quand le contexte dépasse contextMaxTokens ; « fresh » : conversation neuve à chaque exécution.
   */
  contextAction?: 'compact' | 'reset' | 'fresh' | null;
  contextMaxTokens?: number | null;
}

/** Démarrage différé d'une session en file d'attente : l'instruction à transmettre quand une place se libère. */
export interface QueuedStart {
  message: string | null;
  attachments: Attachment[];
}

/** Souvenir d'une work session supprimée, gardé par ses sessions archivées. */
export interface FormerWorksession {
  name: string;
  branch: string;
  label: string;
}

export interface Session {
  id: string;
  projectId: string;
  kind: SessionKind;
  worksessionId: string | null;
  /** Utilisateur qui a lancé la session (hérité de la session parente pour une session lancée par un agent) ; null : ouverte à tous les membres. */
  ownerId: string | null;
  /** Archivée : cachée des listes actives, consultable et relançable depuis l'historique du projet. */
  archivedAt: Date | null;
  /** Work session supprimée où la session a travaillé (nom, branche, libellé) ; null si elle n'en a pas perdu. */
  formerWorksession: FormerWorksession | null;
  /** Session d'agent qui a lancé celle-ci (outil `sessions.create`), null pour une session lancée par un humain. */
  parentSessionId: string | null;
  /** Exécution de workflow qui a ouvert la session (nœud « tâche » ou « session ») ; null pour une session lancée à la main. */
  workflowRunId: string | null;
  name: string;
  provider: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  prompt: string | null;
  /** Fichiers joints à la première instruction. */
  promptAttachments: Attachment[];
  config: Record<string, unknown>;
  externalId: string | null;
  exitCode: number | null;
  error: string | null;
  cleanup: SessionCleanup;
  /** Taille du contexte de l'agent au dernier tour (tokens), null si inconnue. */
  contextTokens: number | null;
  /**
   * Après une remise à zéro « en gardant un résumé » : derniers échanges de la conversation précédente, transmis
   * au modèle avec la première instruction de la conversation neuve (hors transcript), puis effacés.
   */
  resumeDigest: string | null;
  /** Coût estimé cumulé (USD, tarif API), d'après le SDK. */
  costUsd: number;
  /** Commit HEAD du dossier de travail au premier démarrage (référence de l'onglet « Modifications »), null sans git. */
  baseCommit: string | null;
  /** Mise en file d'attente (statut « queued ») faute de place : null sinon. */
  queuedAt: Date | null;
  /** Instruction de démarrage différée par la file d'attente (null : la consigne de la session). */
  queuedStart: QueuedStart | null;
  /** Instance du backend qui tient le processus de la session (déploiement bleu/vert), null : aucune. Interne, hors GraphQL. */
  instanceId?: string | null;
  /**
   * Session « garée » par une instance en drainage à la fin de son tour : processus arrêté, statut `running`/`idle`
   * conservé ; la prochaine instruction la relance sur l'instance qui la reçoit. Interne, hors GraphQL.
   */
  parkedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Work session à créer en même temps que la session, qui s'y exécutera (noms dérivés de la consigne par défaut). */
export interface NewWorksessionInput {
  branch?: string | null;
  name?: string | null;
  label?: string | null;
  baseRef?: string | null;
  taskId?: string | null;
}

export interface CreateSessionInput {
  projectId: string;
  /** Chat (espace personnel seulement, sans work session) ; défaut : session. */
  kind?: SessionKind | null;
  /** Work session où la session s'exécute : obligatoire, sauf `newWorksession` (et pour un chat, qui n'en a pas). */
  worksessionId?: string | null;
  /** Crée d'abord cette work session et y lance la session (exclusif avec worksessionId). */
  newWorksession?: NewWorksessionInput | null;
  parentSessionId?: string | null;
  ownerId?: string | null;
  /** Session lancée par une exécution de workflow. */
  workflowRunId?: string | null;
  name: string;
  provider: string;
  prompt?: string | null;
  /** Fichiers joints à la première instruction (enregistrés à la création). */
  attachments?: AttachmentInput[] | null;
  config?: Record<string, unknown> | null;
}

export interface SessionFilter {
  projectId?: string;
  /** Sessions ordinaires (défaut), chats seuls, ou tout. */
  kind?: SessionKind | 'all';
  /** Restreint aux projets listés (projets accessibles à l'utilisateur). */
  projectIds?: string[];
  worksessionId?: string;
  parentSessionId?: string;
  ownerId?: string;
  /** Restreint à ces sessions (tâche ↔ sessions). */
  ids?: string[];
  status?: SessionStatus;
  provider?: string;
  /** Sessions archivées : exclues (défaut), seules, ou toutes. */
  archived?: 'exclude' | 'only' | 'all';
  /** Texte cherché dans le nom, la consigne et la conversation. */
  search?: string;
  limit?: number;
  offset?: number;
}

/** Relance d'une session à partir de sa conversation, dans son dossier de travail (ou un nouveau s'il a disparu). */
export interface RelaunchInput {
  name?: string | null;
  instruction?: string | null;
  ownerId?: string | null;
}
