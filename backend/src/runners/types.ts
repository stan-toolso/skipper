import type { Project } from '../projects/types.js';

export type RunnerKind = 'local' | 'docker';

/** Réglages propres au runner Docker, stockés dans projects.runner_config. */
export interface RunnerConfig {
  /** Image Docker ; défaut : SKIPPER_RUNNER_IMAGE (skipper-runner:latest). */
  image?: string;
  /** Limite mémoire, ex. "1g" ; défaut : SKIPPER_RUNNER_MEMORY. */
  memory?: string;
  /** Limite CPU, ex. "1" ou "0.5". */
  cpus?: string;
}

export interface RunnerStatus {
  kind: RunnerKind;
  /** L'environnement peut recevoir des sessions et terminaux. */
  ready: boolean;
  /** 'running', 'stopped', 'absent', 'unavailable' (Docker indisponible)... */
  state: string;
  containerName: string | null;
  image: string | null;
  memory: string | null;
  cpus: string | null;
  startedAt: Date | null;
  error: string | null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Un runner sait où et comment exécuter les processus d'un projet : CLI Claude Code des sessions,
 * shell des terminaux, commandes du provider shell. Le code du projet reste au même chemin absolu
 * quel que soit le runner.
 */
export interface Runner {
  readonly kind: RunnerKind;
  status(project: Project): Promise<RunnerStatus>;
  /** Prépare l'environnement (démarre le conteneur si besoin). */
  ensureReady(project: Project): Promise<RunnerStatus>;
  stop(project: Project): Promise<RunnerStatus>;
  /** Supprime l'environnement (conteneur) ; les fichiers du projet ne sont pas touchés. */
  remove(project: Project): Promise<void>;
  /** Exécutable Claude Code à donner au SDK ; undefined = celui embarqué par le SDK. */
  claudeExecutable(project: Project): Promise<string | undefined>;
  /** Shell interactif dans `cwd` (terminal web). */
  terminalCommand(project: Project, cwd: string): Promise<SpawnSpec>;
  /** Exécution d'un script shell dans `cwd` (provider shell). */
  shellCommand(project: Project, cwd: string, shell: string, script: string): Promise<SpawnSpec>;
}
