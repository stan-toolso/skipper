import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { APPLY_SESSION_CLEANUP, UPDATE_SESSION, type Session } from '../graphql/operations';

type ContextAction = '' | 'compact' | 'reset';

const formatTokens = (n: number) => `${Math.round(n / 1000)} k tokens`;

/** Réglages d'une session : nom et nettoyage automatique de l'historique (transcript et conversation de l'agent). */
export default function SessionSettingsModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const cleanup = session.cleanup;
  const [name, setName] = useState(session.name);
  const [retentionOn, setRetentionOn] = useState(cleanup.retentionDays !== null);
  const [retentionDays, setRetentionDays] = useState(String(cleanup.retentionDays ?? 30));
  const [contextAction, setContextAction] = useState<ContextAction>(cleanup.contextAction ?? '');
  const [contextMaxK, setContextMaxK] = useState(String(Math.round((cleanup.contextMaxTokens ?? 100_000) / 1000)));

  const [save, { loading: saving, error: saveError }] = useMutation(UPDATE_SESSION, { onCompleted: onClose });
  const [applyNow, { loading: applying, error: applyError }] = useMutation(APPLY_SESSION_CLEANUP);
  const busy = saving || applying;
  const error = saveError ?? applyError;

  const input = () => ({
    name: name.trim() !== session.name ? name.trim() : undefined,
    cleanup: {
      retentionDays: retentionOn ? Number(retentionDays) : null,
      contextAction: contextAction || null,
      contextMaxTokens: contextAction ? Number(contextMaxK) * 1000 : null,
    },
  });
  const valid = name.trim().length > 0 && (!retentionOn || Number(retentionDays) >= 1) && (!contextAction || Number(contextMaxK) >= 10);
  const hasCleanup = cleanup.retentionDays !== null || cleanup.contextAction !== null;

  return (
    <Modal show onHide={onClose} centered size="lg" backdrop={busy ? 'static' : true}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save({ variables: { id: session.id, input: input() } });
        }}
      >
        <Modal.Header closeButton={!busy}>
          <Modal.Title className="h5 mb-0">
            <i className="bi bi-gear me-2" />
            Réglages de la session
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label>Nom</Form.Label>
            <Form.Control value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Form.Group>

          <h6>Nettoyage automatique</h6>
          <p className="text-secondary small">
            Une session relancée régulièrement accumule un historique sans fin. Le nettoyage s'applique avant chaque exécution planifiée, par un
            balayage toutes les heures pour la purge, ou tout de suite avec le bouton ci-dessous.
          </p>
          <Form.Check
            type="switch"
            id="cleanup-retention"
            className="mb-2"
            label="Purger le transcript affiché : supprimer les événements plus vieux que…"
            checked={retentionOn}
            onChange={(e) => setRetentionOn(e.target.checked)}
          />
          {retentionOn && (
            <div className="d-flex align-items-center gap-2 mb-3 ms-4">
              <Form.Control type="number" min={1} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} style={{ width: '6rem' }} />
              <span>jours</span>
              <Form.Text className="ms-2">La consommation enregistrée n'est pas touchée.</Form.Text>
            </div>
          )}

          <Form.Group className="mb-2">
            <Form.Label className="mb-1">Conversation de l'agent (ce dont le modèle se souvient)</Form.Label>
            <Form.Select value={contextAction} onChange={(e) => setContextAction(e.target.value as ContextAction)}>
              <option value="">Ne rien faire</option>
              <option value="compact">Compacter la conversation quand le contexte dépasse un seuil</option>
              <option value="reset">Repartir d'une conversation neuve quand le contexte dépasse un seuil</option>
            </Form.Select>
          </Form.Group>
          {contextAction && (
            <div className="d-flex align-items-center gap-2 mb-2 ms-4">
              <span>Seuil :</span>
              <Form.Control type="number" min={10} step={10} value={contextMaxK} onChange={(e) => setContextMaxK(e.target.value)} style={{ width: '6rem' }} />
              <span>k tokens</span>
            </div>
          )}
          <Form.Text className="d-block mb-3">
            {contextAction === 'compact' && "Compacter envoie /compact à l'agent : il résume la conversation et repart de ce résumé (comme Claude Code)."}
            {contextAction === 'reset' && "Repartir de zéro oublie la conversation du modèle ; le transcript affiché est conservé, l'agent ne se souvient plus des tours précédents."}
            {' '}
            Contexte actuel : {session.contextTokens === null ? 'inconnu (aucun tour depuis cette version)' : formatTokens(session.contextTokens)}.
          </Form.Text>

          {error && (
            <Alert variant="danger" className="mb-0">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer className="justify-content-between">
          <div>
            {hasCleanup && (
              <Button variant="outline-secondary" disabled={busy} title="Purge le transcript et, si le contexte dépasse le seuil, compacte ou remet à zéro la conversation" onClick={() => void applyNow({ variables: { id: session.id } })}>
                <i className="bi bi-stars me-1" />
                {applying ? 'Nettoyage…' : 'Nettoyer maintenant'}
              </Button>
            )}
          </div>
          <div className="d-flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              Enregistrer
            </Button>
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
