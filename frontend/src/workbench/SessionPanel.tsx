import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { useDialogs } from '../components/Dialogs';
import { APPLY_ENV_FILES, type EnvApplyResult } from '../graphql/envFiles';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SessionReviewReport, type SessionReviewInfo } from '../components/CodeReview';
import { ContextBanner, ContextGauge } from '../components/ContextGauge';
import { SessionChildren, SessionParentNote, useSessionActions, type ControlledSession } from '../components/SessionControls';
import { SESSION_PAGES, type SessionPage } from '../graphql/misc';
import { SESSION } from '../graphql/operations';
import { describeCron } from '../lib/cron';
import { formatCost, permissionModeLabels, sessionStateHint, sessionStatusLabels } from '../lib/humanize';
import { waitingCommandsHint, type CliSubagent } from './workspaces';
import { usePollingQuery } from '../lib/usePollingQuery';
import { sessionDotClass } from './WorkspaceTabs';
import { sessionPagePath } from './workspaces';
import '../components/terminal.css';

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Réécrit les fichiers d'environnement du projet dans le dossier de la session (valeurs du coffre à jour). */
function EnvFilesAction({ projectId, worksessionId }: { projectId: string; worksessionId: string }) {
  const { alert, showError } = useDialogs();
  const [apply, { loading }] = useMutation<{ applyEnvFiles: EnvApplyResult }>(APPLY_ENV_FILES);
  const [done, setDone] = useState<string | null>(null);
  const run = async () => {
    try {
      const { data } = await apply({ variables: { worksessionId } });
      const r = data?.applyEnvFiles;
      if (!r) return;
      const notes = [...r.skipped, ...r.problems.map((p) => `valeur vide — ${p}`)];
      setDone(r.written.length ? `${r.written.length} fichier(s) écrit(s)` : 'aucun fichier');
      if (notes.length) await alert({ title: "Fichiers d'environnement", message: <ul className="mb-0">{notes.map((n) => <li key={n}>{n}</li>)}</ul> });
    } catch (err) {
      showError(err);
    }
  };
  return (
    <>
      <button type="button" className="cc-link" disabled={loading} title="Réécrit les fichiers d'environnement du projet dans ce dossier, en remplaçant ceux présents" onClick={() => void run()}>
        <i className="bi bi-file-earmark-lock me-1" />
        {loading ? 'écriture…' : 'réécrire les fichiers'}
      </button>
      {done && <span className="cc-dimmer"> · {done}</span>}
      {' · '}
      <Link to={`/projects/${projectId}/env`}>modifier</Link>
    </>
  );
}

/** Lien vers la session, avec un bouton pour le copier (retour « copié » quelques secondes). */
function SessionLink({ sessionId }: { sessionId: string }) {
  const url = `${window.location.origin}/sessions/${sessionId}`;
  const [copied, setCopied] = useState<'ok' | 'ko' | null>(null);
  const copy = () => {
    const done = (r: 'ok' | 'ko') => {
      setCopied(r);
      window.setTimeout(() => setCopied(null), 2000);
    };
    if (!navigator.clipboard) return done('ko');
    navigator.clipboard.writeText(url).then(() => done('ok'), () => done('ko'));
  };
  return (
    <>
      <a href={url} className="font-monospace cc-dim" title={url}>
        {url.replace(/^https?:\/\//, '')}
      </a>
      <button type="button" className="cc-link session-panel-copy" title="Copier le lien de la session" onClick={copy}>
        <i className={`bi ${copied === 'ok' ? 'bi-check2' : 'bi-clipboard'} me-1`} />
        {copied === 'ok' ? 'copié' : copied === 'ko' ? 'copie refusée' : 'copier'}
      </button>
    </>
  );
}

/** Bouton qui copie le lien à part entière d'une page partagée (/shared/<id>), celui qui vaut pour tous. */
function CopyPageLink({ pageId }: { pageId: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/shared/${pageId}`;
  return (
    <button
      type="button"
      className="cc-link session-panel-copy"
      title={`Copier le lien de la page (${url.replace(/^https?:\/\//, '')})`}
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <i className={`bi ${copied ? 'bi-check2' : 'bi-link-45deg'} me-1`} />
      {copied ? 'copié' : 'lien'}
    </button>
  );
}

const pageAccess = (p: SessionPage) => (p.linkAccess ? { icon: 'bi-building', text: 'lien ouvert' } : p.members.length ? { icon: 'bi-people', text: `partagée (${p.members.length})` } : { icon: 'bi-lock', text: 'privée' });

/** Pages publiées depuis la session et visibles de la personne : elles s'ouvrent dans le dossier de la session. */
function SessionPages({ sessionId }: { sessionId: string }) {
  const { user } = useAuth();
  const { data } = usePollingQuery<{ session: { id: string; pages: SessionPage[] } | null }>(SESSION_PAGES, { variables: { id: sessionId }, pollInterval: 30_000 });
  const pages = data?.session?.pages ?? [];
  if (!pages.length) return null;
  return (
    <>
      <div className="git-subhead">{pages.length > 1 ? `Pages (${pages.length})` : 'Page'}</div>
      <ul className="session-panel-pages">
        {pages.map((p) => {
          const access = pageAccess(p);
          return (
            <li key={p.id}>
              <Link to={sessionPagePath(sessionId, p.id)} className="session-panel-page" title={`Ouvrir « ${p.title} » à côté de la session`}>
                <i className="bi bi-file-earmark-richtext me-1" />
                {p.title}
              </Link>
              <div className="cc-dim session-panel-page-meta">
                <span title={access.text}>
                  <i className={`bi ${access.icon} me-1`} />
                  {access.text}
                </span>
                {' · '}v{p.version} · {fmt(p.updatedAt)}
                {p.owner.id !== user?.id && <> · de {p.owner.name}</>}
                {p.openComments > 0 && (
                  <span className="cc-yellow">
                    {' · '}
                    {p.openComments} commentaire{p.openComments > 1 ? 's' : ''} à traiter
                  </span>
                )}
                {' · '}
                <CopyPageLink pageId={p.id} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Onglet « Session » du panneau de droite, à côté d'une page de session : ce que l'en-tête de la page montrait
 * (projet, branche, personne, tâche, workflow, planification, jauge de contexte), le bandeau de contexte au-delà du
 * seuil (compacter, repartir d'une conversation neuve, ignorer) et toutes ses actions.
 * La requête est celle de la page, qui la sonde : le panneau lit le cache.
 */
export default function SessionPanel({ sessionId }: { sessionId: string }) {
  const { data } = useQuery<{ session: (ControlledSession & { review: SessionReviewInfo | null }) | null }>(SESSION, { variables: { id: sessionId } });
  const { user } = useAuth();
  const session = data?.session ?? null;
  const actions = useSessionActions(session);
  if (!session) return <div className="git-empty p-2">Chargement de la session…</div>;
  // Au repos, l'agent peut attendre des commandes de fond (tests, build) : il reprendra de lui-même à leur fin.
  const hint =
    (session.pendingRequestCount ? null : waitingCommandsHint(session as ControlledSession & { subagents?: Pick<CliSubagent, 'kind'>[] })) ??
    sessionStateHint(session.status, session.activity, session.pendingRequestCount) ??
    (session.archivedAt ? 'archivée' : sessionStatusLabels[session.status]?.toLowerCase());
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
            <ContextGauge context={session.context} cleanup={session.cleanup} onClick={actions.openContextSettings} />
          </span>
        )}
      </div>
      {!actions.readOnly && <ContextBanner session={session} busy={busy} />}
      {actions.readOnly ? <div className="cc-actions stacked cc-dim">Lecture seule : votre rôle de lecteur sur ce projet ne permet pas d'agir sur la session.</div> : <div className="cc-actions stacked">{actions.buttons}</div>}
      {session.review && <SessionReviewReport review={session.review} />}

      <div className="git-subhead">Détail</div>
      <dl className="session-panel-fields">
        <div>
          <dt>Projet</dt>
          <dd>
            <Link to={`/projects/${session.project.id}`}>{session.project.name}</Link>
          </dd>
        </div>
        <div>
          <dt>Lien</dt>
          <dd>
            <SessionLink sessionId={session.id} />
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
        {session.worksession && !session.archivedAt && (
          <div>
            <dt>Environnement</dt>
            <dd>
              <EnvFilesAction projectId={session.project.id} worksessionId={session.worksession.id} />
            </dd>
          </div>
        )}
        <div>
          <dt>Personne</dt>
          <dd>{session.owner ? (session.owner.id === user?.id ? 'moi' : session.owner.name ?? session.owner.email) : <span className="cc-dimmer">—</span>}</dd>
        </div>
        {session.tasks.length > 0 && (
          <div>
            <dt>{session.tasks.length > 1 ? `Tâches (${session.tasks.length})` : 'Tâche'}</dt>
            <dd>
              {session.tasks.map((t) => (
                <div key={t.id}>
                  <Link to={`/tasks/${t.id}`}>
                    <i className="bi bi-check2-square me-1" />
                    {t.title}
                  </Link>
                </div>
              ))}
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
              <button type="button" className="cc-link text-start" title={`Session lancée par cette planification · ${schedule.cron} (${schedule.timezone}) · cliquer pour la modifier`} onClick={actions.openSchedule}>
                <i className="bi bi-alarm me-1" />
                lancée par « {schedule.name} » · {describeCron(schedule.cron).toLowerCase()} · {schedule.enabled ? (schedule.nextRunAt ? `prochaine le ${new Date(schedule.nextRunAt).toLocaleString()}` : 'planifiée') : 'en pause'}
              </button>
            ) : (
              <button type="button" className="cc-link" onClick={actions.openSchedule}>
                aucune · en créer une
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

      <SessionPages sessionId={session.id} />

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
