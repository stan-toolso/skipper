import { useMutation } from '@apollo/client';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { END_SESSION, INTERRUPT_SESSION, RESUME_SESSION, RUN_SESSION_SCHEDULE_NOW, STOP_SESSION, type ChildSession, type Session } from '../graphql/operations';
import { UNARCHIVE_SESSION } from '../graphql/sessions';
import { sessionStateHint, sessionStatusLabels } from '../lib/humanize';
import { sessionDotClass } from '../workbench/WorkspaceTabs';
import { useDeletions } from '../workbench/useDeletions';
import { useDialogs } from './Dialogs';
import RelaunchModal from './RelaunchModal';
import ScheduleModal from './ScheduleModal';
import SessionSettingsModal from './SessionSettingsModal';

/** Session telle que la requête `Session` la renvoie : le détail suffit aux actions et aux sous-agents. */
export type ControlledSession = Session & { childSessions: ChildSession[] };

/**
 * Actions d'une session (réglages, planification, interrompre, terminer, arrêter, relancer, archiver…) et les
 * modales qu'elles ouvrent, partagées entre l'en-tête déplié de la page de session et l'onglet « Session » du
 * panneau de droite. Le hook accepte une session absente (page en cours de chargement) : il ne rend alors rien.
 */
export function useSessionActions(session: ControlledSession | null | undefined): { buttons: ReactNode; modals: ReactNode; openSettings: () => void; openSchedule: () => void } {
  const { showError } = useDialogs();
  const onError = (err: Error) => void showError(err);
  const [interruptSession] = useMutation(INTERRUPT_SESSION, { onError });
  const [resumeSession, { loading: resuming }] = useMutation(RESUME_SESSION, { onError });
  const [endSession] = useMutation(END_SESSION, { onError });
  const [stopSession] = useMutation(STOP_SESSION, { onError });
  const [runScheduleNow] = useMutation(RUN_SESSION_SCHEDULE_NOW, { onError });
  const [unarchiveSession] = useMutation(UNARCHIVE_SESSION, { refetchQueries: ['Sidebar'], onError });
  const { archiveSession, deleteSession } = useDeletions();
  const [scheduling, setScheduling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const openSettings = () => setSettingsOpen(true);
  const openSchedule = () => setScheduling(true);
  if (!session) return { buttons: null, modals: null, openSettings, openSchedule };

  const id = session.id;
  const archived = Boolean(session.archivedAt);
  const running = session.status === 'RUNNING';
  const busy = running && session.activity === 'BUSY';
  const schedule = session.schedule;
  // Chat (espace personnel) : pas de planification, et pas d'archive — on le supprime directement.
  const chat = session.kind === 'CHAT';
  const buttons = (
    <>
      <button type="button" className="cc-btn" title="Nom de la session et nettoyage automatique de l'historique" onClick={openSettings}>
        <i className="bi bi-gear" /> Réglages
      </button>
      {!chat && (
        <button type="button" className="cc-btn" title={schedule ? 'Modifier la planification de cette session' : 'Relancer cette session à intervalles réguliers avec une instruction'} onClick={openSchedule}>
          <i className="bi bi-alarm" /> {schedule ? 'Planification' : 'Planifier'}
        </button>
      )}
      {schedule && !busy && (
        <button type="button" className="cc-btn" title="Exécute la planification maintenant, sans attendre l'échéance" onClick={() => runScheduleNow({ variables: { id } })}>
          Exécuter maintenant
        </button>
      )}
      {session.status === 'INTERRUPTED' && (
        <button
          type="button"
          className="cc-btn accent"
          disabled={resuming}
          title={session.activity === 'BUSY' ? "L'agent reprend le travail coupé par le redémarrage du serveur" : "Rouvre la conversation ; l'agent attend votre prochaine instruction"}
          onClick={() => resumeSession({ variables: { id } })}
        >
          <i className="bi bi-play-fill" /> Reprendre
        </button>
      )}
      {session.status === 'QUEUED' && (
        <button type="button" className="cc-btn danger" title="La session ne démarrera pas ; un message la remettra en file si la limite est encore atteinte" onClick={() => stopSession({ variables: { id } })}>
          Retirer de la file
        </button>
      )}
      {busy && (
        <button type="button" className="cc-btn" title="Arrête ce que l'agent est en train de faire ; la session reste ouverte" onClick={() => interruptSession({ variables: { id } })}>
          Interrompre
        </button>
      )}
      {running && (
        <button type="button" className="cc-btn accent" title="L'agent finit ce qu'il fait, puis la session se termine" onClick={() => endSession({ variables: { id } })}>
          Terminer la session
        </button>
      )}
      {running && (
        <button type="button" className="cc-btn danger" title="Arrêt immédiat, sans attendre" onClick={() => stopSession({ variables: { id } })}>
          Arrêter
        </button>
      )}
      <button type="button" className="cc-btn" title="Repart d'une nouvelle session avec un résumé de celle-ci" onClick={() => setRelaunching(true)}>
        <i className="bi bi-arrow-repeat" /> Relancer
      </button>
      {archived || chat ? (
        <>
          {archived && (
            <button type="button" className="cc-btn accent" title="Remet la session parmi les sessions actives" onClick={() => unarchiveSession({ variables: { id } })}>
              Restaurer
            </button>
          )}
          <button type="button" className="cc-btn danger" onClick={() => void deleteSession({ id, name: session.name, worksessionId: session.worksession?.id ?? null })}>
            Supprimer
          </button>
        </>
      ) : (
        <button type="button" className="cc-btn" title="La session quitte la barre latérale ; elle reste consultable et relançable depuis l'historique du projet" onClick={() => void archiveSession({ id, name: session.name, worksessionId: session.worksession?.id ?? null })}>
          <i className="bi bi-archive" /> Archiver
        </button>
      )}
    </>
  );
  const modals = (
    <>
      {scheduling && <ScheduleModal session={session} onClose={() => setScheduling(false)} />}
      {settingsOpen && <SessionSettingsModal session={session} onClose={() => setSettingsOpen(false)} />}
      {relaunching && <RelaunchModal session={session} projectName={session.project.name} worksessions={session.worksession ? [{ id: session.worksession.id, label: session.worksession.label }] : []} onClose={() => setRelaunching(false)} />}
    </>
  );
  return { buttons, modals, openSettings, openSchedule };
}

/** Phrase d'état de la session parente (« travaille », « terminée »…), pour la note de sous-agent. */
export function parentStateHint(parent: NonNullable<Session['parentSession']>): string | null {
  return sessionStateHint(parent.status, parent.activity, 0) ?? sessionStatusLabels[parent.status]?.toLowerCase() ?? null;
}

/** Note « sous-agent » : la session a été lancée par l'agent d'une autre session, pas par une personne. */
export function SessionParentNote({ session, compact = false }: { session: Session; compact?: boolean }) {
  const parent = session.parentSession;
  if (!parent) return null;
  const hint = parentStateHint(parent);
  return (
    <div className={`cc-subagent${compact ? ' compact' : ''}`}>
      <i className="bi bi-robot cc-subagent-icon" />
      <span className="cc-subagent-text">
        <strong>Sous-agent</strong> · cette session a été lancée par l'agent de la session <Link to={`/sessions/${parent.id}`}>« {parent.name} »</Link>
        {hint && <span className="cc-dim"> ({hint})</span>}, pas par une personne.
      </span>
      {!compact && (
        <Link to={`/sessions/${parent.id}`} className="cc-btn" title="Ouvrir la session parente">
          <i className="bi bi-box-arrow-up-left" /> Session parente
        </Link>
      )}
    </div>
  );
}

/** Sous-agents de la session : une puce par session lancée par son agent, avec de quoi la terminer. */
export function SessionChildren({ children, stacked = false }: { children: ChildSession[]; stacked?: boolean }) {
  const { showError } = useDialogs();
  const onError = (err: Error) => void showError(err);
  const [endSession] = useMutation(END_SESSION, { onError });
  const [stopSession] = useMutation(STOP_SESSION, { onError });
  if (children.length === 0) return null;
  return (
    <div className={`cc-children${stacked ? ' stacked' : ''}`} title="Sous-agents : sessions lancées par l'agent de cette session (outil sessions.create)">
      {!stacked && (
        <span className="cc-children-title">
          <i className="bi bi-robot" /> {children.length > 1 ? `${children.length} sous-agents` : '1 sous-agent'}
        </span>
      )}
      {children.map((c) => {
        const hint = sessionStateHint(c.status, c.activity, c.pendingRequestCount) ?? (c.archivedAt ? 'archivée' : sessionStatusLabels[c.status]?.toLowerCase());
        return (
          <span key={c.id} className="cc-child">
            <span className={`wb-dot ${sessionDotClass(c)}`} />
            <Link to={`/sessions/${c.id}`} className="cc-child-name" title={`Ouvrir « ${c.name} »`}>
              {c.name}
            </Link>
            {hint && <span className="cc-dimmer">{hint}</span>}
            {c.status === 'RUNNING' && (
              <button type="button" className="cc-link" title="L'agent de cette session finit ce qu'il fait, puis elle se termine" onClick={() => endSession({ variables: { id: c.id } })}>
                terminer
              </button>
            )}
            {c.status === 'QUEUED' && (
              <button type="button" className="cc-link" title="La session ne démarrera pas" onClick={() => stopSession({ variables: { id: c.id } })}>
                retirer de la file
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
