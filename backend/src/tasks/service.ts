import type { Actor } from '../context/types.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { taskRepository } from './repository.js';
import { TASK_PRIORITIES, TASK_STATUSES, type CreateTaskInput, type Task, type TaskFilter, type UpdateTaskInput } from './types.js';

const priorityLabels = { urgent: 'urgente', high: 'haute', medium: 'moyenne', low: 'basse' } as const;
const statusLabels = { todo: 'à faire', in_progress: 'en cours', done: 'terminée', cancelled: 'annulée' } as const;

function validate(input: CreateTaskInput | UpdateTaskInput): void {
  if ('title' in input && input.title != null && !input.title.trim()) throw new AppError('Le titre de la tâche est obligatoire');
  if (input.priority != null && !TASK_PRIORITIES.includes(input.priority)) throw new AppError(`Priorité invalide : ${input.priority}`);
  if (input.status != null && !TASK_STATUSES.includes(input.status)) throw new AppError(`Statut invalide : ${input.status}`);
  if (input.dueDate != null && input.dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new AppError('Échéance attendue au format AAAA-MM-JJ');
}

export const taskService = {
  list: (filter?: TaskFilter) => taskRepository.list(filter),

  async get(id: string): Promise<Task> {
    const task = await taskRepository.findById(id);
    if (!task) throw new NotFoundError('Tâche introuvable');
    return task;
  },

  async create(projectId: string, input: CreateTaskInput, actor: Actor): Promise<Task> {
    const project = await projectService.get(projectId);
    validate(input);
    const task = await taskRepository.create(projectId, { ...input, title: input.title.trim(), dueDate: input.dueDate || null }, actor);
    if (actor.type === 'agent') {
      void notificationService.notify({
        type: 'task.created',
        title: `Nouvelle tâche proposée par un agent`,
        message: `${task.title} (priorité ${priorityLabels[task.priority]}) · ${project.name}`,
        link: `/projects/${projectId}/tasks`,
        projectId,
        sessionId: actor.sessionId ?? null,
        payload: { taskId: task.id },
      });
    }
    return task;
  },

  /** `actor` permet de notifier quand c'est un agent qui termine une tâche. */
  async update(id: string, input: UpdateTaskInput, actor?: Actor): Promise<Task> {
    validate(input);
    const before = await taskRepository.findById(id);
    const task = await taskRepository.update(id, { ...input, title: input.title?.trim(), dueDate: input.dueDate === '' ? null : input.dueDate });
    if (!task) throw new NotFoundError('Tâche introuvable');
    if (actor?.type === 'agent' && before && before.status !== 'done' && task.status === 'done') {
      const project = await projectService.get(task.projectId);
      void notificationService.notify({
        type: 'task.completed',
        title: `Tâche terminée par un agent`,
        message: `${task.title} · ${project.name}`,
        link: `/projects/${task.projectId}/tasks`,
        projectId: task.projectId,
        sessionId: actor.sessionId ?? null,
        payload: { taskId: task.id },
      });
    }
    return task;
  },

  async delete(id: string): Promise<boolean> {
    await this.get(id);
    return taskRepository.delete(id);
  },

  /** Résumé des tâches ouvertes, injecté dans le prompt système des agents. */
  async promptSummary(projectId: string, sessionId?: string): Promise<string> {
    const open = await taskRepository.list({ projectId, status: ['todo', 'in_progress'] });
    const intro =
      "Le projet dispose d'un tableau de tâches géré avec les outils du serveur MCP `tasks` (list, get, create, update, claim). Quand tu réalises une tâche, passe-la en `in_progress` avec `claim` puis en `done` une fois terminée. Si tu découvres du travail à faire plus tard, crée une tâche plutôt que de le laisser tomber.";
    if (open.length === 0) return `${intro}\nAucune tâche ouverte pour le moment.`;
    const lines = open.map((t) => `- [${statusLabels[t.status]}, priorité ${priorityLabels[t.priority]}${t.sessionId && t.sessionId === sessionId ? ', assignée à cette session' : t.sessionId ? ', prise par une autre session' : ''}] ${t.title} (id ${t.id})`);
    return [intro, 'Tâches ouvertes :', ...lines].join('\n');
  },

  /** Texte d'une tâche tel que transmis à un agent chargé de la réaliser. */
  describeForPrompt(task: Task): string {
    return [
      `Réalise la tâche suivante du projet (id ${task.id}, priorité ${priorityLabels[task.priority]}${task.dueDate ? `, échéance ${task.dueDate}` : ''}) :`,
      '',
      `# ${task.title}`,
      '',
      task.description || '(pas de description)',
      '',
      "Elle t'est assignée et est déjà « en cours ». Quand c'est terminé et vérifié, passe-la en `done` avec l'outil `tasks.update`. Si tu es bloqué, laisse-la en cours et explique pourquoi.",
    ].join('\n');
  },
};
