import { Badge } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import AgentAvatar from '../../components/AgentAvatar';
import { PullRequestRow, RequestRow, SessionRow, TaskRow, isRecent, shorten, stalledHint, statusIcon } from '../../components/DashboardRows';
import { agentKindLabels } from '../../graphql/agents';
import type { ProjectDashboard, ProjectTeamMember } from '../../graphql/dashboard';
import { formatCost, timeAgo } from '../../lib/humanize';
import { isOpen } from '../../lib/taskStats';
import { initialsOf } from '../../workbench/WorkspaceTabs';
import { Section, boolParam, fold, intParam, tagsParam, withTags, type WidgetProps } from '../registry';

/** Listes du tableau de bord (`.dash-list`) : à traiter, agents, tâches, pull requests, équipe, échéances, activité. */

const title = (p: WidgetProps, def: string) => p.block.title || def;

/** À traiter : demandes, sessions en erreur ou interrompues, tâches à l'agent arrêté ; dans un projet aussi les tâches « à valider » et les PR à fusionner. */
export function ListTodoWidget(p: WidgetProps) {
  const { ctx } = p;
  const d = ctx.kind === 'project' ? ctx.project?.d : ctx.home;
  if (!d) return null;
  const inProject = ctx.kind === 'project';
  const failed = d.recentSessions.filter((s) => s.status === 'FAILED' && isRecent(s.endedAt ?? s.updatedAt, 24));
  const interrupted = d.recentSessions.filter((s) => s.status === 'INTERRUPTED' && s.activity === 'BUSY' && isRecent(s.endedAt ?? s.updatedAt, 24));
  const stale = d.staleTasks ?? [];
  const toValidate = inProject ? (d as ProjectDashboard).tasks.filter((t) => isOpen(t) && t.statusTag && fold(t.statusTag) === 'a valider' && !t.stalledSince) : [];
  const prs = inProject ? d.pullRequests : [];
  const total = d.pendingRequests.length + failed.length + interrupted.length + stale.length + toValidate.length + prs.length;
  return (
    <Section title={<>{title(p, 'À traiter')}{total > 0 && <Badge bg="warning" text="dark" className="ms-2">{total}</Badge>}</>} link={inProject ? { to: '/inbox', label: 'Toute la file' } : { to: '/requests', label: 'Toutes les demandes' }}>
      <ul className="dash-list">
        {d.pendingRequests.map((r) => <RequestRow key={r.id} request={r} showProject={!inProject} />)}
        {failed.map((s) => <SessionRow key={s.id} session={s} hint={s.error ? shorten(s.error, 80) : 'en erreur'} icon="bi-x-octagon bad" showProject={!inProject} refetch={ctx.refetch} />)}
        {interrupted.map((s) => <SessionRow key={s.id} session={s} hint="interrompue en plein travail par un redémarrage" icon="bi-pause-circle warn" showProject={!inProject} refetch={ctx.refetch} />)}
        {stale.map((t) => <TaskRow key={t.id} task={t} showProject={!inProject} hint={stalledHint(t)} icon="bi-person-x bad" toSession />)}
        {toValidate.map((t) => <TaskRow key={t.id} task={t} showProject={false} hint="à valider : quelque chose à essayer" icon="bi-eye" toSession />)}
        {prs.map((pr) => <PullRequestRow key={pr.id} pr={pr} showProject={false} />)}
        {total === 0 && <li className="empty">Rien à traiter : les agents n’ont besoin de rien pour l’instant.</li>}
      </ul>
    </Section>
  );
}

export function ListRunningSessionsWidget(p: WidgetProps) {
  const { ctx, params } = p;
  const d = ctx.kind === 'project' ? ctx.project?.d : ctx.home;
  if (!d) return null;
  const busy = d.runningSessions.filter((s) => s.activity === 'BUSY').slice(0, intParam(params, 'limit', 10));
  return (
    <Section title={title(p, 'Agents au travail')} link={{ to: '/sessions', label: 'Toutes les sessions' }}>
      <ul className="dash-list">
        {busy.map((s) => <SessionRow key={s.id} session={s} hint="travaille" icon="bi-cpu busy" showProject={ctx.kind === 'home'} refetch={ctx.refetch} />)}
        {busy.length === 0 && <li className="empty">Aucun agent ne travaille en ce moment.</li>}
      </ul>
    </Section>
  );
}

export function ListAttentionTasksWidget(p: WidgetProps) {
  const { ctx, params } = p;
  const d = ctx.kind === 'project' ? ctx.project?.d : ctx.home;
  if (!d) return null;
  const tags = tagsParam(params);
  const tasks = withTags(d.attentionTasks, tags).slice(0, intParam(params, 'limit', 10));
  const to = ctx.kind === 'project' && ctx.project ? `/projects/${ctx.project.project.id}/tasks` : '/tasks';
  return (
    <Section title={title(p, 'Tâches à surveiller')} link={{ to, label: 'Toutes les tâches' }}>
      <ul className="dash-list">
        {tasks.map((t) => <TaskRow key={t.id} task={t} showProject={ctx.kind === 'home'} />)}
        {tasks.length === 0 && <li className="empty">{tags.length ? `Aucune tâche ${tags.join(', ')} urgente, haute ou en retard.` : 'Aucune tâche urgente, haute ou en retard.'}</li>}
      </ul>
    </Section>
  );
}

export function ListPullRequestsWidget(p: WidgetProps) {
  const { ctx, params } = p;
  const d = ctx.kind === 'project' ? ctx.project?.d : ctx.home;
  if (!d) return null;
  const prs = d.pullRequests.slice(0, intParam(params, 'limit', 10));
  const c = d.counts;
  return (
    <Section
      title={
        <>
          {title(p, 'Pull requests à traiter')}
          {c.openPullRequests > 0 && <Badge bg="success" className="ms-2 fw-normal" title="À fusionner">{c.openPullRequests} à fusionner</Badge>}
          {c.pendingPullRequests > 0 && <Badge bg="secondary" className="ms-2 fw-normal" title="Branches avec des modifications, sans pull request ouverte">{c.pendingPullRequests} en préparation</Badge>}
        </>
      }
      link={ctx.kind === 'project' && ctx.project ? { to: `/projects/${ctx.project.project.id}/pull-requests`, label: 'Toutes les pull requests' } : null}
    >
      <ul className="dash-list">
        {prs.map((pr) => <PullRequestRow key={pr.id} pr={pr} showProject={ctx.kind === 'home'} />)}
        {prs.length === 0 && <li className="empty">Aucune pull request à fusionner.</li>}
      </ul>
    </Section>
  );
}

export function ListUpcomingWidget(p: WidgetProps) {
  const { ctx, params } = p;
  if (!ctx.project) return null;
  const { project, d } = ctx.project;
  const limit = intParam(params, 'limit', 6);
  const schedules = d.schedules.filter((s) => s.enabled && s.nextRunAt).slice(0, Math.max(1, Math.floor(limit / 2)));
  const upcomingTasks = d.tasks.filter((t) => isOpen(t) && t.dueDate).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')).slice(0, Math.max(1, limit - schedules.length));
  return (
    <Section title={title(p, 'Prochainement')} link={{ to: `/projects/${project.id}/schedules`, label: 'Planifications' }}>
      <ul className="dash-list">
        {schedules.map((s) => (
          <li key={s.id}>
            <i className="bi bi-alarm icon" />
            <div className="main">
              <Link to={`/projects/${project.id}/schedules?edit=${s.id}`} className="title">{s.name}</Link>
              <div className="meta">{s.owner?.name ?? 'planification'}{s.lastResult && ` · dernière exécution : ${s.lastResult}`}</div>
            </div>
            <div className="side">{s.nextRunAt && new Date(s.nextRunAt).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          </li>
        ))}
        {upcomingTasks.map((t) => <TaskRow key={t.id} task={t} showProject={false} hint="échéance" icon="bi-calendar-event" />)}
        {schedules.length === 0 && upcomingTasks.length === 0 && <li className="empty">Aucune échéance ni planification.</li>}
      </ul>
    </Section>
  );
}

interface ActivityItem {
  key: string;
  icon: string;
  title: string;
  meta: string;
  at: string;
  to?: string;
  href?: string;
}

/** Sessions terminées, PR fusionnées et tâches terminées, mêlées par date. */
function recentActivity(d: ProjectDashboard, limit: number): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const s of d.recentSessions.slice(0, limit)) items.push({ key: `s-${s.id}`, icon: statusIcon(s), title: s.name, meta: `session ${s.status === 'COMPLETED' ? 'terminée' : s.status === 'FAILED' ? 'en erreur' : s.status === 'INTERRUPTED' ? 'interrompue' : 'arrêtée'}${s.owner ? ` · ${s.owner.name}` : ''}${s.costUsd > 0 ? ` · ${formatCost(s.costUsd)}` : ''}`, at: s.endedAt ?? s.updatedAt, to: `/sessions/${s.id}` });
  for (const pr of d.mergedPullRequests.slice(0, limit)) items.push({ key: `pr-${pr.id}`, icon: 'bi-git', title: `${pr.title}`, meta: `pull request fusionnée${pr.task ? ` · ${pr.task.title}` : ''}`, at: pr.mergedAt ?? pr.updatedAt, href: pr.url });
  for (const t of d.tasks.filter((x) => x.status === 'DONE' && x.completedAt).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).slice(0, limit)) items.push({ key: `t-${t.id}`, icon: 'bi-check2-square', title: t.title, meta: `tâche terminée${t.assignee?.name ? ` · ${t.assignee.name}` : ''}`, at: t.completedAt ?? t.updatedAt, to: `/tasks/${t.id}` });
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export function ListActivityWidget(p: WidgetProps) {
  const { ctx, params } = p;
  const limit = intParam(params, 'limit', 8);
  if (ctx.kind === 'project') {
    if (!ctx.project) return null;
    const { project, d } = ctx.project;
    const activity = recentActivity(d, limit);
    return (
      <Section title={title(p, 'Activité récente')} link={{ to: `/projects/${project.id}/history`, label: 'Historique' }}>
        <ul className="dash-list">
          {activity.map((a) => (
            <li key={a.key}>
              <i className={`bi ${a.icon} icon`} />
              <div className="main">
                {a.href ? (
                  <a href={a.href} target="_blank" rel="noreferrer" className="title">{a.title}</a>
                ) : (
                  <Link to={a.to ?? '#'} className="title">{a.title}</Link>
                )}
                <div className="meta">{a.meta}</div>
              </div>
              <div className="side">{timeAgo(a.at)}</div>
            </li>
          ))}
          {activity.length === 0 && <li className="empty">Rien de récent.</li>}
        </ul>
      </Section>
    );
  }
  const d = ctx.home;
  if (!d) return null;
  const sessions = d.recentSessions.slice(0, limit);
  return (
    <Section title={title(p, 'Activité récente')}>
      <ul className="dash-list">
        {sessions.map((s) => <SessionRow key={s.id} session={s} icon={statusIcon(s)} hint={s.endedAt ? timeAgo(s.endedAt) : undefined} showStatus refetch={ctx.refetch} />)}
        {sessions.length === 0 && <li className="empty">Aucune session terminée pour l’instant.</li>}
      </ul>
    </Section>
  );
}

export function UsageTopSessionsWidget(p: WidgetProps) {
  const { ctx, params } = p;
  const usage = ctx.kind === 'project' ? ctx.project?.d.usage : ctx.home?.usage;
  if (!usage) return null;
  const rows = usage.topSessions.slice(0, intParam(params, 'limit', 5));
  return (
    <Section title={title(p, 'Sessions les plus coûteuses du mois')}>
      <ul className="dash-list">
        {rows.map((r, i) => (
          <li key={r.sessionId ?? i}>
            <i className="bi bi-cash-coin icon" />
            <div className="main">
              {r.sessionId ? <Link to={`/sessions/${r.sessionId}`} className="title">{r.sessionName ?? 'Session supprimée'}</Link> : <span className="title text-secondary">Session supprimée</span>}
              {ctx.kind === 'home' && r.projectName && <div className="meta">{r.projectName}</div>}
            </div>
            <div className="side">{formatCost(r.usd)}</div>
          </li>
        ))}
        {rows.length === 0 && <li className="empty">Aucune consommation enregistrée ce mois-ci.</li>}
      </ul>
    </Section>
  );
}

/** Un membre de l'équipe : avatar, ce qu'il fait (tâches en charge de ses sessions), état. */
function TeamRow({ member: m, projectId }: { member: ProjectTeamMember; projectId: string }) {
  const busy = m.sessions.some((s) => s.activity === 'BUSY');
  const waiting = m.sessions.some((s) => s.pendingRequestCount > 0 || s.activity !== 'BUSY');
  const doing = m.tasks.length ? m.tasks.map((t) => t.title).slice(0, 2).join(', ') + (m.tasks.length > 2 ? ` et ${m.tasks.length - 2} autre${m.tasks.length > 3 ? 's' : ''}` : '') : m.sessions.length ? m.sessions.map((s) => s.name).slice(0, 2).join(', ') : null;
  return (
    <li>
      {m.agent ? <AgentAvatar agent={m.agent} size={26} className="icon" /> : <span className="dash-initials">{initialsOf(m.user.name || m.user.email)}</span>}
      <div className="main">
        <span className="title">
          {m.agent ? <Link to={`/projects/${projectId}/agents/${m.agent.id}`}>{m.user.name}</Link> : m.user.name || m.user.email}
          {m.agent && <span className="text-secondary small ms-2">{agentKindLabels[m.agent.kind]}</span>}
        </span>
        <div className="meta">
          {doing ? (
            <>
              {m.tasks.length ? 'sur ' : ''}
              {m.tasks.length ? m.tasks.slice(0, 2).map((t, i) => <span key={t.id}>{i > 0 && ', '}<Link to={`/tasks/${t.id}`}>{t.title}</Link>{t.statusTag && ` (${t.statusTag})`}</span>) : doing}
            </>
          ) : (
            <span>{m.agent ? 'disponible' : 'aucune session en cours'}</span>
          )}
        </div>
      </div>
      <div className="side">
        {busy ? (
          <span className="text-success"><i className="bi bi-circle-fill me-1" style={{ fontSize: 8 }} />au travail</span>
        ) : waiting && m.sessions.length ? (
          <span className="text-warning"><i className="bi bi-circle-fill me-1" style={{ fontSize: 8 }} />en attente</span>
        ) : m.lastActivityAt ? (
          `actif ${timeAgo(m.lastActivityAt)}`
        ) : (
          '—'
        )}
      </div>
    </li>
  );
}

export function ListTeamWidget(p: WidgetProps) {
  const { ctx, params } = p;
  if (!ctx.project) return null;
  const { project, d } = ctx.project;
  const team = boolParam(params, 'onlyAgents') ? d.team.filter((m) => m.agent) : d.team;
  return (
    <Section title={title(p, 'L’équipe en ce moment')} link={{ to: `/projects/${project.id}/agents`, label: 'Agents' }}>
      <ul className="dash-list">
        {team.map((m) => <TeamRow key={m.user.id} member={m} projectId={project.id} />)}
        {team.length === 0 && <li className="empty">Aucun membre.</li>}
      </ul>
    </Section>
  );
}
