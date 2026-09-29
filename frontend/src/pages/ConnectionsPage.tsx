import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Form, InputGroup, Modal, Row, Spinner } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
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
  type ConnectionInput,
  type ConnectionKind,
} from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';

const kindLabels: Record<ConnectionKind, { label: string; newLabel: string; icon: string }> = {
  ssh: { label: 'Serveur SSH', newLabel: 'Nouveau serveur SSH', icon: 'bi-hdd-network' },
  postgres: { label: 'Base PostgreSQL', newLabel: 'Nouvelle base PostgreSQL', icon: 'bi-database' },
};

const exposureOptions: { value: ConnectionExposure; label: string; hint: string }[] = [
  { value: 'mcp', label: 'Outils (recommandé)', hint: "L'agent passe par les outils du serveur : il ne voit jamais les identifiants, chaque usage est journalisé." },
  { value: 'direct', label: 'Shell de la session', hint: 'ssh, scp ou psql fonctionnent directement dans le shell de l\'agent. La clé SSH reste dans un agent SSH éphémère ; un mot de passe de base devient lisible.' },
  { value: 'both', label: 'Les deux', hint: 'Outils et shell.' },
];

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
});

const formFrom = (c: Connection): FormState => ({
  name: c.name,
  description: c.description,
  host: c.host,
  port: String(c.port),
  username: c.username,
  database: c.database ?? '',
  ssl: Boolean(c.ssl),
  viaConnectionId: c.viaConnection?.id ?? '',
  exposure: c.exposure,
  readOnly: c.readOnly,
  requireApproval: c.requireApproval,
  commandAllowlist: c.commandAllowlist.join('\n'),
  privateKey: '',
  password: '',
});

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
      host: form.host,
      port: Number(form.port) || null,
      username: form.username,
      exposure: form.exposure,
      requireApproval: form.requireApproval,
    };
    if (kind === 'ssh') {
      input.commandAllowlist = form.commandAllowlist.split('\n').map((s) => s.trim()).filter(Boolean);
      if (form.privateKey.trim()) input.privateKey = form.privateKey;
    } else {
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
                <Form.Control value={form.name} onChange={text('name')} placeholder={kind === 'ssh' ? 'prod' : 'rds-prod'} required pattern="[a-z0-9][a-z0-9_-]*" />
                <Form.Text>Court, en minuscules : c'est ainsi que les agents la désignent.</Form.Text>
              </Form.Group>
            </Col>
            <Col md={8}>
              <Form.Group>
                <Form.Label>Description</Form.Label>
                <Form.Control value={form.description} onChange={text('description')} placeholder="Ce que c'est, à quoi ça sert, ce qu'il ne faut pas y faire" />
              </Form.Group>
            </Col>
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
              {exposureOptions.map((o) => (
                <Form.Check key={o.value} type="radio" id={`exposure-${o.value}`} name="exposure" className="mb-1" checked={form.exposure === o.value} onChange={() => set('exposure', o.value)} label={<span>{o.label} <span className="text-secondary small">— {o.hint}</span></span>} />
              ))}
              <Form.Check id="requireApproval" className="mt-2" checked={form.requireApproval} onChange={(e) => set('requireApproval', e.target.checked)} label={<span>Me demander avant chaque appel d'outil <span className="text-secondary small">— sinon les outils s'exécutent sans confirmation (le shell dépend du mode d'autorisation de la session).</span></span>} />
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

function ConnectionCard({ connection: c, sshConnections, projectId }: { connection: Connection; sshConnections: Connection[]; projectId: string }) {
  const [editing, setEditing] = useState(false);
  const [test, { loading: testing, data: testData, error: testError }] = useMutation<{ testConnection: { ok: boolean; error: string | null; detail: string | null } }>(TEST_CONNECTION, { refetchQueries: ['ProjectConnections'] });
  const [remove, { error: removeError }] = useMutation(DELETE_CONNECTION, { refetchQueries: ['ProjectConnections'] });
  const [regenerate, { loading: regenerating }] = useMutation(REGENERATE_CONNECTION_KEY, { refetchQueries: ['ProjectConnections'] });
  const [forgetHostKey] = useMutation(FORGET_CONNECTION_HOST_KEY, { refetchQueries: ['ProjectConnections'] });
  const kind = kindLabels[c.kind];
  const lastTest = testData?.testConnection;
  return (
    <Card className="mb-3">
      <Card.Header className="d-flex align-items-center gap-2 flex-wrap">
        <i className={`bi ${kind.icon}`} />
        <strong>{c.name}</strong>
        <span className="text-secondary small">
          {kind.label} · {c.username}@{c.host}
          {c.port !== (c.kind === 'ssh' ? 22 : 5432) ? `:${c.port}` : ''}
          {c.database ? `/${c.database}` : ''}
          {c.viaConnection ? ` · via ${c.viaConnection.name}` : ''}
        </span>
        <span className="ms-auto d-flex gap-1">
          <Badge bg="light" text="dark">
            {exposureOptions.find((o) => o.value === c.exposure)?.label.replace(' (recommandé)', '')}
          </Badge>
          {c.kind === 'postgres' && <Badge bg={c.readOnly ? 'success' : 'warning'} text={c.readOnly ? undefined : 'dark'}>{c.readOnly ? 'lecture seule' : 'écriture'}</Badge>}
          <Badge bg={c.requireApproval ? 'primary' : 'secondary'}>{c.requireApproval ? 'avec approbation' : 'sans approbation'}</Badge>
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
          {c.kind === 'ssh' && (
            <>
              <dt className="col-sm-3">Clé d'hôte</dt>
              <dd className="col-sm-9">
                {c.hostFingerprint ? (
                  <>
                    <code>{c.hostFingerprint}</code> <span className="text-secondary">mémorisée le {fmtDate(c.hostKeySeenAt)}</span>{' '}
                    <Button variant="link" size="sm" className="p-0 align-baseline" onClick={() => window.confirm('Oublier la clé d\'hôte mémorisée ? Elle sera réapprise à la prochaine connexion.') && forgetHostKey({ variables: { id: c.id } })}>
                      oublier
                    </Button>
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
                Outils : <code>{c.kind === 'ssh' ? 'ssh_run, ssh_upload, ssh_download' : 'sql_query, sql_schema'}</code>
              </div>
            )}
            {c.exposure !== 'mcp' && (
              <div>
                Shell : <code>{c.kind === 'ssh' ? `ssh ${c.name}` : `psql service=${c.name}`}</code>
              </div>
            )}
          </dd>
        </dl>
        {c.kind === 'ssh' && <PublicKeyBlock connection={c} />}
        {(testError || removeError) && <Alert variant="danger" className="mt-2 mb-0 py-2">{(testError ?? removeError)?.message}</Alert>}
      </Card.Body>
      <Card.Footer className="d-flex gap-2 flex-wrap">
        <Button size="sm" variant="outline-primary" disabled={testing} onClick={() => test({ variables: { id: c.id } })}>
          {testing ? 'Test en cours…' : 'Tester la connexion'}
        </Button>
        <Button size="sm" variant="outline-secondary" onClick={() => setEditing(true)}>
          Modifier
        </Button>
        {c.kind === 'ssh' && (
          <Button size="sm" variant="outline-secondary" disabled={regenerating} onClick={() => window.confirm('Générer une nouvelle paire de clés ? L\'ancienne clé publique cessera de fonctionner : il faudra installer la nouvelle sur le serveur.') && regenerate({ variables: { id: c.id } })}>
            Régénérer la clé
          </Button>
        )}
        <Button size="sm" variant="outline-danger" className="ms-auto" onClick={() => window.confirm(`Supprimer la connexion « ${c.name} » ?`) && remove({ variables: { id: c.id } })}>
          Supprimer
        </Button>
      </Card.Footer>
      {editing && <ConnectionModal projectId={projectId} kind={c.kind} connection={c} sshConnections={sshConnections.filter((s) => s.id !== c.id)} onClose={() => setEditing(false)} onCreated={() => undefined} />}
    </Card>
  );
}

export default function ConnectionsPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ project: { id: string; name: string; slug: string; connections: Connection[] } | null }>(PROJECT_CONNECTIONS, { variables: { id }, pollInterval: 10_000 });
  const [creating, setCreating] = useState<ConnectionKind | null>(null);
  const [justCreated, setJustCreated] = useState<Connection | null>(null);
  useTabTitle(data?.project ? `Connexions · ${data.project.name}` : 'Connexions');

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const project = data?.project;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const sshConnections = project.connections.filter((c) => c.kind === 'ssh');

  return (
    <>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <Link to={`/projects/${project.id}`} className="small">
            ← {project.name}
          </Link>
          <h1 className="h3 mb-0">Connexions</h1>
        </div>
        <div className="d-flex gap-2">
          <Button size="sm" onClick={() => setCreating('ssh')}>
            <i className="bi bi-hdd-network me-1" /> Serveur SSH
          </Button>
          <Button size="sm" onClick={() => setCreating('postgres')}>
            <i className="bi bi-database me-1" /> Base PostgreSQL
          </Button>
        </div>
      </div>

      <p className="text-secondary small" style={{ maxWidth: 900 }}>
        Systèmes externes que les agents de ce projet peuvent utiliser. Les identifiants sont chiffrés en base et, en mode « outils », ne sont jamais transmis à l'agent : le serveur exécute pour lui et
        journalise chaque accès dans la session. Pour un serveur SSH, Skipper génère une clé dédiée que vous autorisez sur la machine ; pour une base, préférez un rôle en lecture seule.
      </p>

      {justCreated?.kind === 'ssh' && (
        <Alert variant="success" dismissible onClose={() => setJustCreated(null)}>
          <strong>Connexion « {justCreated.name} » créée.</strong> Installez sa clé publique sur le serveur, puis testez la connexion. La clé privée est restée chiffrée sur le serveur Skipper.
        </Alert>
      )}

      {project.connections.length === 0 && <Alert variant="light">Aucune connexion pour ce projet.</Alert>}
      {project.connections.map((c) => (
        <ConnectionCard key={c.id} connection={c} sshConnections={sshConnections} projectId={project.id} />
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
