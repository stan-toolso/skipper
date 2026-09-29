import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { worktreeService } from '../worktrees/service.js';
import { terminalRepository } from './repository.js';
import type { TerminalRecord } from './types.js';

/** Messages échangés avec le navigateur (JSON). */
type ClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
type ServerMessage = { type: 'data'; data: string } | { type: 'exit'; code: number | null };

interface LiveTerminal {
  id: string;
  proc: pty.IPty;
  /** Sortie récente, rejouée à chaque connexion (reconnexion, second onglet). */
  scrollback: string;
  clients: Set<WebSocket>;
}

const SCROLLBACK_LIMIT = 200_000;
const live = new Map<string, LiveTerminal>();

function broadcast(t: LiveTerminal, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const ws of t.clients) if (ws.readyState === ws.OPEN) ws.send(payload);
}

export const terminalService = {
  get: async (id: string): Promise<TerminalRecord> => {
    const t = await terminalRepository.findById(id);
    if (!t) throw new NotFoundError('Terminal introuvable');
    return t;
  },
  listByProject: (projectId: string) => terminalRepository.listByProject(projectId),
  isLive: (id: string) => live.has(id),

  /** Ouvre un shell de connexion dans le workspace du projet. */
  async create(projectId: string, name?: string | null, worktreeId?: string | null): Promise<TerminalRecord> {
    const project = await projectService.get(projectId);
    const cwd = await worktreeService.resolveCwd(project, worktreeId);
    const label = name?.trim() || `Terminal ${(await terminalRepository.countByProject(projectId)) + 1}`;
    const record = await terminalRepository.create(projectId, label, worktreeId ?? null);

    const shell = process.env.SHELL || '/bin/zsh';
    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SKIPPER_PROJECT: project.slug } as Record<string, string>,
    });
    const t: LiveTerminal = { id: record.id, proc, scrollback: '', clients: new Set() };
    live.set(record.id, t);

    proc.onData((data) => {
      t.scrollback = (t.scrollback + data).slice(-SCROLLBACK_LIMIT);
      broadcast(t, { type: 'data', data });
    });
    proc.onExit(({ exitCode }) => {
      live.delete(record.id);
      broadcast(t, { type: 'exit', code: exitCode });
      for (const ws of t.clients) ws.close();
      void terminalRepository.close(record.id, exitCode).catch((err) => console.error('[terminals] clôture', err));
    });
    return record;
  },

  /** Relie une connexion WebSocket au terminal : rejoue la sortie récente puis relaie entrées et sorties. */
  attach(id: string, ws: WebSocket): void {
    const t = live.get(id);
    if (!t) {
      ws.send(JSON.stringify({ type: 'exit', code: null } satisfies ServerMessage));
      ws.close();
      return;
    }
    t.clients.add(ws);
    if (t.scrollback) ws.send(JSON.stringify({ type: 'data', data: t.scrollback } satisfies ServerMessage));
    ws.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === 'input') t.proc.write(message.data);
      else if (message.type === 'resize' && message.cols > 0 && message.rows > 0) t.proc.resize(Math.floor(message.cols), Math.floor(message.rows));
    });
    ws.on('close', () => t.clients.delete(ws));
  },

  async close(id: string): Promise<TerminalRecord> {
    const t = live.get(id);
    if (!t) {
      const record = await this.get(id);
      if (record.status === 'closed') return record;
      throw new AppError("Ce terminal n'est plus actif sur ce serveur");
    }
    t.proc.kill();
    // onExit se charge de la mise à jour en base ; on attend qu'elle soit visible.
    for (let i = 0; i < 50 && live.has(id); i++) await new Promise((r) => setTimeout(r, 100));
    return this.get(id);
  },

  async delete(id: string): Promise<boolean> {
    if (live.has(id)) await this.close(id);
    return terminalRepository.delete(id);
  },

  /** Au démarrage : les terminaux "running" en base n'ont plus de processus. */
  recoverAfterRestart: () => terminalRepository.closeAllRunning(),

  async shutdown(): Promise<void> {
    for (const t of live.values()) t.proc.kill();
  },
};
