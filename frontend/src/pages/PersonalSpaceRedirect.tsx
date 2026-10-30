import { useQuery } from '@apollo/client';
import { Alert } from 'react-bootstrap';
import { Navigate } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import { PERSONAL_SPACE } from '../graphql/sessions';

/** `/me` : ouvre l'espace personnel de la personne connectée (créé à la première visite), qui vit aux routes d'un projet. */
export default function PersonalSpaceRedirect() {
  const { data, error } = useQuery<{ personalSpace: { id: string } }>(PERSONAL_SPACE);
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!data) return <PageLoading title="Mon espace" />;
  return <Navigate to={`/projects/${data.personalSpace.id}`} replace />;
}
