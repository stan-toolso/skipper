import { useMutation, useQuery } from '@apollo/client';
import { Alert, Card, Form, Spinner } from 'react-bootstrap';
import { PUSH_PREFERENCES, SET_PUSH_PREFERENCE, type PushCategory } from '../../graphql/misc';

/**
 * Paramètres › Notifications : les familles de notifications que la personne reçoit en push (et en
 * notification du navigateur). La cloche affiche tout, quel que soit ce choix ; l'activation du push
 * sur un appareil se fait depuis la cloche.
 */
export default function NotificationsSection() {
  const { data, loading, error } = useQuery<{ pushPreferences: PushCategory[] }>(PUSH_PREFERENCES, { fetchPolicy: 'cache-and-network' });
  const [setPreference, { loading: saving, error: saveError }] = useMutation<{ setPushPreference: PushCategory[] }>(SET_PUSH_PREFERENCE, {
    update: (cache, { data: res }) => {
      if (res) cache.writeQuery({ query: PUSH_PREFERENCES, data: { pushPreferences: res.setPushPreference } });
    },
  });
  const categories = data?.pushPreferences ?? [];
  const toggle = (category: PushCategory, enabled: boolean) =>
    void setPreference({
      variables: { category: category.key, enabled },
      optimisticResponse: { setPushPreference: categories.map((c) => (c.key === category.key ? { ...c, enabled } : c)) },
    }).catch(() => undefined);

  return (
    <Card className="mb-4">
      <Card.Header>Notifications reçues en push</Card.Header>
      <Card.Body>
        <p className="text-secondary small">
          Choisissez ce qui vous est envoyé sur vos appareils (notifications système, même Skipper fermé) et affiché par le navigateur quand
          la fenêtre n’est pas au premier plan. La cloche garde toutes les notifications, quel que soit ce choix. Ce réglage vous suit sur tous
          vos appareils ; l’activation des notifications sur un appareil se fait depuis la cloche.
        </p>
        {loading && !data && <Spinner size="sm" />}
        {error && <Alert variant="danger" className="py-2">{error.message}</Alert>}
        {categories.map((c) => (
          <Form.Check
            key={c.key}
            type="switch"
            id={`push-${c.key}`}
            className="mb-2"
            checked={c.enabled}
            disabled={saving}
            onChange={(e) => toggle(c, e.target.checked)}
            label={
              <>
                <span>
                  {c.label}
                  {c.adminsOnly && <span className="badge bg-secondary ms-2">administrateurs</span>}
                </span>
                <div className="small text-secondary">{c.description}</div>
              </>
            }
          />
        ))}
        {saveError && <Alert variant="danger" className="mt-2 mb-0 py-2">{saveError.message}</Alert>}
      </Card.Body>
    </Card>
  );
}
