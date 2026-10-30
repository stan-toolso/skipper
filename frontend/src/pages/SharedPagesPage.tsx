import { useState } from 'react';
import { Alert, Button, ButtonGroup, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import PageLoading from '../components/PageLoading';
import { SHARED_PAGES, type SharedPage } from '../graphql/misc';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

type Filter = 'all' | 'mine' | 'shared';

export function accessLabel(page: SharedPage): { icon: string; text: string } {
  if (page.linkAccess) return { icon: 'bi-building', text: 'Toute personne de Skipper avec le lien' };
  if (page.members.length) return { icon: 'bi-people', text: `Partagée avec ${page.members.length} personne${page.members.length > 1 ? 's' : ''}` };
  return { icon: 'bi-lock', text: 'Privée' };
}

/** Pages partagées : publiées par un agent ou depuis l'explorateur de fichiers, privées jusqu'au partage. */
export default function SharedPagesPage() {
  const { user } = useAuth();
  useTabTitle('Pages');
  const [filter, setFilter] = useState<Filter>('all');
  const { data, loading, error } = usePollingQuery<{ sharedPages: SharedPage[] }>(SHARED_PAGES, { pollInterval: 30_000 });
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const pages = (data?.sharedPages ?? []).filter((p) => (filter === 'mine' ? p.owner.id === user?.id : filter === 'shared' ? p.owner.id !== user?.id : true));
  return (
    <>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <h1 className="h3 mb-0">Pages</h1>
        <ButtonGroup size="sm">
          {(
            [
              ['all', 'Toutes'],
              ['mine', 'Les miennes'],
              ['shared', 'Partagées avec moi'],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <Button key={f} variant={filter === f ? 'primary' : 'outline-secondary'} onClick={() => setFilter(f)}>
              {label}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      <p className="text-secondary small">Un agent publie une page quand vous le lui demandez (« publie ce rapport comme page ») ; vous pouvez aussi publier un fichier HTML depuis l'explorateur de fichiers. Une page est privée jusqu'à ce que son propriétaire la partage.</p>
      <Table size="sm" hover responsive>
        <thead>
          <tr>
            <th>Titre</th>
            <th className="d-none d-md-table-cell">Propriétaire</th>
            <th>Accès</th>
            <th className="d-none d-md-table-cell">Version</th>
            <th className="d-none d-md-table-cell">Mise à jour</th>
          </tr>
        </thead>
        <tbody>
          {pages.length === 0 && (
            <tr>
              <td colSpan={5} className="text-secondary fst-italic">
                {filter === 'mine' ? "Vous n'avez pas encore publié de page." : filter === 'shared' ? 'Aucune page partagée avec vous.' : 'Aucune page pour le moment.'}
              </td>
            </tr>
          )}
          {pages.map((p) => {
            const access = accessLabel(p);
            return (
              <tr key={p.id}>
                <td style={{ maxWidth: 420 }}>
                  <Link to={`/shared/${p.id}`}>{p.title}</Link>
                  {p.description && <div className="small text-secondary text-truncate">{p.description}</div>}
                </td>
                <td className="d-none d-md-table-cell">{p.owner.id === user?.id ? 'Vous' : p.owner.name}</td>
                <td className="small">
                  <i className={`bi ${access.icon} me-1 text-secondary`} />
                  {access.text}
                </td>
                <td className="d-none d-md-table-cell">v{p.version}</td>
                <td className="d-none d-md-table-cell" title={new Date(p.updatedAt).toLocaleString()}>{timeAgo(p.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
