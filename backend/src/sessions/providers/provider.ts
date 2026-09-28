import type { Project } from '../../projects/types.js';
import type { CreateRequestInput } from '../../requests/types.js';
import type { Session } from '../types.js';

/** Description d'un champ de configuration, exposée au front pour générer le formulaire. */
export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  description?: string;
  options?: string[];
  defaultValue?: string;
}

export interface ProviderDescription {
  type: string;
  label: string;
  description: string;
  configFields: ConfigField[];
}

/** Contexte fourni au provider pendant l'exécution d'une session. */
export interface RunContext {
  session: Session;
  /** Projet auquel appartient la session (prompt système, dépôt git...). */
  project: Project;
  /** Dossier de travail : le workspace du projet, déjà créé. */
  cwd: string;
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
  stop(): Promise<void>;
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
