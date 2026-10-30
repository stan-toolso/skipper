import { gql, useMutation, useQuery } from '@apollo/client';
import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Alert, Button, Form, Modal, Spinner } from 'react-bootstrap';
import { useLocation, useNavigate } from 'react-router-dom';
import DiffView from '../components/DiffView';
import { CreatePullRequestModal, PullRequestIndicators, PullRequestModal } from '../components/PullRequests';
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
  GITHUB_PULL_REQUESTS,
  type GitBranch,
  type GitCommit,
  type GitDiff,
  type GitFileChange,
  type GitStatus,
  type PullRequest,
} from '../graphql/operations';
import { GIT_BRANCH_CHANGES, GIT_BRANCH_FILE_DIFF, type GitBranchChanges } from '../graphql/sessions';
import { usePollingQuery } from '../lib/usePollingQuery';
import SessionChanges, { useSessionChanges } from '../components/SessionChanges';
import { useGitPanel } from './GitTargetContext';
import SessionPanel from './SessionPanel';
import TaskPanel from './TaskPanel';

/** Dépôt du projet : sans `gitUrl`, pas de branche de base ni de pull requests à interroger. */
const GIT_PANEL_PROJECT = gql`
  query GitPanelProject($id: ID!) {
    project(id: $id) {
      id
      gitUrl
    }
  }
`;

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

type DiffRequest = { kind: 'file'; path: string; staged: boolean } | { kind: 'commit'; hash: string; subject: string } | { kind: 'branch'; path: string; origPath: string | null; base: string };

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `il y a ${Math.floor(s / 86400)} j`;
  return new Date(iso).toLocaleDateString();
}

/** Fenêtre de diff (fichier ou commit). */
function DiffModal({ req, vars, onClose }: { req: DiffRequest; vars: { projectId: string; worksessionId: string | null }; onClose: () => void }) {
  const fileQ = useQuery<{ gitDiff: GitDiff }>(GIT_DIFF, { variables: { ...vars, path: req.kind === 'file' ? req.path : '', staged: req.kind === 'file' ? req.staged : false }, skip: req.kind !== 'file', fetchPolicy: 'network-only' });
  const commitQ = useQuery<{ gitCommitDiff: GitDiff }>(GIT_COMMIT_DIFF, { variables: { ...vars, hash: req.kind === 'commit' ? req.hash : '' }, skip: req.kind !== 'commit', fetchPolicy: 'network-only' });
  const branchQ = useQuery<{ gitBranchFileDiff: GitDiff }>(GIT_BRANCH_FILE_DIFF, { variables: { ...vars, path: req.kind === 'branch' ? req.path : '', origPath: req.kind === 'branch' ? req.origPath : null }, skip: req.kind !== 'branch', fetchPolicy: 'network-only' });
  const q = req.kind === 'file' ? fileQ : req.kind === 'commit' ? commitQ : branchQ;
  const diff = req.kind === 'file' ? fileQ.data?.gitDiff : req.kind === 'commit' ? commitQ.data?.gitCommitDiff : branchQ.data?.gitBranchFileDiff;
  return (
    <Modal show onHide={onClose} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h6 font-monospace">
          {req.kind === 'file' ? (
            <>
              {req.path} <span className="text-secondary">· {req.staged ? 'indexé (vs HEAD)' : 'non indexé (vs index)'}</span>
            </>
          ) : req.kind === 'branch' ? (
            <>
              {req.path} <span className="text-secondary">· depuis {req.base}</span>
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

/** Revue de toutes les modifications de la branche depuis sa base, fichier par fichier (comme l'onglet « Files changed » d'une PR). */
function BranchReviewModal({ changes, vars, onClose }: { changes: GitBranchChanges; vars: { projectId: string; worksessionId: string | null }; onClose: () => void }) {
  return (
    <Modal show onHide={onClose} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h6">
          Modifications de la branche <span className="font-monospace">{changes.branch ?? 'HEAD'}</span> <span className="text-secondary">· {changes.files.length} fichier(s) depuis {changes.baseBranch}</span>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="p-0">
        {changes.files.map((f) => (
          <BranchFileDiff key={f.path} file={f} vars={vars} />
        ))}
        {changes.files.length === 0 && <div className="p-3 text-secondary">Aucune modification depuis {changes.baseBranch}.</div>}
      </Modal.Body>
    </Modal>
  );
}

function BranchFileDiff({ file, vars }: { file: GitBranchChanges['files'][number]; vars: { projectId: string; worksessionId: string | null } }) {
  const q = useQuery<{ gitBranchFileDiff: GitDiff }>(GIT_BRANCH_FILE_DIFF, { variables: { ...vars, path: file.path, origPath: file.origPath }, fetchPolicy: 'network-only' });
  return (
    <div className="border-bottom">
      <div className="px-3 py-2 font-monospace small d-flex justify-content-between">
        <span>
          <span className={`git-status ${statusLabels[file.status]?.cls ?? ''} me-2`}>{statusLabels[file.status]?.label ?? file.status}</span>
          {file.origPath ? `${file.origPath} → ` : ''}
          {file.path}
        </span>
        <span className="text-secondary">
          {file.additions != null && <span className="git-a">+{file.additions}</span>} {file.deletions != null && <span className="git-d">−{file.deletions}</span>}
        </span>
      </div>
      {q.loading && !q.data && <div className="px-3 pb-2 small text-secondary">Chargement…</div>}
      {q.error && <div className="px-3 pb-2 small text-danger">{q.error.message}</div>}
      {q.data && <DiffView text={q.data.gitBranchFileDiff.text} binary={q.data.gitBranchFileDiff.binary} />}
    </div>
  );
}

/** Modifications de la branche depuis son point de divergence avec sa base (commits et travail non validé). */
function BranchSection({ vars, open, onOpen }: { vars: { projectId: string; worksessionId: string | null }; open: boolean; onOpen: (req: DiffRequest) => void }) {
  const q = usePollingQuery<{ gitBranchChanges: GitBranchChanges | null }>(GIT_BRANCH_CHANGES, { variables: vars, skip: !open, pollInterval: 15000 });
  const [review, setReview] = useState(false);
  const changes = q.data?.gitBranchChanges ?? undefined;
  return (
    <Section
      title={changes ? `Branche vs ${changes.baseBranch}` : 'Branche vs base'}
      count={changes?.files.length}
      defaultOpen={false}
      action={
        <span className="d-flex">
          {changes && changes.files.length > 0 && (
            <button type="button" className="git-icon-btn" title="Relire toutes les modifications" onClick={() => setReview(true)}>
              <i className="bi bi-arrows-fullscreen" />
            </button>
          )}
          <button type="button" className="git-icon-btn" title="Rafraîchir" onClick={() => void q.refetch()}>
            <i className={`bi bi-arrow-clockwise${q.loading ? ' spin' : ''}`} />
          </button>
        </span>
      }
    >
      {q.error && <div className="git-empty">{q.error.message}</div>}
      {q.data && !changes && <div className="git-empty">Aucune branche de base à comparer.</div>}
      {changes && (
        <>
          <div className="git-subhead" title={`Point de divergence : ${changes.mergeBase.slice(0, 7)}`}>
            {changes.commits} commit(s) + travail non validé
          </div>
          {changes.files.length === 0 && <div className="git-empty">Aucune modification depuis {changes.baseBranch}.</div>}
          {changes.files.map((f) => {
            const st = statusLabels[f.status] ?? { label: f.status, cls: '' };
            const name = f.path.split('/').pop() ?? f.path;
            const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
            return (
              <div key={f.path} className="git-row" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                <button type="button" className="git-row-main" onClick={() => onOpen({ kind: 'branch', path: f.path, origPath: f.origPath, base: changes.baseBranch })}>
                  <span className={`git-status ${st.cls}`}>{st.label}</span>
                  <span className="git-name">{name}</span>
                  {dir && <span className="git-dir">{dir}</span>}
                </button>
              </div>
            );
          })}
        </>
      )}
      {review && changes && <BranchReviewModal changes={changes} vars={vars} onClose={() => setReview(false)} />}
    </Section>
  );
}

/** Pull requests GitHub : celle de la branche courante (ou bouton de création), puis les autres PR ouvertes du dépôt. */
function PullRequestsSection({ projectId, worksessionId, branch }: { projectId: string; worksessionId: string | null; branch: string | null }) {
  const q = usePollingQuery<{ githubPullRequests: PullRequest[] }>(GITHUB_PULL_REQUESTS, { variables: { projectId, state: 'OPEN', limit: 50 }, pollInterval: 30000 });
  const [creating, setCreating] = useState(false);
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const prs = q.data?.githubPullRequests ?? [];
  const mine = branch ? prs.find((p) => p.headRefName === branch && !p.isCrossRepository) : undefined;
  const others = prs.filter((p) => p !== mine);
  const row = (p: PullRequest) => (
    <div key={p.number} className="git-row" title={`${p.headRefName} → ${p.baseRefName}${p.author ? ` · ${p.author}` : ''}`}>
      <button type="button" className="git-row-main" onClick={() => setOpenNumber(p.number)}>
        <span className="git-hash">#{p.number}</span>
        <span className="git-name">{p.title}</span>
        <span className="ms-auto ps-1">
          <PullRequestIndicators pr={p} showState={p.isDraft} />
        </span>
      </button>
    </div>
  );
  return (
    <Section
      title="Pull requests"
      count={q.data ? prs.length : undefined}
      action={
        <button type="button" className="git-icon-btn" title="Rafraîchir" onClick={() => void q.refetch()}>
          <i className={`bi bi-arrow-clockwise${q.loading ? ' spin' : ''}`} />
        </button>
      }
    >
      {q.error && <div className="git-empty">{q.error.message}</div>}
      {!q.error && branch && (
        <>
          <div className="git-subhead">Branche courante</div>
          {mine ? (
            row(mine)
          ) : (
            <div className="px-2 pb-1">
              <Button size="sm" variant="outline-primary" className="w-100" onClick={() => setCreating(true)}>
                <i className="bi bi-git me-1" /> Créer une pull request
              </Button>
            </div>
          )}
        </>
      )}
      {!q.error && q.data && (
        <>
          {branch && <div className="git-subhead">Ouvertes dans le dépôt</div>}
          {others.length === 0 && <div className="git-empty">{mine ? 'Aucune autre.' : 'Aucune pull request ouverte.'}</div>}
          {others.map(row)}
        </>
      )}
      {creating && <CreatePullRequestModal projectId={projectId} worksessionId={worksessionId} onClose={() => setCreating(false)} onCreated={(pr) => { setCreating(false); setOpenNumber(pr.number); }} />}
      {openNumber !== null && (
        <PullRequestModal
          projectId={projectId}
          number={openNumber}
          onClose={() => setOpenNumber(null)}
          onMerged={(deleted) => {
            // Le dossier de travail affiché (fichiers d'une session) vient d'être supprimé : retour au projet.
            if (worksessionId && deleted.includes(worksessionId) && /^\/sessions\/[^/]+\/files/.test(location.pathname)) navigate(`/projects/${projectId}`);
          }}
        />
      )}
    </Section>
  );
}

/** Onglets fixes, et un onglet `task:<id>` par tâche dont la session a la charge. */
export type PanelTab = 'session' | 'changes' | 'git' | `task:${string}`;
interface PanelTabDef {
  key: PanelTab;
  icon: string;
  label: string;
  title: string;
}

/** Onglets fixes : icône, libellé court (onglet) et libellé complet (infobulle, rail replié). */
const FIXED_TABS: Record<'session' | 'changes' | 'git', Omit<PanelTabDef, 'key'>> = {
  session: { icon: 'bi-info-circle', label: 'Session', title: 'Session : détail et actions' },
  changes: { icon: 'bi-file-diff', label: 'Modifs', title: 'Modifications : fichiers modifiés par la session' },
  git: { icon: 'bi-git', label: 'Git', title: 'Suivi git : index, commit, branches, pull requests' },
};
const isTaskTab = (t: string): t is `task:${string}` => t.startsWith('task:');
const taskIdOf = (t: PanelTab) => (isTaskTab(t) ? t.slice('task:'.length) : null);
/** Libellé d'un onglet de tâche : « Tâche » seule, sinon le début du titre (le titre complet est en infobulle). */
const shortTitle = (title: string, max = 14) => (title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title);

/** Un onglet « Tâche » par tâche en charge ; avec plusieurs tâches, chaque onglet porte le début du titre de la sienne. */
function panelTabs(sessionId: string | null, tasks: { id: string; title: string }[]): PanelTabDef[] {
  return [
    ...(sessionId ? (['session', 'changes'] as const).map((k) => ({ key: k, ...FIXED_TABS[k] })) : []),
    ...tasks.map((t) => ({ key: `task:${t.id}` as const, icon: 'bi-card-checklist', label: tasks.length > 1 ? shortTitle(t.title) : 'Tâche', title: `Tâche dont la session a la charge : ${t.title}` })),
    { key: 'git' as const, ...FIXED_TABS.git },
  ];
}

/**
 * Choix d'onglet mémorisé par page (session ou tâche) pendant la session de navigation, et dernier choix global
 * (où un onglet de tâche est mémorisé comme « task », quelle que soit la tâche).
 */
const panelTabChoice = new Map<string, PanelTab>();
const LAST_TAB_KEY = 'skipper.workbench.panelTab';
const readLastTab = (): PanelTab | 'task' | null => {
  try {
    const v = localStorage.getItem(LAST_TAB_KEY);
    return v && (v in FIXED_TABS || v === 'task') ? (v as PanelTab | 'task') : null;
  } catch {
    return null;
  }
};

/** Poignée de redimensionnement du panneau, fournie par le workbench (largeur mémorisée comme celle de la sidebar). */
export interface PanelResizer {
  dragging: boolean;
  width: number;
  min: number;
  max: number;
  handleProps: {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onDoubleClick: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  };
}

/**
 * Panneau de droite : onglets « Session » (détail et actions de la session ouverte), « Modifs » (fichiers modifiés
 * par la session), « Tâche » (session en charge d'une tâche) et « Git » (index, commit, branche, pull requests, historique).
 */
export default function GitPanel({ resizer }: { resizer?: PanelResizer }) {
  const { target, open, setOpen } = useGitPanel();
  const vars = target ? { projectId: target.projectId, worksessionId: target.worksessionId } : null;
  const tasks = target?.tasks ?? [];
  const sessionId = target?.sessionId ?? null;
  const tabs = panelTabs(sessionId, tasks);
  const available: PanelTab[] = tabs.map((t) => t.key);
  const pageKey = sessionId ?? tasks[0]?.id ?? null;
  const [tabState, setTabState] = useState<{ pageKey: string | null; tab: PanelTab } | null>(null);
  const remembered: PanelTab | 'task' | null = pageKey ? (tabState?.pageKey === pageKey ? tabState.tab : panelTabChoice.get(pageKey) ?? readLastTab()) : 'git';
  // « task » (dernier choix global) ou un onglet de tâche disparue : le premier onglet de tâche de la page, sinon le premier onglet.
  const wanted: PanelTab = remembered === 'task' || (remembered && isTaskTab(remembered) && !available.includes(remembered)) ? available.find(isTaskTab) ?? available[0] : remembered ?? available[0];
  const tab: PanelTab = available.includes(wanted) ? wanted : available[0];
  const taskId = taskIdOf(tab);
  const chooseTab = (t: PanelTab) => {
    if (pageKey) panelTabChoice.set(pageKey, t);
    setTabState({ pageKey, tab: t });
    try {
      localStorage.setItem(LAST_TAB_KEY, isTaskTab(t) ? 'task' : t);
    } catch {
      /* ignore */
    }
  };
  const changes = useSessionChanges(sessionId, target?.changesKey, open && tab === 'changes');
  const changedCount = changes.changes?.files.length ?? 0;
  const [diffReq, setDiffReq] = useState<DiffRequest | null>(null);
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const gitVisible = Boolean(vars) && open && tab === 'git';
  const projectQ = useQuery<{ project: { id: string; gitUrl: string | null } | null }>(GIT_PANEL_PROJECT, { variables: { id: target?.projectId ?? '' }, skip: !target });
  // Projet sans dépôt git : pas de comparaison à une base ni de pull requests (requêtes inutiles, erreurs côté serveur).
  const hasRepo = Boolean(projectQ.data?.project?.gitUrl);

  const statusQ = usePollingQuery<{ gitStatus: GitStatus }>(GIT_STATUS, { variables: vars ?? undefined, skip: !gitVisible, pollInterval: 5000 });
  const branchesQ = usePollingQuery<{ gitBranches: GitBranch[] }>(GIT_BRANCHES, { variables: vars ?? undefined, skip: !gitVisible, pollInterval: 15000 });
  const logQ = usePollingQuery<{ gitLog: GitCommit[] }>(GIT_LOG, { variables: { ...(vars ?? {}), limit: 30 }, skip: !gitVisible, pollInterval: 15000 });
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
  useEffect(() => setActionError(null), [target?.projectId, target?.worksessionId]);

  if (!target) return null;
  if (!open) {
    return (
      <div className="git-collapsed-rail">
        {tabs.map((t) => (
          <button key={t.key} type="button" className="git-collapsed" title={t.title} onClick={() => { chooseTab(t.key); setOpen(true); }}>
            <i className={`bi ${t.icon}`} />
            {t.key === 'changes' && changedCount > 0 && <span className="git-count">{changedCount}</span>}
          </button>
        ))}
      </div>
    );
  }

  const status = statusQ.data?.gitStatus;
  const staged = status?.changes.filter((c) => c.staged) ?? [];
  const unstaged = status?.changes.filter((c) => c.unstaged || c.untracked || c.conflicted) ?? [];
  const busy = staging || unstaging || committing || fetching || pulling || pushing || checkingOut;
  const local = branchesQ.data?.gitBranches.filter((b) => !b.remote) ?? [];
  const remote = branchesQ.data?.gitBranches.filter((b) => b.remote) ?? [];

  const headTitle = target.label ?? (status ? (status.detached ? 'HEAD détaché' : status.branch ?? 'Git') : 'Git');
  return (
    <>
    {/* Mobile : le panneau recouvre le contenu, toucher à côté le referme (invisible sur bureau). */}
    <div className="wb-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
    {resizer && (
      <div
        className={`wb-resizer right${resizer.dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Largeur du panneau de droite"
        aria-valuenow={resizer.width}
        aria-valuemin={resizer.min}
        aria-valuemax={resizer.max}
        tabIndex={0}
        title="Glisser pour redimensionner · double-clic pour revenir à la largeur par défaut"
        {...resizer.handleProps}
      />
    )}
    <aside className="git-panel">
      <div className="git-head">
        {available.length > 1 ? (
          <div className="git-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`git-tab${tab === t.key ? ' active' : ''}`} title={t.title} onClick={() => chooseTab(t.key)}>
                <i className={`bi ${t.icon}`} />
                <span className="git-tab-label">{t.label}</span>
                {t.key === 'changes' && changedCount > 0 && <span className="git-count">{changedCount}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="git-head-title">
            <i className="bi bi-git me-1" />
            <span title={headTitle}>{headTitle}</span>
          </div>
        )}
        <button type="button" className="git-icon-btn" title="Masquer" onClick={() => setOpen(false)}>
          <i className="bi bi-chevron-double-right" />
        </button>
      </div>
      {tab === 'session' && sessionId && <SessionPanel sessionId={sessionId} />}
      {tab === 'changes' && sessionId && (
        <SessionChanges sessionId={sessionId} workspace={{ projectId: target.projectId, sessionId: target.worksessionId ? sessionId : null }} changes={changes.changes} loading={changes.loading} error={changes.error} onRefresh={changes.refresh} />
      )}
      {taskId && (
        <div className="git-body">
          <TaskPanel key={taskId} taskId={taskId} />
        </div>
      )}
      {tab === 'git' && (
      <>

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

        {vars && hasRepo && <BranchSection vars={vars} open={gitVisible} onOpen={setDiffReq} />}
        {hasRepo && <PullRequestsSection projectId={target.projectId} worksessionId={target.worksessionId} branch={status && !status.detached ? status.branch : null} />}

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

      </>
      )}
      {diffReq && vars && <DiffModal req={diffReq} vars={vars} onClose={() => setDiffReq(null)} />}
    </aside>
    </>
  );
}
