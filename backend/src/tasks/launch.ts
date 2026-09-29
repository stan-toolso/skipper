import { AppError, NotFoundError } from '../errors.js';
import { projectService, slugify } from '../projects/service.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { worktreeRepository } from '../worktrees/repository.js';
import { worktreeService } from '../worktrees/service.js';
import type { Worktree } from '../worktrees/types.js';
import { taskService } from './service.js';
import type { Task } from './types.js';

export interface StartTaskOptions {
  provider?: string | null;
  config?: Record<string, unknown> | null;
  /** Worktree existant dans lequel travailler. */
  worktreeId?: string | null;
  /** Sans worktree précisé : créer un worktree dédié à la tâche (défaut) ou travailler dans le dossier principal. */
  dedicatedWorktree?: boolean | null;
}

/** Nom de dossier et de branche dérivés du titre de la tâche, uniques dans le projet. */
async function taskWorktreeNames(task: Task): Promise<{ name: string; branch: string }> {
  const base = slugify(task.title).slice(0, 40).replace(/-+$/, '') || 'tache';
  const taken = new Set((await worktreeRepository.listByProject(task.projectId)).map((w) => w.name));
  let name = `task-${base}`;
  for (let i = 2; taken.has(name); i++) name = `task-${base}-${i}`;
  return { name, branch: name.replace(/^task-/, 'task/') };
}

/**
 * Crée le worktree dédié à une tâche : dossier `task-<slug>` et branche `task/<slug>` à partir du
 * checkout principal. Renvoie null si le projet n'est pas relié à un dépôt git (la tâche tourne alors
 * dans le dossier principal).
 */
export async function createTaskWorktree(task: Task): Promise<Worktree | null> {
  const project = await projectService.get(task.projectId);
  if (!project.gitUrl) return null;
  const { name, branch } = await taskWorktreeNames(task);
  return worktreeService.create(project.id, { name, branch });
}

/** Confie une tâche à un nouvel agent : crée la session (dans un worktree dédié par défaut), l'assigne à la tâche et passe celle-ci en cours. */
export async function startTaskSession(taskId: string, options: StartTaskOptions = {}): Promise<Session> {
  const task = await taskService.get(taskId);
  if (!task) throw new NotFoundError('Tâche introuvable');

  let worktreeId = options.worktreeId ?? null;
  if (!worktreeId && options.dedicatedWorktree !== false) {
    try {
      worktreeId = (await createTaskWorktree(task))?.id ?? null;
    } catch (err) {
      throw new AppError(`Impossible de créer le worktree de la tâche : ${(err as Error).message}`);
    }
  }

  // La tâche est assignée avant le démarrage pour que l'agent la voie déjà comme la sienne.
  const inProgress = await taskService.update(task.id, { status: 'in_progress' });
  const session = await sessionService.create({
    projectId: task.projectId,
    worktreeId,
    name: task.title.slice(0, 80),
    provider: options.provider ?? 'claude',
    prompt: taskService.describeForPrompt(inProgress),
    config: options.config ?? {},
    autoStart: false,
  });
  await taskService.update(task.id, { sessionId: session.id });
  return sessionService.start(session.id);
}
