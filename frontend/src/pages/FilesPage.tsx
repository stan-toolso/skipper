import { useMutation, useQuery } from '@apollo/client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { CREATE_WORKSPACE_ENTRY, DELETE_WORKSPACE_ENTRY, RENAME_WORKSPACE_ENTRY, WORKSPACE_ENTRIES, type FileEntry } from '../graphql/operations';
import { fileIcon, filesUrl, formatSize, useWorkspaceFromRoute, type WorkspaceRef } from '../lib/files';
import { useTabTitle } from '../workbench/TabsContext';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useDialogs } from '../components/Dialogs';


interface TreeActions {
  createEntry: (dir: string, kind: 'file' | 'dir') => void;
  renameEntry: (entry: FileEntry) => void;
  deleteEntry: (entry: FileEntry) => void;
}

/** Contenu d'un dossier, chargé à l'ouverture ; chaque sous-dossier est un autre DirTree. */
function DirTree({ wsRef, path, depth, expanded, toggle, actions }: { wsRef: WorkspaceRef; path: string; depth: number; expanded: Set<string>; toggle: (p: string) => void; actions: TreeActions }) {
  const { data, loading, error } = useQuery<{ workspaceEntries: FileEntry[] }>(WORKSPACE_ENTRIES, { variables: { ...wsRef, path } });
  if (loading && !data) return <div className="fx-row fx-muted" style={{ paddingLeft: 14 + depth * 16 }}><Spinner size="sm" className="me-2" /> chargement…</div>;
  if (error) return <div className="fx-row text-danger" style={{ paddingLeft: 14 + depth * 16 }}>{error.message}</div>;
  const entries = data?.workspaceEntries ?? [];
  if (!entries.length) return <div className="fx-row fx-muted" style={{ paddingLeft: 14 + depth * 16 }}>dossier vide</div>;
  return (
    <>
      {entries.map((e) => {
        const isDir = e.kind === 'dir';
        const open = isDir && expanded.has(e.path);
        const hidden = e.name.startsWith('.');
        const rowActions = (
          <span className="fx-actions" onClick={(ev) => ev.preventDefault()}>
            {isDir && (
              <>
                <button type="button" title="Nouveau fichier ici" onClick={() => actions.createEntry(e.path, 'file')}><i className="bi bi-file-earmark-plus" /></button>
                <button type="button" title="Nouveau dossier ici" onClick={() => actions.createEntry(e.path, 'dir')}><i className="bi bi-folder-plus" /></button>
              </>
            )}
            <button type="button" title="Renommer" onClick={() => actions.renameEntry(e)}><i className="bi bi-pencil" /></button>
            <button type="button" title="Supprimer" onClick={() => actions.deleteEntry(e)}><i className="bi bi-trash" /></button>
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
              {open && <DirTree wsRef={wsRef} path={e.path} depth={depth + 1} expanded={expanded} toggle={toggle} actions={actions} />}
            </div>
          );
        }
        const openable = e.kind === 'file';
        const inner = (
          <>
            <span className="fx-chevron" />
            <i className={`bi ${fileIcon(e.name, e.kind)} fx-icon`} />
            <span className="fx-name">{e.name}</span>
            <span className="fx-size">{formatSize(e.size)}</span>
            {rowActions}
          </>
        );
        return openable ? (
          <Link key={e.path} to={filesUrl(wsRef, e.path)} className={`fx-row fx-file${hidden ? ' fx-hidden' : ''}`} style={{ paddingLeft: 14 + depth * 16 }} title={`${e.path} · ouvrir dans un onglet`}>
            {inner}
          </Link>
        ) : (
          <div key={e.path} className={`fx-row fx-file fx-hidden`} style={{ paddingLeft: 14 + depth * 16 }} title={`${e.path} (${e.kind === 'symlink' ? 'lien' : 'non ouvrable'})`}>
            {inner}
          </div>
        );
      })}
    </>
  );
}

/** Explorateur de fichiers du workspace d'un projet ou d'un worktree. */
export default function FilesPage() {
  const { info, loading, error } = useWorkspaceFromRoute();
  useGitTarget(info ? { projectId: info.projectId, worktreeId: info.worktreeId, label: info.label } : null);
  useTabTitle(info ? `Fichiers · ${info.label}` : null);
  const storageKey = info ? `skipper.files.expanded.${info.worktreeId ?? info.projectId}` : null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!storageKey) return;
    try {
      setExpanded(new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]));
    } catch {
      setExpanded(new Set());
    }
  }, [storageKey]);

  const toggle = useCallback(
    (p: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            /* ignore */
          }
        }
        return next;
      });
    },
    [storageKey],
  );

  const onError = (err: Error) => setActionError(err.message);
  const [createEntry] = useMutation(CREATE_WORKSPACE_ENTRY, { refetchQueries: ['WorkspaceEntries'], onError });
  const [renameEntry] = useMutation(RENAME_WORKSPACE_ENTRY, { refetchQueries: ['WorkspaceEntries'], onError });
  const { confirm, prompt } = useDialogs();
  const [deleteEntry] = useMutation(DELETE_WORKSPACE_ENTRY, { refetchQueries: ['WorkspaceEntries'], onError });

  if (loading && !info) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!info) return <Alert variant="warning">Projet ou worktree introuvable.</Alert>;
  const wsRef: WorkspaceRef = { projectId: info.projectId, worktreeId: info.worktreeId };

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
      createEntry({ variables: { ...wsRef, path: p, kind } });
      if (dir && !expanded.has(dir)) toggle(dir);
    },
    renameEntry: async (entry) => {
      const name = await prompt({ title: 'Renommer', message: <code>{entry.path}</code>, defaultValue: entry.name, confirmLabel: 'Renommer' });
      if (!name || name === entry.name) return;
      setActionError(null);
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      renameEntry({ variables: { ...wsRef, path: entry.path, newPath: parent ? `${parent}/${name}` : name } });
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
      deleteEntry({ variables: { ...wsRef, path: entry.path } });
    },
  };

  return (
    <div className="fx-page">
      <div className="fx-header">
        <div>
          <span className="fx-title"><i className="bi bi-folder2-open me-2" />{info.label}</span>
          {info.branch && <span className="fx-muted ms-2"><i className="bi bi-git me-1" />{info.branch}</span>}
          <div className="fx-muted small">{info.path}</div>
        </div>
        <div className="fx-header-actions">
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => actions.createEntry('', 'file')}><i className="bi bi-file-earmark-plus me-1" /> Fichier</button>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => actions.createEntry('', 'dir')}><i className="bi bi-folder-plus me-1" /> Dossier</button>
          <Link to={`/projects/${info.projectId}`} className="btn btn-sm btn-outline-secondary">Projet</Link>
        </div>
      </div>
      {actionError && (
        <Alert variant="danger" className="py-2 mx-3 mt-2 mb-0" dismissible onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {!info.exists ? (
        <Alert variant="warning" className="m-3">Le dossier n'existe pas encore sur le serveur : il est créé au premier lancement d'une session.</Alert>
      ) : (
        <div className="fx-tree">
          <DirTree wsRef={wsRef} path="" depth={0} expanded={expanded} toggle={toggle} actions={actions} />
        </div>
      )}
    </div>
  );
}
