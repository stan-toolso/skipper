import { useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Spinner, Table } from 'react-bootstrap';
import { REFRESH_OPENCODE_MODELS, SET_OPENCODE_KEY_ITEM, UPDATE_OPENCODE_SETTINGS, type AppSettings } from '../../graphql/settings';
import VaultTokenPicker from './VaultTokenPicker';

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function ErrorLine({ error }: { error: Error | undefined }) {
  return error ? <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert> : null;
}

/** Modèle par défaut et budget des sessions OpenCode. */
function DefaultsCard({ settings }: { settings: AppSettings }) {
  const { opencode } = settings;
  const [model, setModel] = useState(opencode.defaultModel ?? '');
  const [budget, setBudget] = useState(opencode.sessionBudgetUsd?.toString() ?? '');
  const [update, { loading, error }] = useMutation(UPDATE_OPENCODE_SETTINGS);
  useEffect(() => {
    setModel(opencode.defaultModel ?? '');
    setBudget(opencode.sessionBudgetUsd?.toString() ?? '');
  }, [opencode.defaultModel, opencode.sessionBudgetUsd]);
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));
  const dirty = model.trim() !== (opencode.defaultModel ?? '') || num(budget) !== opencode.sessionBudgetUsd;
  const models = opencode.modelList?.models ?? [];
  return (
    <Card className="mb-4">
      <Card.Header>Sessions OpenCode</Card.Header>
      <Card.Body>
        <p className="text-secondary small">
          OpenCode tourne dans le conteneur du projet avec vos clés de fournisseurs (ci-dessous). Les sessions sans modèle précisé prennent le modèle par défaut.
        </p>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void update({ variables: { input: { defaultModel: model.trim() || null, sessionBudgetUsd: num(budget) } } }).catch(() => undefined);
          }}
        >
          <Row className="g-3 mb-3">
            <Col md={7}>
              <Form.Label className="small mb-1">Modèle par défaut</Form.Label>
              <Form.Control size="sm" list="opencode-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="fournisseur/modèle, ex. anthropic/claude-sonnet-5-5" spellCheck={false} />
              <datalist id="opencode-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Form.Text>Format « fournisseur/modèle ». La liste des modèles vient de la dernière actualisation ci-dessous.</Form.Text>
            </Col>
            <Col md={5}>
              <Form.Label className="small mb-1">Budget par session (USD)</Form.Label>
              <Form.Control size="sm" type="number" min={0} step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Aucun" />
              <Form.Text>La session est interrompue au-delà (coût estimé par OpenCode).</Form.Text>
            </Col>
          </Row>
          <Button size="sm" type="submit" disabled={loading || !dirty}>
            {loading ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
          <ErrorLine error={error} />
        </Form>
      </Card.Body>
    </Card>
  );
}

/** Une clé par fournisseur de modèles, prise dans le coffre (jetons applicatifs). */
function KeysCard({ settings }: { settings: AppSettings }) {
  const { opencode } = settings;
  const [setKey, { loading, error }] = useMutation(SET_OPENCODE_KEY_ITEM);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  return (
    <Card className="mb-4">
      <Card.Header>Clés des fournisseurs</Card.Header>
      <Card.Body>
        <p className="text-secondary small">
          Choisissez, pour chaque fournisseur, le jeton applicatif du coffre qui porte votre clé d'API. Les clés sont remises au serveur OpenCode de la session seul, jamais à l'agent. OpenCode Zen propose des modèles gratuits utilisables sans clé.
        </p>
        <Table size="sm" className="align-middle mb-0">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>Fournisseur</th>
              <th>Clé du coffre</th>
              <th style={{ width: '25%' }}>État</th>
            </tr>
          </thead>
          <tbody>
            {opencode.providers.map((p) => {
              const current = opencode.apiKeys.find((k) => k.provider === p.id) ?? null;
              return (
                <tr key={p.id}>
                  <td>
                    <strong>{p.label}</strong>
                    {p.keyPrefix && <div className="small text-secondary">clés « {p.keyPrefix}… »</div>}
                  </td>
                  <td>
                    <VaultTokenPicker
                      service={p.id}
                      size="sm"
                      value={current?.itemId ?? null}
                      disabled={loading && busyProvider === p.id}
                      onChange={(itemId) => {
                        setBusyProvider(p.id);
                        void setKey({ variables: { provider: p.id, itemId } }).catch(() => undefined).finally(() => setBusyProvider(null));
                      }}
                    />
                  </td>
                  <td className="small">
                    {!current ? (
                      <span className="text-secondary">aucune clé</span>
                    ) : current.usable ? (
                      <>
                        <Badge bg="success">prête</Badge>
                        {current.setAt && <div className="text-secondary">mise à jour le {fmtDate(current.setAt)}</div>}
                      </>
                    ) : (
                      <Badge bg="danger" title="L'élément du coffre n'est plus accessible : remplacez-le.">
                        inaccessible
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <ErrorLine error={error} />
      </Card.Body>
    </Card>
  );
}

/** Modèles offerts par OpenCode avec les clés de la personne : la liste est produite par `opencode models` dans l'image des runners. */
function ModelsCard({ settings }: { settings: AppSettings }) {
  const list = settings.opencode.modelList;
  const [refresh, { loading, error }] = useMutation(REFRESH_OPENCODE_MODELS);
  const [filter, setFilter] = useState('');
  const models = (list?.models ?? []).filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Card className="mb-4">
      <Card.Header>Modèles disponibles</Card.Header>
      <Card.Body>
        <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
          <Button size="sm" variant="outline-secondary" disabled={loading} onClick={() => void refresh().catch(() => undefined)}>
            {loading ? <><Spinner size="sm" className="me-1" /> Interrogation d'OpenCode (peut prendre une minute)…</> : <><i className="bi bi-arrow-repeat me-1" /> Actualiser la liste des modèles</>}
          </Button>
          {list && (
            <span className="small text-secondary">
              Dernière liste le {fmtDate(list.listedAt)} : {list.ok ? `${list.models.length} modèle${list.models.length > 1 ? 's' : ''}` : 'échec'}
            </span>
          )}
        </div>
        {list && !list.ok && <Alert variant="danger" className="py-2">{list.error ?? 'OpenCode n’a pas pu lister les modèles.'}</Alert>}
        <ErrorLine error={error} />
        {list?.ok && list.models.length > 0 && (
          <>
            <Form.Control size="sm" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} className="my-2" style={{ maxWidth: 320 }} />
            <div className="small font-monospace" style={{ maxHeight: 260, overflow: 'auto', columnWidth: 280 }}>
              {models.map((m) => (
                <div key={m}>{m}</div>
              ))}
              {models.length === 0 && <span className="text-secondary">Aucun modèle ne correspond.</span>}
            </div>
          </>
        )}
        {!list && <div className="small text-secondary">Pas encore de liste : actualisez après avoir choisi vos clés. L'image des runners doit contenir OpenCode.</div>}
      </Card.Body>
    </Card>
  );
}

/** Onglet OpenCode des Paramètres : modèle et budget par défaut, clés des fournisseurs, modèles disponibles. */
export default function OpencodeSection({ settings }: { settings: AppSettings }) {
  return (
    <>
      <DefaultsCard settings={settings} />
      <KeysCard settings={settings} />
      <ModelsCard settings={settings} />
    </>
  );
}
