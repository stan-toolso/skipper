import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import { useGitTarget } from '../workbench/GitTargetContext';

import { permissionModeLabels, sessionStatusLabels } from '../lib/humanize';
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

const TECH_KEY = 'skipper.session.technical';

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
  const [technical, setTechnical] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TECH_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleTechnical = () => {
    setTechnical((v) => {
      try {
        localStorage.setItem(TECH_KEY, v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const session = data?.session;
  useTabTitle(session?.name);
  useGitTarget(session ? { projectId: session.project.id, worktreeId: session.worktree?.id ?? null, label: session.worktree ? `${session.project.name} · ${session.worktree.branch}` : session.project.name } : null);
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
    ? `⏸ L'agent attend votre réponse ci-dessus`
    : busy
      ? "✻ L'agent travaille… (touche échap pour l'interrompre)"
      : running
        ? "⏵ L'agent attend vos instructions"
        : `■ ${sessionStatusLabels[session.status]} — écrivez un message pour reprendre la conversation`;

  return (
    <div className="cc">
      <div className="cc-header">
        <div>
          <span className="cc-title">✻ {session.name}</span>
          <span className="cc-meta">
            {' '}
            · <Link to={`/projects/${session.project.id}`} className="cc-meta">{session.project.name}</Link>
            {session.worktree && (
              <>
                {' '}
                · <i className="bi bi-diagram-2" /> {session.worktree.branch}
              </>
            )}
            {technical && (
              <>
                {' '}
                · <code>{session.provider}</code>
                {model && <> · {model}</>}
                {session.exitCode !== null && <> · exit {session.exitCode}</>}
              </>
            )}
          </span>
        </div>
        <div className="cc-actions">
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

      <div className="cc-toggle">
        <label>
          <input type="checkbox" checked={technical} onChange={toggleTechnical} /> Afficher les détails techniques
        </label>
      </div>
      <Transcript events={session.events} technical={technical} />

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
          <span title="Autorisations de cette session">{permissionModeLabels[permissionMode] ?? permissionMode}</span>
        </span>
      </div>

      <div className="cc-input" onClick={() => inputRef.current?.focus()}>
        <span className="cc-caret">&gt;</span>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={running ? "Écrivez ce que l'agent doit faire…" : 'Écrivez une nouvelle instruction pour reprendre…'}
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
        <button type="button" className="cc-send" title="Envoyer" aria-label="Envoyer" disabled={sending || !text.trim()} onClick={submit}>
          <i className="bi bi-send" />
        </button>
      </div>
      <div className="cc-hint">
        <span>Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne</span>
        <span title="Dossier de travail de la session">{technical ? (session.worktree?.path ?? session.project.workspacePath) : ''}</span>
      </div>
    </div>
  );
}
