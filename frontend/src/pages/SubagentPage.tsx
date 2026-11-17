import { gql } from '@apollo/client';
import { Alert } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useMemo } from 'react';
import GoneNotice from '../components/GoneNotice';
import PageLoading from '../components/PageLoading';
import Transcript from '../components/Transcript';
import { isGoneError } from '../lib/gone';
import { useSessionEvents } from '../lib/sessionEvents';
import { subagentTranscript } from '../lib/subagentTranscript';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { elapsedSince, type CliSubagent } from '../workbench/workspaces';
import '../components/terminal.css';

const SUBAGENT_SESSION = gql`
  query SubagentSession($id: ID!) {
    session(id: $id) {
      id
      name
      status
      project {
        id
        name
      }
      subagents {
        id
        toolUseId
        description
        agentType
        background
        startedAt
        toolUses
        lastTool
        summary
      }
    }
  }
`;

interface SubagentSessionData {
  session: { id: string; name: string; status: string; project: { id: string; name: string }; subagents: CliSubagent[] } | null;
}

/**
 * Fil d'un sous-agent du CLI (outil Agent) d'une session, en lecture seule : sa consigne, puis ses messages et appels
 * d'outils, comme dans le transcript de la session (qui ne montre que l'appel qui l'a lancé). Suivi en direct tant
 * qu'il tourne. Ouvert depuis sa ligne dans la sidebar ou depuis l'appel Agent du transcript.
 */
export default function SubagentPage() {
  const { id = '', toolUseId = '' } = useParams();
  const { data, loading, error } = usePollingQuery<SubagentSessionData>(SUBAGENT_SESSION, { variables: { id }, pollInterval: 5000 });
  const { events, loaded } = useSessionEvents(id, { toolUseId });
  const { events: shown, call } = useMemo(() => subagentTranscript(events, toolUseId), [events, toolUseId]);
  const session = data?.session;
  const live = session?.subagents.find((a) => a.toolUseId === toolUseId) ?? null;
  const title = live?.description ?? call?.description ?? 'Sous-agent';
  useTabTitle(session ? `${title} · ${session.name}` : null);

  if (loading && !data) return <PageLoading className="m-3" />;
  if (isGoneError(error) || (!error && !session)) return <GoneNotice what="Cette session" />;
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!session) return null;

  const agentType = live?.agentType ?? call?.agentType;
  const background = live?.background ?? call?.background ?? false;
  return (
    <div className="cc">
      <div className="cc-header">
        <div className="cc-header-main">
          <span className="cc-title" title={title}>
            <i className="bi bi-robot" /> {title}
          </span>
          <span className="cc-meta">
            {' '}
            · sous-agent de <Link to={`/sessions/${session.id}`} className="cc-meta">« {session.name} »</Link>
            {agentType && <> · {agentType}</>}
            {background && <> · arrière-plan</>}
            {' · '}
            {live ? (
              <span className="cc-subagent-live" title={[live.lastTool ? `Dernier outil : ${live.lastTool}` : null, live.summary].filter(Boolean).join(' · ') || undefined}>
                au travail depuis {elapsedSince(live.startedAt)}
                {live.toolUses > 0 && ` · ${live.toolUses} outil${live.toolUses > 1 ? 's' : ''}`}
              </span>
            ) : (
              <span className="cc-dimmer">terminé</span>
            )}
          </span>
        </div>
      </div>
      <Transcript events={shown} loading={!loaded} busy={Boolean(live)} subagentLinks />
      {loaded && !shown.length && <div className="cc-note p-3">Aucun message journalisé pour ce sous-agent.</div>}
    </div>
  );
}
