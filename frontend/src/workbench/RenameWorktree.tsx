import { useMutation } from '@apollo/client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { RENAME_WORKTREE } from '../graphql/operations';
import { canAutoFocus } from '../lib/device';
import type { AddMenuWorktree } from './AddMenu';

interface State {
  openRenameWorktree: (worktree: AddMenuWorktree) => void;
}

const Ctx = createContext<State | null>(null);

export function useRenameWorktree(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRenameWorktree doit être utilisé dans un RenameWorktreeProvider');
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

function RenameModal({ worktree, onClose }: { worktree: AddMenuWorktree; onClose: () => void }) {
  const [label, setLabel] = useState(worktree.customLabel ?? '');
  const [folder, setFolder] = useState(worktree.name);
  const [rename, { loading, error }] = useMutation(RENAME_WORKTREE, { refetchQueries: ['Sidebar', 'ProjectWorktrees', 'Worktree'], onCompleted: onClose });
  const slug = slugifyFolder(folder);
  const folderChanged = slug !== worktree.name;
  const labelChanged = (label.trim() || null) !== (worktree.customLabel ?? null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!labelChanged && !folderChanged) return onClose();
    rename({ variables: { id: worktree.id, label: label.trim() || null, name: folderChanged ? slug : null } });
  };
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Renommer le worktree</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Libellé</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={label} maxLength={100} placeholder={worktree.branch} onChange={(e) => setLabel(e.target.value)} />
            <Form.Text>Nom affiché dans Skipper, texte libre. Vide : la branche ({worktree.branch}).</Form.Text>
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
                <>Nom du dossier et du git worktree. La branche ({worktree.branch}) ne change pas.</>
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

export function RenameWorktreeProvider({ children }: { children: ReactNode }) {
  const [worktree, setWorktree] = useState<AddMenuWorktree | null>(null);
  const openRenameWorktree = useCallback((w: AddMenuWorktree) => setWorktree(w), []);
  const value = useMemo(() => ({ openRenameWorktree }), [openRenameWorktree]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {worktree && <RenameModal key={worktree.id} worktree={worktree} onClose={() => setWorktree(null)} />}
    </Ctx.Provider>
  );
}
