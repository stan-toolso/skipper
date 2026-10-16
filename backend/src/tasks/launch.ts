import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { namesFromText, uniqueName } from '../worksessions/names.js';
import { worksessionService } from '../worksessions/service.js';
import type { Worksession } from '../worksessions/types.js';
import { taskService } from './service.js';
import type { Task } from './types.js';

export interface StartTaskOptions {
  provider?: string | null;
  config?: Record<string, unknown> | null;
  /** Work session existante où travailler (nœud de workflow) ; par défaut, celle de la tâche. */
  worksessionId?: string | null;
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

/** Nom de dossier et de branche dérivés du titre de la tâche, uniques parmi les work sessions données. */
export function taskWorksessionNames(task: Pick<Task, 'title'>, taken: Pick<Worksession, 'name'>[]): { name: string; branch: string } {
  const name = uniqueName(taken, namesFromText(task.title, 'task-').name);
  return { name, branch: name.replace(/^task-/, 'task/') };
}

/**
 * La work session consacrée à une tâche : celle qu'elle a déjà (restaurée si elle était archivée), sinon une
 * nouvelle — dossier `task-<slug>`, branche `task/<slug>` depuis le checkout principal pour un projet git.
 * `actorId` : personne dont le compte GitHub contacte le dépôt distant.
 */
export async function taskWorksession(task: Task, actorId?: string | null): Promise<Worksession> {
  const existing = await worksessionService.forTask(task.id);
  if (existing) return existing;
  const { name, branch } = taskWorksessionNames(task, await worksessionRepository.listByProject(task.projectId, { includeArchived: true }));
  return worksessionService.create(task.projectId, { name, branch, label: task.title, taskId: task.id }, actorId);
}

/**
 * Confie une tâche à un nouvel agent : crée la session dans la work session de la tâche (créée avec sa
 * première session, gardée pour les suivantes), l'assigne à la tâche et passe celle-ci en cours. Pour une
 * automatisation, le texte de la tâche ouvre l'instruction, suivi de la consigne de l'agent ou du nœud.
 */
export async function startTaskSession(taskId: string, options: StartTaskOptions = {}): Promise<Session> {
  const task = await taskService.get(taskId);
  if (!task) throw new NotFoundError('Tâche introuvable');
  const project = await projectService.get(task.projectId);

  let worksession: Worksession;
  try {
    worksession = options.worksessionId ? await worksessionService.assertUsable(project, options.worksessionId) : await taskWorksession(task, options.ownerId);
  } catch (err) {
    throw new AppError(`Impossible de préparer la work session de la tâche : ${(err as Error).message}`);
  }
  const worksessionId = worksession.id;
  const branch = project.gitUrl ? worksession.branch : null;

  // La tâche passe en cours avant le démarrage pour que l'agent la voie déjà comme la sienne.
  const inProgress = await taskService.update(task.id, { status: 'in_progress' });
  const taskText = options.includeTask === false ? '' : taskService.describeForPrompt(inProgress, await taskService.comments(task.id));
  const extra = options.instructions?.trim() ?? '';
  const prompt = options.prompt?.trim() || [taskText, extra].filter(Boolean).join('\n\n---\n\n') || taskText;
  const session = await sessionService.create({
    projectId: task.projectId,
    worksessionId,
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
  // La branche reste attachée à la tâche (pull request) même après suppression de la work session.
  await taskService.update(task.id, { sessionId: session.id, ...(branch ? { branch } : {}) });
  return options.autoStart === false ? session : sessionService.start(session.id);
}
