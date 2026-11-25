import { projectModelFor } from '../projects/models.js';
import { AppError, NotFoundError } from '../errors.js';
import { reviewOf } from '../reviews/types.js';
import { projectService } from '../projects/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { namesFromText, uniqueName } from '../worksessions/names.js';
import { worksessionService } from '../worksessions/service.js';
import type { Worksession } from '../worksessions/types.js';
import { assertUnblocked, taskService } from './service.js';
import { asInstructionAttachments, describeAttachment, fitInInstruction } from './attachments.js';
import type { Task, TaskAttachment, TaskComment } from './types.js';
import type { TaskStatusDefinition } from './statuses.js';
import type { InstructionAuthor } from '../sessions/instructionAuthor.js';

export interface StartTaskOptions {
  provider?: string | null;
  config?: Record<string, unknown> | null;
  /** Consigne relue par l'humain ; sinon le texte de la tâche. */
  prompt?: string | null;
  /** Utilisateur qui lance la session (propriétaire) ; un agent de projet quand la tâche lui est confiée. */
  ownerId?: string | null;
  /** Personne qui a demandé la session quand le propriétaire est un agent. */
  requestedById?: string | null;
  /** Automatisation : instruction ajoutée après le texte de la tâche (ou seule si `includeTask` est faux). */
  instructions?: string | null;
  includeTask?: boolean | null;
  /** Session lancée par une exécution de workflow. */
  workflowRunId?: string | null;
  /** false : la session est créée sans démarrer (l'appelant la démarre). */
  autoStart?: boolean | null;
}

/**
 * Instruction d'une session qui réalise une tâche : le texte de la tâche, puis les consignes de tâches du
 * projet et celles de l'appelant (nœud de workflow, exécution d'agent), sous « Consignes supplémentaires ».
 */
export function composeTaskPrompt(task: Task, comments: TaskComment[], files: TaskFiles | null, statuses: TaskStatusDefinition[] | null, ...instructions: (string | null | undefined)[]): string {
  const extra = instructions.map((i) => i?.trim()).filter((i): i is string => Boolean(i));
  const leftOut = files?.leftOut.length ? ['', `Non joints (au-delà des limites d'une instruction, lisibles dans l'interface) : ${files.leftOut.map(describeAttachment).join(', ')}.`] : [];
  return [taskService.describeForPrompt(task, comments, files?.kept ?? [], 'instruction', [], statuses), ...leftOut, ...(extra.length ? ['', '---', '', 'Consignes supplémentaires :', '', extra.join('\n\n')] : [])].join('\n');
}

/** Les fichiers d'une tâche (les siens et ceux de ses commentaires), partagés entre ce qu'une instruction porte et le reste. */
export interface TaskFiles {
  kept: TaskAttachment[];
  leftOut: TaskAttachment[];
}

/** Les fichiers que reçoit la session à qui l'on confie la tâche, avec sa première instruction : autant qu'une instruction en porte. */
export const taskFiles = async (taskId: string): Promise<TaskFiles> => fitInInstruction(await taskService.attachments(taskId));

/**
 * Libellé, nom de dossier et branche dérivés du titre de la tâche, uniques parmi les work sessions données.
 * Le libellé est le titre ramené à la longueur admise par une work session : un titre long ne doit pas
 * empêcher de confier la tâche à un agent.
 */
export function taskWorksessionNames(task: Pick<Task, 'title'>, taken: Pick<Worksession, 'name'>[]): { label: string; name: string; branch: string } {
  const names = namesFromText(task.title, 'task-');
  const name = uniqueName(taken, names.name);
  return { label: names.label, name, branch: name.replace(/^task-/, 'task/') };
}

/**
 * La work session consacrée à une tâche : celle qu'elle a déjà (restaurée si elle était archivée), sinon une
 * nouvelle — dossier `task-<slug>`, branche `task/<slug>` depuis le checkout principal pour un projet git.
 * `actorId` : personne dont le compte GitHub contacte le dépôt distant.
 */
export async function taskWorksession(task: Task, actorId?: string | null): Promise<Worksession> {
  const existing = await worksessionService.forTask(task.id);
  if (existing) return existing;
  const { label, name, branch } = taskWorksessionNames(task, await worksessionRepository.listByProject(task.projectId, { includeArchived: true }));
  return worksessionService.create(task.projectId, { name, branch, label, taskId: task.id, uniqueBranch: true }, actorId);
}

/**
 * Confie une tâche à un nouvel agent : crée la session dans la work session de la tâche (créée avec sa
 * première session, gardée pour les suivantes), l'assigne à la tâche et passe celle-ci en cours. Une work
 * session n'héberge qu'une session active : la session précédente de la tâche est arrêtée et archivée, la
 * nouvelle reprend le dossier et la branche. Pour une automatisation, le texte de la tâche ouvre
 * l'instruction, suivi de la consigne de l'agent ou du nœud.
 */
export async function startTaskSession(taskId: string, options: StartTaskOptions = {}): Promise<Session> {
  const task = await taskService.get(taskId);
  if (!task) throw new NotFoundError('Tâche introuvable');
  await assertUnblocked(task);
  const project = await projectService.get(task.projectId);

  let worksession: Worksession;
  try {
    worksession = await taskWorksession(task, options.ownerId);
  } catch (err) {
    throw new AppError(`Impossible de préparer le dossier de travail de la tâche : ${(err as Error).message}`);
  }
  const worksessionId = worksession.id;
  await sessionService.vacateWorksession(worksessionId);
  const branch = project.gitUrl ? worksession.branch : null;

  // La tâche passe en cours avant le démarrage pour que l'agent la voie déjà comme la sienne.
  const inProgress = await taskService.update(task.id, { status: 'in_progress' });
  // Les fichiers de la tâche accompagnent l'instruction, comme une personne joint des fichiers à une consigne
  // (l'agent lit les images) ; pas quand l'appelant remplace le texte de la tâche par ses propres consignes.
  const files = options.includeTask === false ? null : await taskFiles(task.id);
  const prompt =
    options.prompt?.trim() ||
    (options.includeTask === false ? (options.instructions?.trim() ?? '') : composeTaskPrompt(inProgress, await taskService.comments(task.id), files, project.taskStatuses, project.taskInstructions, options.instructions));
  const session = await sessionService.create({
    projectId: task.projectId,
    worksessionId,
    name: task.title.slice(0, 80),
    provider: options.provider ?? 'claude',
    prompt,
    attachments: files?.kept.length ? await asInstructionAttachments(files.kept) : null,
    config: options.config ?? {},
    // Sans modèle choisi : celui du projet pour la priorité de la tâche (s'il est réglé), puis le défaut du projet.
    defaultModel: projectModelFor(project, task.priority),
    ownerId: options.ownerId ?? null,
    requestedById: options.requestedById ?? null,
    workflowRunId: options.workflowRunId ?? null,
    autoStart: false,
  });
  // La branche reste attachée à la tâche (pull request) même après suppression de la work session.
  // Les sessions précédentes de la tâche (archivées en libérant le dossier) lui passent la charge.
  await taskService.update(task.id, { sessionId: session.id, releaseSessionIds: task.sessionIds.filter((id) => id !== session.id), ...(branch ? { branch } : {}) });
  return options.autoStart === false ? session : sessionService.start(session.id);
}

/**
 * La session dont on reprend la conversation quand on confie de nouveau la tâche : la plus récente en charge, sinon
 * la dernière passée par la tâche, pourvu qu'elle travaille encore dans le dossier de la tâche (work session
 * existante, archivée ou non). Null : rien à reprendre (première fois, dossier supprimé, chat, revue), il faut une
 * nouvelle session.
 */
export async function resumableTaskSession(task: Task): Promise<Session | null> {
  const [worksession] = await worksessionRepository.findByTask(task.id);
  if (!worksession) return null;
  const ids = [...(task.sessionId ? [task.sessionId] : []), ...(await taskService.sessionIds(task.id))];
  const sessions = ids.length ? await sessionService.list({ ids: [...new Set(ids)], archived: 'all', limit: 500 }) : [];
  for (const id of ids) {
    const s = sessions.find((x) => x.id === id);
    if (!s || s.kind === 'chat' || reviewOf(s)) continue;
    return s.worksessionId === worksession.id ? s : null;
  }
  return null;
}

/**
 * Reprend la tâche dans la conversation de sa session (voir `resumableTaskSession`) au lieu d'en ouvrir une nouvelle :
 * la session est restaurée si elle était archivée (avec son dossier), les autres sessions actives du dossier sont
 * archivées (une seule à la fois), la tâche repasse en cours et le message est envoyé à la session — transmis à
 * l'agent s'il tourne, sinon la session repart avec ce message, conversation comprise.
 */
export async function resumeTaskSession(taskId: string, text: string, author: InstructionAuthor | null = null): Promise<Session> {
  if (!text.trim()) throw new AppError('Le message est vide');
  const task = await taskService.get(taskId);
  if (!task) throw new NotFoundError('Tâche introuvable');
  await assertUnblocked(task);
  const session = await resumableTaskSession(task);
  if (!session) throw new AppError('Aucune session de cette tâche à reprendre : confiez-la à une nouvelle session');
  await worksessionService.forTask(task.id); // restaurée si elle était archivée
  const archived: string[] = [];
  for (const other of await sessionRepository.list({ worksessionId: session.worksessionId!, archived: 'exclude', limit: 50 })) {
    if (other.id === session.id || reviewOf(other)) continue;
    await sessionService.archive(other.id);
    archived.push(other.id);
  }
  if (session.archivedAt) await sessionService.unarchive(session.id);
  await taskService.update(task.id, { status: 'in_progress', sessionId: session.id, releaseSessionIds: archived.filter((id) => task.sessionIds.includes(id)) });
  return sessionService.sendMessage(session.id, text, null, { author });
}
