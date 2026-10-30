import { useMemo, useState, type ReactNode } from 'react';
import { Button, ButtonGroup } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import type { Task } from '../graphql/operations';
import { timeAgo } from '../lib/humanize';
import { useElementWidth } from '../lib/useElementWidth';
import {
  ageDays,
  byAssignee,
  byPriority,
  DAY,
  dashboardStats,
  formatDays,
  hasRunningSession,
  isOpen,
  nextTasks,
  PERIOD_CHOICES,
  shortDate,
  WATCH_LABELS,
  watchlist,
  type Breakdown,
  type DashboardStats,
  type WatchReason,
  type WeekBucket,
} from '../lib/taskStats';
import TaskActions from './TaskActions';
import { PersonChip, TaskPriorityBadge, TaskStatusBadge, TaskTags } from './TaskBadges';
import type { LaunchTarget } from './TaskLaunchModal';
import '../pages/dashboard.css';

const PERIOD_KEY = 'skipper.tasks.dashboard.weeks';
const DEFAULT_WEEKS = 8;
const longDate = (d: Date) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmt1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

export interface TaskDashboardProps {
  /** Toutes les tâches du périmètre filtré, terminées et annulées comprises. */
  tasks: Task[];
  showProject: boolean;
  onEdit: (t: Task) => void;
  onTag: (tag: string) => void;
  targets: Map<string, LaunchTarget>;
}

/**
 * Vue « pilotage » des tâches, pensée pour qui suit l'avancement d'un projet : indicateurs clés, avancement cumulé et
 * prévision de fin du reste à faire, flux créées / terminées par semaine, répartition de la charge, puis ce qui demande
 * un regard (retards, blocages, en cours sans activité), ce qui est en cours, ce qu'il faudrait lancer ensuite et ce qui
 * vient d'être terminé. Les calculs sont dans lib/taskStats.ts.
 */
export default function TaskDashboard({ tasks, showProject, onEdit, onTag, targets }: TaskDashboardProps) {
  const [weeks, setWeeks] = useState(() => {
    try {
      const n = Number(localStorage.getItem(PERIOD_KEY));
      return PERIOD_CHOICES.some((c) => c.weeks === n) ? n : DEFAULT_WEEKS;
    } catch {
      return DEFAULT_WEEKS;
    }
  });
  const choosePeriod = (n: number) => {
    setWeeks(n);
    try {
      localStorage.setItem(PERIOD_KEY, String(n));
    } catch {
      /* ignore */
    }
  };
  // L'instant de référence suit les rafraîchissements de la liste (sondage toutes les quelques secondes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [tasks]);
  const stats = useMemo(() => dashboardStats(tasks, now, weeks), [tasks, now, weeks]);
  const open = useMemo(() => tasks.filter(isOpen), [tasks]);
  const inProgress = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'IN_PROGRESS')
        .sort((a, b) => sessionRank(a) - sessionRank(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.updatedAt.localeCompare(b.updatedAt)),
    [tasks],
  );
  const watch = useMemo(() => watchlist(tasks, now), [tasks, now]);
  const next = useMemo(() => nextTasks(tasks, 8), [tasks]);
  const recentDone = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'DONE' && t.completedAt)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
        .slice(0, 8),
    [tasks],
  );
  const priorities = useMemo(() => byPriority(open), [open]);
  const assignees = useMemo(() => byAssignee(open), [open]);
  const doneDelta = stats.doneWeek - stats.donePrevWeek;
  const net = stats.createdPeriod - stats.donePeriod - stats.cancelledPeriod;
  const projectOf = (t: Task) => (showProject ? `${t.project.name} · ` : '');

  return (
    <div className="task-dash">
      <div className="task-dash-filters">
        <span>Période</span>
        <ButtonGroup size="sm">
          {PERIOD_CHOICES.map((c) => (
            <Button key={c.weeks} variant={weeks === c.weeks ? 'secondary' : 'outline-secondary'} onClick={() => choosePeriod(c.weeks)} title={`Les ${c.weeks} dernières semaines, semaine en cours comprise`}>
              {c.label}
            </Button>
          ))}
        </ButtonGroup>
        <span>
          du {shortDate(stats.buckets[0].start)} à aujourd’hui · {tasks.length} tâche{tasks.length > 1 ? 's' : ''} dans le périmètre filtré
        </span>
      </div>

      <section className="dash-section">
        <div className="dash-tiles">
          <Tile icon="bi-check2-square" label="Ouvertes" value={stats.open} sub={`${stats.todo} à faire · ${stats.inProgress} en cours${stats.important ? ` · ${stats.important} urgente${stats.important > 1 ? 's' : ''} ou haute${stats.important > 1 ? 's' : ''}` : ''}`} />
          <Tile
            icon="bi-cpu"
            label="En cours"
            value={stats.inProgress}
            alert={stats.blocked > 0}
            sub={
              stats.inProgress === 0
                ? 'Aucune tâche en cours'
                : [
                    stats.working ? `${stats.working} agent${stats.working > 1 ? 's' : ''} au travail` : null,
                    stats.waiting ? `${stats.waiting} en attente d’instructions` : null,
                    stats.unattended ? `${stats.unattended} sans agent actif` : null,
                    stats.blocked ? `${stats.blocked} bloquée${stats.blocked > 1 ? 's' : ''}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
            }
          />
          <Tile
            icon="bi-check2-circle"
            label="Terminées sur 7 jours"
            value={stats.doneWeek}
            sub={
              <>
                <span className={doneDelta > 0 ? 'task-dash-good' : doneDelta < 0 ? 'task-dash-bad' : ''}>
                  {doneDelta > 0 ? '+' : ''}
                  {doneDelta}
                </span>{' '}
                par rapport aux 7 jours précédents ({stats.donePrevWeek})
              </>
            }
          />
          <Tile icon="bi-exclamation-triangle" label="En retard" value={stats.overdue} alert={stats.overdue > 0} sub={stats.dueSoon ? `${stats.dueSoon} échéance${stats.dueSoon > 1 ? 's' : ''} dans les 7 jours` : 'Aucune échéance dans les 7 jours'} />
          <Tile
            icon="bi-speedometer2"
            label="Débit"
            value={fmt1(stats.throughput.mean)}
            unit="/ sem."
            sub={`${stats.throughput.min} à ${stats.throughput.max} terminées par semaine sur ${stats.throughput.weeks} semaine${stats.throughput.weeks > 1 ? 's' : ''} révolue${stats.throughput.weeks > 1 ? 's' : ''}`}
          />
          <Tile
            icon="bi-stopwatch"
            label="Délai de traitement"
            value={stats.leadTime.count ? formatDays(stats.leadTime.median) : '—'}
            sub={stats.leadTime.count ? `Médiane · 85 % des tâches en moins de ${formatDays(stats.leadTime.p85)} (${stats.leadTime.count} terminée${stats.leadTime.count > 1 ? 's' : ''} sur la période)` : 'Aucune tâche terminée sur la période'}
            title="Temps entre la création d’une tâche et sa fin, pour les tâches terminées sur la période"
          />
          <Tile
            icon="bi-calendar-check"
            label="Fin estimée du reste à faire"
            date
            value={stats.open === 0 ? 'Rien à faire' : stats.forecastDates ? shortDate(stats.forecastDates.p50) : '—'}
            alert={stats.open > 0 && !stats.forecast}
            sub={
              stats.open === 0
                ? 'Toutes les tâches sont terminées'
                : stats.forecastDates
                  ? `Une chance sur deux · 85 % de chances avant le ${shortDate(stats.forecastDates.p85)} · à périmètre constant`
                  : 'Pas de base de prévision : aucune tâche terminée sur la période'
            }
            title="Simulation de Monte-Carlo sur le débit hebdomadaire observé : dates auxquelles 50 % puis 85 % des scénarios ont écoulé les tâches ouvertes"
          />
          <Tile
            icon="bi-arrow-left-right"
            label="Flux net sur la période"
            value={
              <span className={net > 0 ? 'task-dash-bad' : net < 0 ? 'task-dash-good' : ''}>
                {net > 0 ? '+' : ''}
                {net}
              </span>
            }
            sub={`${stats.createdPeriod} créée${stats.createdPeriod > 1 ? 's' : ''}, ${stats.donePeriod} terminée${stats.donePeriod > 1 ? 's' : ''}, ${stats.cancelledPeriod} annulée${stats.cancelledPeriod > 1 ? 's' : ''} : le reste à faire ${net > 0 ? 'grandit' : net < 0 ? 'diminue' : 'est stable'}`}
          />
        </div>
      </section>

      <div className="task-dash-grid2">
        <div className="task-dash-card">
          <h3>Avancement cumulé</h3>
          <div className="hint">Périmètre (tâches créées, non annulées) et tâches terminées, jour par jour ; en pointillé, la projection au débit moyen.</div>
          <BurnupChart stats={stats} now={now} />
        </div>
        <div className="task-dash-card">
          <h3>Flux par semaine</h3>
          <div className="hint">Tâches créées et terminées chaque semaine ; la semaine en cours est incomplète.</div>
          <ThroughputChart buckets={stats.buckets} />
        </div>
      </div>

      <div className="task-dash-grid2">
        <div className="task-dash-card">
          <h3>Ouvertes par priorité</h3>
          <Bars rows={priorities} />
        </div>
        <div className="task-dash-card">
          <h3>Charge par responsable</h3>
          <Bars rows={assignees} empty="Aucune tâche ouverte." />
        </div>
      </div>

      <div className="task-dash-grid2 task-dash-lists">
        <section className="dash-section">
          <h2 className="dash-section-title">
            <span>À surveiller ({watch.length})</span>
          </h2>
          <ul className="dash-list">
            {watch.slice(0, 10).map(({ task: t, reason, detail }) => (
              <Item key={t.id} task={t} icon={WATCH_ICONS[reason].icon} iconClass={WATCH_ICONS[reason].cls} meta={`${projectOf(t)}${WATCH_LABELS[reason]} · ${detail}`} side={<TaskPriorityBadge priority={t.priority} short />} />
            ))}
            {watch.length > 10 && <li className="empty">… et {watch.length - 10} autre{watch.length - 10 > 1 ? 's' : ''}.</li>}
            {watch.length === 0 && <li className="empty">Rien à signaler : pas de retard, de blocage ni de tâche en cours laissée sans suite.</li>}
          </ul>
        </section>

        <section className="dash-section">
          <h2 className="dash-section-title">
            <span>En cours ({inProgress.length})</span>
          </h2>
          <ul className="dash-list">
            {inProgress.slice(0, 10).map((t) => {
              const state = sessionState(t);
              return (
                <Item
                  key={t.id}
                  task={t}
                  icon={state.icon}
                  iconClass={state.cls}
                  meta={
                    <>
                      {projectOf(t)}
                      {t.statusTag && (
                        <>
                          <TaskStatusBadge status={t.status} statusTag={t.statusTag} />{' '}
                        </>
                      )}
                      {state.label}
                      {t.session && (
                        <>
                          {' '}
                          <Link to={`/sessions/${t.session.id}`}>{t.session.name}</Link>
                        </>
                      )}
                      {t.assignee && (
                        <>
                          {' · '}
                          <PersonChip person={t.assignee} />
                        </>
                      )}
                      {' · mise à jour '}
                      {timeAgo(t.updatedAt)}
                    </>
                  }
                  side={
                    <>
                      <span className="age" title={`Créée le ${new Date(t.createdAt).toLocaleDateString()}`}>
                        depuis {ageDays(t.createdAt, now)} j
                      </span>
                      <TaskPriorityBadge priority={t.priority} short />
                    </>
                  }
                />
              );
            })}
            {inProgress.length > 10 && <li className="empty">… et {inProgress.length - 10} autre{inProgress.length - 10 > 1 ? 's' : ''}.</li>}
            {inProgress.length === 0 && <li className="empty">Aucune tâche en cours.</li>}
          </ul>
        </section>

        <section className="dash-section">
          <h2 className="dash-section-title">
            <span>Prochaines à lancer</span>
            <span className="fw-normal text-lowercase" style={{ letterSpacing: 0, textTransform: 'none' }}>
              par priorité puis échéance
            </span>
          </h2>
          <ul className="dash-list">
            {next.map((t) => (
              <Item
                key={t.id}
                task={t}
                icon="bi-play-circle"
                meta={
                  <>
                    {projectOf(t)}
                    {t.dueDate && <>pour le {new Date(`${t.dueDate}T00:00:00`).toLocaleDateString()} · </>}
                    créée {timeAgo(t.createdAt)}
                    {t.assignee && (
                      <>
                        {' · '}
                        <PersonChip person={t.assignee} />
                      </>
                    )}
                    {t.tags.length > 0 && (
                      <>
                        {' '}
                        <TaskTags tags={t.tags} onSelect={onTag} />
                      </>
                    )}
                  </>
                }
                side={
                  <>
                    <TaskPriorityBadge priority={t.priority} short />
                    <TaskActions task={t} target={targets.get(t.project.id)} onEdit={() => onEdit(t)} compact />
                  </>
                }
              />
            ))}
            {next.length === 0 && <li className="empty">Rien à lancer : aucune tâche à faire.</li>}
          </ul>
        </section>

        <section className="dash-section">
          <h2 className="dash-section-title">
            <span>Terminées récemment</span>
          </h2>
          <ul className="dash-list">
            {recentDone.map((t) => (
              <Item
                key={t.id}
                task={t}
                icon="bi-check2"
                iconClass="good"
                meta={`${projectOf(t)}terminée ${timeAgo(t.completedAt!)} · délai ${formatDays((new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime()) / DAY)}`}
                side={<TaskPriorityBadge priority={t.priority} short />}
              />
            ))}
            {recentDone.length === 0 && <li className="empty">Aucune tâche terminée.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

const PRIORITY_RANK = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

const WATCH_ICONS: Record<WatchReason, { icon: string; cls: string }> = {
  overdue: { icon: 'bi-exclamation-triangle', cls: 'bad' },
  blocked: { icon: 'bi-sign-stop', cls: 'bad' },
  urgent_idle: { icon: 'bi-lightning-charge', cls: 'warn' },
  stale: { icon: 'bi-moon', cls: 'warn' },
  due_soon: { icon: 'bi-calendar-event', cls: '' },
};

/** État de la session en charge d'une tâche en cours : au travail, en attente, ou sans agent actif. */
function sessionState(t: Task): { icon: string; cls: string; label: string } {
  if (t.session?.status === 'RUNNING' && t.session.activity === 'BUSY') return { icon: 'bi-cpu', cls: 'busy', label: 'Agent au travail :' };
  if (t.session?.status === 'RUNNING') return { icon: 'bi-hourglass-split', cls: 'warn', label: 'Agent en attente :' };
  if (t.session) return { icon: 'bi-pause-circle', cls: '', label: 'Session arrêtée :' };
  return { icon: 'bi-person-workspace', cls: '', label: 'Sans session' };
}
const sessionRank = (t: Task) => (t.session?.status === 'RUNNING' && t.session.activity === 'BUSY' ? 0 : hasRunningSession(t) ? 1 : 2);

function Tile({ icon, label, value, unit, sub, alert, title, date }: { icon: string; label: string; value: ReactNode; unit?: string; sub?: ReactNode; alert?: boolean; title?: string; date?: boolean }) {
  return (
    <div className={`dash-tile${alert ? ' alert' : ''}`} title={title}>
      <div className="dash-tile-label">
        <i className={`bi ${icon}`} /> {label}
      </div>
      <div className={`dash-tile-value${date ? ' date' : ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub && <div className="dash-tile-sub">{sub}</div>}
    </div>
  );
}

function Item({ task, icon, iconClass = '', meta, side }: { task: Task; icon: string; iconClass?: string; meta: ReactNode; side?: ReactNode }) {
  return (
    <li>
      <span className={`icon ${iconClass}`}>
        <i className={`bi ${icon}`} />
      </span>
      <div className="main">
        <Link to={`/tasks/${task.id}`} className="title" title={task.title}>
          {task.title}
        </Link>
        <div className="meta">{meta}</div>
      </div>
      {side && <div className="side">{side}</div>}
    </li>
  );
}

/** Barres horizontales empilées (en cours en accent, à faire en gris), sur une même échelle. */
function Bars({ rows, empty = 'Aucune tâche.' }: { rows: Breakdown[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.todo + r.inProgress));
  if (rows.every((r) => r.todo + r.inProgress === 0)) return <div className="hint mt-2">{empty}</div>;
  return (
    <>
      <div className="task-dash-legend">
        <span>
          <i className="task-dash-key sw done" /> en cours
        </span>
        <span>
          <i className="task-dash-key sw" /> à faire
        </span>
      </div>
      <div className="task-dash-bars">
        {rows.map((r) => {
          const total = r.todo + r.inProgress;
          return (
            <div key={r.key} className="contents" style={{ display: 'contents' }}>
              <span className="lbl" title={r.label}>
                {r.label}
              </span>
              <div className="task-dash-bar" title={`${r.inProgress} en cours, ${r.todo} à faire`}>
                {r.inProgress > 0 && <span className="ip" style={{ width: `${(r.inProgress / max) * 100}%` }} />}
                {r.todo > 0 && <span className="td" style={{ width: `${(r.todo / max) * 100}%` }} />}
              </div>
              <span className={`num${total === 0 ? ' opacity-50' : ''}`}>{total}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- Graphiques SVG --------------------------------------------------------------------------------

/** Graduations « rondes » de 0 au-dessus de `max` : 4 à 6 pas de 1, 2, 5, 10, 20… */
function niceTicks(max: number): number[] {
  const rough = Math.max(1, max) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return ticks;
}

/** Colonne à sommet arrondi (4 px) et base carrée. */
function column(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = x < width / 2;
  return (
    <div className="task-dash-tooltip" style={left ? { left: x + 12 } : { right: width - x + 12 }}>
      {children}
    </div>
  );
}

function BurnupChart({ stats, now }: { stats: DashboardStats; now: Date }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = stats.burnup;
  const height = 190;
  const padL = 30;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const start = pts[0].date.getTime();
  const today = now.getTime();
  const last = pts[pts.length - 1];
  const remaining = last.scope - last.done;
  const perDay = stats.throughput.mean / 7;
  // Projection au débit moyen, depuis aujourd'hui ; l'horizon s'étend jusqu'à elle, au plus une demi-période après aujourd'hui.
  const projectedEnd = remaining > 0 && perDay > 0 ? today + (remaining / perDay) * DAY : null;
  const xMax = Math.max(today + DAY, Math.min(projectedEnd ?? today, today + (stats.weeks * 7 * DAY) / 2));
  const ticks = niceTicks(Math.max(...pts.map((p) => p.scope)));
  const yTop = ticks[ticks.length - 1];
  const x = (ms: number) => padL + ((ms - start) / (xMax - start)) * plotW;
  const y = (v: number) => padT + plotH - (v / yTop) * plotH;
  const px = (i: number) => x(Math.min(pts[i].date.getTime() + DAY, today));
  const scopePath = pts.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${y(p.scope).toFixed(1)}`).join(' ');
  const donePath = pts.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${y(p.done).toFixed(1)}`).join(' ');
  const areaPath = `${donePath} L${px(pts.length - 1).toFixed(1)},${y(0)} L${px(0).toFixed(1)},${y(0)} Z`;
  const projEnd = projectedEnd ? Math.min(projectedEnd, xMax) : null;
  const projY = projEnd ? last.done + ((projEnd - today) / DAY) * perDay : 0;
  const projReached = projectedEnd !== null && projectedEnd <= xMax;
  const xToday = x(today);
  const labelAnchor = xToday + 48 < width ? 'start' : 'end';
  const labelX = labelAnchor === 'start' ? xToday + 7 : xToday - 7;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = start + ((e.clientX - rect.left) / Math.max(1, plotW)) * (xMax - start);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].date.getTime() + DAY - ms) < Math.abs(pts[best].date.getTime() + DAY - ms)) best = i;
    setHover(best);
  };
  const h = hover !== null ? pts[hover] : null;

  return (
    <div ref={ref} className="task-dash-chart-wrap">
      {width > 0 && (
        <svg className="task-dash-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Avancement cumulé sur ${stats.weeks} semaines : ${last.done} terminées sur ${last.scope}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text x={padL - 4} y={y(t) + 3} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <path className="done-area" d={areaPath} />
          <path className="scope" d={scopePath} />
          <path className="done" d={donePath} />
          {projEnd && projEnd > today && <line className="forecast" x1={xToday} y1={y(last.done)} x2={x(projEnd)} y2={y(Math.min(projY, last.scope))} />}
          {projReached && projEnd && <circle className="marker forecast" cx={x(projEnd)} cy={y(last.scope)} r={4} />}
          {xToday < width - padR - 1 && <line className="today-line" x1={xToday} x2={xToday} y1={padT} y2={padT + plotH} />}
          <circle className="marker scope" cx={xToday} cy={y(last.scope)} r={4} />
          <circle className="marker done" cx={xToday} cy={y(last.done)} r={4} />
          <text x={labelX} y={y(last.scope) - 5} textAnchor={labelAnchor}>
            {last.scope} au total
          </text>
          <text x={labelX} y={y(last.done) + (projEnd && projEnd > today ? 13 : last.scope - last.done < yTop / 8 ? 12 : -5)} textAnchor={labelAnchor}>
            {last.done} terminées
          </text>
          {h && (
            <>
              <line className="crosshair" x1={px(hover!)} x2={px(hover!)} y1={padT} y2={padT + plotH} />
              <circle className="marker scope" cx={px(hover!)} cy={y(h.scope)} r={4} />
              <circle className="marker done" cx={px(hover!)} cy={y(h.done)} r={4} />
            </>
          )}
          <text x={padL} y={height - 6}>
            {shortDate(pts[0].date)}
          </text>
          <text x={xToday} y={height - 6} textAnchor={xToday > width - 60 ? 'end' : 'middle'}>
            aujourd’hui
          </text>
          {projReached && projEnd && x(projEnd) - xToday > 70 && (
            <text x={x(projEnd)} y={height - 6} textAnchor="end">
              {shortDate(new Date(projEnd))}
            </text>
          )}
          <rect className="hit" x={padL} y={0} width={plotW} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {h && hover !== null && (
        <Tooltip x={px(hover)} width={width}>
          <div className="t">{longDate(h.date)}</div>
          <div>
            <i className="task-dash-key" />
            <span className="v">{h.scope}</span> au total
          </div>
          <div>
            <i className="task-dash-key done" />
            <span className="v">{h.done}</span> terminées
          </div>
          <div>
            <i className="task-dash-key" style={{ visibility: 'hidden' }} />
            <span className="v">{h.scope - h.done}</span> restantes
          </div>
        </Tooltip>
      )}
      <div className="task-dash-legend">
        <span>
          <i className="task-dash-key" /> Périmètre
        </span>
        <span>
          <i className="task-dash-key done" /> Terminées
        </span>
        {projEnd && projEnd > today && (
          <span>
            <i className="task-dash-key forecast" /> Projection au débit moyen{projReached ? ` (${shortDate(new Date(projectedEnd!))})` : ' (au-delà du graphique)'}
          </span>
        )}
      </div>
      <details className="task-dash-data">
        <summary>Données par semaine</summary>
        <table className="table table-sm mb-0">
          <thead>
            <tr>
              <th>Semaine du</th>
              <th className="num">Périmètre</th>
              <th className="num">Terminées</th>
              <th className="num">Restantes</th>
            </tr>
          </thead>
          <tbody>
            {stats.buckets.map((b) => {
              const p = pts.find((q) => q.date.getTime() === b.start.getTime()) ?? pts[0];
              return (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="num">{p.scope}</td>
                  <td className="num">{p.done}</td>
                  <td className="num">{p.scope - p.done}</td>
                </tr>
              );
            })}
            <tr>
              <td>Aujourd’hui</td>
              <td className="num">{last.scope}</td>
              <td className="num">{last.done}</td>
              <td className="num">{last.scope - last.done}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  );
}

function ThroughputChart({ buckets }: { buckets: WeekBucket[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 190;
  const padL = 30;
  const padR = 8;
  const padT = 12;
  const padB = 22;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const ticks = niceTicks(Math.max(...buckets.map((b) => Math.max(b.created, b.done))));
  const yTop = ticks[ticks.length - 1];
  const y = (v: number) => padT + plotH - (v / yTop) * plotH;
  const slot = plotW / buckets.length;
  const barW = Math.min(14, Math.max(3, (slot - 6) / 2));
  const every = Math.max(1, Math.ceil(44 / Math.max(1, slot)));
  const lastIdx = buckets.length - 1;
  const h = hover !== null ? buckets[hover] : null;
  const hx = hover !== null ? padL + hover * slot + slot / 2 : 0;

  return (
    <div ref={ref} className="task-dash-chart-wrap">
      {width > 0 && (
        <svg className="task-dash-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Tâches créées et terminées par semaine sur ${buckets.length} semaines`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text x={padL - 4} y={y(t) + 3} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const gx = padL + i * slot;
            const cx = gx + slot / 2;
            const current = i === lastIdx ? ' current' : '';
            return (
              <g key={b.label} className="slot" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <path className={`created${current}`} d={column(cx - barW - 1, y(b.created), barW, y(0) - y(b.created))} />
                <path className={`finished${current}`} d={column(cx + 1, y(b.done), barW, y(0) - y(b.done))} />
                <rect className="hit" x={gx} y={0} width={slot} height={height} />
                {(i === lastIdx || (i % every === 0 && (lastIdx - i) * slot >= 64)) && (
                  <text x={cx} y={height - 6} textAnchor="middle">
                    {i === lastIdx ? 'cette sem.' : b.label}
                  </text>
                )}
              </g>
            );
          })}
          <line className="grid" x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      {h && (
        <Tooltip x={hx} width={width}>
          <div className="t">Semaine du {h.label}</div>
          <div>
            <i className="task-dash-key sw" />
            <span className="v">{h.created}</span> créées
          </div>
          <div>
            <i className="task-dash-key sw done" />
            <span className="v">{h.done}</span> terminées
          </div>
          {h.cancelled > 0 && (
            <div>
              <i className="task-dash-key sw" style={{ visibility: 'hidden' }} />
              <span className="v">{h.cancelled}</span> annulées
            </div>
          )}
        </Tooltip>
      )}
      <div className="task-dash-legend">
        <span>
          <i className="task-dash-key sw" /> Créées
        </span>
        <span>
          <i className="task-dash-key sw done" /> Terminées
        </span>
        <span>
          <i className="task-dash-key sw done current" /> Semaine en cours (incomplète)
        </span>
      </div>
      <details className="task-dash-data">
        <summary>Données par semaine</summary>
        <table className="table table-sm mb-0">
          <thead>
            <tr>
              <th>Semaine du</th>
              <th className="num">Créées</th>
              <th className="num">Terminées</th>
              <th className="num">Annulées</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.label}>
                <td>{b.label}</td>
                <td className="num">{b.created}</td>
                <td className="num">{b.done}</td>
                <td className="num">{b.cancelled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
