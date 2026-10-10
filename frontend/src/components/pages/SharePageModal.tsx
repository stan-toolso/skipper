import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal, Table } from 'react-bootstrap';
import { ADD_SHARED_PAGE_MEMBER, REMOVE_SHARED_PAGE_MEMBER, UPDATE_SHARED_PAGE, type SharedPage } from '../../graphql/misc';
import { VAULT_SHARE_CANDIDATES } from '../../graphql/vault';
import { useDialogs } from '../Dialogs';

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { dateStyle: 'medium' });

/** Partage d'une page (propriétaire) : personnes, accès général par le lien. */
export default function SharePageModal({ page, onClose }: { page: SharedPage; onClose: () => void }) {
  const { confirm } = useDialogs();
  const { data } = useQuery<{ vaultShareCandidates: { id: string; name: string; email: string }[] }>(VAULT_SHARE_CANDIDATES);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [add, { loading: adding }] = useMutation(ADD_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPage', 'SharedPages'] });
  const [remove] = useMutation(REMOVE_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPage', 'SharedPages'] });
  const [update] = useMutation(UPDATE_SHARED_PAGE, { refetchQueries: ['SharedPage', 'SharedPages'] });
  const candidates = (data?.vaultShareCandidates ?? []).filter((c) => c.id !== page.owner.id && !page.members.some((m) => m.user.id === c.id));
  const link = `${window.location.origin}/shared/${page.id}`;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">Partager « {page.title} »</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form
          className="d-flex gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            void run(async () => {
              await add({ variables: { id: page.id, email: email.trim() } });
              setEmail('');
            });
          }}
        >
          <Form.Control size="sm" type="email" list="share-page-candidates" placeholder="adresse@exemple.fr" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <datalist id="share-page-candidates">
            {candidates.map((c) => (
              <option key={c.id} value={c.email}>
                {c.name}
              </option>
            ))}
          </datalist>
          <Button size="sm" type="submit" disabled={adding || !email.trim()}>
            Ajouter
          </Button>
        </Form>
        <div className="small text-secondary mb-1">Personnes ayant accès</div>
        <Table size="sm" className="small mb-3">
          <tbody>
            <tr>
              <td>
                {page.owner.name} <span className="text-secondary">{page.owner.email}</span>
              </td>
              <td className="text-secondary">propriétaire</td>
              <td />
            </tr>
            {page.members.map((m) => (
              <tr key={m.user.id}>
                <td>
                  {m.user.name} <span className="text-secondary">{m.user.email}</span>
                </td>
                <td className="text-secondary">ajouté le {fmtDay(m.addedAt)}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="link"
                    className="p-0 text-danger"
                    onClick={async () => {
                      if (await confirm({ title: "Retirer l'accès", message: `${m.user.name} ne verra plus cette page.`, confirmLabel: 'Retirer', danger: true })) void run(() => remove({ variables: { id: page.id, userId: m.user.id } }));
                    }}
                  >
                    Retirer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Form.Group>
          <Form.Label className="small text-secondary mb-1">Accès général</Form.Label>
          <Form.Select size="sm" value={page.linkAccess ? 'link' : 'restricted'} onChange={(e) => void run(() => update({ variables: { id: page.id, input: { linkAccess: e.target.value === 'link' } } }))}>
            <option value="restricted">Restreint : seules les personnes ci-dessus</option>
            <option value="link">Toute personne connectée à Skipper disposant du lien</option>
          </Form.Select>
          <Form.Text className="text-secondary">{page.linkAccess ? 'Le lien suffit à toute personne ayant un compte Skipper.' : 'Le lien ne fonctionne que pour les personnes ajoutées.'}</Form.Text>
        </Form.Group>
        {error && (
          <Alert variant="danger" className="mt-3 mb-0 py-2">
            {error}
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="outline-secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          <i className={`bi ${copied ? 'bi-check2' : 'bi-link-45deg'} me-1`} /> {copied ? 'Copié' : 'Copier le lien'}
        </Button>
        <Button onClick={onClose}>Terminé</Button>
      </Modal.Footer>
    </Modal>
  );
}
