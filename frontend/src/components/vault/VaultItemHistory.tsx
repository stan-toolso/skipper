import { useMutation, useQuery } from '@apollo/client';
import { Badge, Button } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { RESTORE_VAULT_ITEM_VERSION, VAULT_ITEM_VERSIONS, type VaultItem, type VaultItemVersion } from '../../graphql/vault';
import { useDialogs } from '../Dialogs';
import { fmtDate } from './kinds';

const VERSION_ACTIONS: Record<string, string> = {
  created: 'création',
  imported: 'état repris',
  updated: 'modification',
  secret_changed: 'secret modifié',
  key_regenerated: 'clé régénérée',
  restored: 'restauration',
};

/**
 * Historique des versions d'un élément du coffre (permission « gérer ») : chaque modification par une personne ou
 * une session, ce qui a changé (jamais de valeur secrète), et la restauration d'une version antérieure.
 */
export default function VaultItemHistory({ item }: { item: VaultItem }) {
  const { confirm, showError } = useDialogs();
  const { data, loading, fetchMore } = useQuery<{ vaultItem: { id: string; versions: VaultItemVersion[] } | null }>(VAULT_ITEM_VERSIONS, { variables: { id: item.id }, fetchPolicy: 'cache-and-network' });
  const [restore, { loading: restoring }] = useMutation(RESTORE_VAULT_ITEM_VERSION, { refetchQueries: ['VaultItems', 'VaultProject', 'VaultItemDetails', 'VaultItemVersions'], onError: (e) => void showError(e) });
  const versions = data?.vaultItem?.versions ?? [];
  if (loading && !versions.length) return <div className="small text-secondary">Chargement…</div>;
  if (!versions.length) return <div className="small text-secondary">Aucune version enregistrée.</div>;
  return (
    <div className="small vault-history">
      <p className="text-secondary mb-2">Chaque modification, par une personne ou une session, garde l'état précédent (secrets compris, jamais affichés). Restaurer une version en crée une nouvelle.</p>
      <ol className="list-unstyled mb-1">
        {versions.map((v) => (
          <li key={v.id} className="vault-history-entry">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <span className="font-monospace">v{v.version}</span>
              <span>{VERSION_ACTIONS[v.action] ?? v.action}</span>
              {v.restoredFrom != null && <span className="text-secondary">de la v{v.restoredFrom}</span>}
              <span className="text-secondary">{fmtDate(v.createdAt)}</span>
              <span>· {v.actor?.name ?? '—'}</span>
              {v.sessionId && (v.session ? <Link to={`/sessions/${v.session.id}`}>par la session « {v.session.name} »</Link> : <span className="text-secondary">par une session</span>)}
              {v.current ? (
                <Badge bg="secondary">actuelle</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="link"
                  className="p-0 align-baseline"
                  style={{ fontSize: 'inherit' }}
                  disabled={restoring}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Restaurer la version ${v.version}`,
                        message: `« ${item.name} » reprendra l'état de la version ${v.version} (${fmtDate(v.createdAt)}) : nom, description, réglages, secrets et politique d'accès. L'état actuel reste dans l'historique.`,
                        confirmLabel: 'Restaurer',
                      })
                    )
                      await restore({ variables: { id: item.id, version: v.version } });
                  }}
                >
                  <i className="bi bi-arrow-counterclockwise me-1" />
                  Restaurer
                </Button>
              )}
            </div>
            {v.changes.length > 0 && (
              <ul className="vault-history-changes mb-0">
                {v.changes.map((c) => (
                  <li key={c.field}>
                    <span className="text-secondary">{c.label} : </span>
                    {c.secret ? (
                      <span>secret modifié</span>
                    ) : (
                      <>
                        <span className="vault-history-before">{c.before ?? '(vide)'}</span>
                        {' → '}
                        <span>{c.after ?? '(vide)'}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {versions.length >= 30 && versions.at(-1)!.version > 1 && (
        <Button
          variant="link"
          size="sm"
          className="p-0"
          onClick={() =>
            void fetchMore({
              variables: { before: versions.at(-1)!.version },
              updateQuery: (prev, { fetchMoreResult }) =>
                prev.vaultItem && fetchMoreResult.vaultItem ? { vaultItem: { ...prev.vaultItem, versions: [...prev.vaultItem.versions, ...fetchMoreResult.vaultItem.versions] } } : prev,
            })
          }
        >
          Afficher plus
        </Button>
      )}
    </div>
  );
}
