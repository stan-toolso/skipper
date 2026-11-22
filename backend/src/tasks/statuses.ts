import { AppError } from '../errors.js';
import { TASK_STATUSES, type TaskStatus } from './types.js';

/**
 * Statuts de tâches d'un projet. Chaque projet choisit les siens (nombre, libellés, ordre) ; chacun appartient à une
 * **catégorie** (`todo`, `in_progress`, `done`, `cancelled`, la colonne `tasks.status`) qui porte tout le sens que
 * Skipper en tire : tâche ouverte ou fermée, bloquante pour ses dépendantes, prise par une session, dates de cycle,
 * « agent arrêté »… Le statut lui-même (`tasks.state`, une clé) n'est qu'une étape plus fine dans la catégorie.
 *
 * Règles : au moins un statut par catégorie (Skipper doit pouvoir créer, prendre, terminer et annuler une tâche), clés
 * uniques. Le statut par défaut d'une catégorie (celui que prend une tâche qui y entre sans statut précis : création,
 * `claim`, passage à `done`…) est celui marqué `isDefault`, sinon le premier de la catégorie.
 *
 * `attention` : le statut attend une personne (trier, valider) : la tâche est rangée dans « À traiter » et, en cours,
 * n'est pas signalée « agent arrêté » faute de session au travail.
 */
export interface TaskStatusDefinition {
  key: string;
  label: string;
  category: TaskStatus;
  /** Ce que veut dire le statut (montré dans l'interface et aux agents) ; null : rien. */
  description: string | null;
  attention: boolean;
  isDefault: boolean;
}

export const DEFAULT_TASK_STATUSES: TaskStatusDefinition[] = [
  { key: 'triage', label: 'À trier', category: 'todo', description: 'Demandes reçues, pas encore qualifiées : à préciser, prioriser ou refuser avant d’être prêtes', attention: true, isDefault: false },
  { key: 'todo', label: 'À faire', category: 'todo', description: 'Prêtes à être confiées à un agent', attention: false, isDefault: true },
  { key: 'in_progress', label: 'En cours', category: 'in_progress', description: 'Un agent ou une personne y travaille', attention: false, isDefault: true },
  { key: 'review', label: 'À valider', category: 'in_progress', description: 'Le travail est fait : une personne doit le vérifier avant de terminer la tâche', attention: true, isDefault: false },
  { key: 'done', label: 'Terminée', category: 'done', description: null, attention: false, isDefault: true },
  { key: 'cancelled', label: 'Annulée', category: 'cancelled', description: null, attention: false, isDefault: true },
];

export const MAX_TASK_STATUSES = 20;
const LABEL_MAX = 40;
const DESCRIPTION_MAX = 300;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Clé dérivée d'un libellé : minuscules sans accents, tirets bas. */
export function statusKeyOf(label: string): string {
  return (
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'statut'
  );
}

export interface TaskStatusInput {
  key?: string | null;
  label: string;
  category: TaskStatus;
  description?: string | null;
  attention?: boolean | null;
  isDefault?: boolean | null;
}

/**
 * Valide et normalise la liste choisie pour un projet (ordre gardé). Sans clé, un statut reçoit celle de son libellé
 * (rendue unique). Un seul statut par défaut par catégorie (le premier marqué l'emporte, sinon le premier de la catégorie).
 */
export function normalizeTaskStatuses(input: TaskStatusInput[]): TaskStatusDefinition[] {
  if (!Array.isArray(input) || input.length === 0) throw new AppError('Au moins un statut par catégorie est nécessaire');
  if (input.length > MAX_TASK_STATUSES) throw new AppError(`Au plus ${MAX_TASK_STATUSES} statuts de tâches par projet`);
  const keys = new Set<string>();
  const out: TaskStatusDefinition[] = [];
  for (const s of input) {
    const label = (s.label ?? '').trim();
    if (!label) throw new AppError('Chaque statut a besoin d’un libellé');
    if (label.length > LABEL_MAX) throw new AppError(`Libellé de statut trop long (${LABEL_MAX} caractères au plus) : « ${label} »`);
    if (!TASK_STATUSES.includes(s.category)) throw new AppError(`Catégorie de statut invalide : ${s.category}`);
    let key = s.key?.trim().toLowerCase() || '';
    if (key) {
      if (!KEY_RE.test(key)) throw new AppError(`Clé de statut invalide : « ${key} » (minuscules, chiffres, - et _)`);
      if (keys.has(key)) throw new AppError(`Deux statuts ont la même clé : « ${key} »`);
    } else {
      const base = statusKeyOf(label);
      key = base;
      for (let i = 2; keys.has(key) || input.some((o) => o !== s && o.key?.trim().toLowerCase() === key); i++) key = `${base}_${i}`;
    }
    keys.add(key);
    const description = s.description?.trim() || null;
    if (description && description.length > DESCRIPTION_MAX) throw new AppError(`Description du statut « ${label} » trop longue (${DESCRIPTION_MAX} caractères au plus)`);
    out.push({ key, label, category: s.category, description, attention: Boolean(s.attention), isDefault: Boolean(s.isDefault) });
  }
  const labels = new Set<string>();
  for (const s of out) {
    const l = s.label.toLowerCase();
    if (labels.has(l)) throw new AppError(`Deux statuts ont le même libellé : « ${s.label} »`);
    labels.add(l);
  }
  for (const category of TASK_STATUSES) {
    const inCategory = out.filter((s) => s.category === category);
    if (!inCategory.length) throw new AppError(`Il faut au moins un statut dans la catégorie « ${CATEGORY_LABELS[category]} »`);
    const chosen = inCategory.find((s) => s.isDefault) ?? inCategory[0];
    for (const s of inCategory) s.isDefault = s === chosen;
  }
  return out;
}

/** Libellés des catégories (réglages, messages d'erreur). */
export const CATEGORY_LABELS: Record<TaskStatus, string> = { todo: 'À faire', in_progress: 'En cours', done: 'Terminée', cancelled: 'Annulée' };

/** Statuts d'un projet d'après sa colonne `task_statuses` (null ou illisible : les statuts par défaut). */
export function projectTaskStatuses(raw: unknown): TaskStatusDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TASK_STATUSES;
  try {
    return normalizeTaskStatuses(raw as TaskStatusInput[]);
  } catch {
    return DEFAULT_TASK_STATUSES;
  }
}

/** Liste à utiliser : celle donnée, sinon (absente : projet incomplet, test) les statuts par défaut. */
const listOf = (statuses: TaskStatusDefinition[] | null | undefined): TaskStatusDefinition[] => (statuses?.length ? statuses : DEFAULT_TASK_STATUSES);

/** Statut par défaut d'une catégorie. */
export function defaultStatusOf(statuses: TaskStatusDefinition[] | null | undefined, category: TaskStatus): TaskStatusDefinition {
  statuses = listOf(statuses);
  return statuses.find((s) => s.category === category && s.isDefault) ?? statuses.find((s) => s.category === category) ?? DEFAULT_TASK_STATUSES.find((s) => s.category === category && s.isDefault)!;
}

/** Statut effectif d'une tâche : le sien s'il existe encore dans sa catégorie, sinon le statut par défaut de la catégorie. */
export function effectiveStatus(statuses: TaskStatusDefinition[] | null | undefined, task: { status: TaskStatus; state: string | null }): TaskStatusDefinition {
  statuses = listOf(statuses);
  const own = task.state ? statuses.find((s) => s.key === task.state) : undefined;
  return own && own.category === task.status ? own : defaultStatusOf(statuses, task.status);
}

/** Retrouve un statut du projet par sa clé ou son libellé (sans tenir compte de la casse ni des accents). */
export function findStatus(statuses: TaskStatusDefinition[] | null | undefined, keyOrLabel: string): TaskStatusDefinition | undefined {
  statuses = listOf(statuses);
  const wanted = keyOrLabel.trim().toLowerCase();
  const folded = statusKeyOf(keyOrLabel);
  return statuses.find((s) => s.key === wanted) ?? statuses.find((s) => s.label.toLowerCase() === wanted) ?? statuses.find((s) => statusKeyOf(s.label) === folded);
}

/**
 * Catégorie et statut à écrire pour une entrée qui donne un statut (`state`), une catégorie (`status`), les deux ou
 * aucun. Un statut précis l'emporte et fixe la catégorie (refusé s'il contredit la catégorie donnée) ; une catégorie
 * seule prend son statut par défaut, sauf si la tâche y est déjà (son statut est gardé). Rien : null (inchangé).
 */
export function resolveTaskState(
  statuses: TaskStatusDefinition[] | null | undefined,
  input: { status?: TaskStatus | null; state?: string | null },
  current: { status: TaskStatus; state: string | null } | null,
): { status: TaskStatus; state: string } | null {
  statuses = listOf(statuses);
  if (input.state != null && input.state.trim() !== '') {
    const def = findStatus(statuses, input.state);
    if (!def) throw new AppError(`Statut inconnu dans ce projet : « ${input.state} ». Statuts possibles : ${statuses.map((s) => `${s.key} (${s.label})`).join(', ')}`);
    if (input.status != null && input.status !== def.category) throw new AppError(`Le statut « ${def.label} » appartient à la catégorie ${def.category}, pas ${input.status}`);
    return { status: def.category, state: def.key };
  }
  if (input.status != null) {
    if (current && current.status === input.status) return { status: input.status, state: effectiveStatus(statuses, current).key };
    return { status: input.status, state: defaultStatusOf(statuses, input.status).key };
  }
  return null;
}

/** Statuts du projet présentés aux agents (prompt, description des outils). */
export function describeStatusesForAgents(statuses: TaskStatusDefinition[] | null | undefined): string {
  return listOf(statuses)
    .map((s) => `\`${s.key}\` « ${s.label} » (catégorie ${s.category}${s.isDefault ? ', par défaut' : ''}${s.attention ? ', attend une personne' : ''})${s.description ? ` : ${s.description}` : ''}`)
    .join(' ; ');
}

/** Les statuts sont-ils ceux par défaut (même liste, mêmes réglages) ? */
export function isDefaultStatuses(statuses: TaskStatusDefinition[]): boolean {
  return JSON.stringify(statuses) === JSON.stringify(DEFAULT_TASK_STATUSES);
}
