import { useMutation } from '@apollo/client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { RENAME_WORKSESSION } from '../graphql/operations';
import { canAutoFocus } from '../lib/device';
import type { AddMenuWorksession } from './AddMenu';

interface State {
  openRenameWorksession: (worksession: AddMenuWorksession) => void;
}

const Ctx = createContext<State | null>(null);

export function useRenameWorksession(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRenameWorksession doit être utilisé dans un RenameWorksessionProvider');
  return ctx;
}

/** Même règle que le serveur : minuscules sans accents, tout ce qui n'est pas alphanumérique devient un tiret, 64 caractères au plus. */
export function slugifyFolder(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function RenameModal({ worksession, onClose }: { worksession: AddMenuWorksession; onClose: () => void }) {
  const [label, setLabel] = useState(worksession.customLabel ?? '');
  const [folder, setFolder] = useState(worksession.name);
  const [rename, { loading, error }] = useMutation(RENAME_WORKSESSION, { refetchQueries: ['Sidebar', 'ProjectWorksessions', 'Worksession'], onCompleted: onClose });
  const slug = slugifyFolder(folder);
  const folderChanged = slug !== worksession.name;
  const labelChanged = (label.trim() || null) !== (worksession.customLabel ?? null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!labelChanged && !folderChanged) return onClose();
    rename({ variables: { id: worksession.id, label: label.trim() || null, name: folderChanged ? slug : null } });
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Renommer la work session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Libellé</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={label} maxLength={100} placeholder={worksession.branch} onChange={(e) => setLabel(e.target.value)} />
            <Form.Text>Nom affiché dans Skipper, texte libre. Vide : la branche ({worksession.branch}).</Form.Text>
          </Form.Group>
          <Form.Group>
            <Form.Label>Dossier</Form.Label>
            <Form.Control className="font-monospace" value={folder} onChange={(e) => setFolder(e.target.value)} />
            <Form.Text>
              {folderChanged ? (
                <>
                  Le dossier (git worktree) devient <code>{slug || '…'}</code>. Possible seulement quand aucune session ni aucun terminal n'y tourne ; les agents le retrouvent sous son nouveau nom.
                </>
              ) : (
                <>Nom du dossier et du git worktree. La branche ({worksession.branch}) ne change pas.</>
              )}
            </Form.Text>
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
          <Button type="submit" disabled={loading || (folderChanged && !slug)}>
            {loading ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

export function RenameWorksessionProvider({ children }: { children: ReactNode }) {
  const [worksession, setWorksession] = useState<AddMenuWorksession | null>(null);
  const openRenameWorksession = useCallback((w: AddMenuWorksession) => setWorksession(w), []);
  const value = useMemo(() => ({ openRenameWorksession }), [openRenameWorksession]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {worksession && <RenameModal key={worksession.id} worksession={worksession} onClose={() => setWorksession(null)} />}
    </Ctx.Provider>
  );
}
