import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { RELAUNCH_SESSION } from '../graphql/sessions';
import { canAutoFocus } from '../lib/device';

const NEW = '__new__';

/** Relance d'une session : une nouvelle session reprend sa conversation comme contexte, dans sa propre work session par défaut. */
export default function RelaunchModal({ session, projectName, worksessions, onClose }: { session: { id: string; name: string }; projectName: string; worksessions: { id: string; label: string }[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(session.name);
  const [where, setWhere] = useState('');
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [instruction, setInstruction] = useState('');
  const [relaunch, { loading, error }] = useMutation<{ relaunchSession: { id: string } }>(RELAUNCH_SESSION, {
    refetchQueries: ['Sidebar', 'Sessions'],
    onCompleted: (res) => {
      onClose();
      navigate(`/sessions/${res.relaunchSession.id}`);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    relaunch({
      variables: {
        id: session.id,
        input: {
          worksessionId: where && where !== NEW ? where : null,
          // '' : sa propre work session (restaurée si besoin), ou une nouvelle si elle a disparu — choisi par le serveur.
          newWorksession: where === NEW ? { branch: branch.trim() || null, label: name.trim() || session.name, baseRef: baseRef.trim() || null } : null,
          name: name.trim() || null,
          instruction: instruction.trim() || null,
        },
      },
    });
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Relancer la session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Une nouvelle session de {projectName} démarre avec la conversation de « {session.name} » comme contexte. La session d'origine reste intacte.
          </p>
          <Form.Group className="mb-3">
            <Form.Label>Nom</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={name} onChange={(e) => setName(e.target.value)} />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Work session</Form.Label>
            <Form.Select value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="">Sa work session (par défaut)</option>
              {worksessions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
              <option value={NEW}>Nouvelle work session…</option>
            </Form.Select>
          </Form.Group>
          {where === NEW && (
            <>
              <Form.Group className="mb-3">
                <Form.Label>Branche</Form.Label>
                <Form.Control autoFocus placeholder="Facultatif : dérivée du nom (créée si elle n'existe pas)" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>À partir de</Form.Label>
                <Form.Control placeholder="Par défaut : HEAD du dossier principal" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
              </Form.Group>
            </>
          )}
          <Form.Group>
            <Form.Label>Instruction</Form.Label>
            <Form.Control as="textarea" rows={3} placeholder="Facultatif : quoi faire ensuite (par défaut : continuer là où elle s'est arrêtée)" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          </Form.Group>
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || (where === NEW && !branch.trim())}>
            {loading ? 'Lancement…' : 'Relancer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
