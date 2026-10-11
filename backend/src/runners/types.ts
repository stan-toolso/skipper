import type { Project } from '../projects/types.js';

/** Un seul environnement d'exécution : le conteneur Docker du projet. Rien ne tourne sur le serveur. */
export type RunnerKind = 'docker';

/** Réglages propres au runner Docker, stockés dans projects.runner_config. */
export interface RunnerConfig {
  /** Image Docker ; défaut : SKIPPER_RUNNER_IMAGE (skipper-runner:latest). */
  image?: string;
  /** Limite mémoire, ex. "1g" ; défaut : SKIPPER_RUNNER_MEMORY. */
  memory?: string;
  /** Limite CPU, ex. "1" ou "0.5". */
  cpus?: string;
  /** Navigateur headless (serveur MCP Playwright) mis à disposition des agents. */
  browser?: boolean;
  /** Nombre maximal de sessions du projet en cours en même temps (absent ou 0 : seule la limite du serveur s'applique). */
  maxSessions?: number;
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
  /** Le conteneur existe mais a été créé avec une autre configuration ou une autre image : à recréer. */
  outdated: boolean;
  /** Raisons lisibles de `outdated` (« option --init ajoutée », « image reconstruite le … »). */
  outdatedReasons: string[];
  /** Processus zombies (terminés, non récoltés) dans le conteneur ; null s'il ne tourne pas ou si le comptage a échoué. */
  zombies: number | null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Le runner sait où et comment exécuter les processus d'un projet : CLI Claude Code des sessions,
 * shell des terminaux, commandes du provider shell. Le code du projet est monté dans le conteneur au
 * même chemin absolu que sur l'hôte.
 */
export interface Runner {
  readonly kind: RunnerKind;
  status(project: Project): Promise<RunnerStatus>;
  /**
   * Prépare l'environnement (démarre le conteneur si besoin). Un conteneur obsolète (`outdated`) est
   * recréé au passage si le projet est inactif selon `setIdleCheck`.
   */
  ensureReady(project: Project): Promise<RunnerStatus>;
  /** Déclare comment savoir qu'aucun processus du projet ne tourne (sessions, terminaux) : condition de la recréation automatique. */
  setIdleCheck(check: (project: Project) => Promise<boolean>): void;
  /** Au démarrage du serveur : supprime les conteneurs obsolètes de ces projets (rien ne tourne encore) ; ils seront recréés à la demande. */
  recreateOutdated(projects: Project[]): Promise<string[]>;
  stop(project: Project): Promise<RunnerStatus>;
  /** Supprime l'environnement (conteneur) ; les fichiers du projet ne sont pas touchés. */
  remove(project: Project): Promise<void>;
  /** Exécutable Claude Code à donner au SDK ; undefined = celui embarqué par le SDK. */
  claudeExecutable(project: Project): Promise<string | undefined>;
  /** Shell interactif dans `cwd` (terminal web) ; `rcfile` : fichier de démarrage bash (historique des commandes). */
  terminalCommand(project: Project, cwd: string, options?: { rcfile?: string }): Promise<SpawnSpec>;
  /** Écrit un fichier dans l'environnement du projet (hors des volumes du code : /tmp du conteneur). */
  putFile(project: Project, filePath: string, content: string): Promise<void>;
  /** Lit un fichier de l'environnement du projet. */
  getFile(project: Project, filePath: string): Promise<string>;
  /** Le chemin existe-t-il dans l'environnement du projet ? */
  pathExists(project: Project, filePath: string): Promise<boolean>;
  /** Supprime un fichier ou un dossier de l'environnement du projet. */
  removePath(project: Project, filePath: string): Promise<void>;
  /** Exécution d'un script shell dans `cwd` (provider shell). */
  shellCommand(project: Project, cwd: string, shell: string, script: string): Promise<SpawnSpec>;
  /**
   * Navigateur headless de la session : un Chromium lancé dans l'environnement du projet, avec son port
   * CDP, et la commande du serveur MCP Playwright (stdio) qui s'y attache. `dispose` arrête Chromium et supprime le profil.
   */
  browserMcpCommand(project: Project, cwd: string, options: BrowserMcpOptions): Promise<BrowserMcpServer>;
  /**
   * Flux d'octets vers le port CDP d'un Chromium de l'environnement (relais TCP ↔ stdio) : Chromium
   * n'écoute que sur la boucle locale du conteneur, le backend passe donc par un `docker exec -i`.
   */
  cdpTunnelCommand(project: Project, port: number): SpawnSpec;
  /** Commande OpenCode (`opencode <args>`) dans `cwd` de l'environnement du projet ; `envKeys` : variables du backend transmises par leur nom. */
  opencodeCommand(project: Project, cwd: string, envKeys: string[]): Promise<SpawnSpec>;
  /** Adresse à laquelle un processus de l'environnement joint le serveur Skipper (ponts MCP d'OpenCode). */
  hostAddress(project: Project): Promise<string>;
}

export interface BrowserMcpOptions {
  /** Identifie le dossier du navigateur de la session (profil). */
  sessionId: string;
}

export interface BrowserMcpServer extends SpawnSpec {
  /** Point d'accès CDP du Chromium de la session, dans l'environnement du projet. */
  cdp: { port: number; browserPath: string };
  /** Arrête Chromium et supprime son dossier (profil) ; à appeler en fin de session. */
  dispose(): Promise<void>;
}

/** Nom court d'une session dans les chemins temporaires (cohérent avec connections/runtime.ts). */
export const sessionTag = (sessionId: string) => `skipper-session-${sessionId.slice(0, 8)}`;
