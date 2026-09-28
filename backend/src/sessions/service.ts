import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { ensureWorkspace } from '../projects/workspace.js';
import { pubSub } from '../pubsub.js';
import { requestService } from '../requests/service.js';
import { sessionRepository } from './repository.js';
import { getProvider } from './providers/registry.js';
import type { RunningHandle } from './providers/provider.js';
import type { CreateSessionInput, Session, SessionFilter } from './types.js';

/** Processus en cours, indexés par id de session (mémoire du serveur). */
const running = new Map<string, RunningHandle>();

async function publishSession(session: Session | null): Promise<Session> {
  if (!session) throw new NotFoundError('Session introuvable');
  pubSub.publish('sessionUpdated', session);
  return session;
}

export const sessionService = {
  list: (filter?: SessionFilter) => sessionRepository.list(filter),
  get: (id: string) => sessionRepository.findById(id),
  events: (sessionId: string, opts?: { after?: string; limit?: number }) => sessionRepository.listEvents(sessionId, opts),
  isRunning: (id: string) => running.has(id),

  async create(input: CreateSessionInput & { autoStart?: boolean }): Promise<Session> {
    const provider = getProvider(input.provider);
    provider.validateConfig?.(input.config ?? {});
    await projectService.get(input.projectId); // lève NotFoundError si le projet n'existe pas
    const session = await sessionRepository.create(input);
    pubSub.publish('sessionUpdated', session);
    return input.autoStart === false ? session : this.start(session.id);
  },

  async start(id: string): Promise<Session> {
    const session = await sessionRepository.findById(id);
    if (!session) throw new NotFoundError('Session introuvable');
    if (session.status === 'running') throw new AppError('La session est déjà en cours');
    const provider = getProvider(session.provider);
    const project = await projectService.get(session.projectId);

    const started = await publishSession(
      await sessionRepository.update(id, { status: 'running', startedAt: new Date(), endedAt: null, exitCode: null, error: null }),
    );

    const emit = async (type: string, payload: Record<string, unknown> = {}) => {
      const event = await sessionRepository.addEvent(id, type, payload);
      pubSub.publish('sessionEvent', id, event);
    };

    let handle: RunningHandle;
    try {
      // La session s'exécute dans le workspace du projet (créé ou cloné si nécessaire).
      const cwd = await ensureWorkspace(project);
      handle = await provider.start({
        session: started,
        project,
        cwd,
        emit,
        setExternalId: async (externalId) => {
          await publishSession(await sessionRepository.update(id, { externalId }));
        },
        ask: async (input, signal) => {
          await emit('request', { type: input.type, title: input.title });
          const response = await requestService.ask(id, input, signal);
          await emit('request.answered', { type: input.type, title: input.title, response });
          return response;
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      await emit('status', { status: 'failed', error: message });
      return publishSession(await sessionRepository.update(id, { status: 'failed', error: message, endedAt: new Date() }));
    }

    running.set(id, handle);
    // Fin du processus gérée en tâche de fond : la mutation `start` rend la main immédiatement.
    void handle.wait().then(async (result) => {
      running.delete(id);
      await requestService.cancelAllForSession(id);
      const current = await sessionRepository.findById(id);
      // Si `stop()` a déjà posé le statut "stopped", on le conserve.
      const status = current?.status === 'stopped' ? 'stopped' : result.error || result.exitCode !== 0 ? 'failed' : 'completed';
      const error = result.error ?? (status === 'failed' ? `Code de sortie ${result.exitCode}` : null);
      await emit('status', { status, exitCode: result.exitCode, error });
      await publishSession(await sessionRepository.update(id, { status, exitCode: result.exitCode, error, endedAt: new Date() }));
    });

    return started;
  },

  async stop(id: string): Promise<Session> {
    const handle = running.get(id);
    if (!handle) throw new AppError("La session n'est pas en cours d'exécution");
    await publishSession(await sessionRepository.update(id, { status: 'stopped', endedAt: new Date() }));
    await requestService.cancelAllForSession(id);
    await handle.stop();
    return publishSession(await sessionRepository.findById(id));
  },

  async delete(id: string): Promise<boolean> {
    if (running.has(id)) await this.stop(id);
    return sessionRepository.delete(id);
  },

  /** À appeler au démarrage : les sessions "running" en base ne le sont plus réellement. */
  async recoverAfterRestart(): Promise<{ sessions: number; requests: number }> {
    const sessions = await sessionRepository.markRunningAsInterrupted();
    const requests = await requestService.expireAllPending();
    return { sessions, requests };
  },

  /** Arrêt propre du serveur : tue les processus encore en cours. */
  async shutdown(): Promise<void> {
    await Promise.all([...running.keys()].map((id) => this.stop(id).catch(() => undefined)));
  },
};
