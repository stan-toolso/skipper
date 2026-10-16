import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import FileEditor from '../components/FileEditor';
import PageLoading from '../components/PageLoading';
import { useDialogs } from '../components/Dialogs';
import { CREATE_WORKSPACE_ENTRY, DELETE_WORKSPACE_ENTRY, GIT_STATUS, RENAME_WORKSPACE_ENTRY, WORKSPACE_ENTRIES, type FileEntry, type GitStatus } from '../graphql/operations';
import { fileIcon, filesUrl, formatSize, useWorkspaceFromRoute, type WorkspaceRef } from '../lib/files';
import { usePageVisible } from '../lib/usePageVisible';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';

interface TreeActions {
  createEntry: (dir: string, kind: 'file' | 'dir') => void;
  renameEntry: (entry: FileEntry) => void;
  deleteEntry: (entry: FileEntry) => void;
}

/** Contenu d'un dossier, chargé à l'ouverture ; chaque sous-dossier est un autre DirTree. */
function DirTree({ wsRef, path, depth, expanded, toggle, actions, active, onOpen }: { wsRef: WorkspaceRef; path: string; depth: number; expanded: Set<string>; toggle: (p: string) => void; actions: TreeActions; active: string; onOpen: (p: string) => void }) {
  const { data, loading, error } = useQuery<{ workspaceEntries: FileEntry[] }>(WORKSPACE_ENTRIES, { variables: { ...wsRef, path } });
  if (loading && !data)
    return (
      <div className="fx-row fx-muted" style={{ paddingLeft: 14 + depth * 16 }}>
        <Spinner size="sm" className="me-2" /> chargement…
      </div>
    );
  if (error)
    return (
      <div className="fx-row text-danger" style={{ paddingLeft: 14 + depth * 16 }}>
        {error.message}
      </div>
    );
  const entries = data?.workspaceEntries ?? [];
  if (!entries.length)
    return (
      <div className="fx-row fx-muted" style={{ paddingLeft: 14 + depth * 16 }}>
        dossier vide
      </div>
    );
  return (
    <>
      {entries.map((e) => {
        const isDir = e.kind === 'dir';
        const open = isDir && expanded.has(e.path);
        const hidden = e.name.startsWith('.');
        const rowActions = (
          <span className="fx-actions" onClick={(ev) => ev.stopPropagation()}>
            {isDir && (
              <>
                <button type="button" title="Nouveau fichier ici" onClick={() => actions.createEntry(e.path, 'file')}>
                  <i className="bi bi-file-earmark-plus" />
                </button>
                <button type="button" title="Nouveau dossier ici" onClick={() => actions.createEntry(e.path, 'dir')}>
                  <i className="bi bi-folder-plus" />
                </button>
              </>
            )}
            <button type="button" title="Renommer" onClick={() => actions.renameEntry(e)}>
              <i className="bi bi-pencil" />
            </button>
            <button type="button" title="Supprimer" onClick={() => actions.deleteEntry(e)}>
              <i className="bi bi-trash" />
            </button>
          </span>
        );
        if (isDir) {
          return (
            <div key={e.path}>
              <div className={`fx-row fx-dir${hidden ? ' fx-hidden' : ''}`} style={{ paddingLeft: 14 + depth * 16 }} onClick={() => toggle(e.path)} title={e.path}>
                <i className={`bi bi-chevron-${open ? 'down' : 'right'} fx-chevron`} />
                <i className={`bi ${open ? 'bi-folder2-open' : 'bi-folder2'} fx-icon`} />
                <span className="fx-name">{e.name}</span>
                {rowActions}
              </div>
              {open && <DirTree wsRef={wsRef} path={e.path} depth={depth + 1} expanded={expanded} toggle={toggle} actions={actions} active={active} onOpen={onOpen} />}
            </div>
          );
        }
        const openable = e.kind === 'file';
        return (
          <div
            key={e.path}
            className={`fx-row fx-file${hidden || !openable ? ' fx-hidden' : ''}${active === e.path ? ' active' : ''}`}
            style={{ paddingLeft: 14 + depth * 16 }}
            title={openable ? e.path : `${e.path} (${e.kind === 'symlink' ? 'lien' : 'non ouvrable'})`}
            onClick={openable ? () => onOpen(e.path) : undefined}
            role={openable ? 'button' : undefined}
          >
            <span className="fx-chevron" />
            <i className={`bi ${fileIcon(e.name, e.kind)} fx-icon`} />
            <span className="fx-name">{e.name}</span>
            <span className="fx-size">{formatSize(e.size)}</span>
            {rowActions}
          </div>
        );
      })}
    </>
  );
}

const readList = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeList = (key: string, list: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ignore */
  }
};

/**
 * Dossier de travail d'un projet ou d'un worktree : arborescence à gauche, fichiers ouverts (onglets internes) à
 * droite. Le fichier actif est dans l'URL (/…/files/chemin), les onglets ouverts sont mémorisés par dossier.
 */
export default function FilesPage() {
  const { info, loading, error, filePath } = useWorkspaceFromRoute();
  const navigate = useNavigate();
  const client = useApolloClient();
  const visible = usePageVisible();
  useGitTarget(info ? { projectId: info.projectId, worktreeId: info.worktreeId, label: info.label } : null);
  useTabTitle(info ? `Fichiers · ${info.label}` : null);
  const wsKey = info ? (info.worktreeId ?? info.projectId) : null;
  const expandedKey = wsKey ? `skipper.files.expanded.${wsKey}` : null;
  const openKey = wsKey ? `skipper.files.open.${wsKey}` : null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string[]>([]);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showTree, setShowTree] = useState(true);

  useEffect(() => {
    if (!expandedKey || !openKey) return;
    setExpanded(new Set(readList(expandedKey)));
    setOpen(readList(openKey));
  }, [expandedKey, openKey]);

  // Le fichier de l'URL est toujours parmi les onglets ouverts ; ses dossiers parents sont dépliés.
  useEffect(() => {
    if (!filePath || !openKey) return;
    setOpen((list) => {
      if (list.includes(filePath)) return list;
      const next = [...list, filePath];
      writeList(openKey, next);
      return next;
    });
    setExpanded((prev) => {
      const parts = filePath.split('/');
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      if (expandedKey) writeList(expandedKey, [...next]);
      return next;
    });
    setShowTree(false);
  }, [filePath, openKey, expandedKey]);

  const toggle = useCallback(
    (p: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        if (expandedKey) writeList(expandedKey, [...next]);
        return next;
      });
    },
    [expandedKey],
  );

  const wsRef = useMemo<WorkspaceRef | null>(() => (info ? { projectId: info.projectId, worktreeId: info.worktreeId } : null), [info?.projectId, info?.worktreeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openFile = useCallback(
    (p: string) => {
      if (wsRef) navigate(filesUrl(wsRef, p));
    },
    [wsRef, navigate],
  );
  const closeFile = (p: string) => {
    if (dirty[p] && !window.confirm(`Fermer ${p.split('/').pop()} sans enregistrer les modifications ?`)) return;
    const next = open.filter((x) => x !== p);
    setOpen(next);
    if (openKey) writeList(openKey, next);
    setDirty((d) => {
      const nd = { ...d };
      delete nd[p];
      return nd;
    });
    if (filePath === p && wsRef) navigate(filesUrl(wsRef, next[next.length - 1] ?? ''), { replace: true });
  };

  // Actualisation : bouton, retour au premier plan, et toutes les 60 s quand l'état git a changé.
  const refresh = useCallback(() => {
    void client.refetchQueries({ include: ['WorkspaceEntries'] });
    setRefreshKey((k) => k + 1);
  }, [client]);
  const gitQ = usePollingQuery<{ gitStatus: GitStatus | null }>(GIT_STATUS, { variables: wsRef ?? { projectId: '', worktreeId: null }, skip: !wsRef || !visible, pollInterval: 60_000, fetchPolicy: 'network-only' });
  const signature = useMemo(() => {
    const s = gitQ.data?.gitStatus;
    if (!s) return '';
    return `${s.headCommit?.hash ?? ''}:${s.changes.map((c) => `${c.path}${c.indexStatus}${c.worktreeStatus}`).join(',')}`;
  }, [gitQ.data]);
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    if (signature) refresh();
  }, [signature, refresh]);
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) refresh();
    wasVisible.current = visible;
  }, [visible, refresh]);

  const onError = (err: Error) => setActionError(err.message);
  const [createEntry] = useMutation(CREATE_WORKSPACE_ENTRY, { refetchQueries: ['WorkspaceEntries'], onError });
  const [renameEntry] = useMutation(RENAME_WORKSPACE_ENTRY, { refetchQueries: ['WorkspaceEntries'], onError });
  const { confirm, prompt } = useDialogs();
  const [deleteEntry] = useMutation(DELETE_WORKSPACE_ENTRY, { refetchQueries: ['WorkspaceEntries'], onError });

  if (loading && !info) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!info || !wsRef) return <Alert variant="warning">Projet ou worktree introuvable.</Alert>;

  const actions: TreeActions = {
    createEntry: async (dir, kind) => {
      const name = await prompt({
        title: kind === 'dir' ? 'Nouveau dossier' : 'Nouveau fichier',
        message: dir ? <>Dans <code>{dir}</code></> : 'À la racine du dossier de travail',
        placeholder: kind === 'dir' ? 'nom-du-dossier' : 'nom-du-fichier.ext',
        confirmLabel: 'Créer',
      });
      if (!name) return;
      setActionError(null);
      const p = dir ? `${dir}/${name}` : name;
      await createEntry({ variables: { ...wsRef, path: p, kind } });
      if (dir && !expanded.has(dir)) toggle(dir);
      if (kind === 'file') openFile(p);
    },
    renameEntry: async (entry) => {
      const name = await prompt({ title: 'Renommer', message: <code>{entry.path}</code>, defaultValue: entry.name, confirmLabel: 'Renommer' });
      if (!name || name === entry.name) return;
      setActionError(null);
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      const newPath = parent ? `${parent}/${name}` : name;
      await renameEntry({ variables: { ...wsRef, path: entry.path, newPath } });
      if (open.includes(entry.path)) {
        const next = open.map((p) => (p === entry.path ? newPath : p));
        setOpen(next);
        if (openKey) writeList(openKey, next);
        if (filePath === entry.path) navigate(filesUrl(wsRef, newPath), { replace: true });
      }
    },
    deleteEntry: async (entry) => {
      const ok = await confirm({
        title: entry.kind === 'dir' ? 'Supprimer le dossier' : 'Supprimer le fichier',
        message: (
          <>
            Supprimer {entry.kind === 'dir' ? 'le dossier' : 'le fichier'} <code>{entry.path}</code>
            {entry.kind === 'dir' ? ' et tout son contenu' : ''} ?
          </>
        ),
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (!ok) return;
      setActionError(null);
      await deleteEntry({ variables: { ...wsRef, path: entry.path } });
      const gone = open.filter((p) => p === entry.path || p.startsWith(`${entry.path}/`));
      if (gone.length) {
        const next = open.filter((p) => !gone.includes(p));
        setOpen(next);
        if (openKey) writeList(openKey, next);
        if (gone.includes(filePath)) navigate(filesUrl(wsRef, next[next.length - 1] ?? ''), { replace: true });
      }
    },
  };

  return (
    <div className={`fx-page${filePath ? ' has-file' : ''}${showTree ? ' show-tree' : ''}`}>
      <div className="fx-header">
        <div className="min-w-0">
          <button type="button" className="fx-tree-toggle btn btn-sm btn-outline-secondary me-2" title="Arborescence" onClick={() => setShowTree((v) => !v)}>
            <i className="bi bi-list" />
          </button>
          <span className="fx-title">
            <i className="bi bi-folder2-open me-2" />
            {info.label}
          </span>
          {info.branch && (
            <span className="fx-muted ms-2">
              <i className="bi bi-git me-1" />
              {info.branch}
            </span>
          )}
          <div className="fx-muted small text-truncate">{info.path}</div>
        </div>
        <div className="fx-header-actions">
          <button type="button" className="btn btn-sm btn-outline-secondary" title="Actualiser l'arborescence et les fichiers ouverts non modifiés" onClick={refresh}>
            <i className="bi bi-arrow-clockwise" />
          </button>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => actions.createEntry('', 'file')}>
            <i className="bi bi-file-earmark-plus me-1" /> Fichier
          </button>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => actions.createEntry('', 'dir')}>
            <i className="bi bi-folder-plus me-1" /> Dossier
          </button>
          <Link to={`/projects/${info.projectId}`} className="btn btn-sm btn-outline-secondary">
            Projet
          </Link>
        </div>
      </div>
      {actionError && (
        <Alert variant="danger" className="py-2 mx-3 mt-2 mb-0" dismissible onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {!info.exists ? (
        <Alert variant="warning" className="m-3">
          Le dossier n'existe pas encore sur le serveur : il est créé au premier lancement d'une session.
        </Alert>
      ) : (
        <div className="fx-split">
          <div className="fx-tree">
            <DirTree wsRef={wsRef} path="" depth={0} expanded={expanded} toggle={toggle} actions={actions} active={filePath} onOpen={openFile} />
          </div>
          <div className="fx-main">
            {open.length > 0 && (
              <div className="fx-tabs" role="tablist">
                {open.map((p) => (
                  <div key={p} role="tab" aria-selected={p === filePath} className={`fx-tab${p === filePath ? ' active' : ''}`} onClick={() => openFile(p)} title={p}>
                    <i className={`bi ${fileIcon(p.split('/').pop() ?? p, 'file')}`} />
                    <span className="fx-tab-name">{p.split('/').pop()}</span>
                    {dirty[p] && <span className="fe-dirty">●</span>}
                    <button
                      type="button"
                      className="fx-tab-close"
                      title="Fermer"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(p);
                      }}
                    >
                      <i className="bi bi-x" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {filePath ? (
              <FileEditor key={`${wsKey}:${filePath}`} wsRef={wsRef} path={filePath} refreshKey={refreshKey} onDirty={(d) => setDirty((prev) => (prev[filePath] === d ? prev : { ...prev, [filePath]: d }))} />
            ) : (
              <div className="fx-empty">
                <i className="bi bi-file-earmark-text" />
                <div>Choisissez un fichier dans l'arborescence.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
