import { useMutation } from '@apollo/client';
import { Alert, Button, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import ChatComposer from '../components/ChatComposer';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import StatusBadge from '../components/StatusBadge';
import { DELETE_SESSION, STOP_SESSION, type Session } from '../graphql/operations';
import { CHATS } from '../graphql/sessions';
import { formatCost, sessionStateHint, timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

/** Chats de la personne connectée : conversations légères de son espace personnel, les plus récentes d'abord. */
export default function ChatsPage() {
  useTabTitle('Chats');
  const { data, loading, error } = usePollingQuery<{ chats: Session[] }>(CHATS, { variables: { limit: 100 }, pollInterval: 5000 });
  const { confirm, showError } = useDialogs();
  const [stopSession] = useMutation(STOP_SESSION, { refetchQueries: ['Chats'] });
  const [deleteSession] = useMutation(DELETE_SESSION, { refetchQueries: ['Chats'] });
  const chats = data?.chats ?? [];

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <h1 className="h3 mb-0">Chats</h1>
        <Link to="/me" className="small">
          Mon espace personnel
        </Link>
      </div>
      <ChatComposer autoFocus />
      {error && <Alert variant="danger">Erreur : {error.message}</Alert>}
      {loading && !data && <PageLoading />}
      {data && (
        <Table hover responsive size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Chat</th>
              <th>État</th>
              <th className="d-none d-md-table-cell">Dernière activité</th>
              <th className="d-none d-md-table-cell text-end">Coût</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {chats.length === 0 && (
              <tr>
                <td colSpan={5} className="text-secondary">
                  Aucun chat pour l'instant : posez une question ci-dessus.
                </td>
              </tr>
            )}
            {chats.map((c) => {
              const hint = sessionStateHint(c.status, c.activity, c.pendingRequestCount);
              return (
                <tr key={c.id}>
                  <td>
                    <Link to={`/chats/${c.id}`}>{c.name}</Link>
                    {hint && <span className="text-secondary small ms-2">{hint}</span>}
                  </td>
                  <td>
                    <StatusBadge status={c.status} pendingRequests={c.pendingRequestCount} />
                  </td>
                  <td className="text-secondary small d-none d-md-table-cell" title={new Date(c.updatedAt).toLocaleString()}>
                    {timeAgo(c.updatedAt)}
                  </td>
                  <td className="text-secondary small d-none d-md-table-cell text-end">{c.costUsd > 0 ? formatCost(c.costUsd) : '—'}</td>
                  <td className="text-end text-nowrap">
                    {c.status === 'RUNNING' && (
                      <Button size="sm" variant="outline-warning" className="me-1" title="Arrêter le chat (un message le reprend)" onClick={() => void stopSession({ variables: { id: c.id } }).catch(showError)}>
                        Arrêter
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline-danger"
                      title="Supprimer le chat et son historique"
                      onClick={async () => {
                        if (await confirm({ title: 'Supprimer le chat', message: `Supprimer le chat « ${c.name} » et son historique ?`, confirmLabel: 'Supprimer', danger: true })) {
                          void deleteSession({ variables: { id: c.id } }).catch(showError);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
