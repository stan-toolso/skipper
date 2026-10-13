import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Form, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import RelaunchModal from '../components/RelaunchModal';
import StatusBadge from '../components/StatusBadge';
import { DELETE_SESSION, DELETE_WORKTREE, RESTORE_WORKTREE, type Session } from '../graphql/operations';
import { ARCHIVED_SESSIONS, HISTORY_PROJECT, UNARCHIVE_SESSION } from '../graphql/sessions';
import { timeAgo } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';

const PAGE = 50;

interface HistoryProject {
  id: string;
  name: string;
  gitUrl: string | null;
  worktrees: { id: string; branch: string; label: string }[];
  archivedWorktrees: { id: string; name: string; branch: string; label: string; archivedAt: string; git: { commit: string } | null }[];
}

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Historique d'un projet : worktrees archivés (restaurer, supprimer) et sessions archivées (relire, relancer, restaurer, supprimer). */
export default function SessionHistoryPage() {
  const { id = '' } = useParams();
  const client = useApolloClient();
  const { confirm, showError } = useDialogs();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [relaunch, setRelaunch] = useState<Session | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setLimit(PAGE);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const projectQ = useQuery<{ project: HistoryProject | null }>(HISTORY_PROJECT, { variables: { id } });
  const sessionsQ = useQuery<{ archivedSessions: Session[] }>(ARCHIVED_SESSIONS, { variables: { projectId: id, worktreeId, search: query || null, limit, offset: 0 }, fetchPolicy: 'cache-and-network' });
  const project = projectQ.data?.project;
  useTabTitle(project ? `Historique · ${project.name}` : null);
  const refetch = { refetchQueries: ['ArchivedSessions', 'HistoryProject', 'Sidebar'] };
  const [unarchive] = useMutation(UNARCHIVE_SESSION, { ...refetch, onError: (e) => void showError(e) });
  const [deleteSession] = useMutation(DELETE_SESSION, { ...refetch, onError: (e) => void showError(e) });
  const [restoreWorktree] = useMutation(RESTORE_WORKTREE, { ...refetch, onError: (e) => void showError(e) });
  const [deleteWorktree] = useMutation(DELETE_WORKTREE, { ...refetch, onError: (e) => void showError(e) });
  const evict = (typename: string, objId: string) => {
    client.cache.evict({ id: client.cache.identify({ __typename: typename, id: objId }) });
    client.cache.gc();
  };

  if (projectQ.loading && !project) return <PageLoading />;
  if (projectQ.error) return <Alert variant="danger">Erreur : {projectQ.error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const rows = sessionsQ.data?.archivedSessions ?? [];
  const filterLabel = worktreeId ? project.archivedWorktrees.find((w) => w.id === worktreeId)?.label ?? project.worktrees.find((w) => w.id === worktreeId)?.label : null;

  return (
    <>
      <Link to={`/projects/${project.id}`} className="small">
        ← {project.name}
      </Link>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <h1 className="h3 mb-0">Historique</h1>
        <Form.Control type="search" size="sm" placeholder="Chercher dans les noms et les conversations…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 320 }} />
      </div>

      {project.archivedWorktrees.length > 0 && (
        <>
          <h2 className="h5">Worktrees archivés</h2>
          <p className="small text-secondary">Un worktree archivé garde son dossier (commits, modifications non validées) et ses sessions. Le restaurer ramène ses sessions ; son dossier est recréé au besoin à la prochaine utilisation.</p>
          <Table size="sm" hover responsive className="mb-4">
            <thead>
              <tr>
                <th>Worktree</th>
                <th className="d-none d-md-table-cell">Branche</th>
                <th className="d-none d-md-table-cell">Commit</th>
                <th>Archivé</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.archivedWorktrees.map((w) => (
                <tr key={w.id} className={worktreeId === w.id ? 'table-active' : ''}>
                  <td>
                    <i className="bi bi-diagram-2 me-1" />
                    {w.label}
                    {w.label !== w.name && <span className="text-secondary ms-2 small">{w.name}</span>}
                  </td>
                  <td className="font-monospace d-none d-md-table-cell">{w.branch}</td>
                  <td className="font-monospace d-none d-md-table-cell">{w.git?.commit ?? '—'}</td>
                  <td title={fmt(w.archivedAt)}>{timeAgo(w.archivedAt)}</td>
                  <td className="text-end">
                    <Button size="sm" variant="link" className="p-0 px-1" onClick={() => setWorktreeId(worktreeId === w.id ? null : w.id)}>
                      Sessions
                    </Button>
                    <Button
                      size="sm"
                      variant="link"
                      className="p-0 px-1"
                      onClick={() => {
                        if (worktreeId === w.id) setWorktreeId(null);
                        restoreWorktree({ variables: { id: w.id } });
                      }}
                    >
                      Restaurer
                    </Button>
                    <Button
                      size="sm"
                      variant="link"
                      className="p-0 px-1 text-danger"
                      onClick={async () => {
                        const res = await confirm({ title: 'Supprimer le worktree archivé', message: `Supprimer définitivement le worktree « ${w.label} » ? Son dossier (travail non validé et non poussé) est perdu ; ses sessions restent dans l'historique, sans leur worktree.`, confirmLabel: 'Supprimer définitivement', danger: true, checkbox: { label: 'Supprimer aussi la branche locale' } });
                        if (!res) return;
                        await deleteWorktree({ variables: { id: w.id, deleteBranch: res.checked } });
                        evict('Worktree', w.id);
                      }}
                    >
                      Supprimer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      <h2 className="h5">
        Sessions archivées
        {filterLabel && (
          <Badge bg="secondary" className="ms-2 fw-normal" role="button" onClick={() => setWorktreeId(null)}>
            Worktree : {filterLabel} ×
          </Badge>
        )}
      </h2>
      <p className="small text-secondary">Une session archivée garde toute sa conversation. Rouvrez-la pour la lire, restaurez-la parmi les sessions actives, ou relancez une nouvelle session à partir d'elle.</p>
      {sessionsQ.error && <Alert variant="danger">{sessionsQ.error.message}</Alert>}
      <Table size="sm" hover responsive>
        <thead>
          <tr>
            <th>Nom</th>
            <th>État</th>
            <th className="d-none d-md-table-cell">Worktree</th>
            <th className="d-none d-md-table-cell">Par</th>
            <th className="d-none d-md-table-cell">Créée</th>
            <th className="d-none d-md-table-cell">Archivée</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td style={{ maxWidth: 420 }}>
                <Link to={`/sessions/${s.id}`}>{s.name}</Link>
                {s.prompt && <div className="small text-secondary text-truncate">{s.prompt}</div>}
              </td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td className="d-none d-md-table-cell">{s.worktree?.label ?? (s.formerWorktree ? <span className="text-secondary" title="Worktree supprimé">{s.formerWorktree.label} <i className="bi bi-trash3" /></span> : '—')}</td>
              <td className="d-none d-md-table-cell">{s.owner?.name ?? '—'}</td>
              <td className="d-none d-md-table-cell" title={fmt(s.createdAt)}>{timeAgo(s.createdAt)}</td>
              <td className="d-none d-md-table-cell" title={s.archivedAt ? fmt(s.archivedAt) : ''}>{s.archivedAt ? timeAgo(s.archivedAt) : ''}</td>
              <td className="text-end text-nowrap">
                <Button size="sm" variant="link" className="p-0 px-1" onClick={() => setRelaunch(s)}>
                  Relancer
                </Button>
                <Button size="sm" variant="link" className="p-0 px-1" onClick={() => unarchive({ variables: { id: s.id } })}>
                  Restaurer
                </Button>
                <Button
                  size="sm"
                  variant="link"
                  className="p-0 px-1 text-danger"
                  onClick={async () => {
                    if (await confirm({ title: 'Supprimer la session', message: `Supprimer définitivement la session archivée « ${s.name} » et tout son historique ? Cette action est irréversible.`, confirmLabel: 'Supprimer définitivement', danger: true })) {
                      await deleteSession({ variables: { id: s.id } });
                      evict('Session', s.id);
                    }
                  }}
                >
                  Supprimer
                </Button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="text-secondary fst-italic">
                {sessionsQ.loading ? 'Chargement…' : query || worktreeId ? 'Aucune session archivée ne correspond.' : 'Aucune session archivée.'}
              </td>
            </tr>
          )}
        </tbody>
      </Table>
      {rows.length >= limit && (
        <div className="text-center">
          <Button variant="outline-secondary" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
            Afficher plus
          </Button>
        </div>
      )}
      {relaunch && <RelaunchModal session={relaunch} projectName={project.name} worktrees={project.worktrees} onClose={() => setRelaunch(null)} />}
    </>
  );
}
