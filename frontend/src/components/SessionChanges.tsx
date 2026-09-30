import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DiffView from './DiffView';
import { useDialogs } from './Dialogs';
import { filesUrl } from '../lib/files';
import { DISCARD_SESSION_FILE, SESSION_FILE_DIFF, type GitDiff, type SessionChanges as Changes, type SessionFileChange } from '../graphql/operations';

const statusLabels: Record<string, { label: string; cls: string; title: string }> = {
  M: { label: 'M', cls: 'git-m', title: 'Modifié' },
  A: { label: 'A', cls: 'git-a', title: 'Ajouté' },
  D: { label: 'D', cls: 'git-d', title: 'Supprimé' },
  R: { label: 'R', cls: 'git-r', title: 'Renommé' },
  C: { label: 'C', cls: 'git-r', title: 'Copié' },
  T: { label: 'T', cls: 'git-m', title: 'Type modifié' },
  '?': { label: 'U', cls: 'git-u', title: 'Nouveau fichier non suivi' },
};

const modeLabels: Record<Changes['mode'], string> = {
  COMMIT: 'depuis le début de la session',
  HEAD: 'non validées (commit de départ inconnu : les commits faits pendant la session ne sont pas inclus)',
  MTIME: "dossier sans git : fichiers modifiés depuis la création de la session, sans diff",
};

/** Diff d'un fichier, rechargé à chaque rafraîchissement de l'onglet. */
function FileDiff({ sessionId, file, refreshKey }: { sessionId: string; file: SessionFileChange; refreshKey: number }) {
  const { data, loading, error, refetch } = useQuery<{ sessionFileDiff: GitDiff }>(SESSION_FILE_DIFF, {
    variables: { sessionId, path: file.path, origPath: file.origPath },
    fetchPolicy: 'network-only',
    notifyOnNetworkStatusChange: false,
  });
  useEffect(() => {
    if (refreshKey) void refetch();
  }, [refreshKey, refetch]);
  const diff = data?.sessionFileDiff;
  if (error) return <div className="cc-red cc-changes-note">{error.message}</div>;
  if (loading && !diff) return <div className="cc-dim cc-changes-note">Chargement du diff…</div>;
  if (!diff) return null;
  return (
    <>
      <DiffView text={diff.text} binary={diff.binary} />
      {diff.truncated && <div className="cc-dim cc-changes-note">Diff tronqué (trop volumineux).</div>}
    </>
  );
}

/**
 * Onglet « Modifications » de la page de session : fichiers modifiés dans le dossier de travail depuis le
 * démarrage de la session (commits de l'agent compris), avec leur diff.
 */
export default function SessionChanges({
  sessionId,
  workspace,
  changes,
  loading,
  error,
  refreshKey,
  onRefresh,
}: {
  sessionId: string;
  workspace: { projectId: string; worktreeId: string | null };
  changes: Changes | undefined;
  loading: boolean;
  error?: Error;
  refreshKey: number;
  onRefresh: () => void;
}) {
  const { confirm, showError } = useDialogs();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [discard, { loading: discarding }] = useMutation(DISCARD_SESSION_FILE);
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onDiscard = async (f: SessionFileChange) => {
    const ok = await confirm({
      title: 'Abandonner le fichier',
      message: `Remettre ${f.path}${f.origPath ? ` (et ${f.origPath})` : ''} dans son état du début de la session ? ${f.status === 'A' || f.untracked ? 'Le fichier, créé pendant la session, sera supprimé.' : 'Les modifications seront perdues.'} Les commits ne sont pas modifiés.`,
      confirmLabel: 'Abandonner',
      danger: true,
    });
    if (!ok) return;
    try {
      await discard({ variables: { sessionId, path: f.path, origPath: f.origPath } });
      onRefresh();
    } catch (err) {
      showError(err);
    }
  };

  const files = changes?.files ?? [];
  const withDiff = changes?.mode !== 'MTIME';
  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div className="cc-transcript cc-changes">
      <div className="cc-changes-head">
        <span className="cc-dim">
          {changes ? (
            <>
              {files.length === 0 ? 'Aucune modification' : `${files.length} fichier${files.length > 1 ? 's' : ''} modifié${files.length > 1 ? 's' : ''}`} {modeLabels[changes.mode]}
              {changes.baseCommit && (
                <>
                  {' '}
                  · référence <code title={changes.baseCommit}>{changes.baseCommit.slice(0, 7)}</code>
                </>
              )}
              {withDiff && files.length > 0 && (
                <>
                  {' '}
                  · <span className="cc-green">+{additions}</span> <span className="cc-red">−{deletions}</span>
                </>
              )}
              {changes.truncated && ' · liste incomplète'}
            </>
          ) : loading ? (
            'Chargement…'
          ) : null}
        </span>
        <span className="cc-changes-tools">
          {withDiff && files.length > 1 && (
            <button type="button" className="cc-btn" onClick={() => setExpanded(expanded.size ? new Set() : new Set(files.map((f) => f.path)))}>
              {expanded.size ? 'Tout replier' : 'Tout déplier'}
            </button>
          )}
          <button type="button" className="cc-btn" title="Rafraîchir la liste" onClick={onRefresh} disabled={loading}>
            <i className="bi bi-arrow-clockwise" />
          </button>
        </span>
      </div>
      {error && <div className="cc-red cc-changes-note">{error.message}</div>}
      {files.map((f) => {
        const st = statusLabels[f.status] ?? { label: f.status, cls: '', title: f.status };
        const open = withDiff && expanded.has(f.path);
        const deleted = f.status === 'D';
        return (
          <div key={f.path} className="cc-changes-file">
            <div className="cc-changes-row">
              <button type="button" className="cc-changes-main" onClick={() => withDiff && toggle(f.path)} disabled={!withDiff} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                {withDiff && <i className={`bi bi-chevron-${open ? 'down' : 'right'} cc-dimmer`} />}
                <span className={`git-status ${st.cls}`} title={st.title}>
                  {st.label}
                </span>
                <span className="cc-changes-path">
                  {f.origPath && <span className="cc-dim">{f.origPath} → </span>}
                  {f.path}
                </span>
                {withDiff && (f.additions !== null || f.deletions !== null) && (
                  <span className="cc-changes-count">
                    <span className="cc-green">+{f.additions ?? 0}</span> <span className="cc-red">−{f.deletions ?? 0}</span>
                  </span>
                )}
              </button>
              <span className="cc-changes-actions">
                {!deleted && (
                  <Link to={filesUrl(workspace, f.path)} className="cc-btn" title="Ouvrir dans l'éditeur (nouvel onglet)">
                    <i className="bi bi-pencil-square" />
                  </Link>
                )}
                {withDiff && (
                  <button type="button" className="cc-btn danger" title="Abandonner : remettre le fichier dans son état du début de la session" disabled={discarding} onClick={() => void onDiscard(f)}>
                    <i className="bi bi-arrow-counterclockwise" />
                  </button>
                )}
              </span>
            </div>
            {open && <FileDiff sessionId={sessionId} file={f} refreshKey={refreshKey} />}
          </div>
        );
      })}
    </div>
  );
}
