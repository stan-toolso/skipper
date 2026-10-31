import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { runner } from '../runners/index.js';
import { agentGitEnv } from '../git/agentEnv.js';
import { worksessionService } from '../worksessions/service.js';
import { callInstance } from '../instances/client.js';
import { instanceRegistry } from '../instances/registry.js';
import { TerminalHistory } from './history.js';
import { terminalRepository } from './repository.js';
import type { TerminalRecord } from './types.js';

/** Messages échangés avec le navigateur (JSON). */
type ClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
type ServerMessage = { type: 'data'; data: string } | { type: 'exit'; code: number | null };

interface LiveTerminal {
  id: string;
  projectId: string;
  proc: pty.IPty;
  /** Sortie récente, rejouée à chaque connexion (reconnexion, second onglet). */
  scrollback: string;
  clients: Set<WebSocket>;
  /** Historique des commandes de l'utilisateur sur le projet, s'il a pu être chargé. */
  history: TerminalHistory | null;
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
  listByProject: (projectId: string, userId?: string | null) => terminalRepository.listByProject(projectId, userId),
  isLive: (id: string) => live.has(id),
  /** Terminaux ouverts sur ce serveur (processus vivants). */
  liveCount: () => live.size,
  /** Terminaux ouverts (processus vivants) dans le conteneur de ce projet. */
  liveCountByProject: (projectId: string) => [...live.values()].filter((t) => t.projectId === projectId).length,

  /** Ouvre un shell de connexion dans le workspace du projet, avec l'historique des commandes de l'utilisateur. */
  /** Ouvre un shell dans une work session du projet : rien ne s'exécute dans le checkout principal. */
  async create(projectId: string, name: string | null | undefined, worksessionId: string, createdById: string | null = null): Promise<TerminalRecord> {
    if (!worksessionId) throw new AppError('Un terminal s\'ouvre dans une work session : choisissez-en une');
    const project = await projectService.get(projectId);
    const cwd = await worksessionService.resolveCwd(project, worksessionId);
    const label = name?.trim() || `Terminal ${(await terminalRepository.countByProject(projectId)) + 1}`;
    const record = await terminalRepository.create(projectId, label, worksessionId ?? null, createdById, instanceRegistry.id);

    const history = createdById ? await TerminalHistory.prepare(project, record.id, createdById) : null;
    const spec = await runner.terminalCommand(project, cwd, history ? { rcfile: history.files.rcfile } : undefined);
    const proc = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...(await agentGitEnv(createdById ?? null, project.gitUrl, { projectId: project.id })), ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SKIPPER_PROJECT: project.slug } as Record<string, string>,
    });
    const t: LiveTerminal = { id: record.id, projectId: project.id, proc, scrollback: '', clients: new Set(), history };
    live.set(record.id, t);
    history?.start();

    proc.onData((data) => {
      t.scrollback = (t.scrollback + data).slice(-SCROLLBACK_LIMIT);
      broadcast(t, { type: 'data', data });
    });
    proc.onExit(({ exitCode }) => {
      live.delete(record.id);
      broadcast(t, { type: 'exit', code: exitCode });
      for (const ws of t.clients) ws.close();
      void history?.dispose();
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
      // Shell tenu par une autre instance du backend (déploiement bleu/vert) : fermé là-bas.
      const holder = await instanceRegistry.holder(record.instanceId);
      if (holder) {
        await callInstance(holder, 'terminal.close', { id });
        return this.get(id);
      }
      throw new AppError("Ce terminal n'est plus actif sur ce serveur");
    }
    t.proc.kill();
    // onExit se charge de la mise à jour en base ; on attend qu'elle soit visible.
    for (let i = 0; i < 50 && live.has(id); i++) await new Promise((r) => setTimeout(r, 100));
    return this.get(id);
  },

  async delete(id: string): Promise<boolean> {
    if (live.has(id) || (await terminalRepository.findById(id))?.status === 'running') await this.close(id).catch(() => undefined);
    return terminalRepository.delete(id);
  },

  /** Au démarrage : les terminaux "running" en base n'ont plus de processus, sauf ceux d'une autre instance vivante. */
  recoverAfterRestart: (liveInstanceIds: string[] = []) => terminalRepository.closeAllRunning(liveInstanceIds),

  async shutdown(): Promise<void> {
    await Promise.all([...live.values()].map((t) => t.history?.flush()));
    for (const t of live.values()) t.proc.kill();
  },
};
