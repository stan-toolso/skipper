import { useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Row, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import StatusBadge from '../components/StatusBadge';
import { DASHBOARD, type Dashboard, type DashboardProject, type DashboardUsage, type HumanRequest, type Session, type Task } from '../graphql/operations';
import { formatCost, requestTitle, sessionStateHint, taskPriorityLabels, taskStatusLabels, timeAgo } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';
import { useSessionLauncher } from '../components/SessionLauncher';
import './dashboard.css';

/**
 * Page d'accueil : un tableau de bord qui répond à « qu'est-ce qui m'attend ? » — demandes en
 * attente, agents au travail ou en attente d'instructions, tâches à surveiller, consommation
 * du mois — puis une ligne par projet et l'activité récente. Tout vient d'une seule query,
 * rafraîchie régulièrement.
 */
export default function DashboardPage() {
  const { openNewSession } = useSessionLauncher();
  useTabTitle('Tableau de bord');
  const { data, loading, error, refetch } = useQuery<{ dashboard: Dashboard }>(DASHBOARD, { pollInterval: 10_000, fetchPolicy: 'cache-and-network' });
  const d = data?.dashboard;

  if (!d && loading) {
    return (
      <div className="d-flex align-items-center gap-2 text-secondary">
        <Spinner animation="border" size="sm" /> Chargement du tableau de bord…
      </div>
    );
  }
  if (!d) return <Alert variant="danger">{error?.message ?? 'Tableau de bord indisponible.'}</Alert>;

  if (d.projects.length === 0) return <EmptyState />;

  const { counts, usage } = d;
  const waiting = counts.pendingRequests + counts.idleSessions;

  return (
    <>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <h1 className="h3 mb-0">Tableau de bord</h1>
        <div className="d-flex align-items-center gap-2">
          <span className="text-secondary small d-none d-sm-inline">Mis à jour {timeAgo(d.generatedAt)}</span>
          <Button size="sm" variant="outline-secondary" onClick={() => refetch()} title="Rafraîchir">
            <i className="bi bi-arrow-clockwise" />
          </Button>
          <Button size="sm" variant="primary" onClick={() => openNewSession()}>
            <i className="bi bi-plus-lg me-1" /> Session
          </Button>
        </div>
      </div>
      {error && <Alert variant="warning" className="py-2 small">Dernier rafraîchissement en échec : {error.message}</Alert>}

      <div className="dash-tiles mb-4">
        <Link to="/requests" className={`dash-tile${counts.pendingRequests ? ' alert' : ''}`}>
          <div className="dash-tile-label"><i className="bi bi-hand-index-thumb" /> Demandes en attente</div>
          <div className="dash-tile-value">{counts.pendingRequests}</div>
          <div className="dash-tile-sub">
            {counts.pendingRequests ? 'Des agents sont bloqués jusqu’à votre réponse' : counts.idleSessions ? `${plural(counts.idleSessions, 'agent attend', 'agents attendent')} vos instructions` : 'Rien ne vous attend'}
          </div>
        </Link>
        <Link to="/sessions" className="dash-tile">
          <div className="dash-tile-label"><i className="bi bi-cpu" /> Agents au travail</div>
          <div className="dash-tile-value">
            {counts.busySessions}
            {counts.idleSessions > 0 && <small>+ {counts.idleSessions} en attente</small>}
          </div>
          <div className="dash-tile-sub">
            {counts.endedSessions24h ? `${plural(counts.endedSessions24h, 'session terminée', 'sessions terminées')} depuis 24 h` : 'Aucune session terminée depuis 24 h'}
            {counts.failedSessions24h > 0 && <span className="up">, {counts.failedSessions24h} en erreur</span>}
          </div>
        </Link>
        <Link to="/tasks" className={`dash-tile${counts.overdueTasks ? ' alert' : ''}`}>
          <div className="dash-tile-label"><i className="bi bi-check2-square" /> Tâches ouvertes</div>
          <div className="dash-tile-value">
            {counts.todoTasks + counts.inProgressTasks}
            <small>{counts.inProgressTasks} en cours</small>
          </div>
          <div className="dash-tile-sub">
            {counts.overdueTasks > 0 && <span className="up">{plural(counts.overdueTasks, 'en retard', 'en retard')} · </span>}
            {plural(counts.doneTasks7d, 'terminée', 'terminées')} sur 7 jours
          </div>
        </Link>
        <UsageTile usage={usage} />
      </div>

      <Row className="g-4">
        <Col lg={7}>
          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>À traiter{waiting > 0 && <Badge bg="warning" text="dark" className="ms-2">{waiting}</Badge>}</span>
              <Link to="/requests">Toutes les demandes</Link>
            </h2>
            <ul className="dash-list">
              {d.pendingRequests.map((r) => <RequestRow key={r.id} request={r} />)}
              {d.runningSessions.filter((s) => s.activity !== 'BUSY' && s.pendingRequestCount === 0).map((s) => <SessionRow key={s.id} session={s} hint="attend vos instructions" icon="bi-chat-left-dots warn" />)}
              {d.recentSessions.filter((s) => (s.status === 'FAILED' || s.status === 'INTERRUPTED') && isRecent(s.endedAt ?? s.updatedAt, 24)).map((s) => <SessionRow key={s.id} session={s} hint={s.error ? shorten(s.error, 80) : 'en erreur'} icon="bi-x-octagon bad" />)}
              {waiting === 0 && counts.failedSessions24h === 0 && <li className="empty">Rien à traiter : les agents n’ont besoin de rien pour l’instant.</li>}
            </ul>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Agents au travail</span>
              <Link to="/sessions">Toutes les sessions</Link>
            </h2>
            <ul className="dash-list">
              {d.runningSessions.filter((s) => s.activity === 'BUSY').map((s) => <SessionRow key={s.id} session={s} hint="travaille" icon="bi-cpu busy" />)}
              {counts.busySessions === 0 && <li className="empty">Aucun agent ne travaille en ce moment.</li>}
            </ul>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Tâches à surveiller</span>
              <Link to="/tasks">Toutes les tâches</Link>
            </h2>
            <ul className="dash-list">
              {d.attentionTasks.map((t) => <TaskRow key={t.id} task={t} />)}
              {d.attentionTasks.length === 0 && <li className="empty">Aucune tâche urgente, haute ou en retard.</li>}
            </ul>
          </section>
        </Col>

        <Col lg={5}>
          <UsageCard usage={usage} />

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Activité récente</span>
            </h2>
            <ul className="dash-list">
              {d.recentSessions.map((s) => <SessionRow key={s.id} session={s} icon={statusIcon(s)} hint={s.endedAt ? timeAgo(s.endedAt) : undefined} showStatus />)}
              {d.recentSessions.length === 0 && <li className="empty">Aucune session terminée pour l’instant.</li>}
            </ul>
          </section>
        </Col>
      </Row>

      <section className="dash-section">
        <h2 className="dash-section-title">
          <span>Projets</span>
          <Link to="/projects">Tous les projets</Link>
        </h2>
        <ProjectsTable projects={d.projects} />
      </section>
    </>
  );
}

// ---- Tuiles et cartes ---------------------------------------------------------------------------

function UsageTile({ usage }: { usage: DashboardUsage }) {
  const cap = usage.monthlyBudgetUsd;
  const ratio = cap ? Math.min(100, (usage.globalMonthUsd / cap) * 100) : 0;
  const delta = usage.previous7DaysUsd > 0 ? ((usage.last7DaysUsd - usage.previous7DaysUsd) / usage.previous7DaysUsd) * 100 : null;
  return (
    <div className={`dash-tile${ratio >= 80 ? ' alert' : ''}`}>
      <div className="dash-tile-label"><i className="bi bi-cash-coin" /> Consommation du mois</div>
      <div className="dash-tile-value">
        {formatCost(usage.monthUsd)}
        {cap ? <small>/ {formatCost(cap)}</small> : null}
      </div>
      {cap ? (
        <div className="dash-meter" title={`Plafond mensuel : ${formatCost(usage.globalMonthUsd)} consommés sur ${formatCost(cap)}, toutes sessions confondues`}>
          <div className={ratio >= 100 ? 'over' : ratio >= 80 ? 'warn' : ''} style={{ width: `${ratio}%` }} />
        </div>
      ) : null}
      <div className="dash-tile-sub">
        {formatCost(usage.todayUsd)} aujourd’hui · {formatCost(usage.last7DaysUsd)} sur 7 jours
        {delta !== null && Math.abs(delta) >= 5 && (
          <span className={delta > 0 ? 'up' : 'down'}> ({delta > 0 ? '+' : ''}{Math.round(delta)} % vs 7 jours précédents)</span>
        )}
      </div>
    </div>
  );
}

function UsageCard({ usage }: { usage: DashboardUsage }) {
  const monthLabel = new Date(usage.monthStart).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">
        <span>Consommation</span>
        <span className="text-secondary" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 12 }}>estimation au tarif API</span>
      </h2>
      <Card>
        <Card.Body className="pb-2">
          <div className="d-flex justify-content-between align-items-baseline">
            <span className="text-secondary small">Sur vos projets, en {monthLabel}</span>
            <span className="fw-semibold">{formatCost(usage.monthUsd)}</span>
          </div>
          {usage.monthlyBudgetUsd != null && usage.globalMonthUsd !== usage.monthUsd && (
            <div className="d-flex justify-content-between align-items-baseline small text-secondary">
              <span>Tous projets confondus (plafond {formatCost(usage.monthlyBudgetUsd)})</span>
              <span>{formatCost(usage.globalMonthUsd)}</span>
            </div>
          )}
          <DailyChart days={usage.byDay} />
          {usage.topSessions.length > 0 && (
            <Table size="sm" className="mt-3 mb-0">
              <thead>
                <tr>
                  <th>Sessions les plus coûteuses du mois</th>
                  <th className="text-end">Coût</th>
                </tr>
              </thead>
              <tbody>
                {usage.topSessions.map((r, i) => (
                  <tr key={r.sessionId ?? i}>
                    <td className="text-truncate" style={{ maxWidth: 260 }}>
                      {r.sessionId ? <Link to={`/sessions/${r.sessionId}`}>{r.sessionName ?? 'Session supprimée'}</Link> : <span className="text-secondary">Session supprimée</span>}
                      {r.projectName && <span className="text-secondary small ms-2">{r.projectName}</span>}
                    </td>
                    <td className="text-end text-nowrap">{formatCost(r.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {usage.monthUsd === 0 && <div className="text-secondary small mt-2">Aucune consommation enregistrée ce mois-ci.</div>}
        </Card.Body>
      </Card>
    </section>
  );
}

/** Colonnes par jour sur 30 jours, une seule série : la couleur d'accent, le jour courant en plein. */
function DailyChart({ days }: { days: { day: string; usd: number }[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  if (!days.length) return null;
  const height = 96;
  const padTop = 14;
  const padBottom = 14;
  const plotH = height - padTop - padBottom;
  const max = Math.max(...days.map((d) => d.usd), 0.01);
  const slot = width / days.length;
  const barW = Math.min(16, Math.max(3, slot - 2));
  const today = days[days.length - 1];
  const peak = days.reduce((a, b) => (b.usd > a.usd ? b : a), days[0]);
  const label = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return (
    <div ref={ref} className="dash-chart-wrap">
      {width > 0 && (
    <svg className="dash-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Consommation par jour sur ${days.length} jours`}>
      <line x1={0} x2={width} y1={height - padBottom} y2={height - padBottom} />
      {days.map((d, i) => {
        const h = d.usd > 0 ? Math.max(2, (d.usd / max) * plotH) : 0;
        const x = i * slot + (slot - barW) / 2;
        const y = height - padBottom - h;
        return (
          <g key={d.day}>
            <rect x={x} y={y} width={barW} height={h} rx={Math.min(4, barW / 2)} className={d === today ? 'today' : undefined} />
            <rect x={i * slot} y={0} width={slot} height={height} fill="transparent">
              <title>{`${label(d.day)} : ${formatCost(d.usd)}`}</title>
            </rect>
            {d === peak && d.usd > 0 && (
              <text x={Math.min(width - 4, Math.max(4, x + barW / 2))} y={Math.max(10, y - 3)} textAnchor={i < days.length / 4 ? 'start' : i > (days.length * 3) / 4 ? 'end' : 'middle'}>
                {formatCost(d.usd)}
              </text>
            )}
          </g>
        );
      })}
      <text x={2} y={height - 3}>{label(days[0].day)}</text>
      <text x={width - 2} y={height - 3} textAnchor="end">aujourd’hui</text>
    </svg>
      )}
    </div>
  );
}

/** Largeur courante d'un élément, suivie par ResizeObserver (le graphique se redessine avec la fenêtre). */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function ProjectsTable({ projects }: { projects: DashboardProject[] }) {
  const num = (v: number, warn = false) => <td className={`num${v === 0 ? ' zero' : warn ? ' text-warning' : ''}`}>{v}</td>;
  return (
    <>
    <ul className="dash-list dash-project-cards">
      {projects.map((p) => (
        <li key={p.project.id}>
          <div className="main">
            <Link to={`/projects/${p.project.id}`} className="title fw-semibold">{p.project.name}</Link>
            <div className="meta wrap">
              {p.busySessions > 0 && <span className="text-body"><i className="bi bi-cpu me-1" />{plural(p.busySessions, 'agent au travail', 'agents au travail')}</span>}
              {p.idleSessions > 0 && <span className="text-warning"><i className="bi bi-chat-left-dots me-1" />{plural(p.idleSessions, 'en attente', 'en attente')}</span>}
              {p.pendingRequests > 0 && <Link to="/requests" className="text-warning"><i className="bi bi-hand-index-thumb me-1" />{plural(p.pendingRequests, 'demande', 'demandes')}</Link>}
              <Link to={`/projects/${p.project.id}/tasks`} className="text-reset text-decoration-none"><i className="bi bi-check2-square me-1" />{p.todoTasks} à faire, {p.inProgressTasks} en cours</Link>
              {p.overdueTasks > 0 && <span className="text-warning">{plural(p.overdueTasks, 'en retard', 'en retard')}</span>}
              {p.busySessions + p.idleSessions + p.pendingRequests + p.todoTasks + p.inProgressTasks === 0 && <span>Rien en cours</span>}
            </div>
          </div>
          <div className="side">
            <div>{formatCost(p.monthUsd)}</div>
            <div>{p.lastActivityAt ? timeAgo(p.lastActivityAt) : '—'}</div>
          </div>
        </li>
      ))}
    </ul>
    <div className="table-responsive dash-project-table">
      <Table hover size="sm" className="align-middle dash-projects mb-0">
        <thead>
          <tr>
            <th>Projet</th>
            <th className="num" title="Agents qui travaillent">Au travail</th>
            <th className="num" title="Agents qui attendent vos instructions">En attente</th>
            <th className="num">Demandes</th>
            <th className="num">À faire</th>
            <th className="num">En cours</th>
            <th className="num">Ce mois</th>
            <th>Dernière activité</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.project.id}>
              <td className="name">
                <Link to={`/projects/${p.project.id}`} className="fw-semibold text-decoration-none">{p.project.name}</Link>
                <div className="small text-secondary">
                  {p.project.git?.branch && <span className="font-monospace me-2"><i className="bi bi-git me-1" />{p.project.git.branch}</span>}
                  {p.overdueTasks > 0 && <span className="text-warning">{plural(p.overdueTasks, 'tâche en retard', 'tâches en retard')}</span>}
                </div>
              </td>
              {num(p.busySessions)}
              {num(p.idleSessions, true)}
              <td className={`num${p.pendingRequests ? ' text-warning fw-semibold' : ' zero'}`}>
                {p.pendingRequests ? <Link to="/requests" className="text-warning">{p.pendingRequests}</Link> : 0}
              </td>
              <td className={`num${p.todoTasks === 0 ? ' zero' : ''}`}><Link to={`/projects/${p.project.id}/tasks`} className="text-reset text-decoration-none">{p.todoTasks}</Link></td>
              {num(p.inProgressTasks)}
              <td className={`num${p.monthUsd === 0 ? ' zero' : ''}`}>{formatCost(p.monthUsd)}</td>
              <td className="text-secondary small">{p.lastActivityAt ? timeAgo(p.lastActivityAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
    </>
  );
}

// ---- Lignes de liste ----------------------------------------------------------------------------

function RequestRow({ request }: { request: HumanRequest }) {
  return (
    <li>
      <i className={`bi ${request.type === 'question' ? 'bi-question-circle' : 'bi-hand-index-thumb'} icon warn`} />
      <div className="main">
        <Link to={`/sessions/${request.session.id}`} className="title">{requestTitle(request)}</Link>
        <div className="meta">{request.session.name} · {request.session.project.name}</div>
      </div>
      <div className="side">{timeAgo(request.createdAt)}</div>
    </li>
  );
}

function SessionRow({ session, hint, icon, showStatus }: { session: Session; hint?: string; icon: string; showStatus?: boolean }) {
  const state = hint ?? sessionStateHint(session.status, session.activity, session.pendingRequestCount);
  return (
    <li>
      <i className={`bi ${icon} icon`} />
      <div className="main">
        <Link to={`/sessions/${session.id}`} className="title">{session.name}</Link>
        <div className="meta">
          {session.project.name}
          {session.worktree && <span className="font-monospace"> · {session.worktree.branch}</span>}
          {state && !showStatus && ` · ${state}`}
        </div>
      </div>
      <div className="side">
        {showStatus ? <StatusBadge status={session.status} /> : null}
        {showStatus && session.costUsd > 0 && <div>{formatCost(session.costUsd)}</div>}
        {showStatus ? <div>{hint}</div> : session.startedAt ? `depuis ${timeAgo(session.startedAt).replace('il y a ', '')}` : null}
      </div>
    </li>
  );
}

function TaskRow({ task }: { task: Task }) {
  const overdue = task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10);
  const prio = taskPriorityLabels[task.priority];
  return (
    <li>
      <i className={`bi bi-check2-square icon${overdue ? ' bad' : task.priority === 'URGENT' ? ' warn' : ''}`} />
      <div className="main">
        <Link to={`/projects/${task.project.id}/tasks`} className="title">{task.title}</Link>
        <div className="meta">
          {task.project.name} · {taskStatusLabels[task.status]}
          {task.session && <> · <Link to={`/sessions/${task.session.id}`}>{task.session.name}</Link></>}
        </div>
      </div>
      <div className="side">
        <Badge bg={prio.bg} text={prio.bg === 'warning' ? 'dark' : undefined}>{prio.label}</Badge>
        {task.dueDate && <div className={overdue ? 'text-danger' : undefined}>{overdue ? 'en retard · ' : 'pour le '}{new Date(`${task.dueDate}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</div>}
      </div>
    </li>
  );
}

/** Sans projet : le parcours en trois étapes, comme avant. */
function EmptyState() {
  return (
    <>
      <h1 className="h3 mb-2">Bienvenue sur Skipper</h1>
      <p className="text-secondary mb-4" style={{ maxWidth: 720 }}>
        Skipper vous permet de confier du travail à des agents (Claude Code, pour commencer) qui travaillent en arrière-plan sur vos projets.
        Vous gardez la main : vous leur donnez des instructions, vous suivez ce qu'ils font, et ils vous demandent votre accord avant les actions sensibles.
      </p>
      <Row className="g-3">
        {[
          { n: 1, icon: 'bi-folder2', title: 'Créez un projet', text: 'Un projet regroupe un dossier de travail (avec, si vous voulez, un dépôt git), des instructions permanentes pour les agents, et leurs sessions.', to: '/projects/new', cta: 'Nouveau projet', primary: true },
          { n: 2, icon: 'bi-chat-dots', title: 'Lancez une session', text: "Décrivez ce que l'agent doit faire. Il travaille en arrière-plan, vous suivez ses actions en direct et pouvez lui écrire à tout moment.", to: '/sessions', cta: 'Nouvelle session', disabled: true },
          { n: 3, icon: 'bi-bell', title: 'Répondez aux demandes', text: "Quand un agent veut modifier un fichier, lancer une commande ou a une question, il vous demande. Autorisez, refusez ou expliquez.", to: '/requests', cta: 'Voir les demandes' },
        ].map((step) => (
          <Col md={4} key={step.n}>
            <Card className="h-100">
              <Card.Body>
                <div className="fs-4 mb-2">
                  <i className={`bi ${step.icon} text-secondary`} /> <span className="badge bg-secondary">{step.n}</span>
                </div>
                <Card.Title className="h6">{step.title}</Card.Title>
                <Card.Text className="text-secondary small">{step.text}</Card.Text>
                <Button as={Link as any} to={step.to} size="sm" variant={step.primary ? 'primary' : 'outline-secondary'} disabled={step.disabled}>
                  {step.cta}
                </Button>
              </Card.Body>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  );
}

// ---- Utilitaires --------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isRecent = (iso: string, hours: number) => Date.now() - new Date(iso).getTime() < hours * 3600_000;
const statusIcon = (s: Session) => (s.status === 'COMPLETED' ? 'bi-check-circle' : s.status === 'FAILED' || s.status === 'INTERRUPTED' ? 'bi-x-octagon bad' : 'bi-stop-circle');
