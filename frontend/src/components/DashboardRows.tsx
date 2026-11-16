import { useMutation } from '@apollo/client';
import { Badge, Button } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { RESUME_SESSION, type DashboardUsage, type HumanRequest, type Session, type Task } from '../graphql/operations';
import { forgeOfUrl, prRef, type TrackedPullRequest } from '../graphql/pullRequests';
import { formatCost, requestTitle, sessionStateHint, taskPriorityLabels, taskStatusLabels, timeAgo } from '../lib/humanize';
import { useDialogs } from './Dialogs';
import RateLimitGauges, { busiestWindow } from './RateLimitGauges';
import StatusBadge from './StatusBadge';
import { PullRequestStageBadge, TrackedPullRequestIndicators } from './TrackedPullRequests';

/**
 * Lignes et tuiles partagées par le tableau de bord d'accueil (tous projets) et le tableau de bord d'un projet :
 * une demande, une session, une tâche, une pull request (listes `.dash-list`), et la tuile de consommation.
 * Styles dans pages/dashboard.css.
 */

export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
export const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const isRecent = (iso: string, hours: number) => Date.now() - new Date(iso).getTime() < hours * 3600_000;
export const statusIcon = (s: Session) => (s.status === 'COMPLETED' ? 'bi-check-circle' : s.status === 'FAILED' ? 'bi-x-octagon bad' : s.status === 'INTERRUPTED' ? 'bi-pause-circle' : 'bi-stop-circle');

export function UsageTile({ usage }: { usage: DashboardUsage }) {
  const cap = usage.monthlyBudgetUsd;
  const ratio = cap ? Math.min(100, (usage.globalMonthUsd / cap) * 100) : 0;
  const delta = usage.previous7DaysUsd > 0 ? ((usage.last7DaysUsd - usage.previous7DaysUsd) / usage.previous7DaysUsd) * 100 : null;
  const limits = usage.rateLimits;
  const busiest = limits ? busiestWindow(limits) : null;
  const limitAlert = Boolean(limits && (limits.status === 'rejected' || (busiest?.utilization ?? 0) >= 0.75));
  return (
    <div className={`dash-tile${ratio >= 80 || limitAlert ? ' alert' : ''}`}>
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
      {limits && busiest && (
        <div className="dash-tile-sub" title="Limites d'utilisation de l'abonnement Claude : fenêtre la plus chargée">
          {limits.status === 'rejected' ? (
            <span className="up">Limite atteinte ({limits.rateLimitLabel ?? busiest.label}) : tours refusés</span>
          ) : (
            <span className={(busiest.utilization ?? 0) >= 0.75 ? 'up' : undefined}>
              Limite Claude : {busiest.label} à {Math.round((busiest.utilization ?? 0) * 100)} %
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export { RateLimitGauges };

export function RequestRow({ request, showProject = true }: { request: HumanRequest; showProject?: boolean }) {
  return (
    <li>
      <i className={`bi ${request.type === 'question' ? 'bi-question-circle' : request.type === 'approval' ? 'bi-shield-check' : 'bi-hand-index-thumb'} icon warn`} />
      <div className="main">
        <Link to={`/sessions/${request.session.id}`} className="title">{requestTitle(request)}</Link>
        <div className="meta">{request.session.name}{showProject && ` · ${request.session.project.name}`}</div>
      </div>
      <div className="side">{timeAgo(request.createdAt)}</div>
    </li>
  );
}

export function SessionRow({ session, hint, icon, showStatus, showProject = true, refetch = ['Dashboard'] }: { session: Session; hint?: string; icon: string; showStatus?: boolean; showProject?: boolean; refetch?: string[] }) {
  const state = hint ?? sessionStateHint(session.status, session.activity, session.pendingRequestCount);
  const { showError } = useDialogs();
  const [resumeSession, { loading: resuming }] = useMutation(RESUME_SESSION, { refetchQueries: refetch, onError: (err) => void showError(err) });
  return (
    <li>
      <i className={`bi ${icon} icon`} />
      <div className="main">
        <Link to={`/sessions/${session.id}`} className="title">{session.name}</Link>
        <div className="meta">
          {showProject ? session.project.name : session.owner?.name ?? ''}
          {session.worksession && <span className="font-monospace"> · {session.worksession.branch}</span>}
          {state && !showStatus && ` · ${state}`}
        </div>
      </div>
      <div className="side">
        {session.status === 'INTERRUPTED' && (
          <Button size="sm" variant="outline-primary" disabled={resuming} title={session.activity === 'BUSY' ? "L'agent reprend le travail coupé par l'interruption" : "Rend la session reprenable sans lancer de tour (rien n'est facturé) : votre prochain message la relance"} onClick={() => void resumeSession({ variables: { id: session.id } })}>
            <i className="bi bi-play-fill" /> {resuming ? 'Reprise…' : 'Reprendre'}
          </Button>
        )}
        {showStatus ? <StatusBadge status={session.status} /> : null}
        {showStatus && session.costUsd > 0 && <div>{formatCost(session.costUsd)}</div>}
        {showStatus ? <div>{hint}</div> : session.startedAt ? `depuis ${timeAgo(session.startedAt).replace('il y a ', '')}` : null}
      </div>
    </li>
  );
}

/** Sous-titre d'une tâche « agent arrêté » dans « À traiter ». */
export const stalledHint = (t: Pick<Task, 'stalledSince'> & Partial<Pick<Task, 'wakeAt' | 'wakeNote'>>) =>
  t.wakeAt && new Date(t.wakeAt) <= new Date()
    ? `en cours, réveil passé (${timeAgo(t.wakeAt)})${t.wakeNote ? ` : ${t.wakeNote.slice(0, 120)}` : ''}`
    : `en cours, mais l'agent s'est arrêté${t.stalledSince ? ` ${timeAgo(t.stalledSince)}` : ''} sans la terminer`;

/**
 * `toSession` (listes « À traiter ») : le titre mène à la session de la tâche, là où l'on agit, et la tâche passe en lien
 * secondaire ; sans session, il mène à la tâche.
 */
export function TaskRow({ task, showProject = true, hint, icon, toSession = false }: { task: Task; showProject?: boolean; hint?: string; icon?: string; toSession?: boolean }) {
  const viaSession = toSession && task.session != null;
  const overdue = task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10);
  const prio = taskPriorityLabels[task.priority];
  return (
    <li>
      <i className={`bi ${icon ?? 'bi-check2-square'} icon${overdue ? ' bad' : task.priority === 'URGENT' ? ' warn' : ''}`} />
      <div className="main">
        <Link to={viaSession ? `/sessions/${task.session!.id}` : `/tasks/${task.id}`} className="title" title={viaSession ? `Ouvrir la session « ${task.session!.name} »` : undefined}>{task.title}</Link>
        <div className="meta">
          {showProject && `${task.project.name} · `}
          {hint ?? taskStatusLabels[task.status]}
          {task.statusTag && ` · ${task.statusTag}`}
          {viaSession ? <> · <Link to={`/tasks/${task.id}`}>tâche</Link></> : task.session && <> · <Link to={`/sessions/${task.session.id}`}>{task.session.name}</Link></>}
        </div>
      </div>
      <div className="side">
        <Badge bg={prio.bg} text={prio.bg === 'warning' ? 'dark' : undefined}>{prio.label}</Badge>
        {task.dueDate && <div className={overdue ? 'text-danger' : undefined}>{overdue ? 'en retard · ' : 'pour le '}{new Date(`${task.dueDate}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</div>}
      </div>
    </li>
  );
}

/** Session à ouvrir pour agir sur une PR : celle qui la suit (dossier de la branche), sinon celle qui l'a ouverte. */
export const prSession = (pr: Pick<TrackedPullRequest, 'session' | 'createdBySession'>) => pr.session ?? pr.createdBySession;

/**
 * Une pull request suivie qui attend une action : relecture et fusion. Le titre mène à la session qui la suit (on lui
 * demande de fusionner, corriger, résoudre) ; le numéro, et le titre faute de session, ouvrent la forge.
 */
export function PullRequestRow({ pr, showProject = true }: { pr: TrackedPullRequest; showProject?: boolean }) {
  const session = prSession(pr);
  return (
    <li>
      <i className="bi bi-git icon" />
      <div className="main">
        {session ? (
          <span className="title">
            <a href={pr.url} target="_blank" rel="noreferrer" className="text-secondary" title={`Ouvrir sur ${forgeOfUrl(pr.url)}`}>{prRef(pr)}</a>{' '}
            <Link to={`/sessions/${session.id}`} title={`Ouvrir la session « ${session.name} »`}>{pr.title}</Link>
          </span>
        ) : (
          <a href={pr.url} target="_blank" rel="noreferrer" className="title" title={`Ouvrir sur ${forgeOfUrl(pr.url)}`}>
            <span className="text-secondary">{prRef(pr)}</span> {pr.title}
          </a>
        )}
        <div className="meta">
          {showProject && <Link to={`/projects/${pr.project.id}/pull-requests`}>{pr.project.name}</Link>}
          {pr.task && <>{showProject && ' · '}<Link to={`/tasks/${pr.task.id}`}>{pr.task.title}</Link></>}
          {session && <> · <Link to={`/sessions/${session.id}`}>{session.name}</Link></>}
          {pr.note && <> · {pr.note}</>}
        </div>
      </div>
      <div className="side d-flex align-items-center gap-1">
        <TrackedPullRequestIndicators pr={pr} />
        <PullRequestStageBadge stage={pr.stage} />
      </div>
    </li>
  );
}
