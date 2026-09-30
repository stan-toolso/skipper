import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Form, Modal, Spinner } from 'react-bootstrap';
import DiffView from '../components/DiffView';
import { useDialogs } from '../components/Dialogs';
import {
  GIT_BRANCHES,
  GIT_CHECKOUT,
  GIT_COMMIT,
  GIT_COMMIT_DIFF,
  GIT_DIFF,
  GIT_DISCARD,
  GIT_FETCH,
  GIT_LOG,
  GIT_PULL,
  GIT_PUSH,
  GIT_STAGE,
  GIT_STATUS,
  GIT_UNSTAGE,
  type GitBranch,
  type GitCommit,
  type GitDiff,
  type GitFileChange,
  type GitStatus,
} from '../graphql/operations';
import { useGitPanel } from './GitTargetContext';

const statusLabels: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'git-m' },
  A: { label: 'A', cls: 'git-a' },
  D: { label: 'D', cls: 'git-d' },
  R: { label: 'R', cls: 'git-r' },
  C: { label: 'C', cls: 'git-r' },
  U: { label: '!', cls: 'git-d' },
  '?': { label: 'U', cls: 'git-u' },
  T: { label: 'T', cls: 'git-m' },
};

type DiffRequest = { kind: 'file'; path: string; staged: boolean } | { kind: 'commit'; hash: string; subject: string };

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `il y a ${Math.floor(s / 86400)} j`;
  return new Date(iso).toLocaleDateString();
}

/** Fenêtre de diff (fichier ou commit). */
function DiffModal({ req, vars, onClose }: { req: DiffRequest; vars: { projectId: string; worktreeId: string | null }; onClose: () => void }) {
  const fileQ = useQuery<{ gitDiff: GitDiff }>(GIT_DIFF, { variables: { ...vars, path: req.kind === 'file' ? req.path : '', staged: req.kind === 'file' ? req.staged : false }, skip: req.kind !== 'file', fetchPolicy: 'network-only' });
  const commitQ = useQuery<{ gitCommitDiff: GitDiff }>(GIT_COMMIT_DIFF, { variables: { ...vars, hash: req.kind === 'commit' ? req.hash : '' }, skip: req.kind !== 'commit', fetchPolicy: 'network-only' });
  const q = req.kind === 'file' ? fileQ : commitQ;
  const diff = req.kind === 'file' ? fileQ.data?.gitDiff : commitQ.data?.gitCommitDiff;
  return (
    <Modal show onHide={onClose} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h6 font-monospace">
          {req.kind === 'file' ? (
            <>
              {req.path} <span className="text-secondary">· {req.staged ? 'indexé (vs HEAD)' : 'non indexé (vs index)'}</span>
            </>
          ) : (
            <>
              {req.hash.slice(0, 7)} <span className="text-secondary">· {req.subject}</span>
            </>
          )}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="p-0">
        {q.loading && !diff && (
          <div className="p-3">
            <Spinner size="sm" /> Chargement…
          </div>
        )}
        {q.error && <Alert variant="danger" className="m-3">{q.error.message}</Alert>}
        {diff && <DiffView text={diff.text} binary={diff.binary} />}
        {diff?.truncated && <div className="text-secondary small p-2">Diff tronqué (trop volumineux).</div>}
      </Modal.Body>
    </Modal>
  );
}

function ChangeRow({ c, staged, onOpen, onStage, onUnstage, onDiscard }: { c: GitFileChange; staged: boolean; onOpen: () => void; onStage?: () => void; onUnstage?: () => void; onDiscard?: () => void }) {
  const code = staged ? c.indexStatus : c.untracked ? '?' : c.worktreeStatus;
  const st = statusLabels[code] ?? { label: code, cls: '' };
  const name = c.path.split('/').pop() ?? c.path;
  const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '';
  return (
    <div className="git-row" title={c.origPath ? `${c.origPath} → ${c.path}` : c.path}>
      <button type="button" className="git-row-main" onClick={onOpen}>
        <span className={`git-status ${st.cls}`}>{st.label}</span>
        <span className="git-name">{name}</span>
        {dir && <span className="git-dir">{dir}</span>}
      </button>
      <span className="git-row-actions">
        {onDiscard && (
          <button type="button" title="Abandonner les modifications" onClick={onDiscard}>
            <i className="bi bi-arrow-counterclockwise" />
          </button>
        )}
        {onStage && (
          <button type="button" title="Indexer (git add)" onClick={onStage}>
            <i className="bi bi-plus-lg" />
          </button>
        )}
        {onUnstage && (
          <button type="button" title="Désindexer" onClick={onUnstage}>
            <i className="bi bi-dash-lg" />
          </button>
        )}
      </span>
    </div>
  );
}

function Section({ title, count, defaultOpen = true, children, action }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode; action?: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="git-section">
      <div className="git-section-head">
        <button type="button" className="git-section-toggle" onClick={() => setOpen((v) => !v)}>
          <i className={`bi bi-chevron-${open ? 'down' : 'right'}`} /> {title}
          {count !== undefined && <span className="git-count">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="git-section-body">{children}</div>}
    </div>
  );
}

/** Panneau git (sidebar droite) : modifications, commit, branches, historique. */
export default function GitPanel() {
  const { target, open, setOpen } = useGitPanel();
  const vars = target ? { projectId: target.projectId, worktreeId: target.worktreeId } : null;
  const [diffReq, setDiffReq] = useState<DiffRequest | null>(null);
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const statusQ = useQuery<{ gitStatus: GitStatus }>(GIT_STATUS, { variables: vars ?? undefined, skip: !vars || !open, pollInterval: 5000 });
  const branchesQ = useQuery<{ gitBranches: GitBranch[] }>(GIT_BRANCHES, { variables: vars ?? undefined, skip: !vars || !open, pollInterval: 15000 });
  const logQ = useQuery<{ gitLog: GitCommit[] }>(GIT_LOG, { variables: { ...(vars ?? {}), limit: 30 }, skip: !vars || !open, pollInterval: 15000 });
  const refetchAll = () => Promise.all([statusQ.refetch(), branchesQ.refetch(), logQ.refetch()]);
  const opts = { onCompleted: () => void refetchAll(), onError: (e: Error) => setActionError(e.message) };
  const [stage, { loading: staging }] = useMutation(GIT_STAGE, opts);
  const [unstage, { loading: unstaging }] = useMutation(GIT_UNSTAGE, opts);
  const { confirm } = useDialogs();
  const [discard] = useMutation(GIT_DISCARD, opts);
  const [commit, { loading: committing }] = useMutation(GIT_COMMIT, { ...opts, onCompleted: () => { setMessage(''); void refetchAll(); } });
  const [fetch, { loading: fetching }] = useMutation(GIT_FETCH, opts);
  const [pull, { loading: pulling }] = useMutation(GIT_PULL, opts);
  const [push, { loading: pushing }] = useMutation(GIT_PUSH, opts);
  const [checkout, { loading: checkingOut }] = useMutation(GIT_CHECKOUT, { ...opts, onCompleted: () => { setNewBranch(''); void refetchAll(); } });
  useEffect(() => setActionError(null), [target?.projectId, target?.worktreeId]);

  if (!target) return null;
  if (!open) {
    return (
      <button type="button" className="git-collapsed" title="Afficher le suivi git" onClick={() => setOpen(true)}>
        <i className="bi bi-git" />
      </button>
    );
  }

  const status = statusQ.data?.gitStatus;
  const staged = status?.changes.filter((c) => c.staged) ?? [];
  const unstaged = status?.changes.filter((c) => c.unstaged || c.untracked || c.conflicted) ?? [];
  const busy = staging || unstaging || committing || fetching || pulling || pushing || checkingOut;
  const local = branchesQ.data?.gitBranches.filter((b) => !b.remote) ?? [];
  const remote = branchesQ.data?.gitBranches.filter((b) => b.remote) ?? [];

  return (
    <aside className="git-panel">
      <div className="git-head">
        <div className="git-head-title">
          <i className="bi bi-git me-1" />
          <span title={target.label}>{target.label}</span>
        </div>
        <button type="button" className="git-icon-btn" title="Masquer" onClick={() => setOpen(false)}>
          <i className="bi bi-chevron-double-right" />
        </button>
      </div>

      {statusQ.error && <Alert variant="warning" className="m-2 py-1 small">{statusQ.error.message}</Alert>}
      {actionError && (
        <Alert variant="danger" className="m-2 py-1 small" dismissible onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {status && (
        <div className="git-branchbar">
          <span className="git-branch" title={status.upstream ? `suit ${status.upstream}` : 'sans branche distante'}>
            <i className="bi bi-diagram-2 me-1" />
            {status.detached ? 'HEAD détaché' : status.branch}
            {status.ahead > 0 && <span className="git-ab" title="commits à pousser">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-ab" title="commits à récupérer">↓{status.behind}</span>}
          </span>
          <span className="git-branch-actions">
            <button type="button" className="git-icon-btn" title="Fetch" disabled={busy} onClick={() => fetch({ variables: vars ?? undefined })}>
              <i className={`bi bi-arrow-repeat${fetching ? ' spin' : ''}`} />
            </button>
            <button type="button" className="git-icon-btn" title="Pull (fast-forward)" disabled={busy || !status.upstream} onClick={() => pull({ variables: vars ?? undefined })}>
              <i className="bi bi-cloud-download" />
            </button>
            <button type="button" className="git-icon-btn" title={status.upstream ? 'Push' : 'Push (crée la branche distante)'} disabled={busy || status.detached} onClick={() => push({ variables: vars ?? undefined })}>
              <i className="bi bi-cloud-upload" />
            </button>
          </span>
        </div>
      )}

      <div className="git-body">
        <Section
          title="Indexé"
          count={staged.length}
          action={
            staged.length > 0 ? (
              <button type="button" className="git-icon-btn" title="Tout désindexer" disabled={busy} onClick={() => unstage({ variables: { ...vars, paths: [] } })}>
                <i className="bi bi-dash-lg" />
              </button>
            ) : undefined
          }
        >
          {staged.length === 0 && <div className="git-empty">Rien d'indexé.</div>}
          {staged.map((c) => (
            <ChangeRow key={`s:${c.path}`} c={c} staged onOpen={() => setDiffReq({ kind: 'file', path: c.path, staged: true })} onUnstage={() => unstage({ variables: { ...vars, paths: [c.path] } })} />
          ))}
        </Section>

        <Section
          title="Modifications"
          count={unstaged.length}
          action={
            unstaged.length > 0 ? (
              <button type="button" className="git-icon-btn" title="Tout indexer" disabled={busy} onClick={() => stage({ variables: { ...vars, paths: [] } })}>
                <i className="bi bi-plus-lg" />
              </button>
            ) : undefined
          }
        >
          {unstaged.length === 0 && <div className="git-empty">Aucune modification en cours.</div>}
          {unstaged.map((c) => (
            <ChangeRow
              key={`u:${c.path}`}
              c={c}
              staged={false}
              onOpen={() => setDiffReq({ kind: 'file', path: c.path, staged: false })}
              onStage={() => stage({ variables: { ...vars, paths: [c.path] } })}
              onDiscard={async () => {
                const ok = await confirm(
                  c.untracked
                    ? { title: 'Supprimer le fichier', message: <>Supprimer le fichier non suivi <code>{c.path}</code> ?</>, confirmLabel: 'Supprimer', danger: true }
                    : { title: 'Abandonner les modifications', message: <>Abandonner les modifications de <code>{c.path}</code> ? Elles seront perdues.</>, confirmLabel: 'Abandonner', danger: true },
                );
                if (ok) discard({ variables: { ...vars, paths: [c.path] } });
              }}
            />
          ))}
        </Section>

        <div className="git-commit">
          <Form.Control
            as="textarea"
            rows={2}
            size="sm"
            placeholder={staged.length ? 'Message de commit' : "Indexez des modifications, puis décrivez-les ici"}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && message.trim() && staged.length) commit({ variables: { ...vars, message } });
            }}
          />
          <div className="d-flex gap-2 mt-1">
            <Button size="sm" disabled={busy || !message.trim() || staged.length === 0} onClick={() => commit({ variables: { ...vars, message } })}>
              {committing ? 'Validation…' : 'Valider (commit)'}
            </Button>
            {unstaged.length > 0 && (
              <Button size="sm" variant="outline-secondary" disabled={busy || !message.trim()} title="Indexe tout puis valide" onClick={() => commit({ variables: { ...vars, message, stageAll: true } })}>
                Tout valider
              </Button>
            )}
          </div>
        </div>

        <Section title="Branches" count={local.length} defaultOpen={false}>
          <Form
            className="d-flex gap-1 mb-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newBranch.trim()) checkout({ variables: { ...vars, branch: newBranch.trim(), create: true } });
            }}
          >
            <Form.Control size="sm" placeholder="Nouvelle branche depuis HEAD" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />
            <Button size="sm" type="submit" variant="outline-primary" disabled={busy || !newBranch.trim()}>
              Créer
            </Button>
          </Form>
          {local.map((b) => (
            <div key={b.name} className={`git-row${b.current ? ' current' : ''}`} title={b.commit ? `${b.commit.shortHash} ${b.commit.subject}` : b.name}>
              <button type="button" className="git-row-main" disabled={b.current || busy} onClick={() => checkout({ variables: { ...vars, branch: b.name } })}>
                <i className={`bi ${b.current ? 'bi-check-lg git-a' : 'bi-diagram-2'} me-1`} />
                <span className="git-name">{b.name}</span>
                {b.upstream && <span className="git-dir">{b.upstream}</span>}
              </button>
            </div>
          ))}
          {remote.filter((r) => !local.some((l) => l.upstream === r.name)).length > 0 && (
            <div className="git-subhead">Distantes non extraites</div>
          )}
          {remote
            .filter((r) => !local.some((l) => l.upstream === r.name))
            .map((b) => (
              <div key={b.name} className="git-row" title={b.commit ? `${b.commit.shortHash} ${b.commit.subject}` : b.name}>
                <button type="button" className="git-row-main" disabled={busy} onClick={() => checkout({ variables: { ...vars, branch: b.name } })}>
                  <i className="bi bi-cloud me-1" />
                  <span className="git-name">{b.name}</span>
                </button>
              </div>
            ))}
        </Section>

        <Section title="Historique" defaultOpen={false}>
          {(logQ.data?.gitLog ?? []).map((c) => (
            <div key={c.hash} className="git-row" title={`${c.author} · ${new Date(c.date).toLocaleString()}`}>
              <button type="button" className="git-row-main" onClick={() => setDiffReq({ kind: 'commit', hash: c.hash, subject: c.subject })}>
                <span className="git-hash">{c.shortHash}</span>
                <span className="git-name">{c.subject}</span>
                <span className="git-dir">{timeAgo(c.date)}</span>
              </button>
            </div>
          ))}
          {logQ.data && logQ.data.gitLog.length === 0 && <div className="git-empty">Aucun commit.</div>}
        </Section>
      </div>

      {diffReq && vars && <DiffModal req={diffReq} vars={vars} onClose={() => setDiffReq(null)} />}
    </aside>
  );
}
