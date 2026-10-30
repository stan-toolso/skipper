import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { ADD_TASK_COMMENT, DELETE_TASK_COMMENT, TASK_COMMENTS, UPDATE_TASK_COMMENT } from '../graphql/tasks';
import type { TaskComment } from '../graphql/operations';
import { toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useDialogs } from './Dialogs';
import AttachmentChips from './AttachmentChips';
import Markdown from './Markdown';
import TaskAttachments from './TaskAttachments';

const REFETCH = ['TaskComments', 'Tasks', 'TaskDetail', 'TaskPage'];

function CommentRow({ c, taskId }: { c: TaskComment; taskId: string }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const [removed, setRemoved] = useState<string[]>([]);
  const { confirm, showError } = useDialogs();
  const [update, { loading }] = useMutation(UPDATE_TASK_COMMENT, { refetchQueries: REFETCH, onCompleted: () => setEditing(false), onError: (e) => void showError(e) });
  const [remove] = useMutation(DELETE_TASK_COMMENT, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const edited = new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;
  return (
    <div className="task-comment">
      <div className="task-comment-head">
        <i className={`bi ${c.authorType === 'agent' ? 'bi-robot' : 'bi-person'}`} />
        {c.authorSession ? <Link to={`/sessions/${c.authorSession.id}`}>{c.authorName}</Link> : <span className="fw-semibold">{c.authorName}</span>}
        <span className="text-secondary" title={new Date(c.createdAt).toLocaleString()}>
          {timeAgo(c.createdAt)}
          {edited && ' · modifié'}
        </span>
        <span className="task-comment-actions">
          {c.editable && !editing && (
            <button type="button" className="btn btn-link btn-sm p-0 text-secondary" title="Modifier" onClick={() => setEditing(true)}>
              <i className="bi bi-pencil" />
            </button>
          )}
          {c.deletable && (
            <button
              type="button"
              className="btn btn-link btn-sm p-0 text-secondary"
              title="Supprimer"
              onClick={async () => {
                if (await confirm({ title: 'Supprimer le commentaire', message: 'Supprimer ce commentaire ?', confirmLabel: 'Supprimer', danger: true })) remove({ variables: { id: c.id } });
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
          {c.body && <Markdown text={c.body} className="task-comment-body" />}
          <TaskAttachments taskId={taskId} attachments={c.attachments} />
        </>
      )}
    </div>
  );
}

/** Commentaires d'une tâche, avec saisie (Markdown, ⌘/Ctrl+Entrée pour envoyer). Pas de <form> : vit dans des formulaires. */
export default function TaskComments({ taskId }: { taskId: string }) {
  const { data } = usePollingQuery<{ task: { id: string; comments: TaskComment[] } | null }>(TASK_COMMENTS, { variables: { id: taskId }, pollInterval: 10_000 });
  const [text, setText] = useState('');
  const files = usePendingAttachments();
  const [add, { loading, error }] = useMutation(ADD_TASK_COMMENT, {
    refetchQueries: REFETCH,
    onCompleted: () => {
      setText('');
      files.reset();
    },
  });
  const comments = data?.task?.comments ?? [];
  const canSend = Boolean(text.trim() || files.items.length);
  const send = async () => {
    if (!canSend) return;
    const attachments = files.items.length ? await toAttachmentInputs(files.items) : null;
    add({ variables: { taskId, body: text, attachments } });
  };
  return (
    <div className="task-comments">
      {comments.map((c) => (
        <CommentRow key={c.id} c={c} taskId={taskId} />
      ))}
      {data && comments.length === 0 && <div className="text-secondary small fst-italic">Pas encore de commentaire.</div>}
      <div className="mt-2">
        <Form.Control
          as="textarea"
          rows={2}
          placeholder="Ajouter un commentaire (Markdown, ⌘/Ctrl+Entrée pour envoyer)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={files.onPaste}
          onDrop={files.onDrop}
          onDragOver={files.onDragOver}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="d-flex justify-content-between align-items-start gap-2 mt-1">
          <AttachmentChips items={files.items} onAdd={(f) => files.add(f)} onRemove={files.remove} disabled={loading} error={files.error} />
          <Button size="sm" variant="outline-primary" className="flex-shrink-0" disabled={loading || !canSend} onClick={() => void send()}>
            {loading ? 'Envoi…' : 'Commenter'}
          </Button>
        </div>
        {error && (
          <Alert variant="danger" className="mt-2 mb-0 py-1 small">
            {error.message}
          </Alert>
        )}
      </div>
    </div>
  );
}
