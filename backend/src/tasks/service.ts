import { userRepository } from '../users/repository.js';
import type { Actor } from '../context/types.js';
import type { AttachmentInput } from '../sessions/types.js';
import { AppError, NotFoundError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { describeAttachment, describeAttachments, fitInInstruction, removeAllTaskAttachments, removeAttachmentFiles, removeTaskAttachments, storeTaskAttachments, validateTaskAttachments, type AttachmentDelivery } from './attachments.js';
import { dependencyCycle, normalizeDependencyIds } from './dependencyGraph.js';
import { findMentions, sessionMentionable, userMentionable, type Mentionable } from './mentions.js';
import { taskRepository } from './repository.js';
import { promptTasks } from './promptList.js';
import { DEFAULT_TASK_STATUSES, describeStatusesForAgents, effectiveStatus, resolveTaskState, type TaskStatusDefinition } from './statuses.js';
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
  type TaskMention,
  type TaskPerson,
  type TaskPersonInput,
  type TaskReaction,
  type UpdateTaskInput,
} from './types.js';
import { log } from '../log.js';
import { auditService } from '../audit/service.js';

export const priorityLabels = { urgent: 'urgente', high: 'haute', medium: 'moyenne', low: 'basse' } as const;
export const statusLabels = { todo: 'à faire', in_progress: 'en cours', done: 'terminée', cancelled: 'annulée' } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELDS = 100;
const MAX_FIELD_KEY = 100;
const MAX_FIELD_VALUE = 10_000;
const MAX_COMMENT = 20_000;
const MAX_EMOJI_CODEPOINTS = 8;
const MAX_DEPENDENCIES = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Libellé du statut d'une tâche dans son projet, en minuscule initiale (« à valider ») ; sans statuts du projet, celui de sa catégorie. */
export function stateText(t: Pick<Task, 'status' | 'state'>, statuses?: TaskStatusDefinition[] | null): string {
  if (!statuses) return statusLabels[t.status];
  const label = effectiveStatus(statuses, t).label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Statuts des projets demandés (une lecture par projet). */
async function statusesByProject(projectIds: string[]): Promise<Map<string, TaskStatusDefinition[]>> {
  const out = new Map<string, TaskStatusDefinition[]>();
  for (const id of new Set(projectIds)) {
    const project = await projectService.get(id).catch(() => null);
    if (project) out.set(id, project.taskStatuses);
  }
  return out;
}

/** « « Titre » (id) » d'une tâche, pour les messages et prompts. */
const taskRef = (t: Pick<Task, 'id' | 'title'>) => `« ${t.title} » (${t.id})`;

/** Une tâche est bloquée tant qu'au moins une de ses dépendances n'est pas terminée. */
export const isBlocked = (t: Pick<Task, 'blockedByIds'>) => t.blockedByIds.length > 0;

/** Refuse de confier à un agent une tâche bloquée (lancement, reprise, prise en charge par un agent). */
export async function assertUnblocked(task: Task): Promise<void> {
  if (!isBlocked(task)) return;
  const blockers = await taskRepository.findByIds(task.blockedByIds);
  const names = task.blockedByIds.map((id) => blockers.find((b) => b.id === id)).map((b, i) => (b ? `${taskRef(b)}, ${statusLabels[b.status]}` : task.blockedByIds[i]));
  throw new AppError(`La tâche est bloquée par ${names.join(' ; ')} : elle pourra être confiée à un agent quand ses dépendances seront terminées.`);
}

/** Emoji d'une réaction nettoyé : court, sans espace. */
export function normalizeEmoji(emoji: string): string {
  const e = emoji.trim();
  if (!e) throw new AppError('Emoji manquant');
  if (/\s/.test(e) || Array.from(e).length > MAX_EMOJI_CODEPOINTS) throw new AppError('Réaction invalide : un seul emoji attendu');
  return e;
}

/** Mode d'emploi du fil d'une tâche pour un agent : réponses, mentions, réactions. */
export const THREAD_HINT =
  "Le fil d'une tâche se lit comme une conversation : `tasks.comment` y poste un message (`reply_to` pour répondre dans le fil d'un message), `tasks.react` pose ou retire un emoji sur un message ou sur la tâche, et une mention (« @Nom », « @e-mail » pour un membre du projet ; « @session:<id> » pour une session d'agent ; `tasks.people` liste qui l'on peut mentionner) prévient la personne ou transmet le message à la session. Pour obtenir l'accord d'une personne avant une action sensible (mise en production, serveur, action irréversible), utilise `tasks.request_approval` plutôt qu'un simple message : c'est une vraie demande, et elle constate d'elle-même l'accord de la personne qui t'a demandé le travail quand elle est administrateur.";

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

export const MAX_WAKE_NOTE_LENGTH = 2000;
/** Délai maximal d'une date de réveil : au-delà, une tâche n'est plus « en attente », elle est à replanifier. */
export const MAX_WAKE_DAYS = 90;

/** Formate une date de réveil pour un lecteur (agent ou personne), heure de Paris. */
export const formatWakeAt = (d: Date) => d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Date de réveil saisie (ISO 8601, ex. « 2026-11-14T07:00:00+01:00 ») : undefined reste inchangée, chaîne vide ou null
 * la retire. Refusée si elle est passée ou au-delà de MAX_WAKE_DAYS jours.
 */
export function parseWakeAt(value: string | Date | null | undefined, now = new Date()): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  const d = value instanceof Date ? value : new Date(value.trim());
  if (Number.isNaN(d.getTime())) throw new AppError(`Date de réveil illisible : ${String(value)} (attendu : date et heure ISO, ex. 2026-11-14T07:00:00+01:00)`);
  if (d.getTime() <= now.getTime()) throw new AppError('La date de réveil doit être dans le futur');
  if (d.getTime() > now.getTime() + MAX_WAKE_DAYS * 86_400_000) throw new AppError(`Date de réveil trop lointaine (${MAX_WAKE_DAYS} jours au plus) : rends plutôt la tâche`);
  return d;
}

/** Note de réveil nettoyée ; null si vide, undefined reste undefined. */
export function normalizeWakeNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  const text = note?.trim() || null;
  if (text && text.length > MAX_WAKE_NOTE_LENGTH) throw new AppError(`Note de réveil trop longue (${MAX_WAKE_NOTE_LENGTH} caractères au plus)`);
  return text;
}

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

/** Remplace dans le texte d'un message les mentions par leur libellé, pour un lecteur (agent) qui ne connaît pas l'alias. */
const readableMentions = (c: TaskComment): string => (c.mentions.length ? ` (mentionne ${c.mentions.map((m) => (m.kind === 'session' ? `la session « ${m.label} » (${m.id})` : m.label)).join(', ')})` : '');

/** Demande à la session en charge de tenir l'étiquette d'état de sa tâche à jour. */
const STATUS_TAG_HINT =
  "Tiens l'étiquette d'état de la tâche à jour à mesure que ton travail avance : un mot ou deux affichés à côté de son statut dans la sidebar et le tableau (`tasks.update` avec `status_tag`, ex. « analyse », « implémentation », « tests », « en revue », « bloquée » ; une chaîne vide la retire).";
/**
 * Rappel de fin : une tâche laissée « en cours » quand la session s'arrête est signalée « agent arrêté » à l'équipe
 * (tasks/stalled.ts) ; l'agent la ferme, la rend ou explique ce qui la retient avant de finir.
 */
export function finishTaskHint(statuses?: TaskStatusDefinition[] | null): string {
  const review = reviewStatusOf(statuses);
  return [
    `Avant de terminer (dernier tour, archivage de la session), passe chaque tâche dont tu es en charge à \`done\` (\`tasks.update\`) si le travail est fini et vérifié${review ? ` ; ${reviewHint(review)}` : ''} ; sinon rends-la (\`tasks.release\`) ou laisse-la en cours avec un message dans son fil qui dit ce qui reste et ce que tu attends.`,
    "Si tu attends un événement daté (un job de nuit, un relevé du lendemain, une réponse), pose une date de réveil (`tasks.update` avec `wake_at`, et `wake_note` : ce qu'il faudra vérifier) : la tâche est « en attente » jusque-là, puis l'agent qui la tenait est reconvoqué (ou la tâche revient dans « À traiter » pour une personne). Une tâche laissée « en cours » par une session arrêtée en erreur, sans rien dire ou dont le réveil est passé est signalée « agent arrêté » à l'équipe.",
  ].join(' ');
}

/**
 * Statut « à valider » du projet : le premier statut de la catégorie « en cours » qui attend une personne, hors statut
 * par défaut de la catégorie (null : le projet n'en a pas, ou « en cours » attend déjà une personne). C'est là que va une tâche dont le travail est fait mais reste à vérifier, plutôt que « en cours ».
 */
export function reviewStatusOf(statuses?: TaskStatusDefinition[] | null): TaskStatusDefinition | null {
  return (statuses?.length ? statuses : DEFAULT_TASK_STATUSES).find((s) => s.category === 'in_progress' && s.attention && !s.isDefault) ?? null;
}

/** Consigne du passage au statut « à valider » (travail livré, vérification à faire, éventuellement à une date ultérieure). */
const reviewHint = (review: TaskStatusDefinition) =>
  `si le travail est fait (livré, fusionné, déployé) mais reste à vérifier — relecture par une personne, mesure en production, relevé à venir —, passe-la au statut \`${review.key}\` « ${review.label} » (\`tasks.update\` avec \`state\`) plutôt que de la laisser « en cours », et si cette vérification ne peut se faire qu'à une date ultérieure, pose aussi une date de réveil (\`wake_at\`, \`wake_note\`) : elle reste « en attente » jusque-là, puis l'agent qui la tenait est reconvoqué pour vérifier et la passer à \`done\``;

/**
 * Fin de l'instruction d'une session qui réalise une tâche : comment la terminer. Les statuts du projet donnent le
 * statut « à valider » (s'il existe) : sans lui, un agent qui n'a plus qu'une vérification à faire laisse la tâche
 * « en cours » (constaté le 25/11/2026 sur la tâche Curso 313c1101).
 */
export function finishTaskInstruction(statuses?: TaskStatusDefinition[] | null): string {
  const review = reviewStatusOf(statuses);
  return [
    "Elle t'est assignée et est déjà « en cours ». Quand c'est terminé et vérifié, passe-la en `done` avec l'outil `tasks.update`.",
    review ? `${reviewHint(review).charAt(0).toUpperCase()}${reviewHint(review).slice(1)}.` : '',
    "Si tu es bloqué, laisse-la en cours et explique pourquoi dans son fil (`tasks.comment`).",
  ]
    .filter(Boolean)
    .join(' ');
}

function validate(input: CreateTaskInput | UpdateTaskInput): void {
  if ('title' in input && input.title != null && !input.title.trim()) throw new AppError('Le titre de la tâche est obligatoire');
  if (input.priority != null && !TASK_PRIORITIES.includes(input.priority)) throw new AppError(`Priorité invalide : ${input.priority}`);
  if (input.status != null && !TASK_STATUSES.includes(input.status)) throw new AppError(`Statut invalide : ${input.status}`);
  if (input.dueDate != null && input.dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new AppError('Échéance attendue au format AAAA-MM-JJ');
  if (input.summary != null && input.summary.trim().length > SUMMARY_MAX) throw new AppError(`Le résumé doit rester court (${SUMMARY_MAX} caractères au plus) : le détail va dans la description`);
}

/** Longueur maximale du résumé d'une tâche : une ou deux phrases, le détail va dans la description. */
export const SUMMARY_MAX = 500;

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
  if (input.summary !== undefined) out.summary = input.summary?.trim() || null;
  if (input.dueDate === '') out.dueDate = null;
  if (input.statusTag !== undefined) out.statusTag = normalizeStatusTag(input.statusTag);
  if (input.tags != null) out.tags = normalizeTags(input.tags);
  const wake = out as UpdateTaskInput;
  if ('wakeAt' in input && input.wakeAt !== undefined) wake.wakeAt = parseWakeAt(input.wakeAt);
  if ('wakeNote' in input && input.wakeNote !== undefined) wake.wakeNote = normalizeWakeNote(input.wakeNote);
  return out;
}

/** Lignes décrivant ce qui a changé entre deux états d'une tâche (vide si rien de visible n'a changé). */
export function describeTaskChanges(before: Task, after: Task, addedAttachments: TaskAttachment[] = [], statuses?: TaskStatusDefinition[] | null): string[] {
  const lines: string[] = [];
  if (before.title !== after.title) lines.push(`- Titre : « ${before.title} » → « ${after.title} »`);
  if (stateText(before, statuses) !== stateText(after, statuses) || before.status !== after.status) lines.push(`- Statut : ${stateText(before, statuses)} → ${stateText(after, statuses)}`);
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
  if (before.dependsOnIds.join('\n') !== after.dependsOnIds.join('\n')) lines.push(`- Dépendances (bloquée par) : ${before.dependsOnIds.join(', ') || 'aucune'} → ${after.dependsOnIds.join(', ') || 'aucune'}`);
  if ((before.wakeAt?.getTime() ?? null) !== (after.wakeAt?.getTime() ?? null)) lines.push(`- Réveil : ${before.wakeAt ? formatWakeAt(before.wakeAt) : 'aucun'} → ${after.wakeAt ? formatWakeAt(after.wakeAt) : 'aucun'}`);
  if (before.wakeNote !== after.wakeNote && after.wakeNote) lines.push(`- À vérifier au réveil : ${after.wakeNote}`);
  if (before.autoStartWhenUnblocked !== after.autoStartWhenUnblocked) lines.push(`- Lancement automatique quand débloquée : ${after.autoStartWhenUnblocked ? 'activé' : 'désactivé'}`);
  if (before.summary !== after.summary) lines.push(after.summary ? `- Résumé, nouveau texte : ${after.summary}` : '- Résumé retiré');
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
      .catch((err) => log.error(`[tasks] écouteur ${name}`, err));
  }
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/** Acteur d'une modification de tâche au journal d'audit (sans acteur : Skipper lui-même, ex. fusion d'une PR). */
const auditActor = (actor: TaskActor | null | undefined) =>
  actor ? { userId: actor.type === 'human' ? (actor.userId ?? null) : null, sessionId: actor.type === 'agent' ? (actor.sessionId ?? null) : null, label: actor.name ?? null } : null;

export const taskService = {
  list: (filter?: TaskFilter) => taskRepository.list(filter),
  listForSession: (sessionId: string) => taskRepository.listForSession(sessionId),
  /** Tâches de ces identifiants, sans ordre garanti (dépendances d'une tâche…). */
  findByIds: (ids: string[]) => taskRepository.findByIds(ids),
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

  /** Première des tâches dont la session est en charge, null sinon (les lectures qui n'en veulent qu'une). */
  async forSession(sessionId: string): Promise<Task | null> {
    return (await taskRepository.list({ sessionId, limit: 1 }))[0] ?? null;
  },

  /** Toutes les tâches dont la session est en charge (une session peut en mener plusieurs). */
  tasksInCharge: (sessionId: string) => taskRepository.list({ sessionId, limit: 100 }),

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

  /**
   * Dépendances demandées pour une tâche (`taskId` null : tâche à créer) : identifiants nettoyés, tâches existantes du
   * même projet, sans la tâche elle-même ni cycle. Renvoie aussi le nombre de celles qui la bloquent (pas terminées).
   */
  async prepareDependencies(projectId: string, taskId: string | null, ids: string[]): Promise<{ ids: string[]; blocking: number }> {
    const wanted = normalizeDependencyIds(ids);
    if (wanted.length > MAX_DEPENDENCIES) throw new AppError(`Au plus ${MAX_DEPENDENCIES} dépendances par tâche`);
    const invalid = wanted.find((id) => !UUID_RE.test(id));
    if (invalid) throw new AppError(`Dépendance invalide : ${invalid} (identifiant de tâche attendu)`);
    if (taskId && wanted.includes(taskId)) throw new AppError('Une tâche ne peut pas dépendre d’elle-même');
    const found = await taskRepository.findByIds(wanted);
    for (const id of wanted) {
      const dep = found.find((t) => t.id === id);
      if (!dep) throw new AppError(`Dépendance introuvable : ${id}`);
      if (dep.projectId !== projectId) throw new AppError(`La tâche ${taskRef(dep)} appartient à un autre projet : une dépendance est une tâche du même projet`);
    }
    if (taskId && wanted.length) {
      const cycle = dependencyCycle(taskId, wanted, await taskRepository.dependencyEdges(projectId));
      if (cycle) {
        const titles = new Map([...found, ...(await taskRepository.findByIds(cycle))].map((t) => [t.id, t.title]));
        throw new AppError(`Dépendance circulaire : ${cycle.map((id) => `« ${titles.get(id) ?? id} »`).join(' → ')}`);
      }
    }
    return { ids: wanted, blocking: found.filter((t) => t.status !== 'done').length };
  },

  /**
   * Dépendances et lancement automatique d'une entrée : validés, et l'option n'est armée que si la tâche a des
   * dépendances non terminées (sinon il n'y a rien à attendre), au nom de l'acteur.
   */
  async withDependencies<T extends CreateTaskInput | UpdateTaskInput>(projectId: string, current: Task | null, input: T, actor?: TaskActor): Promise<T> {
    const out = { ...input };
    let blocking = current?.blockedByIds.length ?? 0;
    if (input.dependsOn != null) {
      const deps = await this.prepareDependencies(projectId, current?.id ?? null, input.dependsOn);
      out.dependsOn = deps.ids;
      blocking = deps.blocking;
    }
    const arm = input.autoStartWhenUnblocked ?? (input.dependsOn != null && current?.autoStartWhenUnblocked ? true : null);
    if (arm != null) {
      out.autoStartWhenUnblocked = arm && blocking > 0;
      // Option réévaluée après un changement de dépendances : elle reste au nom de qui l'avait armée.
      out.autoStartById = input.autoStartById ?? (input.autoStartWhenUnblocked == null ? current?.autoStartById : null) ?? actor?.userId ?? null;
      if (out.autoStartWhenUnblocked && !out.autoStartById) throw new AppError('Le lancement automatique doit être armé par une personne (au nom de qui la session sera lancée)');
    }
    return out;
  },

  async create(projectId: string, input: CreateTaskInput, actor: TaskActor): Promise<Task> {
    const project = await projectService.get(projectId);
    await validateTaskAttachments('', null, input.attachments);
    input = await this.withDependencies(projectId, null, input, actor);
    // Statut du projet : celui demandé, sinon le statut par défaut de la catégorie (« À faire » d'ordinaire).
    const resolved = resolveTaskState(project.taskStatuses, input, null) ?? resolveTaskState(project.taskStatuses, { status: 'todo' }, null)!;
    input = { ...input, ...resolved };
    const created = await taskRepository.create(projectId, prepare(input), actor);
    const attachments = await storeTaskAttachments(created.id, null, input.attachments).catch(async (err) => {
      await taskRepository.delete(created.id).catch(() => undefined);
      throw err;
    });
    const task = attachments.length ? { ...created, attachmentCount: attachments.length } : created;
    await auditService.record({ projectId, actor: auditActor(actor), action: 'task.create', targetType: 'task', targetId: task.id, targetLabel: task.title, details: { status: task.status, priority: task.priority, workflowRunId: actor.workflowRunId ?? undefined } });
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
        .catch((err) => log.error(`[tasks] écouteur ${name}`, err));
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
    input = await this.withDependencies(before.projectId, before, input, actor);
    if (input.state != null || input.status != null) {
      const resolved = resolveTaskState((await projectService.get(before.projectId)).taskStatuses, input, before);
      if (resolved) input = { ...input, ...resolved };
      else delete input.state;
    } else delete input.state;
    const updated = await taskRepository.update(id, prepare(input));
    if (!updated) throw new NotFoundError('Tâche introuvable');
    const removed = await removeTaskAttachments(id, null, input.removeAttachmentIds);
    const addedAttachments = await storeTaskAttachments(id, null, input.attachments);
    const task = removed.length || addedAttachments.length ? { ...updated, attachmentCount: updated.attachmentCount - removed.length + addedAttachments.length } : updated;
    if (before.status !== task.status || (before.state ?? null) !== (task.state ?? null)) {
      await auditService.record({ projectId: task.projectId, actor: auditActor(actor), action: 'task.status', targetType: 'task', targetId: task.id, targetLabel: task.title, details: { from: before.status, to: task.status, fromState: before.state ?? undefined, toState: task.state ?? undefined } });
    }
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
    if (deleted) await removeAllTaskAttachments(id).catch((err) => log.warn('[tasks] fichiers joints non supprimés', err));
    return deleted;
  },

  /** Fichiers d'une tâche : les siens (`commentId` null), ceux d'un commentaire, ou tous (`commentId` absent), les plus anciens d'abord. */
  attachments: (taskId: string, commentId?: string | null) => taskRepository.listAttachments(taskId, commentId),
  findAttachment: (id: string) => taskRepository.findAttachment(id),

  // ---- Fil de discussion (commentaires, mentions, réactions) -------------------------------------

  comments: (taskId: string) => taskRepository.listComments(taskId),
  reactions: (taskId: string) => taskRepository.listReactions(taskId),
  linkSession: (taskId: string, sessionId: string) => taskRepository.linkSession(taskId, sessionId),

  /** Qui l'on peut mentionner dans le fil des tâches d'un projet : ses membres, puis ses sessions d'agent non archivées (en cours d'abord). */
  async mentionables(projectId: string): Promise<Mentionable[]> {
    const { users, sessions } = await taskRepository.mentionCandidates(projectId);
    return [...users.map(userMentionable), ...sessions.map(sessionMentionable)];
  },

  /** Mentions d'un texte, résolues parmi les membres et sessions du projet. */
  async resolveMentions(projectId: string, body: string): Promise<TaskMention[]> {
    return body.includes('@') ? findMentions(body, await this.mentionables(projectId)) : [];
  },

  /**
   * Pose ou retire une réaction sur un message du fil (`commentId`) ou sur la tâche elle-même (null). L'auteur du
   * message, s'il s'agit d'une session, en est informé (écouteurs).
   */
  async toggleReaction(taskId: string, commentId: string | null, emoji: string, actor: TaskActor): Promise<{ reaction: TaskReaction; added: boolean }> {
    const task = await this.get(taskId);
    const comment = commentId ? await this.getComment(commentId) : null;
    if (comment && comment.taskId !== taskId) throw new AppError("Ce message n'appartient pas à cette tâche");
    const result = await taskRepository.toggleReaction(taskId, commentId, normalizeEmoji(emoji), {
      type: actor.type,
      userId: actor.userId,
      sessionId: actor.sessionId,
      name: actor.name?.trim() || (actor.type === 'agent' ? 'Agent' : "Quelqu'un"),
    });
    notifyChanged({ kind: 'reacted', task, reaction: result.reaction, comment, added: result.added });
    return result;
  },

  async getComment(id: string): Promise<TaskComment> {
    const c = await taskRepository.findComment(id);
    if (!c) throw new NotFoundError('Commentaire introuvable');
    return c;
  },

  /**
   * Poste un message dans le fil de la tâche, avec des fichiers le cas échéant (le texte peut alors être vide).
   * `parentId` : réponse dans le fil d'un message (une réponse à une réponse rejoint le fil de la racine). Les
   * mentions sont résolues parmi les membres et sessions du projet : les personnes mentionnées et l'auteur du
   * message auquel on répond sont notifiés, les sessions mentionnées sont reliées à la tâche (elles recevront le
   * message, puis tous les changements de la tâche).
   */
  async addComment(taskId: string, body: string, author: TaskActor, files: AttachmentInput[] | null = null, opts: { parentId?: string | null } = {}): Promise<TaskComment> {
    const task = await this.get(taskId);
    const text = body.replace(/\u0000/g, '').trim();
    if (!text && !files?.length) throw new AppError('Le commentaire est vide');
    await validateTaskAttachments('', null, files);
    if (text.length > MAX_COMMENT) throw new AppError(`Le commentaire dépasse ${MAX_COMMENT} caractères`);
    let parent: TaskComment | null = null;
    if (opts.parentId) {
      parent = await this.getComment(opts.parentId);
      if (parent.taskId !== taskId) throw new AppError("Le message auquel vous répondez n'appartient pas à cette tâche");
      if (parent.parentId) parent = await this.getComment(parent.parentId);
    }
    const mentions = await this.resolveMentions(task.projectId, text);
    const comment = await taskRepository.addComment(
      taskId,
      text,
      { type: author.type, userId: author.userId, sessionId: author.sessionId, name: author.name?.trim() || (author.type === 'agent' ? 'Agent' : 'Quelqu\'un') },
      { parentId: parent?.id ?? null, mentions },
    );
    const attachments = await storeTaskAttachments(taskId, comment.id, files).catch(async (err) => {
      await taskRepository.deleteComment(comment.id).catch(() => undefined);
      throw err;
    });
    for (const m of mentions) if (m.kind === 'session') await taskRepository.linkSession(taskId, m.id).catch((err) => log.warn('[tasks] session mentionnée non reliée', err));
    void this.notifyThread(task, comment, parent, author);
    notifyChanged({ kind: 'commented', task, comment, attachments, parent });
    return comment;
  },

  /** Notifications d'un nouveau message : aux personnes mentionnées, et à l'auteur (humain) du message auquel il répond. */
  async notifyThread(task: Task, comment: TaskComment, parent: TaskComment | null, author: TaskActor): Promise<void> {
    const excerpt = comment.body.length > 140 ? `${comment.body.slice(0, 140)}…` : comment.body || '(fichiers joints)';
    const notified = new Set<string>();
    if (author.userId) notified.add(author.userId);
    const base = { link: `/tasks/${task.id}#comment-${comment.id}`, projectId: task.projectId, sessionId: author.sessionId ?? null, payload: { taskId: task.id, commentId: comment.id } };
    for (const m of comment.mentions) {
      if (m.kind !== 'user' || notified.has(m.id)) continue;
      notified.add(m.id);
      // Un agent mentionné n'est pas notifié : il est convoqué (agents/triggers.ts) ou reçoit le message par le fil.
      if ((await userRepository.findById(m.id))?.kind === 'agent') continue;
      await notificationService.notify({ ...base, type: 'task.mentioned', userId: m.id, title: `${comment.authorName} vous mentionne · ${task.title}`, message: excerpt });
    }
    if (parent?.authorUserId && !notified.has(parent.authorUserId)) {
      await notificationService.notify({ ...base, type: 'task.replied', userId: parent.authorUserId, title: `${comment.authorName} répond à votre message · ${task.title}`, message: excerpt });
    }
  },

  async updateComment(id: string, body: string, files: CommentFiles = {}): Promise<TaskComment> {
    const current = await this.getComment(id);
    const kept = (await taskRepository.listAttachments(current.taskId, id)).filter((a) => !files.removeAttachmentIds?.includes(a.id));
    const text = body.replace(/\u0000/g, '').trim();
    if (!text && kept.length + (files.attachments?.length ?? 0) === 0) throw new AppError('Le commentaire est vide');
    if (text.length > MAX_COMMENT) throw new AppError(`Le commentaire dépasse ${MAX_COMMENT} caractères`);
    await validateTaskAttachments(current.taskId, id, files.attachments, files.removeAttachmentIds);
    const task = await this.get(current.taskId);
    const c = await taskRepository.updateComment(id, text, await this.resolveMentions(task.projectId, text));
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
    const statuses = (await projectService.get(projectId)).taskStatuses;
    const intro = [
      "Le projet dispose d'un tableau de tâches géré avec les outils du serveur MCP `tasks` (list, get, create, update, claim, release, comment, react, people). Quand tu réalises une tâche, passe-la en `in_progress` avec `claim` puis en `done` une fois terminée ; une tâche que tu crées déjà en cours ou terminée (ton propre travail) t'est rattachée d'office, et une session peut être en charge de plusieurs tâches. Si tu découvres du travail à faire plus tard, crée une tâche `todo` plutôt que de le laisser tomber.",
      "Une tâche peut dépendre d'autres tâches du projet (`depends_on` de `create` et `update`) : tant qu'une de ses dépendances n'est pas terminée, elle est bloquée et ne peut pas être prise ni confiée à un agent ; termine d'abord ce qui la bloque.",
      `Statuts des tâches de ce projet (paramètre \`state\` de \`create\` et \`update\`, qui fixe la catégorie \`status\` ; une catégorie seule prend son statut par défaut) : ${describeStatusesForAgents(statuses)}. Un statut qui attend une personne (« à valider » par exemple) : passe-y la tâche quand ton travail est fait mais doit être vérifié par quelqu'un, plutôt que \`done\`, sauf consigne contraire. Si la vérification ne peut se faire qu'à une date ultérieure (mesure en production, relevé de la semaine), pose aussi une date de réveil (\`wake_at\`, \`wake_note\`) : la tâche reste « en attente » jusque-là au lieu d'apparaître « à traiter ».`,
      THREAD_HINT,
    ].join(' ');
    if (open.length === 0) return `${intro}\nAucune tâche ouverte pour le moment.`;
    // Liste plafonnée (relue à chaque tour) : tâches de la session, en cours, puis les plus prioritaires.
    const { shown, hidden } = promptTasks(open, sessionId);
    const lines = shown.map(
      (t) =>
        `- [${stateText(t, statuses)}${statusTagText(t)}, priorité ${priorityLabels[t.priority]}${sessionId && t.sessionIds.includes(sessionId) ? ', assignée à cette session' : t.sessionIds.length ? ', prise par une autre session' : ''}${t.assignee ? `, responsable ${formatPerson(t.assignee)}` : ''}${tagsText(t)}] ${t.title} (id ${t.id})${dependencyText(t)}`,
    );
    if (hidden.length) {
      const byPriority = [...TASK_PRIORITIES].reverse().map((p) => [p, hidden.filter((t) => t.priority === p).length] as const).filter(([, n]) => n > 0);
      lines.push(`… et ${hidden.length} autre(s) tâche(s) ouverte(s) (${byPriority.map(([p, n]) => `${n} de priorité ${priorityLabels[p]}`).join(', ')}) : \`tasks.list\` pour les voir.`);
    }
    return [intro, `Tâches ouvertes (${open.length}${hidden.length ? `, les ${shown.length} plus utiles ici` : ''}) :`, ...lines].join('\n');
  },

  /**
   * Paragraphe du prompt système d'une session reliée à des tâches : celles dont elle a la charge (identifiants, mode
   * d'emploi du fil, étiquette d'état) et celles auxquelles elle est simplement reliée (créées, mentionnée), dont
   * elle reçoit aussi les changements.
   */
  async linkedTaskPrompt(sessionId: string): Promise<string> {
    const tasks = await this.tasksInCharge(sessionId);
    const charged = new Set(tasks.map((t) => t.id));
    const others = (await taskRepository.listForSession(sessionId)).filter((t) => !charged.has(t.id) && t.status !== 'cancelled' && t.status !== 'done');
    if (!tasks.length && !others.length) return '';
    const statuses = await statusesByProject([...tasks, ...others].map((t) => t.projectId));
    const describe = (task: Task) => `${task.id} (« ${task.title} », ${stateText(task, statuses.get(task.projectId))}${statusTagText(task)}, priorité ${priorityLabels[task.priority]}${tagsText(task)})`;
    const lines: string[] = [];
    if (tasks.length === 1) {
      lines.push(`Cette session est en charge de la tâche ${describe(tasks[0])} : utilise cet identifiant avec les outils \`tasks\` (\`get\` la lit avec son fil de discussion, \`update\`, \`comment\`, \`react\`).`);
    } else if (tasks.length > 1) {
      lines.push(`Cette session est en charge de ${tasks.length} tâches : utilise leurs identifiants avec les outils \`tasks\` (\`get\`, \`update\`, \`comment\`, \`react\`) ; \`release\` rend une tâche que tu ne traites plus.`, ...tasks.map((t) => `- ${describe(t)}`));
    }
    if (others.length) lines.push(`Cette session est aussi reliée aux tâches : ${others.map((t) => `${t.id} (« ${t.title} », ${stateText(t, statuses.get(t.projectId))})`).join(' ; ')}.`);
    lines.push(
      "Quand quelqu'un d'autre modifie l'une de ces tâches ou écrit dans son fil, tu reçois un texte commençant par « [Mise à jour de la tâche] », « [Commentaire sur la tâche] » ou « [Réaction sur la tâche] » qui décrit le changement. Ce qui t'est adressé (message du fil d'une tâche dont tu es en charge ou qui te mentionne, modification par une personne d'une tâche dont tu es en charge) arrive comme une instruction : tiens-en compte, et réponds à un message avec `tasks.comment` (`reply_to` pour rester dans son fil) quand il appelle une réponse ; un simple accusé se fait avec `tasks.react`. Le reste arrive comme une note discrète, jointe au résultat d'un outil ou à l'instruction suivante : prends-la en compte sans en rendre compte, sauf si elle change ton travail.",
    );
    if (tasks.length) lines.push(STATUS_TAG_HINT, finishTaskHint(statuses.get(tasks[0].projectId)));
    return lines.join('\n');
  },

  /** Texte d'une tâche tel que transmis à un agent chargé de la réaliser (avec ses personnes, champs et son fil de discussion). */
  describeForPrompt(task: Task, comments: TaskComment[] = [], attachments: TaskAttachment[] = [], attached: AttachmentDelivery = 'none', reactions: TaskReaction[] = [], statuses: TaskStatusDefinition[] | null = null): string {
    const own = attachments.filter((a) => !a.commentId);
    const parts = [
      `Réalise la tâche suivante du projet (id ${task.id}, priorité ${priorityLabels[task.priority]}${task.dueDate ? `, échéance ${task.dueDate}` : ''}) :`,
      '',
      `# ${task.title}`,
      '',
      ...(task.summary ? [`Résumé : ${task.summary}`, ''] : []),
      task.description || '(pas de description)',
    ];
    if (own.length) parts.push('', ...describeAttachments(own, attached));
    if (task.assignee) parts.push('', `Responsable : ${formatPerson(task.assignee)}`);
    if (task.reporter) parts.push(task.assignee ? '' : '', `Rapporteur : ${formatPerson(task.reporter)}`);
    if (task.tags.length) parts.push('', `Étiquettes : ${task.tags.join(', ')}`);
    if (task.customFields.length) parts.push('', 'Champs personnalisés :', ...task.customFields.map((f) => `- ${f.key} : ${f.value}`));
    const own_reactions = reactions.filter((r) => !r.commentId);
    if (own_reactions.length) parts.push('', `Réactions sur la tâche : ${summarizeReactions(own_reactions)}`);
    if (comments.length) parts.push('', ...describeThread(comments, attachments, reactions, attached));
    parts.push(
      '',
      finishTaskInstruction(statuses),
      THREAD_HINT,
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
    const text = this.describeForPrompt({ ...task, status: 'in_progress' }, await taskRepository.listComments(id), kept, 'instruction', await taskRepository.listReactions(id), project.taskStatuses);
    const parts = [text];
    if (leftOut.length) parts.push('', `Non joints (au-delà des limites d'une instruction, lisibles dans l'interface) : ${leftOut.map(describeAttachment).join(', ')}.`);
    if (project.taskInstructions.trim()) parts.push('', '---', '', 'Consignes supplémentaires :', '', project.taskInstructions.trim());
    return parts.join('\n');
  },
};

/** « · bloquée par a, b · lancée automatiquement une fois débloquée » : dépendances d'une tâche pour un agent (vide sans dépendance). */
export function dependencyText(t: Pick<Task, 'dependsOnIds' | 'blockedByIds' | 'autoStartWhenUnblocked'>): string {
  if (!t.dependsOnIds.length) return '';
  if (!t.blockedByIds.length) return ` · dépendances terminées : ${t.dependsOnIds.join(', ')}`;
  return ` · bloquée par ${t.blockedByIds.join(', ')}${t.autoStartWhenUnblocked ? ' (lancée automatiquement une fois débloquée)' : ''}`;
}

/** « 👍 2 (Alice, Bob) · 🎉 1 (Session x) » */
export function summarizeReactions(reactions: TaskReaction[]): string {
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.actorName]);
  return [...byEmoji].map(([emoji, names]) => `${emoji} ${names.length} (${names.join(', ')})`).join(' · ');
}

/**
 * Un message du fil tel que montré à un agent : auteur, date, identifiant (pour y répondre ou y réagir), mentions
 * explicitées, texte, fichiers, réactions. `indent` : réponse dans un fil.
 */
export function describeComment(c: TaskComment, attachments: TaskAttachment[] = [], attached: AttachmentDelivery = 'none', opts: { reactions?: TaskReaction[]; indent?: string; replyTo?: TaskComment | null } = {}): string[] {
  const pad = opts.indent ?? '';
  const head = `${pad}- ${c.authorName}${c.authorType === 'agent' ? ' (agent)' : ''}, ${fmtDate(c.createdAt)} UTC (message ${c.id}${opts.replyTo ? `, en réponse à ${opts.replyTo.authorName}` : ''})${readableMentions(c)} :`;
  const body = [c.body || '(pas de texte)', ...describeAttachments(attachments, attached)];
  if (opts.reactions?.length) body.push(`Réactions : ${summarizeReactions(opts.reactions)}`);
  return [head, ...body.join('\n').split('\n').map((l) => `${pad}  ${l}`)];
}

/** Le fil complet d'une tâche pour un agent : messages racines dans l'ordre, leurs réponses indentées sous chacun. */
export function describeThread(comments: TaskComment[], attachments: TaskAttachment[] = [], reactions: TaskReaction[] = [], attached: AttachmentDelivery = 'none'): string[] {
  const roots = comments.filter((c) => !c.parentId || !comments.some((p) => p.id === c.parentId));
  const lines = ['Fil de discussion (du plus ancien au plus récent ; les réponses sont indentées sous leur message) :'];
  for (const root of roots) {
    lines.push(...describeComment(root, attachments.filter((a) => a.commentId === root.id), attached, { reactions: reactions.filter((r) => r.commentId === root.id) }));
    for (const reply of comments.filter((c) => c.parentId === root.id)) {
      lines.push(...describeComment(reply, attachments.filter((a) => a.commentId === reply.id), attached, { reactions: reactions.filter((r) => r.commentId === reply.id), indent: '    ', replyTo: root }));
    }
  }
  return lines;
}
