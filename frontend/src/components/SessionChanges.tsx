import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Modal, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import DiffView from './DiffView';
import { useDialogs } from './Dialogs';
import { filesUrl } from '../lib/files';
import { usePollingQuery } from '../lib/usePollingQuery';
import { DISCARD_SESSION_FILE, SESSION_CHANGES, SESSION_FILE_DIFF, type GitDiff, type SessionChanges as Changes, type SessionFileChange } from '../graphql/operations';

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
  MTIME: 'dossier sans git : fichiers modifiés depuis la création de la session, sans diff',
};

/** Liste des fichiers modifiés par une session : la requête, rechargée quand `changesKey` change et par sondage tant qu'elle est visible. */
export function useSessionChanges(sessionId: string | null, changesKey: string | undefined, visible: boolean) {
  const q = usePollingQuery<{ sessionChanges: Changes }>(SESSION_CHANGES, { variables: { sessionId: sessionId ?? '' }, skip: !sessionId, pollInterval: visible ? 10_000 : 0, fetchPolicy: 'cache-and-network' });
  const [refreshCount, setRefreshCount] = useState(0);
  const refetch = q.refetch;
  const refresh = () => {
    void refetch().catch(() => undefined);
    setRefreshCount((n) => n + 1);
  };
  // Premier rendu : la requête part d'elle-même ; ensuite chaque changement de clé recharge la liste.
  const [seenKey, setSeenKey] = useState(changesKey);
  useEffect(() => {
    if (changesKey === seenKey) return;
    setSeenKey(changesKey);
    if (sessionId) refresh();
  }, [changesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { changes: q.data?.sessionChanges, loading: q.loading, error: q.error, refreshKey: refreshCount, refresh };
}

/** Fenêtre de diff d'un fichier modifié par la session. */
function SessionDiffModal({ sessionId, file, base, onClose }: { sessionId: string; file: SessionFileChange; base: string | null; onClose: () => void }) {
  const { data, loading, error } = useQuery<{ sessionFileDiff: GitDiff }>(SESSION_FILE_DIFF, { variables: { sessionId, path: file.path, origPath: file.origPath }, fetchPolicy: 'network-only' });
  const diff = data?.sessionFileDiff;
  return (
    <Modal show onHide={onClose} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h6 font-monospace">
          {file.origPath && <span className="text-secondary">{file.origPath} → </span>}
          {file.path} <span className="text-secondary">· depuis le début de la session{base ? ` (${base.slice(0, 7)})` : ''}</span>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="p-0">
        {loading && !diff && (
          <div className="p-3">
            <Spinner size="sm" /> Chargement…
          </div>
        )}
        {error && <Alert variant="danger" className="m-3">{error.message}</Alert>}
        {diff && <DiffView text={diff.text} binary={diff.binary} />}
        {diff?.truncated && <div className="text-secondary small p-2">Diff tronqué (trop volumineux).</div>}
      </Modal.Body>
    </Modal>
  );
}

/**
 * Onglet « Modifications » du panneau de droite : fichiers modifiés dans le dossier de travail depuis le démarrage
 * de la session (commits de l'agent compris). Un clic ouvre le diff ; chaque fichier s'ouvre dans l'éditeur ou se
 * remet dans son état de départ.
 */
export default function SessionChanges({
  sessionId,
  workspace,
  changes,
  loading,
  error,
  onRefresh,
}: {
  sessionId: string;
  workspace: { projectId: string; worksessionId: string | null };
  changes: Changes | undefined;
  loading: boolean;
  error?: Error;
  onRefresh: () => void;
}) {
  const { confirm, showError } = useDialogs();
  const [opened, setOpened] = useState<SessionFileChange | null>(null);
  const [discard, { loading: discarding }] = useMutation(DISCARD_SESSION_FILE);

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
    <div className="git-body session-changes">
      <div className="session-changes-head">
        <span className="session-changes-summary">
          {changes ? (
            <>
              <span title={modeLabels[changes.mode]}>{files.length === 0 ? 'Aucune modification' : `${files.length} fichier${files.length > 1 ? 's' : ''} modifié${files.length > 1 ? 's' : ''}`}</span>
              {withDiff && files.length > 0 && (
                <span className="ms-2">
                  <span className="git-a">+{additions}</span> <span className="git-d">−{deletions}</span>
                </span>
              )}
            </>
          ) : loading ? (
            'Chargement…'
          ) : null}
        </span>
        <button type="button" className="git-icon-btn" title="Rafraîchir la liste" onClick={onRefresh} disabled={loading}>
          <i className={`bi bi-arrow-clockwise${loading ? ' spin' : ''}`} />
        </button>
      </div>
      {changes && (
        <div className="session-changes-mode">
          {modeLabels[changes.mode]}
          {changes.baseCommit && (
            <>
              {' '}
              · référence <code title={changes.baseCommit}>{changes.baseCommit.slice(0, 7)}</code>
            </>
          )}
          {changes.truncated && ' · liste incomplète'}
        </div>
      )}
      {error && <Alert variant="warning" className="m-2 py-1 small">{error.message}</Alert>}
      {files.map((f) => {
        const st = statusLabels[f.status] ?? { label: f.status, cls: '', title: f.status };
        const name = f.path.split('/').pop() ?? f.path;
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const deleted = f.status === 'D';
        return (
          <div key={f.path} className="git-row" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
            <button type="button" className="git-row-main" onClick={() => withDiff && setOpened(f)} disabled={!withDiff}>
              <span className={`git-status ${st.cls}`} title={st.title}>
                {st.label}
              </span>
              <span className="git-name">{name}</span>
              {dir && <span className="git-dir">{dir}</span>}
              {withDiff && (f.additions !== null || f.deletions !== null) && (
                <span className="session-changes-count">
                  <span className="git-a">+{f.additions ?? 0}</span> <span className="git-d">−{f.deletions ?? 0}</span>
                </span>
              )}
            </button>
            <span className="git-row-actions">
              {!deleted && (
                <Link to={filesUrl(workspace, f.path)} title="Ouvrir dans l'éditeur (nouvel onglet)">
                  <i className="bi bi-pencil-square" />
                </Link>
              )}
              {withDiff && (
                <button type="button" title="Abandonner : remettre le fichier dans son état du début de la session" disabled={discarding} onClick={() => void onDiscard(f)}>
                  <i className="bi bi-arrow-counterclockwise" />
                </button>
              )}
            </span>
          </div>
        );
      })}
      {opened && <SessionDiffModal sessionId={sessionId} file={opened} base={changes?.baseCommit ?? null} onClose={() => setOpened(null)} />}
    </div>
  );
}
