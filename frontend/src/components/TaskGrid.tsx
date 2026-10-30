import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import type { Task } from '../graphql/operations';
import { timeAgo } from '../lib/humanize';
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
  type TaskColumn,
  type TaskColumnKey,
  type TaskFilters,
  type TaskTableLayout,
} from '../lib/taskTable';
import { PullRequestChip } from './PullRequests';
import TaskActions from './TaskActions';
import { formatPerson, isOverdue, TaskPriorityBadge, TaskStatusBadge, TaskTags } from './TaskBadges';
import type { LaunchTarget } from './TaskLaunchModal';

export interface TaskGridProps {
  tasks: Task[];
  /** Sans projet imposé (toutes les tâches) : la colonne Projet existe et son filtre choisit le projet. */
  showProject: boolean;
  projects: { id: string; name: string }[];
  filters: TaskFilters;
  onFilterChange: (key: TaskColumnKey, value: string) => void;
  onClearFilters: () => void;
  onEdit: (t: Task) => void;
  onTag: (tag: string) => void;
  targets: Map<string, LaunchTarget>;
}

/**
 * Vue liste des tâches : une ligne par tâche, toujours sur une seule ligne (le texte se tronque). Les colonnes se
 * réordonnent (glisser l'en-tête, ou flèches du choix des colonnes), se redimensionnent (poignée à droite de l'en-tête,
 * double clic pour revenir à la largeur par défaut), se trient (clic sur l'en-tête) et se choisissent (bouton
 * « Colonnes ») ; la plupart se filtrent (ligne sous les en-têtes). La disposition est mémorisée dans localStorage
 * (lib/taskTable.ts).
 */
export default function TaskGrid({ tasks, showProject, projects, filters, onFilterChange, onClearFilters, onEdit, onTag, targets }: TaskGridProps) {
  const [layout, setLayout] = useState<TaskTableLayout>(() => loadLayout());
  useEffect(() => saveLayout(layout), [layout]);
  const available = useCallback((k: TaskColumnKey) => k !== 'project' || showProject, [showProject]);
  const cols = useMemo(() => visibleColumns(layout, available), [layout, available]);
  const rows = useMemo(() => sortTasks(applyFilters(tasks, filters), layout.sort), [tasks, filters, layout.sort]);
  const filtering = Object.values(filters).some((v) => v && v.trim());
  const totalWidth = cols.reduce((sum, c) => sum + (layout.widths[c.key] ?? c.width), 0);

  const toggleSort = (key: TaskColumnKey) =>
    setLayout((l) => ({ ...l, sort: l.sort.key === key ? { key, dir: l.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'createdAt' || key === 'updatedAt' || key === 'completedAt' || key === 'comments' ? 'desc' : 'asc' } }));
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

  return (
    <div className="task-grid-root">
      <div className="task-grid-bar">
        <span className="text-secondary small">
          {rows.length === tasks.length ? `${tasks.length} tâche${tasks.length > 1 ? 's' : ''}` : `${rows.length} sur ${tasks.length} tâche${tasks.length > 1 ? 's' : ''}`}
        </span>
        {filtering && (
          <Button size="sm" variant="link" className="p-0 small" onClick={onClearFilters}>
            <i className="bi bi-x-circle me-1" />
            Effacer les filtres
          </Button>
        )}
        <div className="position-relative ms-auto">
          <Button size="sm" variant="outline-secondary" title="Choisir et ordonner les colonnes" onClick={(e) => {
              e.stopPropagation();
              setChooser((v) => !v);
            }}
            aria-expanded={chooser}
          >
            <i className="bi bi-layout-three-columns me-1" />
            Colonnes
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
            <tr className="task-grid-filters">
              {cols.map((c) => (
                <th key={c.key} className={c.pinned ? 'text-end' : undefined}>
                  <FilterCell col={c} value={filters[c.key] ?? ''} projects={projects} onChange={(v) => onFilterChange(c.key, v)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                {cols.map((c) => (
                  <td key={c.key} className={`task-grid-cell${c.align === 'end' ? ' text-end' : ''}${c.key === 'actions' ? ' task-grid-actions' : ''}`} title={c.key === 'actions' || c.key === 'pullRequest' ? undefined : cellTitle(t, c.key)}>
                    <Cell task={t} col={c} onEdit={() => onEdit(t)} onTag={onTag} target={targets.get(t.project.id)} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="text-secondary fst-italic">
                  {tasks.length === 0 ? 'Aucune tâche.' : 'Aucune tâche ne correspond aux filtres.'}
                </td>
              </tr>
            )}
          </tbody>
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
  const sorted = sort.key === col.key;
  return (
    <th
      ref={ref}
      className={`task-grid-th${col.align === 'end' ? ' text-end' : ''}${dropHere && dragging !== col.key ? ' task-grid-drop' : ''}${dragging === col.key ? ' task-grid-dragging' : ''}`}
      aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
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
        <button type="button" className="task-grid-sort" onClick={onSort} title={`Trier par ${col.label.toLowerCase()}`}>
          <span className="task-grid-label">{col.label}</span>
          <i className={`bi ${sorted ? (sort.dir === 'asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill') : 'bi-caret-down'} task-grid-caret${sorted ? ' on' : ''}`} />
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

function Cell({ task: t, col, onEdit, onTag, target }: { task: Task; col: TaskColumn; onEdit: () => void; onTag: (tag: string) => void; target: LaunchTarget | undefined }) {
  switch (col.key) {
    case 'title':
      return (
        <Link to={`/tasks/${t.id}`} className="fw-semibold text-reset text-decoration-none">
          {t.title}
        </Link>
      );
    case 'project':
      return <Link to={`/projects/${t.project.id}/tasks`}>{t.project.name}</Link>;
    case 'status':
      return <TaskStatusBadge status={t.status} statusTag={t.statusTag} />;
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
      return t.pullRequest ? <PullRequestChip projectId={t.project.id} pr={t.pullRequest} /> : null;
    case 'comments':
      return t.commentCount ? (
        <Link to={`/tasks/${t.id}`} className="text-reset text-decoration-none">
          {t.commentCount}
        </Link>
      ) : null;
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
