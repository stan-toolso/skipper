import { useQuery } from '@apollo/client';
import { Alert } from 'react-bootstrap';
import { Link, Navigate, useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import { SEARCH } from '../graphql/misc';
import type { SearchHit } from '../graphql/operations';

/**
 * `/r/<task|session|any>/<identifiant ou son début>` : lien posé sur un identifiant cité dans un texte (« la tâche
 * 313c1101 », voir `lib/idRefs`). Retrouve la tâche ou la session (même archivée) par la recherche, qui reconnaît les
 * identifiants, puis ouvre sa page ; plusieurs correspondances (début d'identifiant ambigu) sont proposées en liste.
 */
export default function RefRedirect() {
  const { kind = 'any', id = '' } = useParams();
  const prefix = id.toLowerCase();
  const kinds = kind === 'task' ? ['TASK'] : kind === 'session' ? ['SESSION'] : ['TASK', 'SESSION'];
  const { data, error } = useQuery<{ search: { groups: { kind: SearchHit['kind']; hits: SearchHit[] }[] } }>(SEARCH, { variables: { query: prefix, kinds, limit: 10, projectId: null }, fetchPolicy: 'network-only' });
  const label = kind === 'task' ? 'Tâche' : kind === 'session' ? 'Session' : 'Élément';
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!data) return <PageLoading title={`${label} ${prefix.slice(0, 8)}`} />;
  const hits = data.search.groups.flatMap((g) => g.hits).filter((h) => h.id.startsWith(prefix));
  const url = (h: SearchHit) => (h.kind === 'TASK' ? `/tasks/${h.id}` : `/sessions/${h.id}`);
  if (hits.length === 1) return <Navigate to={url(hits[0])} replace />;
  if (!hits.length)
    return (
      <Alert variant="warning" className="m-3">
        {label} <code>{prefix}</code> introuvable : elle n'existe pas, ou elle appartient à un projet dont vous n'êtes pas membre.
      </Alert>
    );
  return (
    <div className="p-3">
      <p>
        Plusieurs éléments commencent par <code>{prefix}</code> :
      </p>
      <ul>
        {hits.map((h) => (
          <li key={h.id}>
            <Link to={url(h)}>{h.title}</Link> <span className="text-secondary small">· {h.kind === 'TASK' ? 'tâche' : 'session'}{h.projectName ? ` · ${h.projectName}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
