import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import { canAutoFocus } from '../lib/device';
import { useSessionEvents } from '../lib/sessionEvents';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useDialogs } from '../components/Dialogs';
import { useCachedName } from '../components/PageLoading';
import { useAuth } from '../auth/AuthContext';

import { bypassConnectionsWarning, permissionModeLabels, permissionModeShortLabels, sessionStatusLabels } from '../lib/humanize';
import AttachmentChips from '../components/AttachmentChips';
import RequestPrompt from '../components/RequestPrompt';
import { SessionChildren, SessionParentNote, parentStateHint, useSessionActions } from '../components/SessionControls';
import { ContextBanner, ContextGauge } from '../components/ContextGauge';
import Transcript from '../components/Transcript';
import { fileToolResultCount } from '../lib/sessionChanges';
import { isImageType, toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import { confirmedPending, newPendingInstruction, withPendingInstructions, type PendingInstruction } from '../lib/pendingInstructions';
import '../components/terminal.css';
import '../components/chat.css';
import {
  INTERRUPT_SESSION,
  PROVIDERS,
  RESUME_SESSION,
  SEND_SESSION_MESSAGE,
  SESSION,
  SESSION_NAME,
  UPDATE_SESSION_CONFIG,
  type ChildSession,
  type ConfigField,
  type HumanRequest,
  type Provider,
  type Session,
  type SessionChanges as SessionChangesData,
} from '../graphql/operations';

type SessionWithRequests = Session & { requests: HumanRequest[]; childSessions: ChildSession[] };

const TECH_KEY = 'skipper.session.technical';
const draftKey = (id: string) => `skipper.session.draft.${id}`;
const readDraft = (id: string) => {
  try {
    return localStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return '';
  }
};
const writeDraft = (id: string, value: string) => {
  try {
    if (value) localStorage.setItem(draftKey(id), value);
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
};
/** Page de session : transcript et saisie d'instructions, à la manière de Claude Code. */
export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = usePollingQuery<{ session: SessionWithRequests | null }>(SESSION, { variables: { id }, pollInterval: 1500 });
  const { events, loaded: eventsLoaded, draft, refresh: refreshEvents } = useSessionEvents(id);
  const [sendMessage, { loading: sending, error: sendError }] = useMutation(SEND_SESSION_MESSAGE);
  const [interruptSession] = useMutation(INTERRUPT_SESSION, { onError: (err) => void showError(err) });
  const [resumeSession, { loading: resuming }] = useMutation(RESUME_SESSION, { onError: (err) => void showError(err) });
  const { confirm, showError } = useDialogs();
  const [updateConfig, { loading: updatingConfig, error: configError }] = useMutation(UPDATE_SESSION_CONFIG);
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  // L'en-tête tient sur une ligne (nom, détail tronqué, jauge) ; un chevron déplie le détail complet, les actions et les sous-agents.
  const [headerOpen, setHeaderOpen] = useState(false);
  const { user } = useAuth();

  // Brouillon conservé par session dans ce navigateur : fermer l'onglet ne perd pas une instruction en cours de rédaction.
  const [text, setTextState] = useState(() => readDraft(id));
  const setText = (value: string) => {
    setTextState(value);
    writeDraft(id, value);
  };
  const [encoding, setEncoding] = useState(false);
  const attachments = usePendingAttachments();
  // Instructions envoyées depuis cette page et pas encore journalisées par le serveur : affichées dans le
  // transcript dès l'envoi, sans attendre l'aller-retour de la mutation ni le prochain relevé des événements.
  const [pendingInstructions, setPendingInstructions] = useState<PendingInstruction[]>([]);
  const pendingRef = useRef(pendingInstructions);
  pendingRef.current = pendingInstructions;
  const shownEvents = useMemo(() => withPendingInstructions(events, pendingInstructions), [events, pendingInstructions]);
  const dropPending = (toDrop: PendingInstruction[]) => {
    if (!toDrop.length) return;
    toDrop.forEach((p) => p.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)));
    setPendingInstructions((list) => list.filter((p) => !toDrop.includes(p)));
  };
  // Une fois l'événement du serveur arrivé, l'instruction en attente qui lui correspond est oubliée.
  useEffect(() => {
    const confirmed = confirmedPending(events, pendingInstructions);
    if (confirmed.size) dropPending(pendingInstructions.filter((p) => confirmed.has(p.id)));
  }, [events, pendingInstructions]);
  // Au changement de session et à la fermeture de la page, rien ne reste des envois en attente (aperçus révoqués).
  useEffect(() => () => dropPending(pendingRef.current), [id]);
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
  const technicalToggle = (
    <label>
      <input type="checkbox" checked={technical} onChange={toggleTechnical} /> Afficher les détails techniques
    </label>
  );
  // Onglet « Modifications » du panneau de droite : sa liste est rechargée après chaque résultat d'un outil qui modifie
  // des fichiers (Edit, Write, Bash...) et à chaque changement d'état de la session (fin de tour d'un agent sans outils).
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
  const cachedName = useCachedName(SESSION_NAME, 'Session', id);
  useTabTitle(session?.name ?? cachedName);
  // Chat : conversation légère de l'espace personnel, sans dossier de travail (ni panneau de droite, ni planification).
  const chat = session?.kind === 'CHAT';
  const archived = Boolean(session?.archivedAt);
  const running = session?.status === 'RUNNING';
  const busy = running && session?.activity === 'BUSY';
  const pending = session?.requests ?? [];
  const changesKey = `${toolResults}:${session?.status}:${session?.activity}`;
  useGitTarget(
    session && !chat
      ? {
          projectId: session.project.id,
          worksessionId: session.worksession?.id ?? null,
          label: session.worksession ? `${session.project.name} · ${session.worksession.branch}` : session.project.name,
          tasks: session.tasks,
          sessionId: session.id,
          changesKey,
        }
      : null,
  );
  const actions = useSessionActions(session);

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

  const canSend = Boolean(text.trim() || attachments.items.length) && !sending && !encoding && !archived;
  const submit = async () => {
    if (!canSend) return;
    const value = text.trim();
    const items = attachments.items;
    // Le message apparaît dans le transcript et la zone de saisie se vide avant tout échange avec le serveur.
    const pending = newPendingInstruction(
      value,
      items.map((i) => ({ name: i.name, mediaType: i.mediaType, size: i.size, previewUrl: isImageType(i.mediaType) ? URL.createObjectURL(i.file) : null })),
      events.length,
    );
    setPendingInstructions((list) => [...list, pending]);
    setText('');
    attachments.reset();
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setEncoding(true);
    try {
      const files = items.length ? await toAttachmentInputs(items) : null;
      await sendMessage({ variables: { id, text: value, attachments: files } });
      // Le serveur a journalisé l'instruction : on la relève tout de suite plutôt qu'au prochain tour de sondage.
      refreshEvents();
    } catch {
      // L'erreur est affichée par sendError ; le message revient dans la zone de saisie pour être renvoyé.
      dropPending([pending]);
      setText(value);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setEncoding(false);
    }
  };

  // Pendant le chargement : l'en-tête avec le nom déjà connu (sidebar), plutôt qu'une page vide.
  if (loading && !data)
    return (
      <div className="cc">
        <div className="cc-header">
          <div>
            <span className="cc-title">✻ {cachedName ?? 'Session'}</span>
            <span className="cc-meta">
              {' '}
              · <Spinner animation="border" size="sm" /> chargement…
            </span>
          </div>
        </div>
      </div>
    );
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!session) return <Alert variant="warning">Session introuvable.</Alert>;

  const actionError = sendError ?? configError;
  const schedule = session.schedule;
  const parentHint = session.parentSession ? parentStateHint(session.parentSession) : null;
  const model = typeof session.config.model === 'string' ? session.config.model : null;
  const permissionMode = typeof session.config.permissionMode === 'string' ? session.config.permissionMode : 'default';
  // Réglages modifiables en cours de route : les champs à choix du provider (modèle, autorisations pour Claude).
  const providerFields = providersData?.providers.find((p) => p.type === session.provider)?.configFields ?? [];
  const modelField = providerFields.find((f) => f.key === 'model' && f.type === 'select');
  const permissionField = providerFields.find((f) => f.key === 'permissionMode' && f.type === 'select');
  // Un chat n'a ni fichiers ni commandes : seuls « demander » et « tout autoriser » ont un sens.
  const permissionOptions = (permissionField?.options ?? []).filter((o) => !chat || o.value === 'default' || o.value === 'bypassPermissions');
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
      ? "L'agent travaille… (Échap pour l'interrompre)"
      : running
        ? "⏵ L'agent attend vos instructions"
        : archived
          ? "■ Session archivée — restaurez-la pour reprendre la conversation, ou relancez-en une nouvelle"
          : session.status === 'QUEUED'
          ? `⧗ En file d'attente${session.queuePosition ? ` (rang ${session.queuePosition})` : ''} — la limite de sessions simultanées est atteinte, l'agent démarrera dès qu'une place se libère`
          : session.status === 'PENDING'
          ? "■ Pas encore démarrée — écrivez la première instruction pour lancer l'agent"
          : session.status === 'INTERRUPTED'
          ? `■ Interrompue${session.activity === 'BUSY' ? ' en plein travail' : ''} — reprenez-la, ou écrivez un message`
          : `■ ${sessionStatusLabels[session.status]} — écrivez un message pour reprendre la conversation`;

  return (
    <div className="cc">
      <div className={`cc-header${headerOpen ? ' open' : ''}`}>
        <div className="cc-header-main">
          <span className="cc-title" title={session.name}>{chat ? <i className="bi bi-chat-left-text-fill cc-chat-icon" /> : '✻ '}{session.name}</span>
          <span className="cc-meta">
            {' '}
            ·{' '}
            {chat ? (
              <Link to="/chats" className="cc-meta" title="Chat de votre espace personnel : tous vos chats">
                chat
              </Link>
            ) : (
              <Link to={`/projects/${session.project.id}`} className="cc-meta">{session.project.name}</Link>
            )}
            {session.worksession && (
              <>
                {' '}
                · <Link to={`/sessions/${session.id}/files`} className="cc-meta" title="Branche de la session · ouvrir ses fichiers"><i className="bi bi-git" /> {session.worksession.branch}</Link>
              </>
            )}
            {!session.worksession && session.formerWorksession && (
              <>
                {' '}
                · <span title={`La session a travaillé sur la branche ${session.formerWorksession.branch} ; son dossier de travail a été supprimé depuis`}><i className="bi bi-git" /> {session.formerWorksession.branch} <span className="cc-dimmer">(dossier supprimé)</span></span>
              </>
            )}
            {session.owner && (
              <>
                {' '}
                · <i className="bi bi-person" /> {session.owner.id === user?.id ? 'moi' : session.owner.name}
              </>
            )}
            {session.tasks.map((t) => (
              <span key={t.id}>
                {' '}
                · <Link to={`/tasks/${t.id}`} className="cc-meta" title={session.tasks.length > 1 ? `Tâche en charge (${session.tasks.length} au total)` : 'Tâche en charge'}><i className="bi bi-check2-square" /> {t.title}</Link>
              </span>
            ))}
            {session.parentSession && (
              <>
                {' '}
                · <Link to={`/sessions/${session.parentSession.id}`} className="cc-meta" title={`Sous-agent : lancée par l'agent de la session « ${session.parentSession.name} »${parentHint ? ` (${parentHint})` : ''}`}><i className="bi bi-robot" /> sous-agent de « {session.parentSession.name} »</Link>
              </>
            )}
            {session.childSessions.length > 0 && (
              <>
                {' '}
                · <button type="button" className="cc-link" title="Sous-agents : sessions lancées par l'agent de cette session (déplier pour les voir)" onClick={() => setHeaderOpen(true)}><i className="bi bi-robot" /> {session.childSessions.length > 1 ? `${session.childSessions.length} sous-agents` : '1 sous-agent'}</button>
              </>
            )}
            {archived && <> · <span className="cc-yellow">archivée</span></>}
          </span>
          {session.context.tokens !== null && (
            <span className="cc-header-gauge">
              <span className="cc-sep"> · </span>
              <ContextGauge context={session.context} onClick={actions.openSettings} />
            </span>
          )}
          <span className="cc-meta cc-meta-more">
            {session.workflowRun && (
              <>
                {' '}
                · workflow{' '}
                <Link to={`/workflows/${session.workflowRun.workflow.id}/runs/${session.workflowRun.id}`} className="cc-meta" title="Exécution de workflow qui a ouvert cette session">
                  <i className="bi bi-diagram-3" /> {session.workflowRun.workflow.name}
                </Link>
              </>
            )}
            {schedule && (
              <>
                {' '}
                ·{' '}
                <button type="button" className="cc-link" title={`${schedule.enabled ? 'Planifiée' : 'Planification désactivée'} : ${schedule.cron} (${schedule.timezone})${schedule.lastResult ? ` · dernière exécution : ${schedule.lastResult}` : ''}`} onClick={actions.openSchedule}>
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
        <button type="button" className="cc-header-toggle" aria-expanded={headerOpen} title={headerOpen ? 'Replier le détail de la session' : 'Détail et actions de la session (aussi dans le panneau de droite)'} onClick={() => setHeaderOpen((v) => !v)}>
          <i className={`bi bi-chevron-${headerOpen ? 'up' : 'down'}`} />
        </button>
      </div>
      {headerOpen && (
        <div className="cc-header-detail">
          <div className="cc-actions">{actions.buttons}</div>
          <div className="cc-toggle cc-toggle-mobile d-md-none">{technicalToggle}</div>
          <SessionParentNote session={session} />
          <SessionChildren children={session.childSessions} />
        </div>
      )}

      {/* Le bandeau de contexte vit dans l'onglet « Session » du panneau de droite ; un chat n'a pas de panneau, il le garde ici. */}
      {chat && <ContextBanner session={session} busy={Boolean(busy)} />}

      {/* Sur mobile, la ligne vit dans le détail repliable de l'en-tête, avec les boutons. */}
      <div className="cc-toggle d-none d-md-flex">{technicalToggle}</div>
      <Transcript events={shownEvents} draft={draft} loading={!eventsLoaded} technical={technical} />
      {actions.modals}

      {pending.length > 0 && (
        <div className="cc-prompts">
          {pending.map((r) => (
            <RequestPrompt key={r.id} request={r} />
          ))}
        </div>
      )}

      <div className="cc-status">
        <span>
          {busy && pending.length === 0 && <span className="cc-spinner">✻ </span>}
          {statusLine}
          {session.status === 'INTERRUPTED' && !archived && (
            <button
              type="button"
              className="cc-btn accent ms-2"
              disabled={resuming}
              title={session.activity === 'BUSY' ? "L'agent reprend le travail coupé par l'interruption" : "Rouvre la conversation ; l'agent attend votre prochaine instruction"}
              onClick={() => void resumeSession({ variables: { id } })}
            >
              <i className="bi bi-play-fill" /> {resuming ? 'Reprise…' : 'Reprendre'}
            </button>
          )}
        </span>
        <span>
          {session.error && <span className="cc-red">{session.error} · </span>}
          {actionError && <span className="cc-red">{actionError.message} · </span>}
          {bypassWarning() && (
            <span className="cc-yellow" title={bypassWarning() ?? undefined}>
              <i className="bi bi-exclamation-triangle" /> connexions non soumises
            </span>
          )}
        </span>
      </div>

      {!archived && (
      <div
        className="cc-input"
        onClick={(e) => {
          // Un clic sur la boîte ramène le curseur dans la saisie, sauf sur un contrôle (listes, boutons, puces).
          if (!(e.target as HTMLElement).closest('select, button, label, a')) inputRef.current?.focus();
        }}
        onDrop={attachments.onDrop}
        onDragOver={attachments.onDragOver}
      >
        <AttachmentChips items={attachments.items} onAdd={(files) => attachments.add(files)} onRemove={attachments.remove} disabled={sending || encoding} showButton={false} error={attachments.error} />
        <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={running ? "Écrivez ce que l'agent doit faire…" : 'Écrivez une nouvelle instruction pour reprendre…'}
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
        {/* Rangée d'outils : fichiers joints, modèle et autorisations de la session (modifiables à tout moment), envoi. */}
        <div className="cc-input-tools">
          <label className="cc-attach" title="Joindre des fichiers (ou collez une image, ou déposez des fichiers ici)" aria-label="Joindre des fichiers">
            <i className="bi bi-plus-lg" />
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
          {modelField ? (
            <span className="cc-pill" title="Modèle de cette session (modifiable à tout moment)">
              <span className="cc-pill-label">{(modelField.options ?? []).find((o) => o.value === model)?.label ?? model ?? '—'}</span>
              <i className="bi bi-chevron-down" />
              <select className="cc-select" aria-label="Modèle" value={model ?? ''} disabled={updatingConfig} onChange={(e) => changeSetting(modelField, e.target.value)}>
                {model && !(modelField.options ?? []).some((o) => o.value === model) && <option value={model}>{model}</option>}
                {(modelField.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            model && (
              <span className="cc-pill static" title="Modèle de cette session">
                {model}
              </span>
            )
          )}
          {permissionField ? (
            <span
              className={`cc-pill${permissionMode === 'bypassPermissions' ? ' warn' : ''}`}
              title={`Autorisations de cette session (modifiables à tout moment) : ${permissionModeLabels[permissionMode] ?? permissionMode}.${bypassWarning() ? ` ${bypassWarning()}` : ''}`}
            >
              {permissionMode === 'bypassPermissions' && <i className="bi bi-exclamation-triangle" />}
              <span className="cc-pill-label">{permissionModeShortLabels[permissionMode] ?? (permissionField.options ?? []).find((o) => o.value === permissionMode)?.label ?? permissionMode}</span>
              <i className="bi bi-chevron-down" />
              <select className="cc-select" aria-label="Autorisations" value={permissionMode} disabled={updatingConfig} onChange={(e) => changeSetting(permissionField, e.target.value)}>
                {permissionOptions.map((o) => (
                  <option key={o.value} value={o.value} title={o.description ?? undefined}>
                    {permissionModeShortLabels[o.value] ?? o.label}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            <span className={`cc-pill static${permissionMode === 'bypassPermissions' ? ' warn' : ''}`} title={`Autorisations de cette session : ${permissionModeLabels[permissionMode] ?? permissionMode}`}>
              {permissionMode === 'bypassPermissions' && <i className="bi bi-exclamation-triangle" />}
              {permissionModeShortLabels[permissionMode] ?? permissionMode}
            </span>
          )}
          <button type="button" className="cc-send" title="Envoyer (Entrée)" aria-label="Envoyer" disabled={!canSend} onClick={() => void submit()}>
            <i className="bi bi-arrow-up" />
          </button>
        </div>
      </div>
      )}
      {technical && !chat && (
        <div className="cc-hint justify-content-end">
          <span title="Dossier de travail de la session">{session.worksession?.path ?? session.project.workspacePath}</span>
        </div>
      )}
    </div>
  );
}
