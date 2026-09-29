import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import { renderSecretsFile } from '../connections/website.js';
import { PLAYWRIGHT_MCP_ARGS, sessionTag, type BrowserMcpOptions, type BrowserMcpServer, type Runner, type RunnerStatus, type SpawnSpec } from './types.js';

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
  /**
   * Playwright MCP via npx ; Chromium doit avoir été installé sur le serveur (`npx playwright install chromium`).
   * Les secrets vont dans un dossier temporaire de la session (0700), balayé au démarrage comme ceux de l'accès direct.
   */
  async browserMcpCommand(_project: Project, cwd: string, options: BrowserMcpOptions): Promise<BrowserMcpServer> {
    const args = ['-y', '@playwright/mcp@latest', ...PLAYWRIGHT_MCP_ARGS, '--output-dir', `${cwd}/.playwright-mcp`];
    let dir: string | null = null;
    if (Object.keys(options.secrets).length) {
      dir = path.join(os.tmpdir(), `${sessionTag(options.sessionId)}-browser`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'secrets.env');
      await writeFile(file, renderSecretsFile(options.secrets), { mode: 0o600 });
      args.push('--secrets', file);
    }
    return { command: 'npx', args, dispose: async () => (dir ? rm(dir, { recursive: true, force: true }) : undefined) };
  }
}
