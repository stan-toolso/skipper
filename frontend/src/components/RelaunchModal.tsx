import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { RELAUNCH_SESSION } from '../graphql/sessions';
import { canAutoFocus } from '../lib/device';

/**
 * Relance d'une session : une nouvelle session reprend sa conversation comme contexte, dans le même dossier de
 * travail et sur la même branche ; la session d'origine est archivée (une seule session par dossier).
 */
export default function RelaunchModal({ session, projectName, onClose }: { session: { id: string; name: string; archivedAt?: string | null }; projectName: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(session.name);
  const [instruction, setInstruction] = useState('');
  const [relaunch, { loading, error }] = useMutation<{ relaunchSession: { id: string } }>(RELAUNCH_SESSION, {
    refetchQueries: ['Sidebar', 'Sessions', 'ArchivedSessions'],
    onCompleted: (res) => {
      onClose();
      navigate(`/sessions/${res.relaunchSession.id}`);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    relaunch({ variables: { id: session.id, input: { name: name.trim() || null, instruction: instruction.trim() || null } } });
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Relancer la session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Une nouvelle session de {projectName} démarre avec la conversation de « {session.name} » comme contexte, dans le même dossier de travail et sur la même branche.
            {session.archivedAt ? " La session d'origine reste dans l'historique." : " La session d'origine est archivée (arrêtée si elle tourne) et reste consultable dans l'historique."}
          </p>
          <Form.Group className="mb-3">
            <Form.Label>Nom</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={name} onChange={(e) => setName(e.target.value)} />
          </Form.Group>
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
          <Button type="submit" disabled={loading}>
            {loading ? 'Lancement…' : 'Relancer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
