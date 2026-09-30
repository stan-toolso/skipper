import type { Project } from '../../projects/types.js';
import type { CreateRequestInput } from '../../requests/types.js';
import type { Attachment, Session, SessionActivity } from '../types.js';

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
  /** Fichiers joints à la première instruction (chemins sur disque ; images et PDF peuvent aussi être transmis au modèle). */
  initialAttachments: Attachment[];
  /** Signale si l'agent travaille ou attend des instructions. */
  setActivity(activity: SessionActivity): Promise<void>;
  /** Journalise un événement (persisté et diffusé en temps réel). */
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
  /** Enregistre l'identifiant de la session côté provider (ex. session_id Claude). */
  setExternalId(externalId: string): Promise<void>;
  /**
   * Soumet une demande à l'humain (autorisation, question...) et attend sa réponse.
   * Rejette avec RequestCancelledError si la demande est annulée ou `signal` déclenché.
   */
  ask(input: CreateRequestInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface RunResult {
  exitCode: number | null;
  error?: string;
}

/** Poignée sur une exécution en cours, permettant de l'attendre ou de l'arrêter. */
export interface RunningHandle {
  wait(): Promise<RunResult>;
  /** Arrêt immédiat (abandon du travail en cours). */
  stop(): Promise<void>;
  /** Envoie une instruction à l'agent en cours d'exécution (providers interactifs). */
  sendMessage?(text: string, attachments?: Attachment[]): Promise<void>;
  /** Fin propre : plus d'instructions, l'agent termine son tour puis la session se termine. */
  end?(): Promise<void>;
  /** Interrompt le tour en cours sans terminer la session. */
  interrupt?(): Promise<void>;
}

/**
 * Un provider sait lancer une session d'un type donné en arrière-plan.
 * Ajouter un nouveau type d'agent = implémenter cette interface et l'enregistrer dans `registry.ts`.
 */
export interface SessionProvider {
  readonly type: string;
  describe(): ProviderDescription;
  /** Valide la config avant création ; lève une erreur si invalide. */
  validateConfig?(config: Record<string, unknown>): void;
  start(ctx: RunContext): Promise<RunningHandle>;
}
