import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { canAutoFocus } from '../lib/device';

/**
 * Boîtes de dialogue de l'application, en remplacement de window.alert / confirm / prompt : des
 * modales au thème de Skipper, non bloquantes pour le navigateur, utilisables avec `await`.
 *
 *   const { confirm, prompt, alert, showError } = useDialogs();
 *   if (await confirm({ message: 'Supprimer ?', danger: true })) …
 *   const name = await prompt({ title: 'Nom du dossier' });   // null si annulé
 *   mutation().catch(showError);
 */

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  /** Libellé du bouton d'action (défaut « Confirmer »). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Action destructrice : bouton rouge. */
  danger?: boolean;
}

export interface ConfirmCheckbox {
  label: string;
  defaultChecked?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** La saisie, espaces retirés, ne peut pas être vide (défaut : vrai). */
  required?: boolean;
}

export interface AlertOptions {
  title?: string;
  message: ReactNode;
  danger?: boolean;
  closeLabel?: string;
}

export interface Dialogs {
  /** Confirmation avec une option à cocher : `null` si annulé, sinon l'état de la case. */
  confirm(opts: ConfirmOptions & { checkbox: ConfirmCheckbox }): Promise<{ checked: boolean } | null>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Saisie d'un texte : `null` si annulé, sinon la valeur (espaces de bord retirés). */
  prompt(opts: PromptOptions): Promise<string | null>;
  alert(opts: AlertOptions | string): Promise<void>;
  /** Affiche le message d'une erreur (à brancher sur un `.catch`). */
  showError(err: unknown): Promise<void>;
}

type Pending =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions & { checkbox?: ConfirmCheckbox }; resolve: (v: boolean | { checked: boolean } | null) => void }
  | { id: number; kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | { id: number; kind: 'alert'; opts: AlertOptions; resolve: () => void };

const DialogsContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('useDialogs doit être utilisé sous <DialogProvider>');
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const [closing, setClosing] = useState(false);
  const nextId = useRef(0);

  const enqueue = useCallback((p: Omit<Pending, 'id'>) => {
    setQueue((q) => [...q, { ...p, id: nextId.current++ } as Pending]);
  }, []);

  const api = useMemo<Dialogs>(() => {
    const confirm = ((opts: ConfirmOptions & { checkbox?: ConfirmCheckbox }) =>
      new Promise<boolean | { checked: boolean } | null>((resolve) => enqueue({ kind: 'confirm', opts, resolve }))) as Dialogs['confirm'];
    const prompt: Dialogs['prompt'] = (opts) => new Promise((resolve) => enqueue({ kind: 'prompt', opts, resolve }));
    const alert: Dialogs['alert'] = (opts) =>
      new Promise((resolve) => enqueue({ kind: 'alert', opts: typeof opts === 'string' ? { message: opts } : opts, resolve }));
    const showError: Dialogs['showError'] = (err) =>
      alert({ title: 'Erreur', danger: true, message: err instanceof Error ? err.message : String(err) });
    return { confirm, prompt, alert, showError };
  }, [enqueue]);

  const current = queue[0];
  // La réponse est transmise tout de suite ; la modale disparaît avec son animation, puis la suivante s'ouvre.
  const settle = () => setClosing(true);
  const onExited = () => {
    setQueue((q) => q.slice(1));
    setClosing(false);
  };

  return (
    <DialogsContext.Provider value={api}>
      {children}
      {current && <DialogModal key={current.id} pending={current} show={!closing} onSettled={settle} onExited={onExited} />}
    </DialogsContext.Provider>
  );
}

function DialogModal({ pending, show, onSettled, onExited }: { pending: Pending; show: boolean; onSettled: () => void; onExited: () => void }) {
  const [value, setValue] = useState(pending.kind === 'prompt' ? (pending.opts.defaultValue ?? '') : '');
  const [checked, setChecked] = useState(pending.kind === 'confirm' ? (pending.opts.checkbox?.defaultChecked ?? false) : false);
  const done = useRef(false);

  const finish = (answer: () => void) => {
    if (done.current) return;
    done.current = true;
    answer();
    onSettled();
  };
  const cancel = () =>
    finish(() => {
      if (pending.kind === 'confirm') pending.resolve(pending.opts.checkbox ? null : false);
      else if (pending.kind === 'prompt') pending.resolve(null);
      else pending.resolve();
    });
  const ok = () =>
    finish(() => {
      if (pending.kind === 'confirm') pending.resolve(pending.opts.checkbox ? { checked } : true);
      else if (pending.kind === 'prompt') pending.resolve(value.trim());
      else pending.resolve();
    });

  const promptInvalid = pending.kind === 'prompt' && (pending.opts.required ?? true) && !value.trim();
  const danger = pending.kind !== 'prompt' && !!pending.opts.danger;
  const title = pending.opts.title ?? (pending.kind === 'alert' ? (danger ? 'Erreur' : 'Information') : 'Confirmation');
  const message = pending.opts.message;

  return (
    <Modal show={show} onHide={cancel} onExited={onExited} centered className="app-dialog" backdropClassName="app-dialog-backdrop">
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (!promptInvalid) ok();
        }}
      >
        <Modal.Header closeButton={pending.kind !== 'alert'}>
          <Modal.Title className="h6 d-flex align-items-center gap-2">
            {danger && <i className={`bi ${pending.kind === 'alert' ? 'bi-exclamation-octagon' : 'bi-exclamation-triangle'} text-danger`} />}
            {title}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {message && <div className={pending.kind === 'prompt' ? 'mb-2 text-secondary' : 'app-dialog-message'}>{message}</div>}
          {pending.kind === 'prompt' && (
            <Form.Control autoFocus={canAutoFocus()} value={value} placeholder={pending.opts.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
          )}
          {pending.kind === 'confirm' && pending.opts.checkbox && (
            <Form.Check className="mt-3" id={`dialog-check-${pending.id}`} label={pending.opts.checkbox.label} checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          )}
        </Modal.Body>
        <Modal.Footer>
          {pending.kind === 'alert' ? (
            <Button type="submit" variant={danger ? 'danger' : 'primary'} autoFocus>
              {pending.opts.closeLabel ?? 'Fermer'}
            </Button>
          ) : (
            <>
              <Button variant="outline-secondary" onClick={cancel}>
                {(pending.kind === 'confirm' && pending.opts.cancelLabel) || 'Annuler'}
              </Button>
              <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={promptInvalid} autoFocus={pending.kind === 'confirm'}>
                {pending.opts.confirmLabel ?? (pending.kind === 'prompt' ? 'Valider' : 'Confirmer')}
              </Button>
            </>
          )}
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
