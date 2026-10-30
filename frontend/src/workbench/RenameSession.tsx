import { useMutation } from '@apollo/client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { UPDATE_SESSION } from '../graphql/operations';
import { canAutoFocus } from '../lib/device';

export interface RenamableSession {
  id: string;
  name: string;
}

interface State {
  openRenameSession: (session: RenamableSession) => void;
}

const Ctx = createContext<State | null>(null);

export function useRenameSession(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRenameSession doit être utilisé dans un RenameSessionProvider');
  return ctx;
}

/** Renommage d'une session depuis la sidebar (le même nom se change aussi dans les réglages de la session). */
function RenameModal({ session, onClose }: { session: RenamableSession; onClose: () => void }) {
  const [name, setName] = useState(session.name);
  const [rename, { loading, error }] = useMutation(UPDATE_SESSION, { refetchQueries: ['Sidebar'], onCompleted: onClose });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (!next || next === session.name) return onClose();
    rename({ variables: { id: session.id, input: { name: next } } });
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Renommer la session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group>
            <Form.Label>Nom</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            <Form.Text>Nom affiché dans Skipper. La branche et le dossier de travail ne changent pas.</Form.Text>
          </Form.Group>
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

export function RenameSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RenamableSession | null>(null);
  const openRenameSession = useCallback((s: RenamableSession) => setSession(s), []);
  const value = useMemo(() => ({ openRenameSession }), [openRenameSession]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {session && <RenameModal key={session.id} session={session} onClose={() => setSession(null)} />}
    </Ctx.Provider>
  );
}
