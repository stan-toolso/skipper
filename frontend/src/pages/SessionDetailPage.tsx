import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import RequestPrompt from '../components/RequestPrompt';
import Transcript from '../components/Transcript';
import '../components/terminal.css';
import {
  DELETE_SESSION,
  END_SESSION,
  INTERRUPT_SESSION,
  SEND_SESSION_MESSAGE,
  SESSION,
  STOP_SESSION,
  type HumanRequest,
  type Session,
  type SessionEvent,
} from '../graphql/operations';

type SessionWithEvents = Session & { events: SessionEvent[]; requests: HumanRequest[] };

const statusLabels: Record<Session['status'], string> = {
  PENDING: 'en attente de démarrage',
  RUNNING: 'en cours',
  COMPLETED: 'terminée',
  FAILED: 'échouée',
  STOPPED: 'arrêtée',
  INTERRUPTED: 'interrompue (serveur redémarré)',
};

/** Page de session : transcript et saisie d'instructions, à la manière de Claude Code. */
export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<{ session: SessionWithEvents | null }>(SESSION, { variables: { id }, pollInterval: 1500 });
  const [sendMessage, { loading: sending, error: sendError }] = useMutation(SEND_SESSION_MESSAGE);
  const [interruptSession, { error: interruptError }] = useMutation(INTERRUPT_SESSION);
  const [endSession, { error: endError }] = useMutation(END_SESSION);
  const [stopSession, { error: stopError }] = useMutation(STOP_SESSION);
  const [deleteSession] = useMutation(DELETE_SESSION, { onCompleted: () => navigate('/sessions') });

  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const session = data?.session;
  useTabTitle(session?.name);
  const running = session?.status === 'RUNNING';
  const busy = running && session?.activity === 'BUSY';
  const pending = session?.requests ?? [];

  useEffect(() => {
    inputRef.current?.focus();
  }, [session?.id]);

  // Échap interrompt le tour en cours, comme dans Claude Code.
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && busy && pending.length === 0) interruptSession({ variables: { id } });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, pending.length, id, interruptSession]);

  const submit = () => {
    const value = text.trim();
    if (!value || sending) return;
    setText('');
    sendMessage({ variables: { id, text: value } });
  };

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!session) return <Alert variant="warning">Session introuvable.</Alert>;

  const actionError = sendError ?? interruptError ?? endError ?? stopError;
  const model = typeof session.config.model === 'string' ? session.config.model : null;
  const permissionMode = typeof session.config.permissionMode === 'string' ? session.config.permissionMode : 'default';

  const statusLine = pending.length
    ? `⏸ En attente de votre réponse (${pending.length} demande${pending.length > 1 ? 's' : ''})`
    : busy
      ? '✻ Claude travaille… (échap pour interrompre)'
      : running
        ? '⏵ En attente de vos instructions'
        : `■ Session ${statusLabels[session.status]} — envoyer un message la relance`;

  return (
    <div className="cc">
      <div className="cc-header">
        <div>
          <span className="cc-title">✻ {session.name}</span>
          <span className="cc-meta">
            {' '}
            · <Link to={`/projects/${session.project.id}`} className="cc-meta">{session.project.name}</Link> · <code>{session.provider}</code>
            {model && <> · {model}</>}
            {session.exitCode !== null && <> · exit {session.exitCode}</>}
          </span>
        </div>
        <div className="cc-actions">
          {busy && (
            <button type="button" className="cc-btn" onClick={() => interruptSession({ variables: { id } })}>
              Interrompre
            </button>
          )}
          {running && (
            <button type="button" className="cc-btn accent" onClick={() => endSession({ variables: { id } })}>
              Terminer
            </button>
          )}
          {running && (
            <button type="button" className="cc-btn danger" onClick={() => stopSession({ variables: { id } })}>
              Arrêter
            </button>
          )}
          <button
            type="button"
            className="cc-btn danger"
            onClick={() => {
              if (window.confirm('Supprimer cette session ?')) deleteSession({ variables: { id } });
            }}
          >
            Supprimer
          </button>
        </div>
      </div>

      <Transcript events={session.events} />

      {pending.map((r) => (
        <RequestPrompt key={r.id} request={r} />
      ))}

      <div className="cc-status">
        <span>
          {busy && pending.length === 0 && <span className="cc-spinner">✻ </span>}
          {statusLine}
        </span>
        <span>
          {session.error && <span className="cc-red">{session.error} · </span>}
          {actionError && <span className="cc-red">{actionError.message} · </span>}
          ⏵⏵ {permissionMode}
        </span>
      </div>

      <div className="cc-input" onClick={() => inputRef.current?.focus()}>
        <span className="cc-caret">&gt;</span>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={running ? 'Donnez une instruction à Claude…' : 'Relancer la session avec une nouvelle instruction…'}
          disabled={sending}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="cc-hint">
        <span>Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne</span>
        <span>{session.project.workspacePath}</span>
      </div>
    </div>
  );
}
