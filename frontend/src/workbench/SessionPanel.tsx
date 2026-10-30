import { useQuery } from '@apollo/client';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ContextBanner, ContextGauge } from '../components/ContextGauge';
import { SessionChildren, SessionParentNote, useSessionActions, type ControlledSession } from '../components/SessionControls';
import { SESSION } from '../graphql/operations';
import { formatCost, permissionModeLabels, sessionStateHint, sessionStatusLabels } from '../lib/humanize';
import { sessionDotClass } from './WorkspaceTabs';
import '../components/terminal.css';

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Onglet « Session » du panneau de droite, à côté d'une page de session : ce que l'en-tête de la page montrait
 * (projet, branche, personne, tâche, workflow, planification, jauge de contexte), le bandeau de contexte au-delà du
 * seuil (compacter, repartir d'une conversation neuve, ignorer) et toutes ses actions.
 * La requête est celle de la page, qui la sonde : le panneau lit le cache.
 */
export default function SessionPanel({ sessionId }: { sessionId: string }) {
  const { data } = useQuery<{ session: ControlledSession | null }>(SESSION, { variables: { id: sessionId } });
  const { user } = useAuth();
  const session = data?.session ?? null;
  const actions = useSessionActions(session);
  if (!session) return <div className="git-empty p-2">Chargement de la session…</div>;
  const hint = sessionStateHint(session.status, session.activity, session.pendingRequestCount) ?? (session.archivedAt ? 'archivée' : sessionStatusLabels[session.status]?.toLowerCase());
  const schedule = session.schedule;
  const model = typeof session.config.model === 'string' ? session.config.model : null;
  const permissionMode = typeof session.config.permissionMode === 'string' ? session.config.permissionMode : 'default';
  const busy = session.status === 'RUNNING' && session.activity === 'BUSY';
  return (
    <div className="git-body session-panel">
      <div className="session-panel-head">
        <span className={`wb-dot ${sessionDotClass(session)}`} />
        <span className="session-panel-title" title={session.name}>
          {session.name}
        </span>
      </div>
      <div className="session-panel-state">
        {hint && <span>{hint}</span>}
        {session.archivedAt && <span className="cc-yellow"> · archivée</span>}
        {session.context.tokens !== null && (
          <span className="session-panel-gauge">
            <ContextGauge context={session.context} onClick={actions.openSettings} />
          </span>
        )}
      </div>
      <ContextBanner session={session} busy={busy} />
      <div className="cc-actions stacked">{actions.buttons}</div>

      <div className="git-subhead">Détail</div>
      <dl className="session-panel-fields">
        <div>
          <dt>Projet</dt>
          <dd>
            <Link to={`/projects/${session.project.id}`}>{session.project.name}</Link>
          </dd>
        </div>
        {session.worksession && (
          <div>
            <dt>Branche</dt>
            <dd className="font-monospace">
              <i className="bi bi-git me-1" />
              {session.worksession.branch}
            </dd>
          </div>
        )}
        {!session.worksession && session.formerWorksession && (
          <div>
            <dt>Branche</dt>
            <dd className="font-monospace" title="La session a travaillé sur cette branche ; son dossier de travail a été supprimé depuis">
              <i className="bi bi-git me-1" />
              {session.formerWorksession.branch} <span className="cc-dimmer">(dossier supprimé)</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Dossier</dt>
          <dd className="font-monospace cc-dim" title="Dossier de travail de la session">
            {session.worksession?.path ?? session.project.workspacePath}
          </dd>
        </div>
        <div>
          <dt>Personne</dt>
          <dd>{session.owner ? (session.owner.id === user?.id ? 'moi' : session.owner.name ?? session.owner.email) : <span className="cc-dimmer">—</span>}</dd>
        </div>
        {session.task && (
          <div>
            <dt>Tâche</dt>
            <dd>
              <Link to={`/tasks/${session.task.id}`}>
                <i className="bi bi-check2-square me-1" />
                {session.task.title}
              </Link>
            </dd>
          </div>
        )}
        {session.workflowRun && (
          <div>
            <dt>Workflow</dt>
            <dd>
              <Link to={`/workflows/${session.workflowRun.workflow.id}/runs/${session.workflowRun.id}`} title="Exécution de workflow qui a ouvert cette session">
                <i className="bi bi-diagram-3 me-1" />
                {session.workflowRun.workflow.name}
              </Link>
            </dd>
          </div>
        )}
        <div>
          <dt>Planification</dt>
          <dd>
            {schedule ? (
              <button type="button" className="cc-link" title={`${schedule.cron} (${schedule.timezone})${schedule.lastResult ? ` · dernière exécution : ${schedule.lastResult}` : ''}`} onClick={actions.openSchedule}>
                <i className="bi bi-alarm me-1" />
                {schedule.enabled ? (schedule.nextRunAt ? `prochaine le ${new Date(schedule.nextRunAt).toLocaleString()}` : 'planifiée') : 'désactivée'}
              </button>
            ) : (
              <button type="button" className="cc-link" onClick={actions.openSchedule}>
                aucune · planifier
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>Modèle</dt>
          <dd>{model ?? <span className="cc-dimmer">par défaut</span>}</dd>
        </div>
        <div>
          <dt>Autorisations</dt>
          <dd>{permissionModeLabels[permissionMode] ?? permissionMode}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            <code>{session.provider}</code>
            {session.exitCode !== null && <span className="cc-dim"> · exit {session.exitCode}</span>}
          </dd>
        </div>
        {session.costUsd > 0 && (
          <div>
            <dt>Coût</dt>
            <dd>{formatCost(session.costUsd)}</dd>
          </div>
        )}
        <div>
          <dt>Créée</dt>
          <dd>{fmt(session.createdAt)}</dd>
        </div>
        {session.endedAt && (
          <div>
            <dt>Terminée</dt>
            <dd>{fmt(session.endedAt)}</dd>
          </div>
        )}
      </dl>

      {session.parentSession && (
        <>
          <div className="git-subhead">Lancée par</div>
          <SessionParentNote session={session} compact />
        </>
      )}
      {session.childSessions.length > 0 && (
        <>
          <div className="git-subhead">
            {session.childSessions.length > 1 ? `${session.childSessions.length} sous-agents` : '1 sous-agent'}
          </div>
          <SessionChildren children={session.childSessions} stacked />
        </>
      )}
      {actions.modals}
    </div>
  );
}
