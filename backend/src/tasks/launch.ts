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
  /** Consigne relue par l'humain ; sinon le texte de la tâche. */
  prompt?: string | null;
  /** Utilisateur qui lance la session (propriétaire). */
  ownerId?: string | null;
  /** Automatisation : instruction ajoutée après le texte de la tâche (ou seule si `includeTask` est faux). */
  instructions?: string | null;
  includeTask?: boolean | null;
  /** Session lancée par une exécution d'agent ou de workflow. */
  agentId?: string | null;
  agentRunId?: string | null;
  workflowRunId?: string | null;
  /** false : la session est créée sans démarrer (l'appelant la démarre). */
  autoStart?: boolean | null;
}

/** Nom de dossier et de branche dérivés du titre de la tâche, uniques dans le projet (worktrees archivés compris). */
async function taskWorktreeNames(task: Task): Promise<{ name: string; branch: string }> {
  const base = slugify(task.title).slice(0, 40).replace(/-+$/, '') || 'tache';
  const taken = new Set((await worktreeRepository.listByProject(task.projectId, { includeArchived: true })).map((w) => w.name));
  let name = `task-${base}`;
  for (let i = 2; taken.has(name); i++) name = `task-${base}-${i}`;
  return { name, branch: name.replace(/^task-/, 'task/') };
}

/**
 * Crée le worktree dédié à une tâche : dossier `task-<slug>` et branche `task/<slug>` à partir du
 * checkout principal. Renvoie null si le projet n'est pas relié à un dépôt git (la tâche tourne alors
 * dans le dossier principal). `actorId` : personne dont le compte GitHub contacte le dépôt distant.
 */
export async function createTaskWorktree(task: Task, actorId?: string | null): Promise<Worktree | null> {
  const project = await projectService.get(task.projectId);
  if (!project.gitUrl) return null;
  const { name, branch } = await taskWorktreeNames(task);
  return worktreeService.create(project.id, { name, branch }, actorId);
}

/**
 * Confie une tâche à un nouvel agent : crée la session (dans un worktree dédié par défaut), l'assigne à la
 * tâche et passe celle-ci en cours. Pour une automatisation, le texte de la tâche ouvre l'instruction, suivi
 * de la consigne de l'agent ou du nœud.
 */
export async function startTaskSession(taskId: string, options: StartTaskOptions = {}): Promise<Session> {
  const task = await taskService.get(taskId);
  if (!task) throw new NotFoundError('Tâche introuvable');

  let worktreeId = options.worktreeId ?? null;
  let branch = worktreeId ? (await worktreeService.get(worktreeId)).branch : null;
  if (!worktreeId && options.dedicatedWorktree !== false) {
    try {
      const wt = await createTaskWorktree(task, options.ownerId);
      worktreeId = wt?.id ?? null;
      branch = wt?.branch ?? null;
    } catch (err) {
      throw new AppError(`Impossible de créer le worktree de la tâche : ${(err as Error).message}`);
    }
  }

  // La tâche passe en cours avant le démarrage pour que l'agent la voie déjà comme la sienne.
  const inProgress = await taskService.update(task.id, { status: 'in_progress' });
  const taskText = options.includeTask === false ? '' : taskService.describeForPrompt(inProgress, await taskService.comments(task.id));
  const extra = options.instructions?.trim() ?? '';
  const prompt = options.prompt?.trim() || [taskText, extra].filter(Boolean).join('\n\n---\n\n') || taskText;
  const session = await sessionService.create({
    projectId: task.projectId,
    worktreeId,
    name: task.title.slice(0, 80),
    provider: options.provider ?? 'claude',
    prompt,
    config: options.config ?? {},
    ownerId: options.ownerId ?? null,
    agentId: options.agentId ?? null,
    agentRunId: options.agentRunId ?? null,
    workflowRunId: options.workflowRunId ?? null,
    autoStart: false,
  });
  // La branche reste attachée à la tâche (pull request) même après suppression du worktree.
  await taskService.update(task.id, { sessionId: session.id, ...(branch ? { branch } : {}) });
  return options.autoStart === false ? session : sessionService.start(session.id);
}
