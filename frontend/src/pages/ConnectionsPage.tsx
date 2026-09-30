import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Form, InputGroup, Modal, Row, Spinner } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import {
  CREATE_CONNECTION,
  DELETE_CONNECTION,
  FORGET_CONNECTION_HOST_KEY,
  PROJECT_CONNECTIONS,
  REGENERATE_CONNECTION_KEY,
  TEST_CONNECTION,
  UPDATE_CONNECTION,
  type Connection,
  type ConnectionExposure,
  type ConnectionFieldInput,
  type ConnectionInput,
  type ConnectionKind,
} from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';

const kindLabels: Record<ConnectionKind, { label: string; newLabel: string; icon: string }> = {
  ssh: { label: 'Serveur SSH', newLabel: 'Nouveau serveur SSH', icon: 'bi-hdd-network' },
  postgres: { label: 'Base PostgreSQL', newLabel: 'Nouvelle base PostgreSQL', icon: 'bi-database' },
  website: { label: 'Site web', newLabel: 'Nouveau site web', icon: 'bi-globe' },
};

const exposureOptions: { value: ConnectionExposure; label: string; hint: string }[] = [
  { value: 'mcp', label: 'Outils (recommandé)', hint: "L'agent passe par les outils du serveur : il ne voit jamais les identifiants, chaque usage est journalisé." },
  { value: 'direct', label: 'Shell de la session', hint: 'ssh, scp ou psql fonctionnent directement dans le shell de l\'agent. La clé SSH reste dans un agent SSH éphémère ; un mot de passe de base devient lisible.' },
  { value: 'both', label: 'Les deux', hint: 'Outils et shell.' },
];

/** Pour un site web, « outils » désigne le navigateur headless et « shell » des variables d'environnement. */
const websiteExposureOptions: { value: ConnectionExposure; label: string; hint: string }[] = [
  { value: 'mcp', label: 'Navigateur (recommandé)', hint: "Les champs secrets sont fournis au navigateur headless du projet : l'agent tape le nom de la variable dans le formulaire, le navigateur saisit la valeur à sa place et la masque dans ses réponses." },
  { value: 'direct', label: 'Shell de la session', hint: "Tous les champs deviennent des variables d'environnement du shell de l'agent (pour curl, des scripts). L'agent peut alors lire les valeurs." },
  { value: 'both', label: 'Les deux', hint: 'Navigateur et shell.' },
];

/** Ligne du tableau de champs d'un site web, telle que saisie. */
interface FieldRow {
  key: string;
  label: string;
  secret: boolean;
  value: string;
  /** Un secret déjà enregistré : valeur vide = inchangée. */
  stored: boolean;
}

const defaultWebsiteFields = (): FieldRow[] => [
  { key: 'username', label: 'Identifiant', secret: false, value: '', stored: false },
  { key: 'password', label: 'Mot de passe', secret: true, value: '', stored: false },
];

/** Nom de variable tel que le backend le calcule (aperçu dans le formulaire). */
const variablePreview = (connectionName: string, key: string) => `${connectionName || 'nom'}_${key || 'cle'}`.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

interface FormState {
  name: string;
  description: string;
  host: string;
  port: string;
  username: string;
  database: string;
  ssl: boolean;
  viaConnectionId: string;
  exposure: ConnectionExposure;
  readOnly: boolean;
  requireApproval: boolean;
  commandAllowlist: string;
  privateKey: string;
  password: string;
  url: string;
  fields: FieldRow[];
}

const emptyForm = (kind: ConnectionKind): FormState => ({
  name: '',
  description: '',
  host: '',
  port: kind === 'ssh' ? '22' : '5432',
  username: '',
  database: '',
  ssl: false,
  viaConnectionId: '',
  exposure: 'mcp',
  readOnly: true,
  requireApproval: true,
  commandAllowlist: '',
  privateKey: '',
  password: '',
  url: '',
  fields: kind === 'website' ? defaultWebsiteFields() : [],
});

const formFrom = (c: Connection): FormState => ({
  name: c.name,
  description: c.description,
  host: c.host ?? '',
  port: String(c.port ?? ''),
  username: c.username ?? '',
  database: c.database ?? '',
  ssl: Boolean(c.ssl),
  viaConnectionId: c.viaConnection?.id ?? '',
  exposure: c.exposure,
  readOnly: c.readOnly,
  requireApproval: c.requireApproval,
  commandAllowlist: c.commandAllowlist.join('\n'),
  privateKey: '',
  password: '',
  url: c.url ?? '',
  fields: c.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.value ?? '', stored: f.secret })),
});

/** Éditeur des champs d'un site web : autant de lignes qu'on veut, chacune publique ou secrète. */
function FieldsEditor({ connectionName, fields, onChange }: { connectionName: string; fields: FieldRow[]; onChange: (rows: FieldRow[]) => void }) {
  const update = (i: number, patch: Partial<FieldRow>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const move = (i: number, d: -1 | 1) => {
    const rows = [...fields];
    const [row] = rows.splice(i, 1);
    rows.splice(i + d, 0, row);
    onChange(rows);
  };
  return (
    <div>
      <Form.Label>Champs</Form.Label>
      {fields.length === 0 && <div className="text-secondary small mb-2">Aucun champ. Ajoutez au moins un identifiant et un mot de passe.</div>}
      {fields.map((f, i) => (
        <Row key={i} className="g-2 align-items-start mb-2">
          <Col md={3}>
            <Form.Control size="sm" value={f.key} onChange={(e) => update(i, { key: e.target.value.toLowerCase() })} placeholder="clé (ex. username)" pattern="[a-z][a-z0-9_]*" required />
            <Form.Text className="font-monospace" style={{ fontSize: '0.7rem' }}>
              {variablePreview(connectionName, f.key)}
            </Form.Text>
          </Col>
          <Col md={3}>
            <Form.Control size="sm" value={f.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Libellé (ex. Adresse e-mail)" />
          </Col>
          <Col md={4}>
            <Form.Control
              size="sm"
              type={f.secret ? 'password' : 'text'}
              value={f.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={f.secret ? (f.stored ? '(inchangé)' : 'valeur secrète') : 'valeur'}
              autoComplete="new-password"
              required={!f.secret || !f.stored}
            />
          </Col>
          <Col md={2} className="d-flex align-items-center gap-1 pt-1">
            <Form.Check id={`field-secret-${i}`} className="small text-nowrap" label="secret" checked={f.secret} onChange={(e) => update(i, { secret: e.target.checked, stored: e.target.checked ? f.stored : false })} />
            <Button variant="link" size="sm" className="p-0 ms-auto text-secondary" disabled={i === 0} onClick={() => move(i, -1)} title="Monter">
              <i className="bi bi-arrow-up" />
            </Button>
            <Button variant="link" size="sm" className="p-0 text-secondary" disabled={i === fields.length - 1} onClick={() => move(i, 1)} title="Descendre">
              <i className="bi bi-arrow-down" />
            </Button>
            <Button variant="link" size="sm" className="p-0 text-danger" onClick={() => remove(i)} title="Supprimer le champ">
              <i className="bi bi-x-lg" />
            </Button>
          </Col>
        </Row>
      ))}
      <Button variant="outline-secondary" size="sm" onClick={() => onChange([...fields, { key: '', label: '', secret: false, value: '', stored: false }])}>
        <i className="bi bi-plus-lg me-1" /> Ajouter un champ
      </Button>
      <Form.Text className="d-block mt-1">
        Un champ <strong>secret</strong> est chiffré, jamais réaffiché, et saisi par le navigateur à la place de l'agent sous le nom de variable indiqué. Un champ public (identifiant, URL d'un formulaire, code d'organisation…) est
        communiqué tel quel à l'agent.
      </Form.Text>
    </div>
  );
}

/** Fenêtre de création / modification d'une connexion. */
function ConnectionModal({ projectId, kind, connection, sshConnections, onClose, onCreated }: { projectId: string; kind: ConnectionKind; connection: Connection | null; sshConnections: Connection[]; onClose: () => void; onCreated: (c: Connection) => void }) {
  const [form, setForm] = useState<FormState>(connection ? formFrom(connection) : emptyForm(kind));
  const [importKey, setImportKey] = useState(false);
  const [create, { loading: creating, error: createError }] = useMutation<{ createConnection: Connection }>(CREATE_CONNECTION, { refetchQueries: ['ProjectConnections'] });
  const [update, { loading: updating, error: updateError }] = useMutation(UPDATE_CONNECTION, { refetchQueries: ['ProjectConnections'], onCompleted: onClose });
  const error = createError ?? updateError;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const text = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => set(k, e.target.value as never);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const input: ConnectionInput = {
      name: form.name,
      description: form.description,
      exposure: form.exposure,
      requireApproval: form.requireApproval,
    };
    if (kind === 'website') {
      input.url = form.url;
      // Secret enregistré laissé vide : inchangé (null) ; sinon la valeur saisie.
      input.fields = form.fields.map((f): ConnectionFieldInput => ({ key: f.key, label: f.label, secret: f.secret, value: f.secret && f.stored && !f.value ? null : f.value }));
    } else {
      input.host = form.host;
      input.port = Number(form.port) || null;
      input.username = form.username;
    }
    if (kind === 'ssh') {
      input.commandAllowlist = form.commandAllowlist.split('\n').map((s) => s.trim()).filter(Boolean);
      if (form.privateKey.trim()) input.privateKey = form.privateKey;
    } else if (kind === 'postgres') {
      input.database = form.database;
      input.ssl = form.ssl;
      input.viaConnectionId = form.viaConnectionId || null;
      input.readOnly = form.readOnly;
      if (form.password || !connection) input.password = form.password;
    }
    if (connection) update({ variables: { id: connection.id, input } });
    else create({ variables: { projectId, input: { ...input, kind } } }).then((res) => res.data && onCreated(res.data.createConnection));
  };

  return (
    <Modal show onHide={onClose} size="lg">
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h5">
            <i className={`bi ${kindLabels[kind].icon} me-2`} />
            {connection ? `Modifier « ${connection.name} »` : kindLabels[kind].newLabel}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Row className="g-3">
            <Col md={4}>
              <Form.Group>
                <Form.Label>Nom</Form.Label>
                <Form.Control value={form.name} onChange={text('name')} placeholder={kind === 'ssh' ? 'prod' : kind === 'postgres' ? 'rds-prod' : 'admin-site'} required pattern="[a-z0-9][a-z0-9_-]*" />
                <Form.Text>Court, en minuscules : c'est ainsi que les agents la désignent.</Form.Text>
              </Form.Group>
            </Col>
            <Col md={8}>
              <Form.Group>
                <Form.Label>Description</Form.Label>
                <Form.Control value={form.description} onChange={text('description')} placeholder="Ce que c'est, à quoi ça sert, ce qu'il ne faut pas y faire" />
              </Form.Group>
            </Col>
            {kind === 'website' ? (
              <>
                <Col md={12}>
                  <Form.Group>
                    <Form.Label>Adresse</Form.Label>
                    <Form.Control type="url" value={form.url} onChange={text('url')} placeholder="https://admin.example.com/login" required />
                    <Form.Text>Le site ou, mieux, sa page de connexion : c'est là que l'agent ouvrira le navigateur.</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={12}>
                  <FieldsEditor connectionName={form.name} fields={form.fields} onChange={(rows) => set('fields', rows)} />
                </Col>
              </>
            ) : (
              <>
                <Col md={6}>
                  <Form.Group>
                    <Form.Label>Hôte</Form.Label>
                    <Form.Control value={form.host} onChange={text('host')} placeholder={kind === 'ssh' ? 'serveur.example.com' : 'base.xxxx.eu-west-3.rds.amazonaws.com'} required />
                  </Form.Group>
                </Col>
                <Col md={2}>
                  <Form.Group>
                    <Form.Label>Port</Form.Label>
                    <Form.Control type="number" min={1} max={65535} value={form.port} onChange={text('port')} />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group>
                    <Form.Label>Utilisateur</Form.Label>
                    <Form.Control value={form.username} onChange={text('username')} placeholder={kind === 'ssh' ? 'deploy' : 'readonly'} required />
                  </Form.Group>
                </Col>
              </>
            )}

            {kind === 'postgres' && (
              <>
                <Col md={4}>
                  <Form.Group>
                    <Form.Label>Base de données</Form.Label>
                    <Form.Control value={form.database} onChange={text('database')} required />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group>
                    <Form.Label>Mot de passe</Form.Label>
                    <Form.Control type="password" value={form.password} onChange={text('password')} placeholder={connection?.hasSecret ? '(inchangé)' : ''} autoComplete="new-password" />
                    <Form.Text>Stocké chiffré. Utilisez de préférence un rôle dédié aux agents.</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group>
                    <Form.Label>Tunnel SSH</Form.Label>
                    <Form.Select value={form.viaConnectionId} onChange={text('viaConnectionId')}>
                      <option value="">Aucun (accès direct à l'hôte)</option>
                      {sshConnections.map((s) => (
                        <option key={s.id} value={s.id}>
                          via {s.name} ({s.username}@{s.host})
                        </option>
                      ))}
                    </Form.Select>
                    <Form.Text>Pour une base accessible seulement depuis un serveur.</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={12} className="d-flex gap-4">
                  <Form.Check id="ssl" label="Connexion TLS (sslmode=require)" checked={form.ssl} onChange={(e) => set('ssl', e.target.checked)} />
                  <Form.Check id="readOnly" label="Lecture seule (transactions READ ONLY)" checked={form.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />
                </Col>
              </>
            )}

            {kind === 'ssh' && (
              <>
                <Col md={12}>
                  <Form.Group>
                    <Form.Label>Commandes autorisées par les outils</Form.Label>
                    <Form.Control as="textarea" rows={2} value={form.commandAllowlist} onChange={text('commandAllowlist')} placeholder={'Un préfixe par ligne, ex.\npm2\ntail -n\nsystemctl status'} />
                    <Form.Text>Vide : toute commande (soumise à approbation si elle est demandée). Sinon, seules les commandes commençant par l'un de ces préfixes sont exécutées par l'outil ssh_run.</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={12}>
                  <Button variant="link" size="sm" className="p-0" onClick={() => setImportKey((v) => !v)}>
                    {importKey ? 'Laisser Skipper générer la clé' : connection ? 'Remplacer la clé par une clé privée existante…' : 'Importer une clé privée existante au lieu d\'en générer une…'}
                  </Button>
                  <Collapse in={importKey}>
                    <div>
                      <Form.Control as="textarea" rows={4} className="font-monospace small mt-2" value={form.privateKey} onChange={text('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                      <Form.Text>Déconseillé : préférez une clé dédiée générée ici, que vous autorisez sur le serveur. La clé importée est stockée chiffrée et n'est jamais réaffichée.</Form.Text>
                    </div>
                  </Collapse>
                </Col>
              </>
            )}

            <Col md={12}>
              <hr className="my-1" />
              <Form.Label className="fw-semibold">Accès des agents</Form.Label>
              {(kind === 'website' ? websiteExposureOptions : exposureOptions).map((o) => (
                <Form.Check key={o.value} type="radio" id={`exposure-${o.value}`} name="exposure" className="mb-1" checked={form.exposure === o.value} onChange={() => set('exposure', o.value)} label={<span>{o.label} <span className="text-secondary small">— {o.hint}</span></span>} />
              ))}
              {kind !== 'website' && (
                <Form.Check id="requireApproval" className="mt-2" checked={form.requireApproval} onChange={(e) => set('requireApproval', e.target.checked)} label={<span>Me demander avant chaque appel d'outil <span className="text-secondary small">— sinon les outils s'exécutent sans confirmation (le shell dépend du mode d'autorisation de la session).</span></span>} />
              )}
              {kind === 'website' && <Form.Text className="d-block mt-2">Les actions du navigateur (saisie, clic) passent par les demandes d'autorisation de la session ; vous y verrez le nom de la variable, pas sa valeur. Le navigateur headless doit être activé dans les réglages du projet.</Form.Text>}
            </Col>
          </Row>
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={creating || updating}>
            {creating || updating ? 'Enregistrement…' : connection ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Clé publique à installer sur le serveur, avec copie et instructions. */
function PublicKeyBlock({ connection }: { connection: Connection }) {
  const [copied, setCopied] = useState(false);
  if (!connection.publicKey) return null;
  const copy = () => navigator.clipboard?.writeText(connection.publicKey ?? '').then(() => setCopied(true));
  return (
    <div className="mt-2">
      <div className="small text-secondary mb-1">
        Clé publique à ajouter dans <code>~/.ssh/authorized_keys</code> de <code>{connection.username}</code> sur <code>{connection.host}</code> :
      </div>
      <InputGroup size="sm">
        <Form.Control readOnly value={connection.publicKey} className="font-monospace" onFocus={(e) => e.currentTarget.select()} />
        <Button variant="outline-secondary" onClick={copy}>
          {copied ? 'Copiée' : 'Copier'}
        </Button>
      </InputGroup>
      <div className="small text-secondary mt-1">
        Pour restreindre ce que la clé peut faire côté serveur, préfixez la ligne par <code>restrict,command="…"</code>.
      </div>
    </div>
  );
}

function ConnectionCard({ connection: c, sshConnections, projectId, canEdit, browserEnabled }: { connection: Connection; sshConnections: Connection[]; projectId: string; canEdit: boolean; browserEnabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [test, { loading: testing, data: testData, error: testError }] = useMutation<{ testConnection: { ok: boolean; error: string | null; detail: string | null } }>(TEST_CONNECTION, { refetchQueries: ['ProjectConnections'] });
  const [remove, { error: removeError }] = useMutation(DELETE_CONNECTION, { refetchQueries: ['ProjectConnections'] });
  const [regenerate, { loading: regenerating }] = useMutation(REGENERATE_CONNECTION_KEY, { refetchQueries: ['ProjectConnections'] });
  const { confirm } = useDialogs();
  const [forgetHostKey] = useMutation(FORGET_CONNECTION_HOST_KEY, { refetchQueries: ['ProjectConnections'] });
  const kind = kindLabels[c.kind];
  const lastTest = testData?.testConnection;
  return (
    <Card className="mb-3">
      <Card.Header className="d-flex align-items-center gap-2 flex-wrap">
        <i className={`bi ${kind.icon}`} />
        <strong>{c.name}</strong>
        <span className="text-secondary small">
          {kind.label} ·{' '}
          {c.kind === 'website' ? (
            <a href={c.url ?? '#'} target="_blank" rel="noreferrer" className="text-secondary">
              {c.url}
            </a>
          ) : (
            <>
              {c.username}@{c.host}
              {c.port !== (c.kind === 'ssh' ? 22 : 5432) ? `:${c.port}` : ''}
              {c.database ? `/${c.database}` : ''}
              {c.viaConnection ? ` · via ${c.viaConnection.name}` : ''}
            </>
          )}
        </span>
        <span className="ms-auto d-flex gap-1">
          <Badge bg="light" text="dark">
            {(c.kind === 'website' ? websiteExposureOptions : exposureOptions).find((o) => o.value === c.exposure)?.label.replace(' (recommandé)', '')}
          </Badge>
          {c.kind === 'postgres' && <Badge bg={c.readOnly ? 'success' : 'warning'} text={c.readOnly ? undefined : 'dark'}>{c.readOnly ? 'lecture seule' : 'écriture'}</Badge>}
          {c.kind !== 'website' && <Badge bg={c.requireApproval ? 'primary' : 'secondary'}>{c.requireApproval ? 'avec approbation' : 'sans approbation'}</Badge>}
          {c.lastTestOk === true && <Badge bg="success">testée</Badge>}
          {c.lastTestOk === false && <Badge bg="danger">en échec</Badge>}
        </span>
      </Card.Header>
      <Card.Body className="small">
        {c.description && <p className="mb-2">{c.description}</p>}
        <dl className="row mb-0">
          {c.kind === 'ssh' && c.commandAllowlist.length > 0 && (
            <>
              <dt className="col-sm-3">Commandes autorisées</dt>
              <dd className="col-sm-9">
                {c.commandAllowlist.map((p) => (
                  <code key={p} className="me-2">
                    {p}
                  </code>
                ))}
              </dd>
            </>
          )}
          {c.kind === 'postgres' && (
            <>
              <dt className="col-sm-3">Mot de passe</dt>
              <dd className="col-sm-9">{c.hasSecret ? 'enregistré (chiffré)' : <span className="text-warning">aucun</span>}</dd>
            </>
          )}
          {c.kind === 'website' && (
            <>
              <dt className="col-sm-3">Champs</dt>
              <dd className="col-sm-9">
                {c.fields.length === 0 && <span className="text-warning">aucun</span>}
                {c.fields.map((f) => (
                  <div key={f.key}>
                    {f.label} <code>{f.variable}</code> {f.secret ? <span className="text-secondary">secret, enregistré (chiffré)</span> : <span>= {f.value}</span>}
                  </div>
                ))}
              </dd>
            </>
          )}
          {c.kind === 'ssh' && (
            <>
              <dt className="col-sm-3">Clé d'hôte</dt>
              <dd className="col-sm-9">
                {c.hostFingerprint ? (
                  <>
                    <code>{c.hostFingerprint}</code> <span className="text-secondary">mémorisée le {fmtDate(c.hostKeySeenAt)}</span>{' '}
                    {canEdit && (
                      <Button variant="link" size="sm" className="p-0 align-baseline" onClick={async () => (await confirm({ title: "Oublier la clé d'hôte", message: "Oublier la clé d'hôte mémorisée ? Elle sera réapprise à la prochaine connexion.", confirmLabel: 'Oublier' })) && forgetHostKey({ variables: { id: c.id } })}>
                        oublier
                      </Button>
                    )}
                  </>
                ) : (
                  <span className="text-secondary">pas encore mémorisée : elle le sera à la première connexion réussie (testez la connexion).</span>
                )}
              </dd>
            </>
          )}
          <dt className="col-sm-3">Dernier test</dt>
          <dd className="col-sm-9">
            {c.lastTestAt ? (
              <>
                {c.lastTestOk ? <span className="text-success">réussi</span> : <span className="text-danger">échoué</span>} le {fmtDate(c.lastTestAt)}
                {c.lastTestError && <div className="text-danger">{c.lastTestError}</div>}
              </>
            ) : (
              <span className="text-secondary">jamais</span>
            )}
            {lastTest?.ok && lastTest.detail && <div className="text-success">{lastTest.detail}</div>}
          </dd>
          <dt className="col-sm-3">Pour les agents</dt>
          <dd className="col-sm-9">
            {c.exposure !== 'direct' && (
              <div>
                {c.kind === 'website' ? (
                  <>
                    Navigateur : <code>browser_type</code> / <code>browser_fill_form</code> avec le nom de variable d'un secret
                    {!browserEnabled && <span className="text-warning"> — navigateur headless désactivé sur ce projet</span>}
                  </>
                ) : (
                  <>
                    Outils : <code>{c.kind === 'ssh' ? 'ssh_run, ssh_upload, ssh_download' : 'sql_query, sql_schema'}</code>
                  </>
                )}
              </div>
            )}
            {c.exposure !== 'mcp' && (
              <div>
                Shell : <code>{c.kind === 'ssh' ? `ssh ${c.name}` : c.kind === 'postgres' ? `psql service=${c.name}` : c.fields.map((f) => `$${f.variable}`).join(', ') || 'aucune variable'}</code>
              </div>
            )}
          </dd>
        </dl>
        {c.kind === 'ssh' && <PublicKeyBlock connection={c} />}
        {(testError || removeError) && <Alert variant="danger" className="mt-2 mb-0 py-2">{(testError ?? removeError)?.message}</Alert>}
      </Card.Body>
      {canEdit && (
      <Card.Footer className="d-flex gap-2 flex-wrap">
        <Button size="sm" variant="outline-primary" disabled={testing} onClick={() => test({ variables: { id: c.id } })}>
          {testing ? 'Test en cours…' : c.kind === 'website' ? 'Tester l\'adresse' : 'Tester la connexion'}
        </Button>
        <Button size="sm" variant="outline-secondary" onClick={() => setEditing(true)}>
          Modifier
        </Button>
        {c.kind === 'ssh' && (
          <Button size="sm" variant="outline-secondary" disabled={regenerating} onClick={async () => (await confirm({ title: 'Régénérer la clé SSH', message: "Générer une nouvelle paire de clés ? L'ancienne clé publique cessera de fonctionner : il faudra installer la nouvelle sur le serveur.", confirmLabel: 'Régénérer', danger: true })) && regenerate({ variables: { id: c.id } })}>
            Régénérer la clé
          </Button>
        )}
        <Button size="sm" variant="outline-danger" className="ms-auto" onClick={async () => (await confirm({ title: 'Supprimer la connexion', message: `Supprimer la connexion « ${c.name} » ? Les agents ne pourront plus l'utiliser.`, confirmLabel: 'Supprimer', danger: true })) && remove({ variables: { id: c.id } })}>
          Supprimer
        </Button>
      </Card.Footer>
      )}
      {editing && <ConnectionModal projectId={projectId} kind={c.kind} connection={c} sshConnections={sshConnections.filter((s) => s.id !== c.id)} onClose={() => setEditing(false)} onCreated={() => undefined} />}
    </Card>
  );
}

export default function ConnectionsPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ project: { id: string; name: string; slug: string; runnerConfig: { browser?: boolean } | null; myRole: string; connections: Connection[] } | null }>(PROJECT_CONNECTIONS, { variables: { id }, pollInterval: 10_000 });
  const [creating, setCreating] = useState<ConnectionKind | null>(null);
  const [justCreated, setJustCreated] = useState<Connection | null>(null);
  useTabTitle(data?.project ? `Connexions · ${data.project.name}` : 'Connexions');

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const project = data?.project;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const sshConnections = project.connections.filter((c) => c.kind === 'ssh');
  const canEdit = project.myRole === 'ADMIN';
  const browserEnabled = Boolean(project.runnerConfig?.browser);

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <Link to={`/projects/${project.id}`} className="small">
            ← {project.name}
          </Link>
          <h1 className="h3 mb-0">Connexions</h1>
        </div>
        {canEdit && (
          <div className="d-flex gap-2">
            <Button size="sm" onClick={() => setCreating('ssh')}>
              <i className="bi bi-hdd-network me-1" /> Serveur SSH
            </Button>
            <Button size="sm" onClick={() => setCreating('postgres')}>
              <i className="bi bi-database me-1" /> Base PostgreSQL
            </Button>
            <Button size="sm" onClick={() => setCreating('website')}>
              <i className="bi bi-globe me-1" /> Site web
            </Button>
          </div>
        )}
      </div>

      <p className="text-secondary small" style={{ maxWidth: 900 }}>
        Systèmes externes que les agents de ce projet peuvent utiliser. Les identifiants sont chiffrés en base et, en mode « outils », ne sont jamais transmis à l'agent : le serveur exécute pour lui et
        journalise chaque accès dans la session. Pour un serveur SSH, Skipper génère une clé dédiée que vous autorisez sur la machine ; pour une base, préférez un rôle en lecture seule. Pour un site web, les
        champs secrets sont saisis par le navigateur headless à la place de l'agent.
      </p>

      {!browserEnabled && project.connections.some((c) => c.kind === 'website' && c.exposure !== 'direct') && (
        <Alert variant="warning" className="py-2 small">
          Le navigateur headless n'est pas activé sur ce projet : les agents ne pourront pas se connecter aux sites web. Activez-le dans les réglages du projet.
        </Alert>
      )}

      {project.connections.some((c) => c.exposure !== 'mcp') && (
        <Alert variant="warning" className="py-2 small">
          Les agents s'exécutent dans le conteneur du projet : l'accès depuis le shell (ssh, psql, variables d'environnement des sites) n'y est pas disponible, seuls les outils et le navigateur le sont.
        </Alert>
      )}

      {justCreated?.kind === 'ssh' && (
        <Alert variant="success" dismissible onClose={() => setJustCreated(null)}>
          <strong>Connexion « {justCreated.name} » créée.</strong> Installez sa clé publique sur le serveur, puis testez la connexion. La clé privée est restée chiffrée sur le serveur Skipper.
        </Alert>
      )}

      {project.connections.length === 0 && <Alert variant="light">Aucune connexion pour ce projet.</Alert>}
      {project.connections.map((c) => (
        <ConnectionCard key={c.id} connection={c} sshConnections={sshConnections} projectId={project.id} canEdit={canEdit} browserEnabled={browserEnabled} />
      ))}

      {creating && (
        <ConnectionModal
          projectId={project.id}
          kind={creating}
          connection={null}
          sshConnections={sshConnections}
          onClose={() => setCreating(null)}
          onCreated={(c) => {
            setCreating(null);
            setJustCreated(c);
          }}
        />
      )}
    </>
  );
}
