import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Form, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import RelaunchModal from '../components/RelaunchModal';
import StatusBadge from '../components/StatusBadge';
import { DELETE_SESSION, type Session } from '../graphql/operations';
import { ARCHIVED_SESSIONS, HISTORY_PROJECT, UNARCHIVE_SESSION } from '../graphql/sessions';
import { timeAgo } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';
import ProjectHeader from '../components/ProjectHeader';

const PAGE = 50;

interface HistoryProject {
  id: string;
  name: string;
  description: string | null;
  myRole: 'ADMIN' | 'MEMBER' | 'VIEWER';
  gitUrl: string | null;
}

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Historique d'un projet : les sessions archivées (relire, relancer, restaurer, supprimer). Le dossier de travail
 * d'une session (sa branche) l'accompagne : archivé avec elle, restauré avec elle, supprimé avec elle.
 */
export default function SessionHistoryPage() {
  const { id = '' } = useParams();
  const client = useApolloClient();
  const { confirm, showError } = useDialogs();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
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
  const sessionsQ = useQuery<{ archivedSessions: Session[] }>(ARCHIVED_SESSIONS, { variables: { projectId: id, search: query || null, limit, offset: 0 }, fetchPolicy: 'cache-and-network' });
  const project = projectQ.data?.project;
  useTabTitle(project ? `Historique · ${project.name}` : null);
  const refetch = { refetchQueries: ['ArchivedSessions', 'HistoryProject', 'Sidebar'] };
  const [unarchive] = useMutation(UNARCHIVE_SESSION, { ...refetch, onError: (e) => void showError(e) });
  const [deleteSession] = useMutation(DELETE_SESSION, { ...refetch, onError: (e) => void showError(e) });
  const evict = (typename: string, objId: string) => {
    client.cache.evict({ id: client.cache.identify({ __typename: typename, id: objId }) });
    client.cache.gc();
  };

  if (projectQ.loading && !project) return <PageLoading />;
  if (projectQ.error) return <Alert variant="danger">Erreur : {projectQ.error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const rows = sessionsQ.data?.archivedSessions ?? [];

  return (
    <>
      <ProjectHeader project={project} active="history" />
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <Form.Control type="search" size="sm" placeholder="Chercher dans les noms et les conversations…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 320, maxWidth: '100%' }} className="ms-auto" />
      </div>

      <h2 className="h5">Sessions archivées</h2>
      <p className="small text-secondary">
        Une session archivée garde toute sa conversation et son dossier de travail (commits, modifications non validées, branche). Rouvrez-la pour la lire, restaurez-la parmi les sessions actives, ou relancez une nouvelle session à partir d'elle, sur la même branche.
      </p>
      {sessionsQ.error && <Alert variant="danger">{sessionsQ.error.message}</Alert>}
      <Table size="sm" hover responsive>
        <thead>
          <tr>
            <th>Nom</th>
            <th>État</th>
            {project.gitUrl && <th className="d-none d-md-table-cell">Branche</th>}
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
              {project.gitUrl && (
                <td className="d-none d-md-table-cell font-monospace">
                  {s.worksession?.branch ?? (s.formerWorksession ? <span className="text-secondary" title="Dossier de travail supprimé : la branche a pu être supprimée aussi">{s.formerWorksession.branch} <i className="bi bi-trash3" /></span> : '—')}
                </td>
              )}
              <td className="d-none d-md-table-cell">{s.owner?.name ?? '—'}</td>
              <td className="d-none d-md-table-cell" title={fmt(s.createdAt)}>{timeAgo(s.createdAt)}</td>
              <td className="d-none d-md-table-cell" title={s.archivedAt ? fmt(s.archivedAt) : ''}>{s.archivedAt ? timeAgo(s.archivedAt) : ''}</td>
              <td className="text-end text-nowrap">
                <Button size="sm" variant="link" className="p-0 px-1" onClick={() => setRelaunch(s)}>
                  Relancer
                </Button>
                <Button size="sm" variant="link" className="p-0 px-1" title="Remet la session parmi les sessions actives, avec son dossier de travail" onClick={() => unarchive({ variables: { id: s.id } })}>
                  Restaurer
                </Button>
                <Button
                  size="sm"
                  variant="link"
                  className="p-0 px-1 text-danger"
                  onClick={async () => {
                    const opts = {
                      title: 'Supprimer la session',
                      message: `Supprimer définitivement la session archivée « ${s.name} » et tout son historique ? Son dossier de travail est supprimé avec elle (travail non validé et non poussé perdu). Cette action est irréversible.`,
                      confirmLabel: 'Supprimer définitivement',
                      danger: true,
                    };
                    const res = s.worksession && project.gitUrl ? await confirm({ ...opts, checkbox: { label: `Supprimer aussi la branche ${s.worksession.branch}` } }) : (await confirm(opts)) ? { checked: false } : null;
                    if (!res) return;
                    await deleteSession({ variables: { id: s.id, deleteBranch: res.checked } });
                    evict('Session', s.id);
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
                {sessionsQ.loading ? 'Chargement…' : query ? 'Aucune session archivée ne correspond.' : 'Aucune session archivée.'}
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
      {relaunch && <RelaunchModal session={relaunch} projectName={project.name} onClose={() => setRelaunch(null)} />}
    </>
  );
}
