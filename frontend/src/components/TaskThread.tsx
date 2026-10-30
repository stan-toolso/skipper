import { useMutation } from '@apollo/client';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ADD_TASK_COMMENT, DELETE_TASK_COMMENT, TASK_THREAD, TOGGLE_TASK_REACTION, UPDATE_TASK_COMMENT } from '../graphql/tasks';
import type { TaskComment, TaskMentionable, TaskReaction } from '../graphql/operations';
import { toAttachmentInputs, usePendingAttachments, type AttachmentRef } from '../lib/attachments';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { initialsOf } from '../workbench/WorkspaceTabs';
import AttachmentChips from './AttachmentChips';
import { useDialogs } from './Dialogs';
import Markdown, { withMentionLinks } from './Markdown';
import TaskAttachments from './TaskAttachments';

const REFETCH = ['TaskThread', 'Tasks', 'TaskDetail', 'TaskPage'];
/** Emojis proposés d'un clic (les plus courants d'un fil de travail). */
const QUICK_EMOJIS = ['👍', '👀', '✅', '🎉', '❤️', '🤔', '❓', '🚀', '👎', '🙏'];

const fmtFull = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

interface ThreadData {
  task: { id: string; commentCount: number; reactions: TaskReaction[]; mentionables: TaskMentionable[]; comments: TaskComment[] } | null;
}

/** Le message d'ouverture du fil (la description de la tâche), rendu par la page de la tâche avec les mêmes codes qu'un message. */
export interface ThreadOpening {
  authorName: string;
  byAgent: boolean;
  sessionId: string | null;
  createdAt: string;
  body: ReactNode;
  attachments: AttachmentRef[];
}

/** Avatar d'un auteur : initiales d'une personne, robot pour une session d'agent. */
function Avatar({ name, agent }: { name: string; agent: boolean }) {
  return agent ? (
    <span className="tt-avatar tt-avatar-agent" title="Session d'agent">
      <i className="bi bi-robot" />
    </span>
  ) : (
    <span className="tt-avatar" title={name}>
      {initialsOf(name)}
    </span>
  );
}

/** Barre des réactions d'un message (ou de la tâche) : une puce par emoji (en relief si l'on en est), et le bouton « + ». */
function Reactions({ reactions, onToggle, canWrite, compact }: { reactions: TaskReaction[]; onToggle: (emoji: string) => void; canWrite: boolean; compact?: boolean }) {
  const [picking, setPicking] = useState(false);
  if (!reactions.length && !canWrite) return null;
  return (
    <div className="tt-reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`tt-reaction${r.mine ? ' mine' : ''}`}
          title={`${r.actors.join(', ')}${canWrite ? (r.mine ? ' · cliquer pour retirer' : ' · cliquer pour réagir aussi') : ''}`}
          disabled={!canWrite}
          onClick={() => onToggle(r.emoji)}
        >
          <span className="tt-reaction-emoji">{r.emoji}</span> {r.count}
        </button>
      ))}
      {canWrite && (
        <span className="tt-react-wrap">
          <button type="button" className={`tt-reaction tt-react-add${picking ? ' open' : ''}${reactions.length || !compact ? '' : ' tt-react-quiet'}`} title="Réagir" aria-label="Ajouter une réaction" onClick={() => setPicking((p) => !p)}>
            <i className="bi bi-emoji-smile" />
            <i className="bi bi-plus" />
          </button>
          {picking && <EmojiPicker onPick={(e) => { onToggle(e); setPicking(false); }} onClose={() => setPicking(false)} />}
        </span>
      )}
    </div>
  );
}

/** Choix d'un emoji : les plus courants, ou un emoji tapé au clavier. */
function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState('');
  useEffect(() => {
    const close = () => onClose();
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div className="tt-emoji-picker" role="dialog" aria-label="Choisir une réaction" onClick={(e) => e.stopPropagation()}>
      {QUICK_EMOJIS.map((e) => (
        <button key={e} type="button" className="tt-emoji" onClick={() => onPick(e)} title={e}>
          {e}
        </button>
      ))}
      <input
        className="tt-emoji-custom"
        placeholder="autre…"
        aria-label="Autre emoji"
        value={custom}
        maxLength={8}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom.trim()) {
            e.preventDefault();
            onPick(custom.trim());
          }
        }}
      />
    </div>
  );
}

/**
 * Zone de saisie d'un message : Markdown, fichiers collés ou déposés, ⌘/Ctrl+Entrée pour envoyer, et suggestions de
 * mention dès que l'on tape « @ » (membres du projet, sessions d'agent ; flèches pour choisir, Entrée ou Tab pour
 * insérer). Pas de <form> : vit dans des formulaires.
 */
function Composer({
  taskId,
  parentId = null,
  mentionables,
  placeholder,
  autoFocus,
  onSent,
  onCancel,
  compact,
}: {
  taskId: string;
  parentId?: string | null;
  mentionables: TaskMentionable[];
  placeholder: string;
  autoFocus?: boolean;
  onSent?: () => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState('');
  const files = usePendingAttachments();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const [add, { loading, error }] = useMutation(ADD_TASK_COMMENT, {
    refetchQueries: REFETCH,
    onCompleted: () => {
      setText('');
      files.reset();
      onSent?.();
    },
  });
  const canSend = Boolean(text.trim() || files.items.length);
  const send = async () => {
    if (!canSend || loading) return;
    const attachments = files.items.length ? await toAttachmentInputs(files.items) : null;
    add({ variables: { taskId, body: text, attachments, parentId } });
  };

  // Suggestions : « @ » en début de mot avant le curseur, puis jusqu'à 40 caractères sans retour à la ligne.
  const detect = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|[\s(«"'])@([^@\n]{0,40})$/u.exec(before);
    if (!m) return setMention(null);
    const query = m[2];
    const start = caret - query.length - 1;
    setMention((cur) => (cur && cur.start === start ? { ...cur, query } : { start, query, index: 0 }));
  }, []);
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = fold(mention.query.trim());
    const hits = mentionables.filter((m) => !q || fold(m.label).includes(q) || fold(m.text).includes(q) || (m.detail ? fold(m.detail).includes(q) : false));
    // Les personnes d'abord, puis les sessions ; au plus huit.
    return [...hits.filter((m) => m.kind === 'user'), ...hits.filter((m) => m.kind === 'session')].slice(0, 8);
  }, [mention, mentionables]);
  const insert = (m: TaskMentionable) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}${m.text} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const pos = mention.start + m.text.length + 1;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({ ...mention, index: (mention.index + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(suggestions[mention.index] ?? suggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && onCancel) {
      onCancel();
    }
  };
  return (
    <div className={`tt-composer${compact ? ' compact' : ''}`}>
      <div className="tt-composer-box">
        <Form.Control
          as="textarea"
          ref={ref}
          rows={compact ? 2 : 3}
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) => detect(text, (e.target as HTMLTextAreaElement).selectionStart ?? text.length)}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={files.onPaste}
          onDrop={files.onDrop}
          onDragOver={files.onDragOver}
          onKeyDown={onKeyDown}
        />
        {mention && suggestions.length > 0 && (
          <div className="tt-mention-menu" role="listbox" aria-label="Mentionner">
            {suggestions.map((m, i) => (
              <button
                key={`${m.kind}:${m.id}`}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className={`tt-mention-item${i === mention.index ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(m)}
              >
                <i className={`bi ${m.kind === 'session' ? 'bi-robot' : 'bi-person'}`} />
                <span className="tt-mention-label">{m.label}</span>
                {m.detail && <span className="tt-mention-detail">{m.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tt-composer-foot">
        <AttachmentChips items={files.items} onAdd={(f) => files.add(f)} onRemove={files.remove} disabled={loading} error={files.error} />
        <span className="tt-composer-hint">@ pour mentionner · Markdown · ⌘/Ctrl+Entrée</span>
        <span className="tt-composer-actions">
          {onCancel && (
            <Button size="sm" variant="link" className="text-secondary" onClick={onCancel}>
              Annuler
            </Button>
          )}
          <Button size="sm" variant={parentId ? 'outline-primary' : 'primary'} disabled={loading || !canSend} onClick={() => void send()} title="Envoyer (⌘/Ctrl+Entrée)">
            {loading ? 'Envoi…' : parentId ? 'Répondre' : 'Envoyer'}
          </Button>
        </span>
      </div>
      {error && (
        <Alert variant="danger" className="mt-2 mb-0 py-1 small">
          {error.message}
        </Alert>
      )}
    </div>
  );
}

/** Un message du fil : avatar, auteur, date, texte (mentions en pastilles), fichiers, réactions ; actions au survol. */
function Message({
  c,
  taskId,
  canWrite,
  onReply,
  onToggleReaction,
  isReply,
  compact,
}: {
  c: TaskComment;
  taskId: string;
  canWrite: boolean;
  onReply?: () => void;
  onToggleReaction: (emoji: string) => void;
  isReply?: boolean;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const [removed, setRemoved] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const { user } = useAuth();
  const { confirm, showError } = useDialogs();
  const [update, { loading }] = useMutation(UPDATE_TASK_COMMENT, { refetchQueries: REFETCH, onCompleted: () => setEditing(false), onError: (e) => void showError(e) });
  const [remove] = useMutation(DELETE_TASK_COMMENT, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const edited = new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;
  const mentionsMe = Boolean(user && c.mentions.some((m) => m.kind === 'user' && m.id === user.id));
  const agent = c.authorType === 'agent';
  return (
    <div id={`comment-${c.id}`} className={`tt-msg${isReply ? ' tt-reply' : ''}${mentionsMe ? ' tt-mentions-me' : ''}`}>
      <Avatar name={c.authorName} agent={agent} />
      <div className="tt-msg-main">
        <div className="tt-msg-head">
          {c.authorSession ? (
            <Link to={`/sessions/${c.authorSession.id}`} className="tt-author">
              {c.authorName}
            </Link>
          ) : (
            <span className="tt-author">{c.authorName}</span>
          )}
          {agent && <span className="tt-badge-agent">agent</span>}
          <span className="tt-time" title={fmtFull(c.createdAt)}>
            {timeAgo(c.createdAt)}
            {edited && ' · modifié'}
          </span>
          <span className="tt-msg-actions">
            {canWrite && (
              <span className="tt-react-wrap">
                <button type="button" className="tt-icon-btn" title="Réagir" aria-label="Réagir" onClick={() => setPicking((p) => !p)}>
                  <i className="bi bi-emoji-smile" />
                </button>
                {picking && <EmojiPicker onPick={(e) => { onToggleReaction(e); setPicking(false); }} onClose={() => setPicking(false)} />}
              </span>
            )}
            {canWrite && onReply && (
              <button type="button" className="tt-icon-btn" title="Répondre dans le fil" aria-label="Répondre dans le fil" onClick={onReply}>
                <i className="bi bi-reply" />
              </button>
            )}
            {c.editable && !editing && (
              <button type="button" className="tt-icon-btn" title="Modifier" aria-label="Modifier" onClick={() => setEditing(true)}>
                <i className="bi bi-pencil" />
              </button>
            )}
            {c.deletable && (
              <button
                type="button"
                className="tt-icon-btn"
                title="Supprimer"
                aria-label="Supprimer"
                onClick={async () => {
                  if (await confirm({ title: 'Supprimer le message', message: isReply ? 'Supprimer cette réponse ?' : 'Supprimer ce message et ses réponses ?', confirmLabel: 'Supprimer', danger: true })) remove({ variables: { id: c.id } });
                }}
              >
                <i className="bi bi-trash" />
              </button>
            )}
          </span>
        </div>
        {editing ? (
          <div className="mt-1">
            <Form.Control as="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            <TaskAttachments taskId={taskId} attachments={c.attachments} removed={removed} onToggleRemove={(id) => setRemoved((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))} />
            <div className="d-flex gap-2 mt-1">
              <Button size="sm" variant="outline-secondary" onClick={() => { setEditing(false); setBody(c.body); setRemoved([]); }}>
                Annuler
              </Button>
              <Button size="sm" disabled={loading || (!body.trim() && removed.length >= c.attachments.length)} onClick={() => update({ variables: { id: c.id, body, removeAttachmentIds: removed.length ? removed : null } })}>
                Enregistrer
              </Button>
            </div>
          </div>
        ) : (
          <>
            {c.body && <Markdown text={withMentionLinks(c.body, c.mentions)} className="tt-body" />}
            <TaskAttachments taskId={taskId} attachments={c.attachments} />
          </>
        )}
        <Reactions reactions={c.reactions} onToggle={onToggleReaction} canWrite={canWrite} compact={compact} />
      </div>
    </div>
  );
}

/** Un message racine avec son fil de réponses (replié au-delà de trois) et, à la demande, la zone pour y répondre. */
function RootMessage({ root, replies, taskId, canWrite, mentionables, toggle, compact }: { root: TaskComment; replies: TaskComment[]; taskId: string; canWrite: boolean; mentionables: TaskMentionable[]; toggle: (commentId: string | null, emoji: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(replies.length <= 3);
  const [replying, setReplying] = useState(false);
  const last = replies[replies.length - 1];
  const participants = [...new Set(replies.map((r) => r.authorName))];
  return (
    <div className="tt-root">
      <Message c={root} taskId={taskId} canWrite={canWrite} onReply={() => { setReplying(true); setOpen(true); }} onToggleReaction={(e) => toggle(root.id, e)} compact={compact} />
      {(replies.length > 0 || replying) && (
        <div className="tt-thread">
          {replies.length > 0 && (
            <button type="button" className="tt-thread-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <i className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}`} />
              {replies.length} réponse{replies.length > 1 ? 's' : ''}
              {!open && last && (
                <span className="tt-thread-meta">
                  {' · '}
                  {participants.slice(0, 3).join(', ')}
                  {participants.length > 3 && ` et ${participants.length - 3} autre${participants.length > 4 ? 's' : ''}`}
                  {' · dernière '}
                  {timeAgo(last.createdAt)}
                </span>
              )}
            </button>
          )}
          {open && replies.map((r) => <Message key={r.id} c={r} taskId={taskId} canWrite={canWrite} onToggleReaction={(e) => toggle(r.id, e)} isReply compact={compact} />)}
          {open && canWrite && !replying && replies.length > 0 && (
            <button type="button" className="tt-thread-reply-link" onClick={() => setReplying(true)}>
              <i className="bi bi-reply" /> Répondre dans le fil
            </button>
          )}
          {replying && <Composer taskId={taskId} parentId={root.id} mentionables={mentionables} placeholder={`Répondre à ${root.authorName}…`} autoFocus compact onSent={() => setReplying(false)} onCancel={() => setReplying(false)} />}
        </div>
      )}
    </div>
  );
}

/**
 * Le fil de discussion d'une tâche, à la manière d'un canal Slack : le message d'ouverture (`opening`, la description
 * de la tâche, rendu par la page), puis les messages dans l'ordre, chacun avec ses réponses en fil, ses réactions et
 * ses mentions ; en bas, la zone de saisie. `canWrite` : les lecteurs du projet lisent sans écrire. `compact` :
 * dans le panneau de droite ou une modale.
 */
export default function TaskThread({ taskId, opening, canWrite = true, compact }: { taskId: string; opening?: ThreadOpening; canWrite?: boolean; compact?: boolean }) {
  const { data } = usePollingQuery<ThreadData>(TASK_THREAD, { variables: { id: taskId }, pollInterval: 10_000 });
  const { showError } = useDialogs();
  const [toggleReaction] = useMutation(TOGGLE_TASK_REACTION, { refetchQueries: ['TaskThread'], onError: (e) => void showError(e) });
  const toggle = useCallback((commentId: string | null, emoji: string) => void toggleReaction({ variables: { taskId, commentId, emoji } }), [taskId, toggleReaction]);
  const comments = data?.task?.comments ?? [];
  const mentionables = data?.task?.mentionables ?? [];
  const { roots, byParent } = useMemo(() => {
    const byParent = new Map<string, TaskComment[]>();
    const ids = new Set(comments.map((c) => c.id));
    const roots: TaskComment[] = [];
    for (const c of comments) {
      if (c.parentId && ids.has(c.parentId)) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
      else roots.push(c);
    }
    return { roots, byParent };
  }, [comments]);

  // Un lien #comment-<id> (notification de mention ou de réponse) amène au message et le met en relief.
  useEffect(() => {
    if (!data || !window.location.hash.startsWith('#comment-')) return;
    const el = document.getElementById(window.location.hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('tt-flash');
    const t = setTimeout(() => el.classList.remove('tt-flash'), 2500);
    return () => clearTimeout(t);
  }, [data]);

  return (
    <div className={`tt${compact ? ' tt-compact' : ''}`}>
      {opening && (
        <div className="tt-msg tt-opening">
          <Avatar name={opening.authorName} agent={opening.byAgent} />
          <div className="tt-msg-main">
            <div className="tt-msg-head">
              {opening.sessionId ? (
                <Link to={`/sessions/${opening.sessionId}`} className="tt-author">
                  {opening.authorName}
                </Link>
              ) : (
                <span className="tt-author">{opening.authorName}</span>
              )}
              {opening.byAgent && <span className="tt-badge-agent">agent</span>}
              <span className="tt-time" title={fmtFull(opening.createdAt)}>
                a ouvert la tâche {timeAgo(opening.createdAt)}
              </span>
            </div>
            <div className="tt-body tt-opening-body">{opening.body}</div>
            <TaskAttachments taskId={taskId} attachments={opening.attachments} />
            <Reactions reactions={data?.task?.reactions ?? []} onToggle={(e) => toggle(null, e)} canWrite={canWrite} compact={compact} />
          </div>
        </div>
      )}
      {data && comments.length === 0 && <div className="tt-empty">Pas encore de message. {canWrite && 'Écrivez le premier : les sessions reliées à la tâche le recevront.'}</div>}
      {roots.map((root) => (
        <RootMessage key={root.id} root={root} replies={byParent.get(root.id) ?? []} taskId={taskId} canWrite={canWrite} mentionables={mentionables} toggle={toggle} compact={compact} />
      ))}
      {canWrite && <Composer taskId={taskId} mentionables={mentionables} placeholder="Écrire dans le fil… (@ pour mentionner une personne ou une session)" compact={compact} />}
    </div>
  );
}
