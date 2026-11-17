import type { SessionSubagent } from './subagents.js';
import type { Project } from '../../projects/types.js';
import type { CreateRequestInput } from '../../requests/types.js';
import type { UserClaudeSettings } from '../../settings/claude.js';
import type { UserOpencodeSettings } from '../../settings/opencode.js';
import type { Attachment, Session, SessionActivity } from '../types.js';
import type { InstructionAuthor } from '../instructionAuthor.js';

/** Réglages de la personne pour qui le formulaire est décrit (modèles autorisés, modèle par défaut) ; absents : description générique. */
export interface DescribeContext {
  claude?: UserClaudeSettings | null;
  opencode?: UserOpencodeSettings | null;
}

/** Description d'un champ de configuration, exposée au front pour générer le formulaire. */
export interface ConfigOption {
  value: string;
  label: string;
  description?: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  description?: string;
  options?: ConfigOption[];
  defaultValue?: string;
  /** true : affiché dans la section « Options avancées » du formulaire. */
  advanced?: boolean;
}

export interface ProviderDescription {
  type: string;
  label: string;
  description: string;
  /** true si la session accepte des instructions en cours d'exécution (sendMessage). */
  interactive: boolean;
  configFields: ConfigField[];
}

/** Contexte fourni au provider pendant l'exécution d'une session. */
export interface RunContext {
  session: Session;
  /** Projet auquel appartient la session (prompt système, dépôt git...). */
  project: Project;
  /** Dossier de travail : le workspace du projet, déjà créé. */
  cwd: string;
  /** Première instruction à traiter : le prompt de la session, ou le message qui a relancé une session terminée. */
  initialMessage: string | null;
  /**
   * Texte placé devant la première instruction pour le modèle seulement (absent du transcript) : résumé de la
   * conversation précédente après une remise à zéro « en gardant un résumé ».
   */
  initialPreamble?: string | null;
  /** Fichiers joints à la première instruction (chemins sur disque ; images et PDF peuvent aussi être transmis au modèle). */
  initialAttachments: Attachment[];
  /** Auteur de la première instruction : journalisé avec elle et annoncé au modèle (`authorHeader`). */
  initialAuthor?: InstructionAuthor | null;
  /** Signale si l'agent travaille ou attend des instructions. */
  setActivity(activity: SessionActivity): Promise<void>;
  /** Journalise un événement (persisté et diffusé en temps réel). */
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
  /** Enregistre l'identifiant de la session côté provider (ex. session_id Claude). */
  setExternalId(externalId: string): Promise<void>;
  /** Enregistre la taille du contexte de l'agent (tokens d'entrée du dernier appel au modèle), null si inconnue. */
  setContextTokens?(tokens: number | null): Promise<void>;
  /** Enregistre les sous-agents du CLI en cours (providers/subagents.ts), montrés dans la sidebar ; [] quand il n'y en a plus. */
  setSubagents?(subagents: SessionSubagent[]): Promise<void>;
  /**
   * Soumet une demande à l'humain (autorisation, question...) et attend sa réponse.
   * Rejette avec RequestCancelledError si la demande est annulée ou `signal` déclenché.
   */
  ask(input: CreateRequestInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
  /**
   * true dès que le serveur a commencé à s'arrêter. pm2 envoie son signal à tout l'arbre de
   * processus : l'agent peut mourir avant que `stop()` ne soit appelé, sa fin n'est alors pas une erreur.
   */
  isServerStopping(): boolean;
  /**
   * Enregistre un changement de configuration que le provider a déjà appliqué lui-même (ex. mode
   * d'autorisation accordé par l'humain en réponse à une demande), pour l'afficher et le conserver au prochain lancement.
   */
  recordConfig(changes: Record<string, unknown>): Promise<void>;
  /**
   * Fin d'un tour que l'agent a repris de lui-même (tâche de fond terminée, sans instruction d'une personne) : ce qui
   * l'a réveillé et son dernier texte. Le service prévient la personne qui pilote la session (`session.self_turn`).
   */
  onSelfTurnEnded?(info: { trigger: string; text: string | null }): Promise<void>;
}

export interface RunResult {
  exitCode: number | null;
  error?: string;
  /**
   * true si le flux a été fermé par le serveur (`stop()` ou arrêt du serveur), par opposition à
   * un agent qui s'est terminé de lui-même ; `error` est alors absent.
   */
  closedByServer?: boolean;
}

/** Poignée sur une exécution en cours, permettant de l'attendre ou de l'arrêter. */
export interface RunningHandle {
  wait(): Promise<RunResult>;
  /** Arrêt immédiat (abandon du travail en cours). */
  stop(): Promise<void>;
  /** Envoie une instruction à l'agent en cours d'exécution (providers interactifs). */
  sendMessage?(text: string, attachments?: Attachment[], author?: InstructionAuthor | null): Promise<void>;
  /**
   * Note discrète : un texte à porter à la connaissance de l'agent sans lui ouvrir de tour (remis avec le résultat de
   * ses prochains outils, ou avec sa prochaine instruction s'il attend).
   */
  notify?(text: string): Promise<void>;
  /** Fin propre : plus d'instructions, l'agent termine son tour puis la session se termine. */
  end?(): Promise<void>;
  /** Interrompt le tour en cours sans terminer la session. */
  interrupt?(): Promise<void>;
  /**
   * Applique en cours d'exécution une partie de la configuration (ex. modèle, mode d'autorisation).
   * Ne reçoit que les clés modifiées et renvoie celles qu'il a appliquées ; les autres valent pour le prochain lancement.
   */
  updateConfig?(patch: Record<string, unknown>): Promise<string[]>;
}

/**
 * Un provider sait lancer une session d'un type donné en arrière-plan.
 * Ajouter un nouveau type d'agent = implémenter cette interface et l'enregistrer dans `registry.ts`.
 */
export interface SessionProvider {
  readonly type: string;
  /** Description du type et de son formulaire, adaptée aux réglages de la personne quand ils sont fournis. */
  describe(ctx?: DescribeContext): ProviderDescription;
  /** Valide la config avant création ; lève une erreur si invalide. */
  validateConfig?(config: Record<string, unknown>): void;
  start(ctx: RunContext): Promise<RunningHandle>;
}
