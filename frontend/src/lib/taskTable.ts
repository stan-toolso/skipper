import type { Task, TaskPriority, TaskStatus } from '../graphql/operations';

/**
 * Vue liste des tâches : définition des colonnes, disposition choisie par la personne (ordre, largeurs, colonnes
 * visibles, tri) mémorisée dans localStorage, filtres par colonne et tri. Tout est pur pour être testable ; le rendu
 * est dans components/TaskGrid.tsx.
 */

export type TaskColumnKey =
  | 'title'
  | 'project'
  | 'status'
  | 'statusTag'
  | 'priority'
  | 'tags'
  | 'assignee'
  | 'reporter'
  | 'dueDate'
  | 'session'
  | 'worksession'
  | 'pullRequest'
  | 'comments'
  | 'attachments'
  | 'createdBy'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
  | 'actions';

export type ColumnFilter = { kind: 'text' } | { kind: 'select'; options: { value: string; label: string }[] };

export interface TaskColumn {
  key: TaskColumnKey;
  label: string;
  /** Largeur par défaut en pixels. */
  width: number;
  minWidth: number;
  /** Affichée tant que la personne n'a pas choisi ses colonnes. */
  defaultVisible: boolean;
  sortable: boolean;
  filter: ColumnFilter | null;
  align?: 'end';
  /** Colonne toujours présente et toujours en dernier (actions) : ni masquable ni déplaçable. */
  pinned?: boolean;
}

export const STATUS_LABELS: Record<TaskStatus, string> = { TODO: 'À faire', IN_PROGRESS: 'En cours', DONE: 'Terminée', CANCELLED: 'Annulée' };
export const PRIORITY_LABELS: Record<TaskPriority, string> = { URGENT: 'Urgente', HIGH: 'Haute', MEDIUM: 'Moyenne', LOW: 'Basse' };
const STATUS_ORDER: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const PRIORITY_ORDER: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

export const DUE_FILTER_OPTIONS = [
  { value: 'overdue', label: 'En retard' },
  { value: 'week', label: 'Sous 7 jours' },
  { value: 'set', label: 'Avec échéance' },
  { value: 'none', label: 'Sans échéance' },
];

export const TASK_COLUMNS: TaskColumn[] = [
  { key: 'title', label: 'Titre', width: 280, minWidth: 140, defaultVisible: true, sortable: true, filter: { kind: 'text' } },
  { key: 'project', label: 'Projet', width: 105, minWidth: 70, defaultVisible: true, sortable: true, filter: { kind: 'select', options: [] } },
  { key: 'status', label: 'Statut', width: 125, minWidth: 80, defaultVisible: true, sortable: true, filter: { kind: 'select', options: STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] })) } },
  { key: 'statusTag', label: 'État', width: 110, minWidth: 70, defaultVisible: false, sortable: true, filter: { kind: 'text' } },
  { key: 'priority', label: 'Priorité', width: 92, minWidth: 60, defaultVisible: true, sortable: true, filter: { kind: 'select', options: PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })) } },
  { key: 'tags', label: 'Étiquettes', width: 125, minWidth: 70, defaultVisible: true, sortable: true, filter: { kind: 'text' } },
  { key: 'assignee', label: 'Responsable', width: 115, minWidth: 70, defaultVisible: true, sortable: true, filter: { kind: 'text' } },
  { key: 'reporter', label: 'Rapporteur', width: 130, minWidth: 70, defaultVisible: false, sortable: true, filter: { kind: 'text' } },
  { key: 'dueDate', label: 'Échéance', width: 100, minWidth: 80, defaultVisible: true, sortable: true, filter: { kind: 'select', options: DUE_FILTER_OPTIONS } },
  { key: 'session', label: 'Session', width: 160, minWidth: 80, defaultVisible: false, sortable: true, filter: { kind: 'text' } },
  { key: 'worksession', label: 'Work session', width: 160, minWidth: 80, defaultVisible: false, sortable: true, filter: { kind: 'text' } },
  { key: 'pullRequest', label: 'PR', width: 96, minWidth: 60, defaultVisible: true, sortable: true, filter: { kind: 'text' } },
  { key: 'comments', label: 'Comm.', width: 76, minWidth: 50, defaultVisible: true, sortable: true, filter: null, align: 'end' },
  { key: 'attachments', label: 'Fichiers', width: 70, minWidth: 50, defaultVisible: false, sortable: true, filter: null, align: 'end' },
  {
    key: 'createdBy',
    label: 'Origine',
    width: 90,
    minWidth: 60,
    defaultVisible: false,
    sortable: true,
    filter: {
      kind: 'select',
      options: [
        { value: 'human', label: 'Humain' },
        { value: 'agent', label: 'Agent' },
      ],
    },
  },
  { key: 'createdAt', label: 'Créée', width: 100, minWidth: 70, defaultVisible: false, sortable: true, filter: null },
  { key: 'updatedAt', label: 'Mise à jour', width: 112, minWidth: 70, defaultVisible: true, sortable: true, filter: null },
  { key: 'completedAt', label: 'Terminée le', width: 110, minWidth: 70, defaultVisible: false, sortable: true, filter: null },
  { key: 'actions', label: 'Actions', width: 122, minWidth: 90, defaultVisible: true, sortable: false, filter: null, pinned: true },
];

export const COLUMN_BY_KEY: Record<TaskColumnKey, TaskColumn> = Object.fromEntries(TASK_COLUMNS.map((c) => [c.key, c])) as Record<TaskColumnKey, TaskColumn>;
const ALL_KEYS = TASK_COLUMNS.map((c) => c.key);
const isKey = (k: unknown): k is TaskColumnKey => typeof k === 'string' && (ALL_KEYS as string[]).includes(k);

export type SortDir = 'asc' | 'desc';
export interface TaskTableLayout {
  /** Ordre des colonnes, toutes présentes (les masquées aussi) ; la colonne épinglée est toujours en dernier. */
  order: TaskColumnKey[];
  hidden: TaskColumnKey[];
  /** Largeurs choisies à la souris ; une colonne absente garde sa largeur par défaut. */
  widths: Partial<Record<TaskColumnKey, number>>;
  sort: { key: TaskColumnKey; dir: SortDir };
}

export const DEFAULT_SORT: TaskTableLayout['sort'] = { key: 'createdAt', dir: 'desc' };
export const LAYOUT_KEY = 'skipper.tasks.table.v1';

export function defaultLayout(): TaskTableLayout {
  return { order: [...ALL_KEYS], hidden: TASK_COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.key), widths: {}, sort: { ...DEFAULT_SORT } };
}

/** Remet d'aplomb une disposition lue du stockage : colonnes inconnues ignorées, nouvelles colonnes ajoutées, épinglée en dernier. */
export function normalizeLayout(raw: unknown): TaskTableLayout {
  const base = defaultLayout();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<Record<keyof TaskTableLayout, unknown>>;
  const order = Array.isArray(r.order) ? r.order.filter(isKey) : [];
  const seen = new Set<TaskColumnKey>();
  const cleanOrder: TaskColumnKey[] = [];
  for (const k of order) {
    if (!seen.has(k) && !COLUMN_BY_KEY[k].pinned) {
      seen.add(k);
      cleanOrder.push(k);
    }
  }
  // Une nouvelle colonne apparaît à sa place par défaut (juste après la colonne connue qui la précède).
  for (let i = 0; i < ALL_KEYS.length; i++) {
    const k = ALL_KEYS[i];
    if (seen.has(k) || COLUMN_BY_KEY[k].pinned) continue;
    const prev = ALL_KEYS.slice(0, i).reverse().find((p) => seen.has(p));
    const at = prev ? cleanOrder.indexOf(prev) + 1 : 0;
    cleanOrder.splice(at, 0, k);
    seen.add(k);
  }
  cleanOrder.push(...ALL_KEYS.filter((k) => COLUMN_BY_KEY[k].pinned));
  // Les colonnes nouvelles depuis l'enregistrement suivent leur visibilité par défaut.
  const known = new Set(order);
  const hiddenRaw = Array.isArray(r.hidden) ? r.hidden.filter(isKey) : [];
  const hidden = ALL_KEYS.filter((k) => !COLUMN_BY_KEY[k].pinned && (known.has(k) ? hiddenRaw.includes(k) : !COLUMN_BY_KEY[k].defaultVisible));
  const widths: TaskTableLayout['widths'] = {};
  if (r.widths && typeof r.widths === 'object') {
    for (const [k, v] of Object.entries(r.widths as Record<string, unknown>)) {
      if (isKey(k) && typeof v === 'number' && Number.isFinite(v)) widths[k] = clampWidth(k, v);
    }
  }
  const s = r.sort as { key?: unknown; dir?: unknown } | undefined;
  const sort: TaskTableLayout['sort'] = s && isKey(s.key) && COLUMN_BY_KEY[s.key].sortable ? { key: s.key, dir: s.dir === 'asc' ? 'asc' : 'desc' } : { ...DEFAULT_SORT };
  return { order: cleanOrder, hidden, widths, sort };
}

export function clampWidth(key: TaskColumnKey, width: number): number {
  return Math.round(Math.min(1200, Math.max(COLUMN_BY_KEY[key].minWidth, width)));
}

export function loadLayout(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): TaskTableLayout {
  try {
    const raw = storage?.getItem(LAYOUT_KEY);
    return normalizeLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(layout: TaskTableLayout, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* stockage indisponible : la disposition vaut pour la page courante */
  }
}

/** Déplace la colonne `key` juste avant `before` (ou en fin, avant l'épinglée, si `before` est absent). */
export function moveColumn(order: TaskColumnKey[], key: TaskColumnKey, before: TaskColumnKey | null): TaskColumnKey[] {
  if (COLUMN_BY_KEY[key].pinned || key === before) return order;
  const rest = order.filter((k) => k !== key);
  const pinnedAt = rest.findIndex((k) => COLUMN_BY_KEY[k].pinned);
  let at = before ? rest.indexOf(before) : -1;
  if (at < 0 || (pinnedAt >= 0 && at > pinnedAt)) at = pinnedAt >= 0 ? pinnedAt : rest.length;
  rest.splice(at, 0, key);
  return rest;
}

/** Décale une colonne d'un cran (flèches du choix des colonnes). */
export function shiftColumn(order: TaskColumnKey[], key: TaskColumnKey, delta: -1 | 1): TaskColumnKey[] {
  const i = order.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length || COLUMN_BY_KEY[key].pinned || COLUMN_BY_KEY[order[j]].pinned) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function visibleColumns(layout: TaskTableLayout, available: (key: TaskColumnKey) => boolean = () => true): TaskColumn[] {
  return layout.order.filter((k) => !layout.hidden.includes(k) && available(k)).map((k) => COLUMN_BY_KEY[k]);
}

/** Texte de la cellule, tel qu'on le lit : c'est sur lui que portent les filtres texte. */
export function cellText(t: Task, key: TaskColumnKey): string {
  switch (key) {
    case 'title':
      return t.title;
    case 'project':
      return t.project.name;
    case 'status':
      return STATUS_LABELS[t.status];
    case 'statusTag':
      return t.statusTag ?? '';
    case 'priority':
      return PRIORITY_LABELS[t.priority];
    case 'tags':
      return t.tags.join(' ');
    case 'assignee':
      return personText(t.assignee);
    case 'reporter':
      return personText(t.reporter);
    case 'dueDate':
      return t.dueDate ?? '';
    case 'session':
      return t.session?.name ?? '';
    case 'worksession':
      return t.worksession?.label ?? t.branch ?? '';
    case 'pullRequest':
      return t.pullRequest ? `#${t.pullRequest.number} ${t.pullRequest.title}` : '';
    case 'comments':
      return t.commentCount ? String(t.commentCount) : '';
    case 'attachments':
      return t.attachmentCount ? String(t.attachmentCount) : '';
    case 'createdBy':
      return t.createdByType === 'agent' ? 'Agent' : 'Humain';
    case 'createdAt':
      return t.createdAt;
    case 'updatedAt':
      return t.updatedAt;
    case 'completedAt':
      return t.completedAt ?? '';
    case 'actions':
      return '';
  }
}

const personText = (p: { name: string | null; email: string | null } | null): string => [p?.name, p?.email].filter(Boolean).join(' ');

export type TaskFilters = Partial<Record<TaskColumnKey, string>>;

/** Date du jour en AAAA-MM-JJ (heure locale), pour les filtres d'échéance. */
export const todayIso = (now = new Date()): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const isOpen = (t: Task) => t.status !== 'DONE' && t.status !== 'CANCELLED';

export function matchesFilter(t: Task, key: TaskColumnKey, value: string, now = new Date()): boolean {
  const v = value.trim();
  if (!v) return true;
  switch (key) {
    case 'status':
      return t.status === v;
    case 'priority':
      return t.priority === v;
    case 'createdBy':
      return t.createdByType === v;
    case 'project':
      return t.project.id === v;
    case 'dueDate': {
      const today = todayIso(now);
      if (v === 'none') return !t.dueDate;
      if (!t.dueDate) return false;
      if (v === 'set') return true;
      if (v === 'overdue') return isOpen(t) && t.dueDate < today;
      if (v === 'week') {
        const limit = new Date(now);
        limit.setDate(limit.getDate() + 7);
        return t.dueDate <= todayIso(limit);
      }
      return true;
    }
    default: {
      const needle = fold(v);
      if (key === 'tags') return t.tags.some((tag) => fold(tag).includes(needle));
      return fold(cellText(t, key)).includes(needle);
    }
  }
}

/** Minuscules sans accents : « Échéance » et « echeance » se trouvent. */
export const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export function applyFilters(tasks: Task[], filters: TaskFilters, now = new Date()): Task[] {
  const active = (Object.entries(filters) as [TaskColumnKey, string | undefined][]).filter((e): e is [TaskColumnKey, string] => Boolean(e[1]?.trim()));
  if (active.length === 0) return tasks;
  return tasks.filter((t) => active.every(([k, v]) => matchesFilter(t, k, v, now)));
}

const END = '￿';
/** Valeur de tri : les vides vont toujours en fin, quel que soit le sens. */
export function sortValue(t: Task, key: TaskColumnKey): string | number | null {
  switch (key) {
    case 'title':
      return fold(t.title);
    case 'project':
      return fold(t.project.name);
    case 'status':
      return STATUS_ORDER.indexOf(t.status);
    case 'statusTag':
      return t.statusTag ? fold(t.statusTag) : null;
    case 'priority':
      return PRIORITY_ORDER.indexOf(t.priority);
    case 'tags':
      return t.tags.length ? fold(t.tags.join(' ')) : null;
    case 'assignee':
      return t.assignee ? fold(personText(t.assignee)) : null;
    case 'reporter':
      return t.reporter ? fold(personText(t.reporter)) : null;
    case 'dueDate':
      return t.dueDate ?? null;
    case 'session':
      return t.session ? fold(t.session.name) : null;
    case 'worksession':
      return t.worksession ? fold(t.worksession.label) : t.branch ? fold(t.branch) : null;
    case 'pullRequest':
      return t.pullRequest ? t.pullRequest.number : null;
    case 'comments':
      return t.commentCount;
    case 'attachments':
      return t.attachmentCount;
    case 'createdBy':
      return t.createdByType;
    case 'createdAt':
      return new Date(t.createdAt).getTime();
    case 'updatedAt':
      return new Date(t.updatedAt).getTime();
    case 'completedAt':
      return t.completedAt ? new Date(t.completedAt).getTime() : null;
    case 'actions':
      return END;
  }
}

export function sortTasks(tasks: Task[], sort: TaskTableLayout['sort']): Task[] {
  const list = tasks.map((t, i) => ({ t, i, v: sortValue(t, sort.key) }));
  const sign = sort.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    const cmp = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    return cmp !== 0 ? cmp * sign : a.i - b.i;
  });
  return list.map((x) => x.t);
}
