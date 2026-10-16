import type { Actor } from '../context/types.js';
import type { AttachmentInput } from '../sessions/types.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { describeAttachment, describeAttachments, fitInInstruction, removeAllTaskAttachments, removeAttachmentFiles, removeTaskAttachments, storeTaskAttachments, validateTaskAttachments, type AttachmentDelivery } from './attachments.js';
import { taskRepository } from './repository.js';
import {
  OPEN_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type CommentFiles,
  type CreateTaskInput,
  type Task,
  type TaskAttachment,
  type TaskActor,
  type TaskChange,
  type TaskComment,
  type TaskField,
  type TaskFilter,
  type TaskPerson,
  type TaskPersonInput,
  type UpdateTaskInput,
} from './types.js';

export const priorityLabels = { urgent: 'urgente', high: 'haute', medium: 'moyenne', low: 'basse' } as const;
export const statusLabels = { todo: 'à faire', in_progress: 'en cours', done: 'terminée', cancelled: 'annulée' } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELDS = 100;
const MAX_FIELD_KEY = 100;
const MAX_FIELD_VALUE = 10_000;
const MAX_COMMENT = 20_000;

/** Nom lisible d'une personne : « Nom <e-mail> », ou ce qui est renseigné. */
export function formatPerson(p: TaskPerson | null | undefined): string {
  if (!p) return '';
  if (p.name && p.email) return `${p.name} <${p.email}>`;
  return p.name ?? p.email ?? '';
}

/** Personne normalisée : espaces retirés, e-mail en minuscules et vérifié ; null si les deux champs sont vides. */
export function normalizePerson(input: TaskPersonInput | null | undefined, label: string): TaskPerson | null {
  if (!input) return null;
  const name = input.name?.trim() || null;
  const email = input.email?.trim().toLowerCase() || null;
  if (!name && !email) return null;
  if (name && name.length > 200) throw new AppError(`Le nom du ${label} dépasse 200 caractères`);
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new AppError(`E-mail du ${label} invalide : ${email}`);
  return { name, email };
}

/** Champs personnalisés normalisés : clés uniques (sans tenir compte de la casse), lignes vides ignorées, limites de taille. */
export function normalizeFields(fields: TaskField[] | null | undefined): TaskField[] {
  const out: TaskField[] = [];
  const seen = new Set<string>();
  for (const f of fields ?? []) {
    const key = (f.key ?? '').trim();
    const value = (f.value ?? '').trim();
    if (!key && !value) continue;
    if (!key) throw new AppError('Un champ personnalisé doit avoir une clé');
    if (key.length > MAX_FIELD_KEY) throw new AppError(`La clé « ${key.slice(0, 20)}… » dépasse ${MAX_FIELD_KEY} caractères`);
    if (value.length > MAX_FIELD_VALUE) throw new AppError(`La valeur du champ « ${key} » dépasse ${MAX_FIELD_VALUE} caractères`);
    if (seen.has(key.toLowerCase())) throw new AppError(`Champ personnalisé en double : ${key}`);
    seen.add(key.toLowerCase());
    out.push({ key, value });
  }
  if (out.length > MAX_FIELDS) throw new AppError(`Au plus ${MAX_FIELDS} champs personnalisés par tâche`);
  return out;
}

export const MAX_STATUS_TAG_LENGTH = 40;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** Étiquette d'état nettoyée (espaces réduits) ; null si vide, undefined reste undefined (inchangée). */
export function normalizeStatusTag(tag: string | null | undefined): string | null | undefined {
  if (tag === undefined) return undefined;
  const text = tag?.replace(/\s+/g, ' ').trim() || null;
  if (text && text.length > MAX_STATUS_TAG_LENGTH) throw new AppError(`Étiquette d'état trop longue (${MAX_STATUS_TAG_LENGTH} caractères au plus)`);
  return text;
}

/** Étiquettes nettoyées (espaces réduits), sans les vides ni les doublons (sans tenir compte de la casse). */
export function normalizeTags(tags: string[] | null | undefined): string[] | undefined {
  if (tags == null) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.replace(/\s+/g, ' ').trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new AppError(`Étiquette trop longue (${MAX_TAG_LENGTH} caractères au plus) : ${tag.slice(0, 20)}…`);
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new AppError(`Au plus ${MAX_TAGS} étiquettes par tâche`);
  return out;
}

/** « · <étiquette d'état> » après un statut, quand la tâche en a une. */
export const statusTagText = (t: Pick<Task, 'statusTag'>) => (t.statusTag ? ` · ${t.statusTag}` : '');
/** « , étiquettes a, b » quand la tâche en a. */
export const tagsText = (t: Pick<Task, 'tags'>) => (t.tags.length ? `, étiquettes ${t.tags.join(', ')}` : '');

/** Demande à la session en charge de tenir l'étiquette d'état de sa tâche à jour. */
const STATUS_TAG_HINT =
  "Tiens l'étiquette d'état de la tâche à jour à mesure que ton travail avance : un mot ou deux affichés à côté de son statut dans la sidebar et le tableau (`tasks.update` avec `status_tag`, ex. « analyse », « implémentation », « tests », « en revue », « bloquée » ; une chaîne vide la retire).";

function validate(input: CreateTaskInput | UpdateTaskInput): void {
  if ('title' in input && input.title != null && !input.title.trim()) throw new AppError('Le titre de la tâche est obligatoire');
  if (input.priority != null && !TASK_PRIORITIES.includes(input.priority)) throw new AppError(`Priorité invalide : ${input.priority}`);
  if (input.status != null && !TASK_STATUSES.includes(input.status)) throw new AppError(`Statut invalide : ${input.status}`);
  if (input.dueDate != null && input.dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new AppError('Échéance attendue au format AAAA-MM-JJ');
}

/** Entrée prête pour le dépôt : personnes et champs normalisés (une clé absente reste absente = inchangée). */
function prepare<T extends CreateTaskInput | UpdateTaskInput>(input: T): T & { assignee?: TaskPerson | null; reporter?: TaskPerson | null } {
  validate(input);
  const out: T & { assignee?: TaskPerson | null; reporter?: TaskPerson | null } = { ...input, assignee: undefined, reporter: undefined };
  delete out.assignee;
  delete out.reporter;
  if (input.assignee !== undefined) out.assignee = normalizePerson(input.assignee, 'responsable');
  if (input.reporter !== undefined) out.reporter = normalizePerson(input.reporter, 'rapporteur');
  if (input.customFields != null) out.customFields = normalizeFields(input.customFields);
  if (input.title != null) out.title = input.title.trim();
  if (input.dueDate === '') out.dueDate = null;
  if (input.statusTag !== undefined) out.statusTag = normalizeStatusTag(input.statusTag);
  if (input.tags != null) out.tags = normalizeTags(input.tags);
  return out;
}

/** Lignes décrivant ce qui a changé entre deux états d'une tâche (vide si rien de visible n'a changé). */
export function describeTaskChanges(before: Task, after: Task, addedAttachments: TaskAttachment[] = []): string[] {
  const lines: string[] = [];
  if (before.title !== after.title) lines.push(`- Titre : « ${before.title} » → « ${after.title} »`);
  if (before.status !== after.status) lines.push(`- Statut : ${statusLabels[before.status]} → ${statusLabels[after.status]}`);
  if (before.statusTag !== after.statusTag) lines.push(`- Étiquette d'état : ${before.statusTag ? `« ${before.statusTag} »` : 'aucune'} → ${after.statusTag ? `« ${after.statusTag} »` : 'aucune'}`);
  if (before.tags.join('\n') !== after.tags.join('\n')) lines.push(`- Étiquettes : ${before.tags.join(', ') || 'aucune'} → ${after.tags.join(', ') || 'aucune'}`);
  if (before.priority !== after.priority) lines.push(`- Priorité : ${priorityLabels[before.priority]} → ${priorityLabels[after.priority]}`);
  if (before.dueDate !== after.dueDate) lines.push(`- Échéance : ${before.dueDate ?? 'aucune'} → ${after.dueDate ?? 'aucune'}`);
  if (formatPerson(before.assignee) !== formatPerson(after.assignee)) lines.push(`- Responsable : ${formatPerson(before.assignee) || 'personne'} → ${formatPerson(after.assignee) || 'personne'}`);
  if (formatPerson(before.reporter) !== formatPerson(after.reporter)) lines.push(`- Rapporteur : ${formatPerson(before.reporter) || 'personne'} → ${formatPerson(after.reporter) || 'personne'}`);
  const beforeFields = new Map(before.customFields.map((f) => [f.key.toLowerCase(), f]));
  const afterFields = new Map(after.customFields.map((f) => [f.key.toLowerCase(), f]));
  for (const [k, f] of afterFields) {
    const old = beforeFields.get(k);
    if (!old) lines.push(`- Champ « ${f.key} » : aucun → « ${f.value} »`);
    else if (old.value !== f.value) lines.push(`- Champ « ${f.key} » : « ${old.value} » → « ${f.value} »`);
  }
  for (const [k, f] of beforeFields) if (!afterFields.has(k)) lines.push(`- Champ « ${f.key} » retiré`);
  if (before.description !== after.description) lines.push(`- Description, nouveau texte :\n${after.description.split('\n').map((l) => `  ${l}`).join('\n')}`);
  const { kept, leftOut } = fitInInstruction(addedAttachments);
  if (kept.length) lines.push(`- Fichiers ajoutés (joints à ce message) : ${kept.map(describeAttachment).join(', ')}`);
  if (leftOut.length) lines.push(`- Fichiers ajoutés (trop gros ou trop nombreux pour ce message, lisibles dans l'interface) : ${leftOut.map(describeAttachment).join(', ')}`);
  return lines;
}

const createdListeners = new Map<string, (task: Task, actor: Actor) => Promise<void> | void>();
const changedListeners = new Map<string, (change: TaskChange) => Promise<void> | void>();

function notifyChanged(change: TaskChange): void {
  for (const [name, fn] of changedListeners) {
    Promise.resolve()
      .then(() => fn(change))
      .catch((err) => console.error(`[tasks] écouteur ${name}`, err));
  }
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

export const taskService = {
  list: (filter?: TaskFilter) => taskRepository.list(filter),
  listForSession: (sessionId: string) => taskRepository.listForSession(sessionId),
  sessionIds: (taskId: string) => taskRepository.sessionIds(taskId),
  people: (projectIds: string[]) => (projectIds.length ? taskRepository.people(projectIds) : Promise.resolve([])),

  /** Écouteurs des créations et des changements (session en charge, automatisations) ; jamais attendus, erreurs journalisées. */
  onTaskCreated: (name: string, fn: (task: Task, actor: Actor) => Promise<void> | void) => createdListeners.set(name, fn),
  onTaskChanged: (name: string, fn: (change: TaskChange) => Promise<void> | void) => changedListeners.set(name, fn),

  async get(id: string): Promise<Task> {
    const task = await taskRepository.findById(id);
    if (!task) throw new NotFoundError('Tâche introuvable');
    return task;
  },

  /** Tâche de la session en charge (la première), null sinon. */
  async forSession(sessionId: string): Promise<Task | null> {
    return (await taskRepository.list({ sessionId, limit: 1 }))[0] ?? null;
  },

  /** Tâche traitée sur une branche : une tâche non annulée de préférence. */
  async forBranch(projectId: string, branch: string): Promise<Task | null> {
    const tasks = await taskRepository.list({ projectId, branch, status: TASK_STATUSES, limit: 10 });
    return tasks.find((t) => t.status !== 'cancelled') ?? tasks[0] ?? null;
  },

  /** Passe à « terminée » les tâches ouvertes de la branche (fusion d'une pull request) ; renvoie leurs identifiants. */
  async completeForBranch(projectId: string, branch: string): Promise<string[]> {
    const ids: string[] = [];
    for (const t of await taskRepository.list({ projectId, branch, status: OPEN_STATUSES, limit: 1000 })) {
      await this.update(t.id, { status: 'done' });
      ids.push(t.id);
    }
    return ids;
  },

  async create(projectId: string, input: CreateTaskInput, actor: TaskActor): Promise<Task> {
    const project = await projectService.get(projectId);
    await validateTaskAttachments('', null, input.attachments);
    const created = await taskRepository.create(projectId, prepare(input), actor);
    const attachments = await storeTaskAttachments(created.id, null, input.attachments).catch(async (err) => {
      await taskRepository.delete(created.id).catch(() => undefined);
      throw err;
    });
    const task = attachments.length ? { ...created, attachmentCount: attachments.length } : created;
    if (actor.type === 'agent') {
      void notificationService.notify({
        type: 'task.created',
        title: `Nouvelle tâche proposée par un agent`,
        message: `${task.title} (priorité ${priorityLabels[task.priority]}) · ${project.name}`,
        link: `/tasks/${task.id}`,
        projectId,
        sessionId: actor.sessionId ?? null,
        payload: { taskId: task.id },
      });
    }
    for (const [name, fn] of createdListeners) {
      Promise.resolve()
        .then(() => fn(task, actor))
        .catch((err) => console.error(`[tasks] écouteur ${name}`, err));
    }
    return task;
  },

  /**
   * Met à jour une tâche. `actor` : qui modifie (un agent qui termine une tâche est notifié aux humains ; la
   * session en charge est prévenue des changements faits par d'autres). Sans acteur (Skipper lui-même : lancement,
   * fusion d'une branche), rien n'est diffusé.
   */
  async update(id: string, input: UpdateTaskInput, actor?: TaskActor): Promise<Task> {
    const before = await taskRepository.findById(id);
    if (!before) throw new NotFoundError('Tâche introuvable');
    await validateTaskAttachments(id, null, input.attachments, input.removeAttachmentIds);
    const updated = await taskRepository.update(id, prepare(input));
    if (!updated) throw new NotFoundError('Tâche introuvable');
    const removed = await removeTaskAttachments(id, null, input.removeAttachmentIds);
    const addedAttachments = await storeTaskAttachments(id, null, input.attachments);
    const task = removed.length || addedAttachments.length ? { ...updated, attachmentCount: updated.attachmentCount - removed.length + addedAttachments.length } : updated;
    if (actor?.type === 'agent' && before.status !== 'done' && task.status === 'done') {
      const project = await projectService.get(task.projectId);
      void notificationService.notify({
        type: 'task.completed',
        title: `Tâche terminée par un agent`,
        message: `${task.title} · ${project.name}`,
        link: `/tasks/${task.id}`,
        projectId: task.projectId,
        sessionId: actor.sessionId ?? null,
        payload: { taskId: task.id },
      });
    }
    notifyChanged({ kind: 'updated', before, task, actor: actor ?? null, addedAttachments });
    return task;
  },

  /** Déplace une tâche dans un autre projet (créée par erreur dans le mauvais) ; sa session et sa branche restent à l'ancien. */
  async move(id: string, projectId: string): Promise<Task> {
    const before = await this.get(id);
    if (before.projectId === projectId) return before;
    await projectService.get(projectId);
    const task = await taskRepository.move(id, projectId);
    if (!task) throw new NotFoundError('Tâche introuvable');
    return task;
  },

  /** Étiquettes distinctes des projets, les plus utilisées d'abord (suggestions des formulaires et filtres). */
  tags: (projectIds: string[]) => (projectIds.length ? taskRepository.tags(projectIds) : Promise.resolve([] as string[])),

  async delete(id: string): Promise<boolean> {
    await this.get(id);
    const deleted = await taskRepository.delete(id);
    if (deleted) await removeAllTaskAttachments(id).catch((err) => console.warn('[tasks] fichiers joints non supprimés', err));
    return deleted;
  },

  /** Fichiers d'une tâche : les siens (`commentId` null), ceux d'un commentaire, ou tous (`commentId` absent), les plus anciens d'abord. */
  attachments: (taskId: string, commentId?: string | null) => taskRepository.listAttachments(taskId, commentId),
  findAttachment: (id: string) => taskRepository.findAttachment(id),

  // ---- Commentaires ----------------------------------------------------------------------------

  comments: (taskId: string) => taskRepository.listComments(taskId),

  async getComment(id: string): Promise<TaskComment> {
    const c = await taskRepository.findComment(id);
    if (!c) throw new NotFoundError('Commentaire introuvable');
    return c;
  },

  /** Ajoute un commentaire, avec des fichiers le cas échéant (le texte peut alors être vide). */
  async addComment(taskId: string, body: string, author: TaskActor, files: AttachmentInput[] | null = null): Promise<TaskComment> {
    const task = await this.get(taskId);
    const text = body.trim();
    if (!text && !files?.length) throw new AppError('Le commentaire est vide');
    await validateTaskAttachments('', null, files);
    if (text.length > MAX_COMMENT) throw new AppError(`Le commentaire dépasse ${MAX_COMMENT} caractères`);
    const comment = await taskRepository.addComment(taskId, text, { type: author.type, userId: author.userId, sessionId: author.sessionId, name: author.name?.trim() || (author.type === 'agent' ? 'Agent' : 'Quelqu\'un') });
    const attachments = await storeTaskAttachments(taskId, comment.id, files).catch(async (err) => {
      await taskRepository.deleteComment(comment.id).catch(() => undefined);
      throw err;
    });
    notifyChanged({ kind: 'commented', task, comment, attachments });
    return comment;
  },

  async updateComment(id: string, body: string, files: CommentFiles = {}): Promise<TaskComment> {
    const current = await this.getComment(id);
    const kept = (await taskRepository.listAttachments(current.taskId, id)).filter((a) => !files.removeAttachmentIds?.includes(a.id));
    const text = body.trim();
    if (!text && kept.length + (files.attachments?.length ?? 0) === 0) throw new AppError('Le commentaire est vide');
    if (text.length > MAX_COMMENT) throw new AppError(`Le commentaire dépasse ${MAX_COMMENT} caractères`);
    await validateTaskAttachments(current.taskId, id, files.attachments, files.removeAttachmentIds);
    const c = await taskRepository.updateComment(id, text);
    if (!c) throw new NotFoundError('Commentaire introuvable');
    await removeTaskAttachments(current.taskId, id, files.removeAttachmentIds);
    await storeTaskAttachments(current.taskId, id, files.attachments);
    return c;
  },

  /** Supprime un commentaire et ses fichiers (les lignes partent en cascade, les fichiers ici). */
  async deleteComment(id: string): Promise<boolean> {
    const comment = await this.getComment(id);
    const attachments = await taskRepository.listAttachments(comment.taskId, id);
    const deleted = await taskRepository.deleteComment(id);
    if (deleted) await removeAttachmentFiles(attachments);
    return deleted;
  },

  // ---- Prompts des agents ----------------------------------------------------------------------

  /** Résumé des tâches ouvertes, injecté dans le prompt système des agents. */
  async promptSummary(projectId: string, sessionId?: string): Promise<string> {
    const open = await taskRepository.list({ projectId, status: OPEN_STATUSES });
    const intro =
      "Le projet dispose d'un tableau de tâches géré avec les outils du serveur MCP `tasks` (list, get, create, update, claim, comment). Quand tu réalises une tâche, passe-la en `in_progress` avec `claim` puis en `done` une fois terminée. Si tu découvres du travail à faire plus tard, crée une tâche plutôt que de le laisser tomber.";
    if (open.length === 0) return `${intro}\nAucune tâche ouverte pour le moment.`;
    const lines = open.map(
      (t) =>
        `- [${statusLabels[t.status]}${statusTagText(t)}, priorité ${priorityLabels[t.priority]}${t.sessionId && t.sessionId === sessionId ? ', assignée à cette session' : t.sessionId ? ', prise par une autre session' : ''}${t.assignee ? `, responsable ${formatPerson(t.assignee)}` : ''}${tagsText(t)}] ${t.title} (id ${t.id})`,
    );
    return [intro, 'Tâches ouvertes :', ...lines].join('\n');
  },

  /** Paragraphe du prompt système d'une session en charge d'une tâche : son identifiant et les messages qu'elle recevra. */
  async linkedTaskPrompt(sessionId: string): Promise<string> {
    const task = await this.forSession(sessionId);
    if (!task) return '';
    return [
      `Cette session est en charge de la tâche ${task.id} (« ${task.title} », ${statusLabels[task.status]}${statusTagText(task)}, priorité ${priorityLabels[task.priority]}${tagsText(task)}) : utilise cet identifiant avec les outils \`tasks\` (\`get\` la lit avec ses commentaires, \`update\`, \`comment\`).`,
      "Quand quelqu'un d'autre la modifie ou la commente, tu reçois un message commençant par « [Mise à jour de la tâche] » ou « [Commentaire sur la tâche] » qui décrit le changement : tiens-en compte, et réponds à un commentaire avec `tasks.comment` quand il appelle une réponse.",
      STATUS_TAG_HINT,
    ].join('\n');
  },

  /** Texte d'une tâche tel que transmis à un agent chargé de la réaliser (avec ses personnes, champs et commentaires). */
  describeForPrompt(task: Task, comments: TaskComment[] = [], attachments: TaskAttachment[] = [], attached: AttachmentDelivery = 'none'): string {
    const own = attachments.filter((a) => !a.commentId);
    const parts = [
      `Réalise la tâche suivante du projet (id ${task.id}, priorité ${priorityLabels[task.priority]}${task.dueDate ? `, échéance ${task.dueDate}` : ''}) :`,
      '',
      `# ${task.title}`,
      '',
      task.description || '(pas de description)',
    ];
    if (own.length) parts.push('', ...describeAttachments(own, attached));
    if (task.assignee) parts.push('', `Responsable : ${formatPerson(task.assignee)}`);
    if (task.reporter) parts.push(task.assignee ? '' : '', `Rapporteur : ${formatPerson(task.reporter)}`);
    if (task.tags.length) parts.push('', `Étiquettes : ${task.tags.join(', ')}`);
    if (task.customFields.length) parts.push('', 'Champs personnalisés :', ...task.customFields.map((f) => `- ${f.key} : ${f.value}`));
    if (comments.length) {
      parts.push('', 'Commentaires (du plus ancien au plus récent) :');
      for (const c of comments) parts.push(...describeComment(c, attachments.filter((a) => a.commentId === c.id), attached));
    }
    parts.push(
      '',
      "Elle t'est assignée et est déjà « en cours ». Quand c'est terminé et vérifié, passe-la en `done` avec l'outil `tasks.update`. Si tu es bloqué, laisse-la en cours et explique pourquoi (l'outil `tasks.comment` ajoute un commentaire à la tâche).",
      STATUS_TAG_HINT,
    );
    return parts.join('\n');
  },

  /** Instruction qu'un agent recevrait pour la tâche (pré-remplit le formulaire « Confier à un agent »). */
  async promptFor(id: string): Promise<string> {
    const task = await this.get(id);
    const project = await projectService.get(task.projectId);
    const { kept, leftOut } = fitInInstruction(await taskRepository.listAttachments(id));
    // Même composition que tasks/launch.ts (composeTaskPrompt) : fichiers joints, puis consignes de tâches du projet.
    const text = this.describeForPrompt({ ...task, status: 'in_progress' }, await taskRepository.listComments(id), kept, 'instruction');
    const parts = [text];
    if (leftOut.length) parts.push('', `Non joints (au-delà des limites d'une instruction, lisibles dans l'interface) : ${leftOut.map(describeAttachment).join(', ')}.`);
    if (project.taskInstructions.trim()) parts.push('', '---', '', 'Consignes supplémentaires :', '', project.taskInstructions.trim());
    return parts.join('\n');
  },
};

/** Un commentaire tel que montré à un agent, ses fichiers nommés sous son texte. */
export function describeComment(c: TaskComment, attachments: TaskAttachment[] = [], attached: AttachmentDelivery = 'none'): string[] {
  return [`- ${c.authorName}${c.authorType === 'agent' ? ' (agent)' : ''}, ${fmtDate(c.createdAt)} UTC :`, ...[c.body || '(pas de texte)', ...describeAttachments(attachments, attached)].join('\n').split('\n').map((l) => `  ${l}`)];
}
