import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import { canAutoFocus } from '../lib/device';
import { useSessionEvents } from '../lib/sessionEvents';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useDialogs } from '../components/Dialogs';

import { bypassConnectionsWarning, permissionModeLabels, sessionStatusLabels } from '../lib/humanize';
import AttachmentChips from '../components/AttachmentChips';
import RequestPrompt from '../components/RequestPrompt';
import ScheduleModal from '../components/ScheduleModal';
import SessionSettingsModal from '../components/SessionSettingsModal';
import Transcript from '../components/Transcript';
import SessionChanges from '../components/SessionChanges';
import { fileToolResultCount } from '../lib/sessionChanges';
import { toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import '../components/terminal.css';
import {
  DELETE_SESSION,
  END_SESSION,
  INTERRUPT_SESSION,
  RESUME_SESSION,
  PROVIDERS,
  RUN_SESSION_SCHEDULE_NOW,
  SEND_SESSION_MESSAGE,
  SESSION,
  SESSION_CHANGES,
  STOP_SESSION,
  UPDATE_SESSION_CONFIG,
  type ConfigField,
  type HumanRequest,
  type Provider,
  type Session,
  type SessionChanges as SessionChangesData,
} from '../graphql/operations';

type SessionWithRequests = Session & { requests: HumanRequest[] };

const TECH_KEY = 'skipper.session.technical';
const TAB_KEY = 'skipper.session.tab';
type PageTab = 'conversation' | 'changes';

/** Page de session : transcript et saisie d'instructions, à la manière de Claude Code. */
export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<{ session: SessionWithRequests | null }>(SESSION, { variables: { id }, pollInterval: 1500 });
  const { events, loaded: eventsLoaded } = useSessionEvents(id);
  const [sendMessage, { loading: sending, error: sendError }] = useMutation(SEND_SESSION_MESSAGE);
  const [interruptSession, { error: interruptError }] = useMutation(INTERRUPT_SESSION);
  const [resumeSession, { loading: resuming, error: resumeError }] = useMutation(RESUME_SESSION);
  const [endSession, { error: endError }] = useMutation(END_SESSION);
  const [stopSession, { error: stopError }] = useMutation(STOP_SESSION);
  const { confirm } = useDialogs();
  const [deleteSession] = useMutation(DELETE_SESSION, { onCompleted: () => navigate('/sessions') });
  const [updateConfig, { loading: updatingConfig, error: configError }] = useMutation(UPDATE_SESSION_CONFIG);
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const [runScheduleNow, { error: runScheduleError }] = useMutation(RUN_SESSION_SCHEDULE_NOW);
  const [scheduling, setScheduling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [text, setText] = useState('');
  const [encoding, setEncoding] = useState(false);
  const attachments = usePendingAttachments();
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
  const [tab, setTab] = useState<PageTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'changes' ? 'changes' : 'conversation';
    } catch {
      return 'conversation';
    }
  });
  const selectTab = (next: PageTab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };
  // Onglet « Modifications » : la liste est rechargée après chaque résultat d'un outil qui modifie des fichiers
  // (Edit, Write, Bash...) et à chaque changement d'état de la session (fin de tour d'un agent sans outils).
  const changesQ = useQuery<{ sessionChanges: SessionChangesData }>(SESSION_CHANGES, { variables: { sessionId: id }, fetchPolicy: 'cache-and-network' });
  const toolResults = useMemo(() => fileToolResultCount(events), [events]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Instructions déjà envoyées, dans l'ordre, sans doublons consécutifs : parcourues avec flèche haut / bas, comme dans Claude Code.
  const history = useMemo(() => {
    const list: string[] = [];
    for (const e of events) {
      if (e.type !== 'instruction') continue;
      const t = String((e.payload as { text?: unknown }).text ?? '').trim();
      if (t && list[list.length - 1] !== t) list.push(t);
    }
    return list;
  }, [events]);
  const historyPos = useRef<number | null>(null); // null : on édite le brouillon ; sinon index dans history
  const draftRef = useRef('');
  const recall = (value: string) => {
    setText(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      el.setSelectionRange(value.length, value.length);
    });
  };
  const session = data?.session;
  useTabTitle(session?.name);
  useGitTarget(session ? { projectId: session.project.id, worktreeId: session.worktree?.id ?? null, label: session.worktree ? `${session.project.name} · ${session.worktree.branch}` : session.project.name } : null);
  const running = session?.status === 'RUNNING';
  const busy = running && session?.activity === 'BUSY';
  const pending = session?.requests ?? [];
  const changesKey = `${toolResults}:${session?.status}:${session?.activity}`;
  const [refreshCount, setRefreshCount] = useState(0);
  const refetchChanges = changesQ.refetch;
  const firstKey = useRef(changesKey);
  useEffect(() => {
    if (changesKey === firstKey.current) return;
    firstKey.current = changesKey;
    void refetchChanges().catch(() => undefined);
    setRefreshCount((n) => n + 1);
  }, [changesKey, refetchChanges]);
  const refreshChanges = () => {
    void refetchChanges().catch(() => undefined);
    setRefreshCount((n) => n + 1);
  };
  const changedFiles = changesQ.data?.sessionChanges.files.length ?? 0;

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

  const canSend = Boolean(text.trim() || attachments.items.length) && !sending && !encoding;
  const submit = async () => {
    if (!canSend) return;
    const value = text.trim();
    const items = attachments.items;
    setEncoding(true);
    try {
      const files = items.length ? await toAttachmentInputs(items) : null;
      setText('');
      attachments.reset();
      if (inputRef.current) inputRef.current.style.height = 'auto';
      await sendMessage({ variables: { id, text: value, attachments: files } });
    } catch {
      /* l'erreur est affichée par sendError */
    } finally {
      setEncoding(false);
    }
  };

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!session) return <Alert variant="warning">Session introuvable.</Alert>;

  const actionError = sendError ?? resumeError ?? interruptError ?? endError ?? stopError ?? configError ?? runScheduleError;
  const schedule = session.schedule;
  const model = typeof session.config.model === 'string' ? session.config.model : null;
  const permissionMode = typeof session.config.permissionMode === 'string' ? session.config.permissionMode : 'default';
  // Réglages modifiables en cours de route : les champs à choix du provider (modèle, autorisations pour Claude).
  const providerFields = providersData?.providers.find((p) => p.type === session.provider)?.configFields ?? [];
  const modelField = providerFields.find((f) => f.key === 'model' && f.type === 'select');
  const permissionField = providerFields.find((f) => f.key === 'permissionMode' && f.type === 'select');
  const bypassWarning = (force = false) => (force || permissionMode === 'bypassPermissions' ? bypassConnectionsWarning(session.project.approvalConnections ?? []) : null);
  const changeSetting = async (field: ConfigField, value: string) => {
    if (field.key === 'permissionMode' && value === 'bypassPermissions') {
      const ok = await confirm({
        title: 'Tout autoriser',
        message: `L'agent agira sans aucune confirmation, y compris pour les commandes.${bypassWarning(true) ? ` ${bypassWarning(true)}` : ''} Continuer ?`,
        confirmLabel: 'Tout autoriser',
        danger: true,
      });
      if (!ok) return;
    }
    updateConfig({ variables: { id, config: { [field.key]: value || null } } });
  };

  const statusLine = pending.length
    ? `⏸ L'agent attend votre réponse ci-dessus`
    : busy
      ? "✻ L'agent travaille… (touche échap pour l'interrompre)"
      : running
        ? "⏵ L'agent attend vos instructions"
        : session.status === 'PENDING'
          ? "■ Pas encore démarrée — écrivez la première instruction pour lancer l'agent"
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
            {session.parentSession && (
              <>
                {' '}
                · lancée par{' '}
                <Link to={`/sessions/${session.parentSession.id}`} className="cc-meta" title="Session d'agent qui a lancé celle-ci">
                  <i className="bi bi-robot" /> {session.parentSession.name}
                </Link>
              </>
            )}
            {schedule && (
              <>
                {' '}
                ·{' '}
                <button type="button" className="cc-link" title={`${schedule.enabled ? 'Planifiée' : 'Planification désactivée'} : ${schedule.cron} (${schedule.timezone})${schedule.lastResult ? ` · dernière exécution : ${schedule.lastResult}` : ''}`} onClick={() => setScheduling(true)}>
                  <i className="bi bi-alarm" />{' '}
                  {schedule.enabled ? (schedule.nextRunAt ? `prochaine exécution le ${new Date(schedule.nextRunAt).toLocaleString()}` : 'planifiée') : 'planification désactivée'}
                </button>
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
          <button type="button" className="cc-btn" title="Nom de la session et nettoyage automatique de l'historique" onClick={() => setSettingsOpen(true)}>
            <i className="bi bi-gear" /> Réglages
          </button>
          <button type="button" className="cc-btn" title={schedule ? 'Modifier la planification de cette session' : 'Relancer cette session à intervalles réguliers avec une instruction'} onClick={() => setScheduling(true)}>
            <i className="bi bi-alarm" /> {schedule ? 'Planification' : 'Planifier'}
          </button>
          {schedule && !busy && (
            <button type="button" className="cc-btn" title="Exécute la planification maintenant, sans attendre l'échéance" onClick={() => runScheduleNow({ variables: { id } })}>
              Exécuter maintenant
            </button>
          )}
          {session?.status === 'INTERRUPTED' && (
            <button
              type="button"
              className="cc-btn accent"
              disabled={resuming}
              title={session.activity === 'BUSY' ? "L'agent reprend le travail coupé par le redémarrage du serveur" : "Rouvre la conversation ; l'agent attend votre prochaine instruction"}
              onClick={() => void resumeSession({ variables: { id } }).catch(() => undefined)}
            >
              <i className="bi bi-play-fill" /> Reprendre
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
        <div className="cc-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'conversation'} className={`cc-tab${tab === 'conversation' ? ' active' : ''}`} onClick={() => selectTab('conversation')}>
            Conversation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            className={`cc-tab${tab === 'changes' ? ' active' : ''}`}
            title="Fichiers modifiés dans le dossier de travail depuis le début de la session"
            onClick={() => selectTab('changes')}
          >
            Modifications
            {changedFiles > 0 && <span className="cc-tab-count">{changedFiles}</span>}
          </button>
        </div>
        {tab === 'conversation' && (
          <label>
            <input type="checkbox" checked={technical} onChange={toggleTechnical} /> Afficher les détails techniques
          </label>
        )}
      </div>
      {tab === 'conversation' ? (
        <Transcript events={events} loading={!eventsLoaded} technical={technical} />
      ) : (
        <SessionChanges
          sessionId={id}
          workspace={{ projectId: session.project.id, worktreeId: session.worktree?.id ?? null }}
          changes={changesQ.data?.sessionChanges}
          loading={changesQ.loading}
          error={changesQ.error}
          refreshKey={refreshCount}
          onRefresh={refreshChanges}
        />
      )}
      {scheduling && <ScheduleModal session={session} onClose={() => setScheduling(false)} />}
      {settingsOpen && <SessionSettingsModal session={session} onClose={() => setSettingsOpen(false)} />}

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
          {bypassWarning() && (
            <span className="cc-yellow" title={bypassWarning() ?? undefined}>
              ⚠ connexions non soumises ·{' '}
            </span>
          )}
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

      <div className="cc-input" onClick={() => inputRef.current?.focus()} onDrop={attachments.onDrop} onDragOver={attachments.onDragOver}>
        <AttachmentChips items={attachments.items} onAdd={(files) => attachments.add(files)} onRemove={attachments.remove} disabled={sending || encoding} showButton={false} error={attachments.error} />
        <div className="cc-input-row">
          <span className="cc-caret">&gt;</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={running ? "Écrivez ce que l'agent doit faire…" : 'Écrivez une nouvelle instruction pour reprendre…'}
            disabled={sending || encoding}
            onChange={(e) => {
              historyPos.current = null;
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onPaste={attachments.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                historyPos.current = null;
                void submit();
                return;
              }
              // Flèche haut sur la première ligne : instruction précédente ; flèche bas sur la dernière : suivante, puis retour au brouillon.
              const el = e.currentTarget;
              if (e.key === 'ArrowUp' && history.length && !el.value.slice(0, el.selectionStart).includes('\n')) {
                const next = historyPos.current === null ? history.length - 1 : historyPos.current - 1;
                if (next < 0) return;
                e.preventDefault();
                if (historyPos.current === null) draftRef.current = text;
                historyPos.current = next;
                recall(history[next]);
              } else if (e.key === 'ArrowDown' && historyPos.current !== null && !el.value.slice(el.selectionEnd).includes('\n')) {
                e.preventDefault();
                const next = historyPos.current + 1;
                historyPos.current = next < history.length ? next : null;
                recall(next < history.length ? history[next] : draftRef.current);
              }
            }}
          />
          <label className="cc-attach" title="Joindre des fichiers (ou collez une image, ou déposez des fichiers ici)">
            <i className="bi bi-paperclip" />
            <input
              type="file"
              multiple
              hidden
              disabled={sending || encoding}
              onChange={(e) => {
                attachments.add(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <button type="button" className="cc-send" title="Envoyer" aria-label="Envoyer" disabled={!canSend} onClick={() => void submit()}>
            <i className="bi bi-send" />
          </button>
        </div>
      </div>
      {technical && (
        <div className="cc-hint justify-content-end">
          <span title="Dossier de travail de la session">{session.worktree?.path ?? session.project.workspacePath}</span>
        </div>
      )}
    </div>
  );
}
