import { useApolloClient, useMutation } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { PROVIDE_SECRETS, type HumanRequest } from '../graphql/operations';
import { isSettledError } from '../lib/requestAnswer';
import Markdown from './Markdown';

/** Contenu d'une demande de secrets (backend/src/vault/secretRequests.ts, SecretsRequestPayload). */
export interface SecretsPayload {
  item: string;
  itemId: string | null;
  description: string | null;
  fields: { key: string; label: string; hint: string | null; multiline: boolean }[];
  projectId: string;
  personalUserId: string | null;
}

export const secretsPayload = (request: HumanRequest) => request.payload as unknown as SecretsPayload;

/** Résumé de la réponse (jamais de valeur : le nom de l'élément et les clés saisies). */
export function secretsAnswerText(r: Record<string, unknown>): string | null {
  if (typeof r.item !== 'string' || !Array.isArray(r.fields)) return null;
  const where = r.destination === 'project' ? 'coffre du projet' : r.destination === 'personal' ? 'coffre personnel' : 'élément mis à jour';
  return `secrets saisis dans « ${r.item} » (${(r.fields as string[]).join(', ')} ; ${where})`;
}

/** Un champ à saisir : masqué par défaut, sur plusieurs lignes (avec chargement d'un fichier) pour une clé ou un certificat. */
function SecretField({ field, value, onChange, disabled, autoFocus }: { field: SecretsPayload['fields'][number]; value: string; onChange: (v: string) => void; disabled: boolean; autoFocus: boolean }) {
  const [shown, setShown] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const id = `secret-${field.key}`;
  return (
    <Form.Group className="mb-3">
      <div className="d-flex align-items-center gap-2 mb-1">
        <Form.Label htmlFor={id} className="mb-0 small fw-semibold">
          {field.label} <span className="text-secondary font-monospace">({field.key})</span>
        </Form.Label>
        <span className="ms-auto d-flex gap-1 align-items-baseline">
          {field.multiline && (
            <>
              <input
                ref={file}
                type="file"
                className="d-none"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) onChange(await f.text());
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="link" className="p-0 small text-nowrap" disabled={disabled} onClick={() => file.current?.click()}>
                Charger un fichier
              </Button>
              <span className="text-secondary small">·</span>
            </>
          )}
          <Button size="sm" variant="link" className="p-0 small text-nowrap" onClick={() => setShown((s) => !s)}>
            {shown ? 'Masquer' : 'Afficher'}
          </Button>
        </span>
      </div>
      {field.multiline ? (
        <Form.Control
          id={id}
          as="textarea"
          rows={6}
          className="font-monospace small"
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // Masquage des caractères là où le navigateur le permet (Chrome, Safari, Firefox récents).
          style={shown ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)}
        />
      ) : (
        <Form.Control id={id} type={shown ? 'text' : 'password'} autoFocus={autoFocus} autoComplete="new-password" spellCheck={false} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.hint && <Form.Text className="text-secondary">{field.hint}</Form.Text>}
    </Form.Group>
  );
}

/**
 * Modale de saisie des secrets demandés par un agent : les valeurs partent directement au serveur (mutation
 * provideSecrets) qui les range, chiffrées, dans le coffre ; l'agent ne reçoit que le nom de l'élément et les clés.
 */
export function SecretsModal({ request, onClose }: { request: HumanRequest; onClose: () => void }) {
  const { user } = useAuth();
  const client = useApolloClient();
  const p = secretsPayload(request);
  const canPersonal = Boolean(user && p.personalUserId === user.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [destination, setDestination] = useState<'personal' | 'project'>(canPersonal ? 'personal' : 'project');
  const [requireApproval, setRequireApproval] = useState(true);
  const [provide, { loading }] = useMutation(PROVIDE_SECRETS);
  const [error, setError] = useState<string | null>(null);
  const missing = p.fields.filter((f) => !values[f.key]);

  // Les valeurs ne restent pas en mémoire de la page une fois la modale fermée.
  const close = () => {
    setValues({});
    onClose();
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (missing.length || loading) return;
    setError(null);
    try {
      await provide({
        variables: {
          requestId: request.id,
          input: { values: p.fields.map((f) => ({ key: f.key, value: values[f.key] })), ...(p.itemId ? {} : { destination, requireApproval }) },
        },
      });
      close();
    } catch (err) {
      if (isSettledError(err)) {
        void client.refetchQueries({ include: 'active' });
        close();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal show onHide={close} centered size="lg" backdrop="static">
      <Form onSubmit={submit} autoComplete="off">
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            <i className="bi bi-key me-2" />
            {request.session.name} demande {p.fields.length > 1 ? 'des secrets' : 'un secret'}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {request.message && <Markdown className="small mb-3" text={request.message} />}
          <p className="small text-secondary">
            Les valeurs sont chiffrées dans le coffre, dans l'élément <strong className="font-monospace">{p.item}</strong>
            {p.itemId ? ' (élément existant : ces champs seront remplacés, les autres gardés)' : ''}. L'agent ne les voit jamais : il s'en sert par les outils du coffre (fichier ou
            commande sur un serveur, champ de formulaire), chaque usage journalisé.
          </p>
          {p.fields.map((f, i) => (
            <SecretField key={f.key} field={f} value={values[f.key] ?? ''} disabled={loading} autoFocus={i === 0} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
          ))}
          {!p.itemId && (
            <>
              <Form.Group className="mb-2">
                <Form.Label className="small fw-semibold mb-1">Ranger dans</Form.Label>
                <Form.Check
                  type="radio"
                  id="secrets-dest-personal"
                  name="secrets-dest"
                  disabled={!canPersonal || loading}
                  checked={destination === 'personal'}
                  onChange={() => setDestination('personal')}
                  label={
                    <>
                      Mon coffre personnel, ouvert à mes sessions de « {request.session.project.name} »
                      {!canPersonal && <span className="text-secondary"> — indisponible : la session ne tourne pas avec vos droits</span>}
                    </>
                  }
                />
                <Form.Check
                  type="radio"
                  id="secrets-dest-project"
                  name="secrets-dest"
                  disabled={loading}
                  checked={destination === 'project'}
                  onChange={() => setDestination('project')}
                  label={<>Le coffre du projet, utilisable par tous ses agents (administrateurs du projet)</>}
                />
              </Form.Group>
              <Form.Check
                type="switch"
                id="secrets-approval"
                className="small"
                disabled={loading}
                checked={requireApproval}
                onChange={(e) => setRequireApproval(e.target.checked)}
                label="Demander mon accord à chaque usage par un agent"
              />
            </>
          )}
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2 small">
              {error}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={close} disabled={loading}>
            Plus tard
          </Button>
          <Button type="submit" variant="primary" disabled={loading || missing.length > 0}>
            {loading ? 'Enregistrement…' : 'Enregistrer dans le coffre'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Demandes déjà ouvertes d'office dans cette page : la modale ne revient pas d'elle-même après « Plus tard ». */
const autoOpened = new Set<string>();

/** Bouton qui ouvre la modale de saisie ; `autoOpen` l'ouvre une fois d'office (prompt de la page de session). */
export function SecretsButton({ request, autoOpen = false, className, disabled }: { request: HumanRequest; autoOpen?: boolean; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Pas d'ouverture d'office depuis une page du workbench gardée en arrière-plan (la modale s'afficherait par-dessus une autre).
    if (!autoOpen || autoOpened.has(request.id) || document.visibilityState === 'hidden' || !ref.current?.getClientRects().length) return;
    autoOpened.add(request.id);
    setOpen(true);
  }, [autoOpen, request.id]);
  return (
    <>
      <Button ref={ref} size="sm" variant="primary" className={className} disabled={disabled} onClick={() => setOpen(true)}>
        <i className="bi bi-key me-1" />
        Saisir {secretsPayload(request).fields.length > 1 ? 'les secrets' : 'le secret'}…
      </Button>
      {open && <SecretsModal request={request} onClose={() => setOpen(false)} />}
    </>
  );
}
