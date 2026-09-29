import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import type { Runner, RunnerStatus, SpawnSpec } from './types.js';

/** Exécution directe sur le serveur, avec l'utilisateur système de Skipper. */
export class LocalRunner implements Runner {
  readonly kind = 'local' as const;

  private readonly status_: RunnerStatus = { kind: 'local', ready: true, state: 'running', containerName: null, image: null, memory: null, cpus: null, startedAt: null, error: null };

  async status(): Promise<RunnerStatus> {
    return this.status_;
  }
  async ensureReady(): Promise<RunnerStatus> {
    return this.status_;
  }
  async stop(): Promise<RunnerStatus> {
    return this.status_;
  }
  async remove(): Promise<void> {}
  async claudeExecutable(): Promise<string | undefined> {
    return config.claudeBin;
  }
  async terminalCommand(_project: Project, _cwd: string): Promise<SpawnSpec> {
    return { command: process.env.SHELL || '/bin/zsh', args: ['-l'] };
  }
  async shellCommand(_project: Project, _cwd: string, shell: string, script: string): Promise<SpawnSpec> {
    return { command: shell || '/bin/sh', args: ['-c', script] };
  }
}
