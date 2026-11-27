import { ApolloError, useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal, Table } from 'react-bootstrap';
import { ADD_SHARED_PAGE_MEMBER, EMAIL_AVAILABLE, REMOVE_SHARED_PAGE_MEMBER, UPDATE_SHARED_PAGE, type SharedPage } from '../../graphql/misc';
import { VAULT_SHARE_CANDIDATES } from '../../graphql/vault';
import { useDialogs } from '../Dialogs';

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { dateStyle: 'medium' });

/** Partage d'une page (propriétaire) : personnes, accès général par le lien. */
export default function SharePageModal({ page, onClose }: { page: SharedPage; onClose: () => void }) {
  const { confirm } = useDialogs();
  const { data } = useQuery<{ vaultShareCandidates: { id: string; name: string; email: string }[] }>(VAULT_SHARE_CANDIDATES);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Adresse sans compte Skipper : on propose d'inviter la personne (compte limité aux pages partagées avec elle).
  const [noAccount, setNoAccount] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null);
  const { data: mail } = useQuery<{ emailNotificationsAvailable: boolean }>(EMAIL_AVAILABLE);
  const canEmail = Boolean(mail?.emailNotificationsAvailable);
  const [copied, setCopied] = useState(false);
  const [add, { loading: adding }] = useMutation(ADD_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPage', 'SharedPages'] });
  const [remove] = useMutation(REMOVE_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPage', 'SharedPages'] });
  const [update] = useMutation(UPDATE_SHARED_PAGE, { refetchQueries: ['SharedPage', 'SharedPages'] });
  const candidates = (data?.vaultShareCandidates ?? []).filter((c) => c.id !== page.owner.id && !page.members.some((m) => m.user.id === c.id));
  const link = `${window.location.origin}/shared/${page.id}`;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNoAccount(null);
    setDoneNote(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const emailed = canEmail && notify;
  const addEmail = (address: string, invite = false) =>
    run(async () => {
      try {
        await add({ variables: { id: page.id, email: address, invite, message: message.trim() || null, notify: emailed } });
      } catch (err) {
        if (!invite && err instanceof ApolloError && err.graphQLErrors.some((g) => g.extensions?.code === 'NO_ACCOUNT')) {
          setNoAccount(address);
          return;
        }
        throw err;
      }
      setEmail('');
      setMessage('');
      if (invite)
        setDoneNote(
          emailed
            ? `Invitation envoyée à ${address}. Le bouton de l'e-mail lui ouvre directement la page : aucun compte à créer, aucun mot de passe. Il ne verra que les pages partagées avec lui.`
            : `${address} est invité. Envoyez-lui le lien de la page (« Copier le lien ») : il se connectera avec cette adresse et ne verra que les pages partagées avec lui.`,
        );
      else setDoneNote(emailed ? `Page partagée avec ${address} : un e-mail l'a prévenu.` : `Page partagée avec ${address}.`);
    });
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">Partager « {page.title} »</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form
          className="mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            void addEmail(email.trim());
          }}
        >
          <div className="d-flex gap-2">
            <Form.Control size="sm" type="email" list="share-page-candidates" placeholder="adresse@exemple.fr" aria-label="Adresse e-mail de la personne" value={email} onChange={(e) => (setEmail(e.target.value), setNoAccount(null))} required autoFocus />
            <datalist id="share-page-candidates">
              {candidates.map((c) => (
                <option key={c.id} value={c.email}>
                  {c.name}
                </option>
              ))}
            </datalist>
            <Button size="sm" type="submit" disabled={adding || !email.trim()} className="text-nowrap">
              <i className="bi bi-send me-1" /> Partager
            </Button>
          </div>
          <Form.Control
            as="textarea"
            size="sm"
            rows={3}
            maxLength={2000}
            className="mt-2"
            placeholder="Message (facultatif) : présentez la page, dites ce que vous attendez de la personne…"
            aria-label="Message d'introduction"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {canEmail ? (
            <Form.Check
              type="switch"
              id="share-page-notify"
              className="small mt-2 mb-0"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              label={message.trim() ? 'Prévenir par e-mail, avec ce message' : 'Prévenir par e-mail'}
            />
          ) : (
            <div className="small text-secondary mt-2">L'envoi des e-mails n'est pas configuré : le message s'affichera sur la page, envoyez le lien vous-même.</div>
          )}
        </Form>
        {noAccount && (
          <Alert variant="info" className="mb-3 py-2 small">
            <div className="mb-2">
              <strong>{noAccount}</strong> n'a pas encore de compte Skipper. Invitez cette personne : {emailed ? "elle recevra un e-mail dont le bouton lui ouvre la page directement, sans compte à créer ni mot de passe" : 'elle se connectera avec cette adresse'}. Elle ne verra que les pages partagées avec elle (aucun projet, aucun menu).
            </div>
            <div className="d-flex gap-2 flex-wrap">
              <Button size="sm" disabled={adding} onClick={() => void addEmail(noAccount, true)}>
                <i className="bi bi-envelope-plus me-1" /> Inviter et partager
              </Button>
              <Button size="sm" variant="outline-secondary" onClick={() => setNoAccount(null)}>
                Annuler
              </Button>
            </div>
          </Alert>
        )}
        {doneNote && (
          <Alert variant="success" className="mb-3 py-2 small">
            {doneNote}
          </Alert>
        )}
        <div className="small text-secondary mb-1">Personnes ayant accès</div>
        <Table size="sm" className="small mb-3 table-stack">
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
                  {m.user.isGuest && (
                    <span className="badge rounded-pill text-bg-secondary ms-1" title="Invité : ne voit que les pages partagées avec lui">
                      invité
                    </span>
                  )}
                  {m.message && <i className="bi bi-chat-quote ms-1 text-secondary" title={`Message : ${m.message}`} aria-label="Partagé avec un message" />}
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
          <Form.Select
            size="sm"
            value={page.publicAccess ? 'public' : page.linkAccess ? 'link' : page.projectAccess ? 'project' : 'restricted'}
            onChange={async (e) => {
              const v = e.target.value;
              if (v === 'public' && !(await confirm({ title: 'Rendre la page publique', message: 'Toute personne qui a le lien pourra lire la page et ses données, sans compte ni connexion. Les commentaires restent réservés aux personnes connectées.', confirmLabel: 'Rendre publique' }))) return;
              const input = v === 'public' ? { publicAccess: true } : v === 'link' ? { linkAccess: true, publicAccess: false } : v === 'project' ? { linkAccess: false, projectAccess: true } : { linkAccess: false, projectAccess: false };
              void run(() => update({ variables: { id: page.id, input } }));
            }}
          >
            <option value="restricted">Restreint : seules les personnes ci-dessus</option>
            {(page.project || page.projectAccess) && <option value="project">Les membres du projet{page.project ? ` « ${page.project.name} »` : ''}</option>}
            <option value="link">Toute personne connectée à Skipper disposant du lien</option>
            <option value="public">Tout le monde disposant du lien, sans connexion (publique)</option>
          </Form.Select>
          <Form.Text className="text-secondary">
            {page.publicAccess
              ? 'Le lien suffit, sans compte ni connexion : à ne faire que pour une page sans donnée confidentielle. Les commentaires restent réservés aux personnes connectées.'
              : page.linkAccess
              ? 'Le lien suffit à toute personne ayant un compte Skipper (sauf les invités, qui ne voient que les pages où ils ont été ajoutés).'
              : page.projectAccess
                ? 'Tout membre du projet voit la page (sauf les invités) : nécessaire pour l’épingler dans le tableau de bord du projet.'
                : 'Le lien ne fonctionne que pour les personnes ajoutées.'}
          </Form.Text>
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
