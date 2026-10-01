import { useApolloClient, type DocumentNode } from '@apollo/client';
import { PROJECT_NAME } from '../graphql/operations';
import { Spinner } from 'react-bootstrap';

/** Indicateur de chargement d'une page, avec son titre quand on le connaît déjà. */
export default function PageLoading({ title, className = '' }: { title?: string | null; className?: string }) {
  return (
    <div className={`d-flex align-items-center gap-2 text-secondary ${className}`}>
      {title && <h1 className="h3 mb-0 me-2 text-body">{title}</h1>}
      <Spinner animation="border" size="sm" /> <span className="small">Chargement…</span>
    </div>
  );
}

/** Nom d'un objet déjà présent dans le cache Apollo (sidebar, listes), sans requête. */
export function useCachedName(fragment: DocumentNode, typename: string, id: string): string | null {
  const client = useApolloClient();
  try {
    return client.readFragment<{ name: string }>({ id: client.cache.identify({ __typename: typename, id }), fragment })?.name ?? null;
  } catch {
    return null;
  }
}

/** Chargement d'une page de projet : le nom du projet (connu de la sidebar) s'affiche tout de suite. */
export function ProjectPageLoading({ id }: { id: string }) {
  return <PageLoading title={useCachedName(PROJECT_NAME, 'Project', id)} />;
}
