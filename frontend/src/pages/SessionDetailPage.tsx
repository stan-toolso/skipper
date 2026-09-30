import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import { canAutoFocus } from '../lib/device';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useDialogs } from '../components/Dialogs';

import { permissionModeLabels, sessionStatusLabels } from '../lib/humanize';
import RequestPrompt from '../components/RequestPrompt';
import Transcript from '../components/Transcript';
import '../components/terminal.css';
import {
  DELETE_SESSION,
  END_SESSION,
  INTERRUPT_SESSION,
  PROVIDERS,
  SEND_SESSION_MESSAGE,
  SESSION,
  STOP_SESSION,
  UPDATE_SESSION_CONFIG,
  type ConfigField,
  type HumanRequest,
  type Provider,
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
  const { confirm } = useDialogs();
  const [deleteSession] = useMutation(DELETE_SESSION, { onCompleted: () => navigate('/sessions') });
  const [updateConfig, { loading: updatingConfig, error: configError }] = useMutation(UPDATE_SESSION_CONFIG);
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);

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

  // Focus dans la zone de saisie à l'ouverture, sauf sur mobile (le clavier virtuel masquerait la page).
  useEffect(() => {
    if (canAutoFocus()) inputRef.current?.focus();
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

  const actionError = sendError ?? interruptError ?? endError ?? stopError ?? configError;
  const model = typeof session.config.model === 'string' ? session.config.model : null;
  const permissionMode = typeof session.config.permissionMode === 'string' ? session.config.permissionMode : 'default';
  // Réglages modifiables en cours de route : les champs à choix du provider (modèle, autorisations pour Claude).
  const providerFields = providersData?.providers.find((p) => p.type === session.provider)?.configFields ?? [];
  const modelField = providerFields.find((f) => f.key === 'model' && f.type === 'select');
  const permissionField = providerFields.find((f) => f.key === 'permissionMode' && f.type === 'select');
  const changeSetting = (field: ConfigField, value: string) => {
    if (field.key === 'permissionMode' && value === 'bypassPermissions' && !window.confirm("Tout autoriser : l'agent agira sans aucune confirmation, y compris pour les commandes. Continuer ?")) return;
    updateConfig({ variables: { id, config: { [field.key]: value || null } } });
  };

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
            onClick={async () => {
              if (await confirm({ title: 'Supprimer la session', message: 'Supprimer cette session et tout son historique ?', confirmLabel: 'Supprimer', danger: true })) deleteSession({ variables: { id } });
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
          <span className="cc-settings">
            {modelField ? (
              <select
                className="cc-select"
                title="Modèle de cette session (modifiable à tout moment)"
                aria-label="Modèle"
                value={model ?? ''}
                disabled={updatingConfig}
                onChange={(e) => changeSetting(modelField, e.target.value)}
              >
                {model && !(modelField.options ?? []).some((o) => o.value === model) && <option value={model}>{model}</option>}
                {(modelField.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              model && <span title="Modèle de cette session">{model}</span>
            )}
            {permissionField ? (
              <select
                className="cc-select"
                title="Autorisations de cette session (modifiables à tout moment)"
                aria-label="Autorisations"
                value={permissionMode}
                disabled={updatingConfig}
                onChange={(e) => changeSetting(permissionField, e.target.value)}
              >
                {(permissionField.options ?? []).map((o) => (
                  <option key={o.value} value={o.value} title={o.description ?? undefined}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <span title="Autorisations de cette session">{permissionModeLabels[permissionMode] ?? permissionMode}</span>
            )}
          </span>
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
