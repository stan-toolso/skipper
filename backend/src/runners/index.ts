import { DockerRunner } from './docker.js';
import type { Runner } from './types.js';

/** Unique environnement d'exécution : tout projet tourne dans son conteneur Docker, jamais sur le serveur. */
export const runner: Runner = new DockerRunner();

export { DockerRunner };
export type { Runner, RunnerConfig, RunnerKind, RunnerStatus, SpawnSpec } from './types.js';
