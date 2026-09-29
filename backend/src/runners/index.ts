import type { Project } from '../projects/types.js';
import { DockerRunner } from './docker.js';
import { LocalRunner } from './local.js';
import type { Runner, RunnerKind } from './types.js';

const runners: Record<RunnerKind, Runner> = { local: new LocalRunner(), docker: new DockerRunner() };

export function runnerFor(project: Project): Runner {
  return runners[project.runner] ?? runners.local;
}

export { DockerRunner, LocalRunner };
export type { Runner, RunnerConfig, RunnerKind, RunnerStatus, SpawnSpec } from './types.js';
