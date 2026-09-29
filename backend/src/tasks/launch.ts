import { NotFoundError } from '../errors.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { taskService } from './service.js';

/** Confie une tâche à un nouvel agent : crée la session, l'assigne à la tâche et passe celle-ci en cours. */
export async function startTaskSession(
  taskId: string,
  options: { provider?: string | null; config?: Record<string, unknown> | null; worktreeId?: string | null } = {},
): Promise<Session> {
  const task = await taskService.get(taskId);
  if (!task) throw new NotFoundError('Tâche introuvable');
  // La tâche est assignée avant le démarrage pour que l'agent la voie déjà comme la sienne.
  const inProgress = await taskService.update(task.id, { status: 'in_progress' });
  const session = await sessionService.create({
    projectId: task.projectId,
    worktreeId: options.worktreeId ?? null,
    name: task.title.slice(0, 80),
    provider: options.provider ?? 'claude',
    prompt: taskService.describeForPrompt(inProgress),
    config: options.config ?? {},
    autoStart: false,
  });
  await taskService.update(task.id, { sessionId: session.id });
  return sessionService.start(session.id);
}
