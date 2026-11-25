import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import type { Task } from '../graphql/operations';
import { formatCost, timeAgo } from '../lib/humanize';
import { groupTasks, GROUP_BY_OPTIONS, laneCounts, LANES, matchesSearch, placeTask, RECENT_DAYS, type GroupBy, type TaskGroup, type TaskLane } from '../lib/taskGroups';
import {
  applyFilters,
  cellText,
  clampWidth,
  COLUMN_BY_KEY,
  defaultLayout,
  loadLayout,
  moveColumn,
  saveLayout,
  shiftColumn,
  sortTasks,
  TASK_COLUMNS,
  visibleColumns,
  type SortDir,
  type TaskColumn,
  type TaskColumnKey,
  type TaskFilters,
  type TaskTableLayout,
} from '../lib/taskTable';
import { PullRequestChip } from './PullRequests';
import { TrackedPullRequestChip } from './TrackedPullRequests';
import TaskActions from './TaskActions';
import { formatPerson, isOverdue, TaskWakeDate, TaskBlockedBadge, TaskStalledBadge, TaskWaitingBadge, TaskPriorityBadge, TaskStatusBadge, TaskTags } from './TaskBadges';
import type { LaunchTarget } from './TaskLaunchModal';

export interface TaskGridProps {
  tasks: Task[];
  /** Sans projet imposé (toutes les tâches) : la colonne Projet existe et son filtre choisit le projet. */
  showProject: boolean;
  projects: { id: string; name: string }[];
  filters: TaskFilters;
  onFilterChange: (key: TaskColumnKey, value: string) => void;
  onClearFilters: () => void;
  /** Recherche libre de la barre d'outils (titre, description, étiquettes…), appliquée ici. */
  search: string;
  /** Historique (tâches fermées) : groupes dépliés, pas de « terminées récemment ». */
  history: boolean;
  onEdit: (t: Task) => void;
  onTag: (tag: string) => void;
  targets: Map<string, LaunchTarget>;
  /**
   * Terminées récemment pas chargées (non null) : leur nombre. Leur groupe n'a alors que son en-tête et son compteur ;
   * le déplier, chercher, filtrer, les isoler ou grouper autrement les demande (`onDoneWanted`).
   */
  doneCount?: number | null;
  onDoneWanted?: (wanted: boolean) => void;
}

const GROUP_BY_KEY = 'skipper.tasks.groupBy';
const COLLAPSED_KEY = 'skipper.tasks.collapsed.v1';
/** Lignes rendues d'emblée par groupe : au-delà, « Afficher les suivantes » (la page reste fluide avec des centaines de tâches). */
const PAGE = 40;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible */
  }
}

/**
 * Vue liste des tâches, rangée par ce qui est attendu (lib/taskGroups.ts) : à traiter, en cours, en attente, à faire,
 * bloquées, terminées récemment (repliées). Un bandeau compte chaque groupe et permet de n'en montrer qu'un ; on peut
 * grouper autrement (priorité, projet, responsable) ou pas du tout. Dans les groupes, une ligne par tâche, toujours sur
 * une seule ligne ; les colonnes se réordonnent, se redimensionnent, se trient (un troisième clic revient à l'ordre
 * par pertinence) et se choisissent ; la ligne de filtres par colonne s'ouvre avec « Filtres ». La disposition est
 * mémorisée dans localStorage (lib/taskTable.ts).
 */
export default function TaskGrid({ tasks, showProject, projects, filters, onFilterChange, onClearFilters, search, history, onEdit, onTag, targets, doneCount = null, onDoneWanted }: TaskGridProps) {
  const [layout, setLayout] = useState<TaskTableLayout>(() => loadLayout());
  useEffect(() => saveLayout(layout), [layout]);
  const [groupBy, setGroupByState] = useState<GroupBy>(() => {
    const v = readJson<string>(GROUP_BY_KEY, 'lane');
    return GROUP_BY_OPTIONS.some((o) => o.value === v) ? (v as GroupBy) : 'lane';
  });
  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    writeJson(GROUP_BY_KEY, g);
  };
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(() => readJson(COLLAPSED_KEY, {}));
  const [focus, setFocus] = useState<TaskLane | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});
  const filtering = Object.values(filters).some((v) => v && v.trim());
  const [showFilters, setShowFilters] = useState(filtering);
  useEffect(() => {
    if (filtering) setShowFilters(true);
  }, [filtering]);

  const available = useCallback((k: TaskColumnKey) => k !== 'project' || showProject, [showProject]);
  const cols = useMemo(() => visibleColumns(layout, available), [layout, available]);
  const effectiveGroupBy: GroupBy = groupBy === 'project' && !showProject ? 'lane' : groupBy;
  const placements = useMemo(() => {
    const now = new Date();
    return new Map(tasks.map((t) => [t.id, placeTask(t, now)]));
  }, [tasks]);
  const matching = useMemo(() => applyFilters(tasks, filters).filter((t) => matchesSearch(t, search)), [tasks, filters, search]);
  const counts = useMemo(() => {
    const c = laneCounts(matching, placements);
    return doneCount != null ? { ...c, done: c.done + doneCount } : c;
  }, [matching, placements, doneCount]);
  const sort = layout.sort;
  const groups = useMemo(() => {
    const list = focus ? matching.filter((t) => placements.get(t.id)?.lane === focus) : matching;
    const out = groupTasks(list, effectiveGroupBy, placements, sort ? (l) => sortTasks(l, sort) : null);
    // Terminées pas encore chargées : leur groupe (en-tête seul) à sa place, avant les annulées.
    if (effectiveGroupBy === 'lane' && doneCount && !out.some((g) => g.lane === 'done') && (!focus || focus === 'done')) {
      const l = LANES.find((x) => x.key === 'done')!;
      const at = out.findIndex((g) => g.lane === 'cancelled');
      out.splice(at < 0 ? out.length : at, 0, { key: l.key, label: l.label, hint: l.hint, tone: l.tone, lane: 'done', tasks: [] });
    }
    return out;
  }, [matching, placements, focus, effectiveGroupBy, sort, doneCount]);
  const shown = groups.reduce((n, g) => n + g.tasks.length, 0);
  const totalWidth = cols.reduce((sum, c) => sum + (layout.widths[c.key] ?? c.width), 0);
  const narrowed = filtering || search.trim() !== '' || focus !== null;

  const isCollapsed = (g: TaskGroup) => {
    if (focus) return false;
    const v = collapsedMap[g.key];
    if (v !== undefined) return v;
    return !history && (g.lane === 'done' || g.lane === 'cancelled');
  };
  // Les terminées récemment sont chargées à la demande : groupe déplié ou isolé, recherche, filtre de colonne, autre groupement.
  const columnFiltering = Object.entries(filters).some(([k, v]) => k !== 'project' && v && v.trim());
  const doneWanted = history || effectiveGroupBy !== 'lane' || focus === 'done' || columnFiltering || search.trim() !== '' || !isCollapsed({ key: 'done', label: '', lane: 'done', tasks: [] });
  useEffect(() => onDoneWanted?.(doneWanted), [doneWanted, onDoneWanted]);
  const toggleGroup = (g: TaskGroup) =>
    setCollapsedMap((m) => {
      const next = { ...m, [g.key]: !isCollapsed(g) };
      writeJson(COLLAPSED_KEY, next);
      return next;
    });

  // Clic sur un en-tête : croissant, décroissant (ou l'inverse pour les dates et nombres), puis retour à la pertinence.
  const toggleSort = (key: TaskColumnKey) =>
    setLayout((l) => {
      const first: SortDir = key === 'createdAt' || key === 'updatedAt' || key === 'completedAt' || key === 'comments' || key === 'cost' ? 'desc' : 'asc';
      if (!l.sort || l.sort.key !== key) return { ...l, sort: { key, dir: first } };
      if (l.sort.dir === first) return { ...l, sort: { key, dir: first === 'asc' ? 'desc' : 'asc' } };
      return { ...l, sort: null };
    });
  const setWidth = (key: TaskColumnKey, width: number | null) =>
    setLayout((l) => {
      const widths = { ...l.widths };
      if (width === null) delete widths[key];
      else widths[key] = clampWidth(key, width);
      return { ...l, widths };
    });
  const toggleHidden = (key: TaskColumnKey) => setLayout((l) => ({ ...l, hidden: l.hidden.includes(key) ? l.hidden.filter((k) => k !== key) : [...l.hidden, key] }));

  // Réordonnancement par glisser-déposer des en-têtes (HTML5 : souris et pavé tactile ; au doigt, les flèches du menu).
  const [dragging, setDragging] = useState<TaskColumnKey | null>(null);
  const [dropAt, setDropAt] = useState<TaskColumnKey | null>(null);
  const drop = (before: TaskColumnKey) => {
    if (dragging) setLayout((l) => ({ ...l, order: moveColumn(l.order, dragging, before) }));
    setDragging(null);
    setDropAt(null);
  };

  const [chooser, setChooser] = useState(false);
  const summaryLanes = LANES.filter((l) => counts[l.key] > 0 || (!history && (l.key === 'attention' || l.key === 'active' || l.key === 'ready')));

  return (
    <div className="task-grid-root">
      <div className="task-lanes" role="toolbar" aria-label="Où en sont les tâches">
        {summaryLanes.map((l) => (
          <button
            key={l.key}
            type="button"
            className={`task-lane-chip${focus === l.key ? ' on' : ''}${counts[l.key] === 0 ? ' empty' : ''}`}
            style={{ '--lane-tone': l.tone } as CSSProperties}
            title={focus === l.key ? 'Montrer tous les groupes' : `${l.hint || l.label} : ne montrer que ce groupe`}
            aria-pressed={focus === l.key}
            disabled={counts[l.key] === 0 && focus !== l.key}
            onClick={() => setFocus((f) => (f === l.key ? null : l.key))}
          >
            <span className="task-lane-dot" />
            <span className="task-lane-count">{counts[l.key]}</span>
            <span className="task-lane-label">{l.key === 'done' && !history ? `terminées · ${RECENT_DAYS} j` : l.label.toLowerCase()}</span>
          </button>
        ))}
      </div>
      <div className="task-grid-bar">
        <span className="text-secondary small">
          {narrowed ? `${shown} sur ${tasks.length} tâche${tasks.length > 1 ? 's' : ''}` : `${tasks.length} tâche${tasks.length > 1 ? 's' : ''}`}
        </span>
        {(filtering || focus) && (
          <Button
            size="sm"
            variant="link"
            className="p-0 small"
            onClick={() => {
              setFocus(null);
              onClearFilters();
            }}
          >
            <i className="bi bi-x-circle me-1" />
            Tout montrer
          </Button>
        )}
        <div className="d-flex align-items-center gap-2 ms-auto">
          <Form.Select size="sm" className="task-grid-groupby" value={effectiveGroupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Grouper par" title="Grouper par">
            {GROUP_BY_OPTIONS.filter((o) => o.value !== 'project' || showProject).map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === 'none' ? o.label : `Grouper : ${o.label.toLowerCase()}`}
              </option>
            ))}
          </Form.Select>
          <Button size="sm" variant={showFilters ? 'secondary' : 'outline-secondary'} title="Filtrer colonne par colonne" aria-pressed={showFilters} onClick={() => setShowFilters((v) => !v)}>
            <i className="bi bi-funnel" />
            <span className="d-none d-md-inline ms-1">Filtres</span>
            {filtering && <span className="task-grid-dot" />}
          </Button>
          <div className="position-relative">
            <Button
              size="sm"
              variant="outline-secondary"
              title="Choisir et ordonner les colonnes"
              onClick={(e) => {
                e.stopPropagation();
                setChooser((v) => !v);
              }}
              aria-expanded={chooser}
            >
              <i className="bi bi-layout-three-columns" />
              <span className="d-none d-md-inline ms-1">Colonnes</span>
            </Button>
            {chooser && (
              <ColumnChooser
                layout={layout}
                available={available}
                onToggle={toggleHidden}
                onShift={(key, delta) => setLayout((l) => ({ ...l, order: shiftColumn(l.order, key, delta) }))}
                onReset={() => setLayout(defaultLayout())}
                onClose={() => setChooser(false)}
              />
            )}
          </div>
        </div>
      </div>
      <div className="task-grid table-responsive">
        <table className="table table-hover table-sm task-grid-table" style={{ minWidth: totalWidth }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: layout.widths[c.key] ?? c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <HeaderCell
                  key={c.key}
                  col={c}
                  sort={layout.sort}
                  dragging={dragging}
                  dropHere={dropAt === c.key}
                  onSort={() => toggleSort(c.key)}
                  onResize={(w) => setWidth(c.key, w)}
                  onDragStart={() => setDragging(c.key)}
                  onDragOver={() => setDropAt(c.key)}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropAt(null);
                  }}
                  onDrop={() => drop(c.key)}
                />
              ))}
            </tr>
            {showFilters && (
              <tr className="task-grid-filters">
                {cols.map((c) => (
                  <th key={c.key} className={c.pinned ? 'text-end' : undefined}>
                    <FilterCell col={c} value={filters[c.key] ?? ''} projects={projects} onChange={(v) => onFilterChange(c.key, v)} />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          {groups.map((g) => {
            const collapsed = isCollapsed(g);
            const limit = pages[g.key] ?? PAGE;
            const rows = collapsed ? [] : g.tasks.slice(0, limit);
            const unloaded = g.lane === 'done' && doneCount != null && g.tasks.length === 0;
            const rest = collapsed ? 0 : g.tasks.length - rows.length;
            return (
              <tbody key={g.key} className={`task-grid-group-body${collapsed ? ' collapsed' : ''}`}>
                {effectiveGroupBy !== 'none' && (
                  <tr className="task-grid-group">
                    <th colSpan={cols.length} scope="rowgroup">
                      <button type="button" className="task-grid-group-toggle" onClick={() => toggleGroup(g)} aria-expanded={!collapsed}>
                        <i className={`bi ${collapsed ? 'bi-chevron-right' : 'bi-chevron-down'} task-grid-group-chevron`} />
                        {g.tone && <span className="task-lane-dot" style={{ '--lane-tone': g.tone } as CSSProperties} />}
                        <span className="task-grid-group-label">{g.lane === 'done' && !history ? `${g.label} · ${RECENT_DAYS} derniers jours` : g.label}</span>
                        <span className="task-grid-group-count">{unloaded ? doneCount : g.tasks.length}</span>
                        {g.hint && <span className="task-grid-group-hint">{g.hint}</span>}
                      </button>
                    </th>
                  </tr>
                )}
                {rows.map((t) => (
                  <tr key={t.id} className={`task-grid-row lane-${placements.get(t.id)?.lane ?? 'ready'}`}>
                    {cols.map((c) => (
                      <td key={c.key} className={`task-grid-cell${c.align === 'end' ? ' text-end' : ''}${c.key === 'actions' ? ' task-grid-actions' : ''}`} title={c.key === 'actions' || c.key === 'pullRequest' ? undefined : cellTitle(t, c.key)}>
                        <Cell task={t} col={c} reason={placements.get(t.id)?.reason ?? null} onEdit={() => onEdit(t)} onTag={onTag} target={targets.get(t.project.id)} />
                      </td>
                    ))}
                  </tr>
                ))}
                {unloaded && !collapsed && (
                  <tr className="task-grid-more">
                    <td colSpan={cols.length} className="text-secondary small">
                      <Spinner size="sm" className="me-2" />
                      Chargement des terminées…
                    </td>
                  </tr>
                )}
                {rest > 0 && (
                  <tr className="task-grid-more">
                    <td colSpan={cols.length}>
                      <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setPages((p) => ({ ...p, [g.key]: limit + PAGE * 5 }))}>
                        Afficher {Math.min(rest, PAGE * 5)} de plus
                      </button>
                      <span className="text-secondary small ms-2">({rest} masquée{rest > 1 ? 's' : ''})</span>
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
          {groups.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={cols.length} className="text-secondary fst-italic task-grid-empty">
                  {tasks.length === 0 ? (history ? 'Aucune tâche fermée.' : 'Aucune tâche ouverte.') : 'Aucune tâche ne correspond à la recherche ou aux filtres.'}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

function cellTitle(t: Task, key: TaskColumnKey): string | undefined {
  switch (key) {
    case 'assignee':
      return formatPerson(t.assignee) || undefined;
    case 'reporter':
      return formatPerson(t.reporter) || undefined;
    case 'createdAt':
    case 'updatedAt':
      return new Date(cellText(t, key)).toLocaleString();
    case 'completedAt':
      return t.completedAt ? new Date(t.completedAt).toLocaleString() : undefined;
    case 'wakeAt':
      return t.wakeAt ? `Vérification programmée le ${new Date(t.wakeAt).toLocaleString()}${t.wakeNote ? ` : ${t.wakeNote}` : ''}` : undefined;
    case 'createdBy':
      return t.createdBySession ? `Créée par la session ${t.createdBySession.name}` : "Créée depuis l'interface";
    case 'session':
      return t.session ? `${t.session.name}${t.session.status === 'RUNNING' ? (t.session.activity === 'BUSY' ? ' · travaille' : ' · attend') : ''}` : undefined;
    default:
      return cellText(t, key) || undefined;
  }
}

function HeaderCell({
  col,
  sort,
  dragging,
  dropHere,
  onSort,
  onResize,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  col: TaskColumn;
  sort: TaskTableLayout['sort'];
  dragging: TaskColumnKey | null;
  dropHere: boolean;
  onSort: () => void;
  onResize: (width: number | null) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  const start = useRef<{ x: number; w: number } | null>(null);
  const sorted = sort?.key === col.key;
  return (
    <th
      ref={ref}
      className={`task-grid-th${col.align === 'end' ? ' text-end' : ''}${dropHere && dragging !== col.key ? ' task-grid-drop' : ''}${dragging === col.key ? ' task-grid-dragging' : ''}`}
      aria-sort={sorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      draggable={!col.pinned}
      onDragStart={(e) => {
        if (col.pinned) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', col.key);
        onDragStart();
      }}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      {col.sortable ? (
        <button type="button" className="task-grid-sort" onClick={onSort} title={sorted ? 'Cliquer pour inverser, puis revenir au tri par pertinence' : `Trier par ${col.label.toLowerCase()}`}>
          <span className="task-grid-label">{col.label}</span>
          <i className={`bi ${sorted ? (sort!.dir === 'asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill') : 'bi-caret-down'} task-grid-caret${sorted ? ' on' : ''}`} />
        </button>
      ) : (
        <span className="task-grid-label">{col.label}</span>
      )}
      {!col.pinned && (
        <span
          className="task-grid-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Largeur de la colonne ${col.label}`}
          title="Glisser pour redimensionner, double clic pour la largeur par défaut"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            start.current = { x: e.clientX, w: ref.current?.getBoundingClientRect().width ?? col.width };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.classList.add('dragging');
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            onResize(start.current.w + (e.clientX - start.current.x));
          }}
          onPointerUp={(e) => {
            start.current = null;
            e.currentTarget.classList.remove('dragging');
          }}
          onPointerCancel={(e) => {
            start.current = null;
            e.currentTarget.classList.remove('dragging');
          }}
          onDoubleClick={() => onResize(null)}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
        />
      )}
    </th>
  );
}

function FilterCell({ col, value, projects, onChange }: { col: TaskColumn; value: string; projects: { id: string; name: string }[]; onChange: (v: string) => void }) {
  if (!col.filter) return null;
  const label = `Filtrer : ${col.label.toLowerCase()}`;
  if (col.filter.kind === 'select') {
    const options = col.key === 'project' ? projects.map((p) => ({ value: p.id, label: p.name })) : col.filter.options;
    return (
      <Form.Select size="sm" className={`task-grid-filter${value ? ' on' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} title={label}>
        <option value="">{col.key === 'project' ? 'Tous' : 'Toutes'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Form.Select>
    );
  }
  return <Form.Control size="sm" className={`task-grid-filter${value ? ' on' : ''}`} type="search" value={value} placeholder="Filtrer…" onChange={(e) => onChange(e.target.value)} aria-label={label} title={label} />;
}

function Cell({ task: t, col, reason, onEdit, onTag, target }: { task: Task; col: TaskColumn; reason: string | null; onEdit: () => void; onTag: (tag: string) => void; target: LaunchTarget | undefined }) {
  switch (col.key) {
    case 'title':
      return (
        <>
          <TaskBlockedBadge task={t} short className="me-1" />
          <TaskStalledBadge task={t} short className="me-1" />
          <TaskWaitingBadge task={t} short className="me-1" />
          {reason && !t.stalledSince && <span className="task-reason me-1">{reason}</span>}
          <Link to={`/tasks/${t.id}`} className="task-grid-title text-reset text-decoration-none">
            {t.title}
          </Link>
        </>
      );
    case 'project':
      return <Link to={`/projects/${t.project.id}/tasks`} className="task-grid-project">{t.project.name}</Link>;
    case 'status':
      return <TaskStatusBadge status={t.status} statusTag={t.statusTag} label={t.stateLabel} attention={t.stateAttention} />;
    case 'statusTag':
      return <>{t.statusTag ?? ''}</>;
    case 'priority':
      return <TaskPriorityBadge priority={t.priority} />;
    case 'tags':
      return <TaskTags tags={t.tags} onSelect={onTag} />;
    case 'assignee':
      return <>{t.assignee?.name ?? t.assignee?.email ?? ''}</>;
    case 'reporter':
      return <>{t.reporter?.name ?? t.reporter?.email ?? ''}</>;
    case 'dueDate':
      return t.dueDate ? <span className={isOverdue(t) ? 'text-danger' : undefined}>{new Date(t.dueDate).toLocaleDateString()}</span> : null;
    case 'wakeAt':
      return <TaskWakeDate task={t} />;
    case 'session':
      return t.session ? (
        <Link to={`/sessions/${t.session.id}`} className="text-reset text-decoration-none">
          <i className={`bi bi-chat-dots me-1 ${t.session.status === 'RUNNING' ? (t.session.activity === 'BUSY' ? 'text-success' : 'text-warning') : 'text-secondary'}`} />
          {t.session.name}
        </Link>
      ) : null;
    case 'branch':
      return t.worksession?.branch || t.branch ? <span className="font-monospace small">{t.worksession?.branch ?? t.branch}</span> : null;
    case 'pullRequest':
      if (t.pullRequests?.length) {
        return (
          <span className="d-inline-flex align-items-center gap-2">
            {t.pullRequests.slice(0, 2).map((pr) => (
              <TrackedPullRequestChip key={pr.id} projectId={t.project.id} pr={pr} />
            ))}
            {t.pullRequests.length > 2 && <span className="text-secondary small">+{t.pullRequests.length - 2}</span>}
          </span>
        );
      }
      return t.pullRequest ? <PullRequestChip projectId={t.project.id} pr={t.pullRequest} /> : null;
    case 'comments':
      return t.commentCount ? (
        <Link to={`/tasks/${t.id}`} className="text-reset text-decoration-none">
          {t.commentCount}
        </Link>
      ) : null;
    case 'cost':
      return t.costUsd > 0 ? <>{formatCost(t.costUsd)}</> : null;
    case 'attachments':
      return t.attachmentCount ? <>{t.attachmentCount}</> : null;
    case 'createdBy':
      return (
        <>
          <i className={`bi ${t.createdByType === 'agent' ? 'bi-robot' : 'bi-person'} me-1 text-secondary`} />
          {t.createdByType === 'agent' ? 'Agent' : 'Humain'}
        </>
      );
    case 'createdAt':
      return <>{timeAgo(t.createdAt)}</>;
    case 'updatedAt':
      return <>{timeAgo(t.updatedAt)}</>;
    case 'completedAt':
      return t.completedAt ? <>{timeAgo(t.completedAt)}</> : null;
    case 'actions':
      return <TaskActions task={t} target={target} onEdit={onEdit} compact />;
  }
}

function ColumnChooser({
  layout,
  available,
  onToggle,
  onShift,
  onReset,
  onClose,
}: {
  layout: TaskTableLayout;
  available: (key: TaskColumnKey) => boolean;
  onToggle: (key: TaskColumnKey) => void;
  onShift: (key: TaskColumnKey, delta: -1 | 1) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', onClose);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const keys = layout.order.filter((k) => !COLUMN_BY_KEY[k].pinned && available(k));
  return (
    <div className="wb-pop task-grid-chooser" onClick={(e) => e.stopPropagation()}>
      <div className="task-grid-chooser-head">
        <span>Colonnes</span>
        <button type="button" className="btn btn-link btn-sm p-0 small" onClick={onReset} title="Ordre, largeurs, colonnes et tri par défaut">
          Réinitialiser
        </button>
      </div>
      {keys.map((k, i) => (
        <div key={k} className="task-grid-chooser-row">
          <Form.Check type="checkbox" id={`task-col-${k}`} label={COLUMN_BY_KEY[k].label} checked={!layout.hidden.includes(k)} onChange={() => onToggle(k)} className="small flex-grow-1 mb-0" />
          <button type="button" className="btn btn-link btn-sm p-0 px-1 text-secondary" disabled={i === 0} onClick={() => onShift(k, -1)} title="Monter (vers la gauche)" aria-label={`Déplacer ${COLUMN_BY_KEY[k].label} vers la gauche`}>
            <i className="bi bi-chevron-up" />
          </button>
          <button type="button" className="btn btn-link btn-sm p-0 px-1 text-secondary" disabled={i === keys.length - 1} onClick={() => onShift(k, 1)} title="Descendre (vers la droite)" aria-label={`Déplacer ${COLUMN_BY_KEY[k].label} vers la droite`}>
            <i className="bi bi-chevron-down" />
          </button>
        </div>
      ))}
      <div className="task-grid-chooser-foot">{TASK_COLUMNS.length - 1 - keys.filter((k) => layout.hidden.includes(k)).length} colonnes affichées</div>
    </div>
  );
}
