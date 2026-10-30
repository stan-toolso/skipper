import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { googleConnectUrl } from '../../apollo';
import { CREATE_VAULT_ITEM, SKIPPER_KINDS, UPDATE_VAULT_ITEM, VAULT_TOKEN_SERVICES, type AwsAuth, type GoogleAccess, type VaultApiAuth, type VaultAwsInput, type VaultFieldInput, type VaultItem, type VaultItemInput, type VaultItemKind, type VaultScalewayInput, type VaultTokenService } from '../../graphql/vault';
import { AGENT_KINDS, DEFAULT_PORTS, FIELD_KEY_PATTERN, isOauthToken, isSkipperKind, KINDS, NAME_PATTERN, variableOf } from './kinds';

/** Coffre destinataire d'un nouvel élément : personnel (projectId null) ou projet administré. */
export interface VaultOwnerChoice {
  projectId: string | null;
  label: string;
}

export interface TunnelCandidate {
  id: string;
  name: string;
  host: string | null;
  username: string | null;
  ownerProjectId: string | null;
  ownerUserId: string | null;
}

interface FieldRow {
  key: string;
  label: string;
  value: string;
  secret: boolean;
  /** Secret déjà enregistré (valeur non obligatoire). */
  stored: boolean;
}

interface Props {
  item?: VaultItem | null;
  owners: VaultOwnerChoice[];
  /** Propriétaire imposé (page projet) ; sinon le premier de `owners`. */
  initialOwner?: string | null;
  tunnels: TunnelCandidate[];
  googleAvailable: boolean;
  onClose: () => void;
  onSaved: (item: VaultItem) => void;
}

const ACCESS_OPTIONS: { value: GoogleAccess; label: string }[] = [
  { value: 'NONE', label: 'Aucun accès' },
  { value: 'READ', label: 'Lecture (sans confirmation)' },
  { value: 'WRITE', label: 'Lecture et écriture (chaque écriture demande votre accord)' },
];

const emptyFields = (kind: VaultItemKind): FieldRow[] =>
  kind === 'website'
    ? [
        { key: 'username', label: 'Identifiant', value: '', secret: false, stored: false },
        { key: 'password', label: 'Mot de passe', value: '', secret: true, stored: false },
      ]
    : kind === 'secret'
      ? [{ key: 'value', label: 'Valeur', value: '', secret: true, stored: false }]
      : [];

/** Création ou modification d'un élément du coffre ; les secrets ne sont envoyés que s'ils sont saisis. */
export default function VaultItemEditor({ item, owners, initialOwner, tunnels, googleAvailable, onClose, onSaved }: Props) {
  const editing = Boolean(item);
  const [ownerKey, setOwnerKey] = useState<string>(initialOwner ?? owners[0]?.projectId ?? '');
  const [kind, setKind] = useState<VaultItemKind>(item?.kind ?? 'ssh');
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [host, setHost] = useState(item?.host ?? '');
  const [port, setPort] = useState(item?.port ? String(item.port) : '');
  const [username, setUsername] = useState(item?.username ?? '');
  const [database, setDatabase] = useState(item?.database ?? '');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(item?.ssl ?? true);
  const [sslCa, setSslCa] = useState(item?.sslCa ?? '');
  const [viaItemId, setViaItemId] = useState(item?.via?.id ?? '');
  const [readOnly, setReadOnly] = useState(item?.readOnly ?? true);
  const [requireApproval, setRequireApproval] = useState(item?.requireApproval ?? true);
  const [allowlist, setAllowlist] = useState(item?.commandAllowlist.join('\n') ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [showKeyImport, setShowKeyImport] = useState(false);
  const [url, setUrl] = useState(item?.url ?? '');
  const [authScheme, setAuthScheme] = useState<VaultApiAuth>(item?.authScheme ?? 'bearer');
  const [authName, setAuthName] = useState(item?.authName ?? '');
  const [token, setToken] = useState('');
  const [fields, setFields] = useState<FieldRow[]>(() => (item ? item.fields.map((f) => ({ key: f.key, label: f.label, value: f.value ?? '', secret: f.secret, stored: f.secret })) : emptyFields('ssh')));
  const [expiresAt, setExpiresAt] = useState(item?.expiresAt ? item.expiresAt.slice(0, 10) : '');
  const [service, setService] = useState(item?.token?.service ?? '');
  const [publicKey, setPublicKey] = useState(item?.langfusePublicKey ?? '');
  const [awsAuth, setAwsAuth] = useState<AwsAuth>(item?.aws?.auth ?? 'sso');
  const [region, setRegion] = useState(item?.aws?.region ?? 'eu-west-3');
  const [startUrl, setStartUrl] = useState(item?.aws?.startUrl ?? '');
  const [ssoRegion, setSsoRegion] = useState(item?.aws?.ssoRegion ?? 'eu-west-1');
  const [accessKeyId, setAccessKeyId] = useState(item?.aws?.accessKeyId ?? '');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [roleArn, setRoleArn] = useState(item?.aws?.roleArn ?? '');
  const [scwAccessKey, setScwAccessKey] = useState(item?.scaleway?.accessKey ?? '');
  const [scwSecretKey, setScwSecretKey] = useState('');
  const [scwOrganizationId, setScwOrganizationId] = useState(item?.scaleway?.organizationId ?? '');
  const [scwProjectId, setScwProjectId] = useState(item?.scaleway?.projectId ?? '');
  const [scwRegion, setScwRegion] = useState(item?.scaleway?.region ?? 'fr-par');
  const [scwZone, setScwZone] = useState(item?.scaleway?.zone ?? 'fr-par-1');
  const { data: servicesData } = useQuery<{ vaultTokenServices: VaultTokenService[] }>(VAULT_TOKEN_SERVICES, { skip: kind !== 'token' });
  const services = servicesData?.vaultTokenServices ?? [];
  const serviceInfo = services.find((t) => t.id === service);
  const oauthToken = Boolean(item && isOauthToken(item));
  const [gmail, setGmail] = useState<GoogleAccess>(item?.google?.gmailAccess ?? 'READ');
  const [drive, setDrive] = useState<GoogleAccess>(item?.google?.driveAccess ?? 'NONE');
  const [error, setError] = useState<string | null>(null);

  const [create, { loading: creating }] = useMutation<{ createVaultItem: VaultItem }>(CREATE_VAULT_ITEM, { refetchQueries: ['VaultItems', 'VaultProject', 'Sidebar'] });
  const [update, { loading: updating }] = useMutation<{ updateVaultItem: VaultItem }>(UPDATE_VAULT_ITEM, { refetchQueries: ['VaultItems', 'VaultProject'] });
  const saving = creating || updating;

  // Changer de type réinitialise le formulaire, sauf le nom et la description.
  const changeKind = (next: VaultItemKind) => {
    setKind(next);
    setFields(emptyFields(next));
    setPort('');
    setReadOnly(true);
    setRequireApproval(true);
    setError(null);
  };
  useEffect(() => {
    if (!editing && kind === 'website' && fields.length === 0) setFields(emptyFields('website'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const ownerProjectId = ownerKey || null;
  const tunnelOptions = useMemo(
    () => tunnels.filter((t) => t.id !== item?.id && (ownerProjectId ? t.ownerProjectId === ownerProjectId : t.ownerProjectId === null)),
    [tunnels, item?.id, ownerProjectId],
  );

  const updateField = (i: number, patch: Partial<FieldRow>) => setFields((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moveField = (i: number, delta: number) =>
    setFields((rows) => {
      const j = i + delta;
      if (j < 0 || j >= rows.length) return rows;
      const next = [...rows];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const googleSubmit = () => {
    if (gmail === 'NONE' && drive === 'NONE') return;
    window.location.href = googleConnectUrl(ownerProjectId, gmail.toLowerCase(), drive.toLowerCase(), item?.id ?? null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanName = name.trim().toLowerCase();
    if (!NAME_PATTERN.test(cleanName)) return setError('Nom invalide : minuscules, chiffres, tirets et tirets bas, 40 caractères au plus (ex. « prod », « rds-prod »).');
    const input: VaultItemInput = { name: cleanName, description: description.trim(), expiresAt: expiresAt || null };
    if (!editing) input.kind = kind;
    if (kind !== 'google') {
      if (kind === 'ssh' || kind === 'postgres' || kind === 'api' || kind === 'aws' || kind === 'scaleway') input.requireApproval = requireApproval;
    } else {
      input.requireApproval = requireApproval;
    }
    if (kind === 'ssh' || kind === 'postgres') {
      input.host = host.trim();
      input.username = username.trim();
      const p = port.trim() ? Number(port) : DEFAULT_PORTS[kind];
      if (!Number.isInteger(p) || !p || p < 1 || p > 65535) return setError('Port invalide');
      input.port = p;
    }
    if (kind === 'ssh') {
      input.commandAllowlist = allowlist
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (privateKey.trim()) input.privateKey = privateKey.trim();
    }
    if (kind === 'postgres') {
      input.database = database.trim();
      input.ssl = ssl;
      input.sslCa = ssl ? sslCa : '';
      input.viaItemId = viaItemId || null;
      input.readOnly = readOnly;
      if (!editing || password) input.password = password;
    }
    if (kind === 'api') {
      input.url = url.trim();
      input.authScheme = authScheme;
      input.authName = authScheme === 'header' || authScheme === 'query' ? authName.trim() : null;
      input.username = authScheme === 'basic' ? username.trim() : null;
      input.readOnly = readOnly;
      if (token) input.token = token;
      else if (!editing) return setError(authScheme === 'basic' ? 'Le mot de passe est obligatoire' : 'Le jeton est obligatoire');
    }
    if (kind === 'token' && !oauthToken) {
      if (!editing) {
        if (!service) return setError('Choisissez le service du jeton.');
        input.service = service;
      }
      if (token) input.token = token;
      else if (!editing) return setError('Le jeton est obligatoire');
    }
    if (kind === 'litellm') {
      input.url = url.trim();
      if (token) input.token = token;
      else if (!editing) return setError("La clé d'API est obligatoire");
    }
    if (kind === 'langfuse') {
      input.url = url.trim();
      input.publicKey = publicKey.trim();
      if (password) input.password = password;
      else if (!editing) return setError('La clé secrète est obligatoire');
    }
    if (kind === 'aws') {
      const a: VaultAwsInput = { region: region.trim() };
      if (!editing) a.auth = awsAuth;
      if (awsAuth === 'sso') {
        a.startUrl = startUrl.trim();
        a.ssoRegion = ssoRegion.trim();
      } else {
        a.accessKeyId = accessKeyId.trim();
        a.roleArn = roleArn.trim();
        if (secretAccessKey) a.secretAccessKey = secretAccessKey;
        else if (!editing) return setError("La clé d'accès secrète est obligatoire");
      }
      input.aws = a;
      input.readOnly = readOnly;
      input.commandAllowlist = allowlist
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (kind === 'scaleway') {
      const s: VaultScalewayInput = { accessKey: scwAccessKey.trim(), organizationId: scwOrganizationId.trim(), projectId: scwProjectId.trim(), region: scwRegion.trim(), zone: scwZone.trim() };
      if (scwSecretKey) s.secretKey = scwSecretKey;
      else if (!editing) return setError('La clé secrète est obligatoire');
      input.scaleway = s;
      input.readOnly = readOnly;
      input.commandAllowlist = allowlist
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (kind === 'website' || kind === 'secret') {
      if (kind === 'website') input.url = url.trim();
      const list: VaultFieldInput[] = [];
      for (const f of fields) {
        const key = f.key.trim().toLowerCase();
        if (!FIELD_KEY_PATTERN.test(key)) return setError(`Clé de champ invalide « ${f.key} » : minuscules, chiffres et tirets bas, 40 caractères au plus.`);
        if (f.secret && !f.value && !f.stored) return setError(`Le champ secret « ${f.label || key} » n'a pas de valeur.`);
        list.push({ key, label: f.label.trim() || key, secret: f.secret, value: f.secret && !f.value ? null : f.value });
      }
      if (kind === 'secret' && list.length === 0) return setError('Ajoutez au moins un champ.');
      input.fields = list;
    }
    try {
      if (editing && item) {
        const res = await update({ variables: { id: item.id, input } });
        if (res.data) onSaved(res.data.updateVaultItem);
      } else {
        const res = await create({ variables: { projectId: ownerProjectId, input } });
        if (res.data) onSaved(res.data.createVaultItem);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const kindInfo = KINDS[kind];
  const isGoogle = kind === 'google';
  return (
    <Modal show onHide={onClose} size="lg" centered backdrop="static">
      <Form onSubmit={isGoogle ? (e) => (e.preventDefault(), googleSubmit()) : submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h5">{editing ? `Modifier « ${item?.name} »` : 'Nouvel élément du coffre'}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="vault-editor">
          {!editing && owners.length > 1 && (
            <Form.Group className="mb-3">
              <Form.Label>Coffre</Form.Label>
              <Form.Select value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)}>
                {owners.map((o) => (
                  <option key={o.projectId ?? 'me'} value={o.projectId ?? ''}>
                    {o.label}
                  </option>
                ))}
              </Form.Select>
              <Form.Text className="text-secondary">Un élément personnel vous appartient et se partage ou s'ouvre à des projets ; un élément de projet est géré par ses administrateurs et utilisable par tous ses agents.</Form.Text>
            </Form.Group>
          )}
          {!editing && (
            <>
              <div className="vault-kinds mb-3">
                {AGENT_KINDS.filter((k) => k !== 'google' || googleAvailable).map((k) => (
                  <button type="button" key={k} className={`vault-kind${kind === k ? ' active' : ''}`} onClick={() => changeKind(k)}>
                    <i className={`bi ${KINDS[k].icon}`} />
                    <span className="vault-kind-label">{KINDS[k].label}</span>
                    <span className="vault-kind-hint">{KINDS[k].hint}</span>
                  </button>
                ))}
              </div>
              <div className="vault-kinds-heading text-secondary small mb-1">Pour Skipper (jamais offerts aux agents)</div>
              <div className="vault-kinds mb-3">
                {SKIPPER_KINDS.map((k) => (
                  <button type="button" key={k} className={`vault-kind${kind === k ? ' active' : ''}`} onClick={() => changeKind(k)}>
                    <i className={`bi ${KINDS[k].icon}`} />
                    <span className="vault-kind-label">{KINDS[k].label}</span>
                    <span className="vault-kind-hint">{KINDS[k].hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {editing && (
            <div className="text-secondary small mb-3">
              <i className={`bi ${kindInfo.icon} me-1`} />
              {kindInfo.label}
            </div>
          )}

          {isGoogle ? (
            <>
              <Row className="g-3">
                <Col md={6}>
                  <Form.Group>
                    <Form.Label>Gmail</Form.Label>
                    <Form.Select value={gmail} onChange={(e) => setGmail(e.target.value as GoogleAccess)}>
                      {ACCESS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group>
                    <Form.Label>Drive</Form.Label>
                    <Form.Select value={drive} onChange={(e) => setDrive(e.target.value as GoogleAccess)}>
                      {ACCESS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
              </Row>
              <p className="text-secondary small mt-3 mb-0">
                Vous serez redirigé vers Google pour accorder ces accès. Les lectures sont libres ; les écritures (envoi d'un e-mail, création d'un fichier…) demandent votre accord à chaque fois. Le jeton reste sur le serveur.
                {editing && ' Sur Google, vous pouvez aussi choisir un autre compte : il remplacera celui-ci.'}
              </p>
            </>
          ) : (
            <>
              <Row className="g-3">
                <Col md={5}>
                  <Form.Group>
                    <Form.Label>Nom</Form.Label>
                    <Form.Control value={name} onChange={(e) => setName(e.target.value)} placeholder={kindInfo.placeholder} pattern="[a-z0-9][a-z0-9_\-]*" required autoFocus />
                    <Form.Text className="text-secondary">{isSkipperKind(kind) ? "Court, en minuscules : c'est ainsi qu'il apparaît dans vos réglages." : "Court, en minuscules : c'est ainsi que les agents le désignent."}</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={7}>
                  <Form.Group>
                    <Form.Label>Description</Form.Label>
                    <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi sert cet élément, pour les humains et les agents" />
                  </Form.Group>
                </Col>
              </Row>

              {(kind === 'ssh' || kind === 'postgres') && (
                <Row className="g-3 mt-0">
                  <Col md={6}>
                    <Form.Group>
                      <Form.Label>Hôte</Form.Label>
                      <Form.Control value={host} onChange={(e) => setHost(e.target.value)} required placeholder="serveur.exemple.fr" />
                    </Form.Group>
                  </Col>
                  <Col md={2}>
                    <Form.Group>
                      <Form.Label>Port</Form.Label>
                      <Form.Control type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} placeholder={String(DEFAULT_PORTS[kind])} />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Utilisateur</Form.Label>
                      <Form.Control value={username} onChange={(e) => setUsername(e.target.value)} required />
                    </Form.Group>
                  </Col>
                </Row>
              )}

              {kind === 'postgres' && (
                <>
                  <Row className="g-3 mt-0">
                    <Col md={4}>
                      <Form.Group>
                        <Form.Label>Base de données</Form.Label>
                        <Form.Control value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="toutes les bases" />
                        <Form.Text className="text-secondary">Vide : le serveur entier, l’agent nomme la base à chaque appel (postgres par défaut).</Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={4}>
                      <Form.Group>
                        <Form.Label>Mot de passe</Form.Label>
                        <Form.Control type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={item?.hasSecret ? '(inchangé)' : ''} />
                        <Form.Text className="text-secondary">Utilisez de préférence un rôle dédié aux agents.</Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={4}>
                      <Form.Group>
                        <Form.Label>Tunnel SSH</Form.Label>
                        <Form.Select value={viaItemId} onChange={(e) => setViaItemId(e.target.value)}>
                          <option value="">Aucun (accès direct à l'hôte)</option>
                          {tunnelOptions.map((t) => (
                            <option key={t.id} value={t.id}>
                              via {t.name} ({t.username}@{t.host})
                            </option>
                          ))}
                        </Form.Select>
                        <Form.Text className="text-secondary">Un serveur SSH du même coffre.</Form.Text>
                      </Form.Group>
                    </Col>
                  </Row>
                  <div className="d-flex gap-4 mt-3">
                    <Form.Check type="checkbox" id="vault-ssl" label="Connexion TLS" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
                    <Form.Check type="checkbox" id="vault-ro" label="Lecture seule (transactions READ ONLY)" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                  </div>
                  {ssl && (
                    <Form.Group className="mt-2">
                      <Form.Label>Certificat de l'autorité du serveur (optionnel)</Form.Label>
                      <Form.Control as="textarea" rows={3} className="font-monospace small" value={sslCa} onChange={(e) => setSslCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
                      <Form.Text className="text-secondary">Pour Cloud SQL et les serveurs à certificat privé : le certificat est vérifié, pas le nom d'hôte.</Form.Text>
                    </Form.Group>
                  )}
                </>
              )}

              {kind === 'ssh' && (
                <>
                  <Form.Group className="mt-3">
                    <Form.Label>Commandes autorisées par les outils (optionnel)</Form.Label>
                    <Form.Control as="textarea" rows={3} className="font-monospace small" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder={'systemctl status\njournalctl -u'} />
                    <Form.Text className="text-secondary">Un préfixe par ligne ; vide = tout. Avec une liste, les enchaînements (;, |, &&, redirections) et les transferts de fichiers sont refusés.</Form.Text>
                  </Form.Group>
                  <div className="mt-2">
                    <Button variant="link" size="sm" className="p-0" onClick={() => setShowKeyImport((v) => !v)}>
                      {editing ? 'Remplacer la clé par une clé privée existante…' : 'Importer une clé privée existante plutôt que d’en générer une…'}
                    </Button>
                    {showKeyImport && (
                      <Form.Group className="mt-2">
                        <Form.Control as="textarea" rows={4} className="font-monospace small" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                        <Form.Text className="text-secondary">Déconseillé : une clé générée ici ne quitte jamais le serveur. La clé importée doit être sans phrase de passe.</Form.Text>
                      </Form.Group>
                    )}
                  </div>
                </>
              )}

              {kind === 'api' && (
                <>
                  <Form.Group className="mt-3">
                    <Form.Label>Adresse de base</Form.Label>
                    <Form.Control type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://api.exemple.com/v1" />
                    <Form.Text className="text-secondary">Les agents n'appellent que des chemins sous cette adresse ; les adresses internes sont refusées.</Form.Text>
                  </Form.Group>
                  <Row className="g-3 mt-0">
                    <Col md={4}>
                      <Form.Group>
                        <Form.Label>Authentification</Form.Label>
                        <Form.Select value={authScheme} onChange={(e) => setAuthScheme(e.target.value as VaultApiAuth)}>
                          <option value="bearer">En-tête Bearer</option>
                          <option value="header">En-tête personnalisé</option>
                          <option value="basic">Basic (utilisateur + mot de passe)</option>
                          <option value="query">Paramètre de requête</option>
                        </Form.Select>
                      </Form.Group>
                    </Col>
                    {(authScheme === 'header' || authScheme === 'query') && (
                      <Col md={4}>
                        <Form.Group>
                          <Form.Label>{authScheme === 'header' ? "Nom de l'en-tête" : 'Nom du paramètre'}</Form.Label>
                          <Form.Control value={authName} onChange={(e) => setAuthName(e.target.value)} required placeholder={authScheme === 'header' ? 'X-Api-Key' : 'api_key'} />
                        </Form.Group>
                      </Col>
                    )}
                    {authScheme === 'basic' && (
                      <Col md={4}>
                        <Form.Group>
                          <Form.Label>Utilisateur</Form.Label>
                          <Form.Control value={username} onChange={(e) => setUsername(e.target.value)} required />
                        </Form.Group>
                      </Col>
                    )}
                    <Col md={4}>
                      <Form.Group>
                        <Form.Label>{authScheme === 'basic' ? 'Mot de passe' : 'Jeton'}</Form.Label>
                        <Form.Control type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={item?.hasSecret ? '(inchangé)' : ''} required={!editing} />
                      </Form.Group>
                    </Col>
                  </Row>
                  <Form.Check className="mt-3" type="checkbox" id="vault-api-ro" label="Lecture seule (GET, HEAD et OPTIONS seulement)" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                </>
              )}

              {kind === 'token' && (
                <>
                  {oauthToken ? (
                    <Alert variant="info" className="mt-3 mb-0 py-2 small">
                      Ce jeton a été obtenu par une connexion depuis Skipper ({item?.token?.serviceLabel}
                      {item?.token?.account ? `, compte ${item.token.account}` : ''}) : il est renouvelé par Skipper et ne se modifie pas ici. Seuls le nom, la description et le rappel de rotation changent ; pour le remplacer, reconnectez le compte dans les Paramètres.
                    </Alert>
                  ) : (
                    <Row className="g-3 mt-0">
                      <Col md={5}>
                        <Form.Group>
                          <Form.Label>Service</Form.Label>
                          <Form.Select value={service} onChange={(e) => setService(e.target.value)} required disabled={editing}>
                            <option value="">Choisir…</option>
                            {(editing && item?.token ? [{ id: item.token.service, label: item.token.serviceLabel, prefix: null, opencode: false }] : services).map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))}
                          </Form.Select>
                          <Form.Text className="text-secondary">{editing ? 'Le service d’un jeton ne change pas : créez un autre élément.' : 'Fixé à la création.'}</Form.Text>
                        </Form.Group>
                      </Col>
                      <Col md={7}>
                        <Form.Group>
                          <Form.Label>Jeton</Form.Label>
                          <Form.Control type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={item?.hasSecret ? '(inchangé)' : (serviceInfo?.prefix ? `${serviceInfo.prefix}…` : '')} required={!editing} />
                          <Form.Text className="text-secondary">
                            {serviceInfo?.prefix ? `Commence par « ${serviceInfo.prefix} ». ` : ''}Chiffré, utilisé par Skipper pour votre compte seulement ; jamais offert aux agents.
                          </Form.Text>
                        </Form.Group>
                      </Col>
                    </Row>
                  )}
                </>
              )}

              {kind === 'litellm' && (
                <Row className="g-3 mt-0">
                  <Col md={7}>
                    <Form.Group>
                      <Form.Label>Adresse du proxy</Form.Label>
                      <Form.Control type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://litellm.exemple.fr" />
                      <Form.Text className="text-secondary">URL de base (sans /v1) ; les adresses internes sont refusées.</Form.Text>
                    </Form.Group>
                  </Col>
                  <Col md={5}>
                    <Form.Group>
                      <Form.Label>Clé d'API</Form.Label>
                      <Form.Control type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={item?.hasSecret ? '(inchangé)' : 'sk-…'} required={!editing} />
                    </Form.Group>
                  </Col>
                </Row>
              )}

              {kind === 'langfuse' && (
                <>
                  <Form.Group className="mt-3">
                    <Form.Label>Hôte Langfuse</Form.Label>
                    <Form.Control type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://cloud.langfuse.com" />
                  </Form.Group>
                  <Row className="g-3 mt-0">
                    <Col md={6}>
                      <Form.Group>
                        <Form.Label>Clé publique</Form.Label>
                        <Form.Control value={publicKey} onChange={(e) => setPublicKey(e.target.value)} required placeholder="pk-lf-…" />
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group>
                        <Form.Label>Clé secrète</Form.Label>
                        <Form.Control type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={item?.hasSecret ? '(inchangé)' : 'sk-lf-…'} required={!editing} />
                      </Form.Group>
                    </Col>
                  </Row>
                </>
              )}

              {kind === 'aws' && (
                <>
                  <Row className="g-3 mt-0">
                    <Col md={7}>
                      <Form.Group>
                        <Form.Label>Authentification</Form.Label>
                        <Form.Select value={awsAuth} onChange={(e) => setAwsAuth(e.target.value as AwsAuth)} disabled={editing}>
                          <option value="sso">IAM Identity Center (connexion par code, recommandé)</option>
                          <option value="keys">Clés d'accès (utilisateur IAM)</option>
                        </Form.Select>
                        <Form.Text className="text-secondary">{editing ? "Le mode ne change pas : créez un autre élément." : awsAuth === 'sso' ? 'Après la création, connectez-vous par code depuis les détails de l’élément, puis choisissez le compte et le rôle. Les jetons sont renouvelés par Skipper.' : 'Utilisez de préférence un utilisateur IAM dédié aux agents, aux droits limités.'}</Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={5}>
                      <Form.Group>
                        <Form.Label>Région par défaut</Form.Label>
                        <Form.Control value={region} onChange={(e) => setRegion(e.target.value)} required placeholder="eu-west-3" pattern="[a-z]{2}(-[a-z]+)+-[0-9]" />
                        <Form.Text className="text-secondary">Les commandes peuvent en indiquer une autre (--region).</Form.Text>
                      </Form.Group>
                    </Col>
                  </Row>
                  {awsAuth === 'sso' ? (
                    <Row className="g-3 mt-0">
                      <Col md={8}>
                        <Form.Group>
                          <Form.Label>Portail d'accès</Form.Label>
                          <Form.Control type="url" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} required placeholder="https://mon-org.awsapps.com/start" />
                          <Form.Text className="text-secondary">L'adresse de connexion d'IAM Identity Center (celle de « aws configure sso »).</Form.Text>
                        </Form.Group>
                      </Col>
                      <Col md={4}>
                        <Form.Group>
                          <Form.Label>Région d'Identity Center</Form.Label>
                          <Form.Control value={ssoRegion} onChange={(e) => setSsoRegion(e.target.value)} required placeholder="eu-west-1" pattern="[a-z]{2}(-[a-z]+)+-[0-9]" />
                        </Form.Group>
                      </Col>
                    </Row>
                  ) : (
                    <>
                      <Row className="g-3 mt-0">
                        <Col md={5}>
                          <Form.Group>
                            <Form.Label>Identifiant de la clé d'accès</Form.Label>
                            <Form.Control value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} required placeholder="AKIA…" className="font-monospace" />
                          </Form.Group>
                        </Col>
                        <Col md={7}>
                          <Form.Group>
                            <Form.Label>Clé d'accès secrète</Form.Label>
                            <Form.Control type="password" autoComplete="new-password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} placeholder={item?.hasSecret ? '(inchangée)' : ''} required={!editing} />
                          </Form.Group>
                        </Col>
                      </Row>
                      <Form.Group className="mt-3">
                        <Form.Label>Rôle à endosser (optionnel)</Form.Label>
                        <Form.Control value={roleArn} onChange={(e) => setRoleArn(e.target.value)} placeholder="arn:aws:iam::123456789012:role/agents" className="font-monospace" />
                        <Form.Text className="text-secondary">Les commandes s'exécutent alors avec les identifiants temporaires de ce rôle (sts assume-role), pas avec les clés elles-mêmes.</Form.Text>
                      </Form.Group>
                    </>
                  )}
                  <Form.Check className="mt-3" type="checkbox" id="vault-aws-ro" label="Lecture seule (opérations describe-*, get-*, list-*, s3 ls… seulement)" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                  <Form.Group className="mt-3">
                    <Form.Label>Commandes autorisées par l'outil (optionnel)</Form.Label>
                    <Form.Control as="textarea" rows={2} className="font-monospace small" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder={'s3 ls\nec2 describe-instances'} />
                    <Form.Text className="text-secondary">Un préfixe par ligne, sans « aws » ; vide = tout (dans la limite de la lecture seule).</Form.Text>
                  </Form.Group>
                </>
              )}

              {kind === 'scaleway' && (
                <>
                  <Row className="g-3 mt-0">
                    <Col md={5}>
                      <Form.Group>
                        <Form.Label>Clé d'accès</Form.Label>
                        <Form.Control value={scwAccessKey} onChange={(e) => setScwAccessKey(e.target.value)} required placeholder="SCW…" pattern="SCW[A-Z0-9]{17}" className="font-monospace" />
                        <Form.Text className="text-secondary">Console Scaleway → IAM → Applications : créez une application dédiée aux agents, une politique aux droits limités, puis une clé d'API.</Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={7}>
                      <Form.Group>
                        <Form.Label>Clé secrète</Form.Label>
                        <Form.Control type="password" autoComplete="new-password" value={scwSecretKey} onChange={(e) => setScwSecretKey(e.target.value)} placeholder={item?.hasSecret ? '(inchangée)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'} required={!editing} className="font-monospace" />
                      </Form.Group>
                    </Col>
                  </Row>
                  <Row className="g-3 mt-0">
                    <Col md={6}>
                      <Form.Group>
                        <Form.Label>Projet par défaut (optionnel)</Form.Label>
                        <Form.Control value={scwProjectId} onChange={(e) => setScwProjectId(e.target.value)} placeholder="UUID du projet" className="font-monospace" />
                        <Form.Text className="text-secondary">Complété au test de l'élément si la clé peut lire IAM ; sinon à saisir (Console → Paramètres du projet).</Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group>
                        <Form.Label>Organisation (optionnel)</Form.Label>
                        <Form.Control value={scwOrganizationId} onChange={(e) => setScwOrganizationId(e.target.value)} placeholder="UUID de l'organisation" className="font-monospace" />
                        <Form.Text className="text-secondary">Complétée au test de l'élément si la clé peut lire IAM ; sinon à saisir (Console → Paramètres de l'organisation). Le CLI scw l'exige.</Form.Text>
                      </Form.Group>
                    </Col>
                  </Row>
                  <Row className="g-3 mt-0">
                    <Col md={6}>
                      <Form.Group>
                        <Form.Label>Région par défaut</Form.Label>
                        <Form.Select
                          value={scwRegion}
                          onChange={(e) => {
                            setScwRegion(e.target.value);
                            if (!scwZone.startsWith(`${e.target.value}-`)) setScwZone(`${e.target.value}-1`);
                          }}
                        >
                          <option value="fr-par">fr-par (Paris)</option>
                          <option value="nl-ams">nl-ams (Amsterdam)</option>
                          <option value="pl-waw">pl-waw (Varsovie)</option>
                        </Form.Select>
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group>
                        <Form.Label>Zone par défaut</Form.Label>
                        <Form.Control value={scwZone} onChange={(e) => setScwZone(e.target.value)} required placeholder="fr-par-1" pattern="[a-z]{2}-[a-z]{3}-[0-9]" />
                        <Form.Text className="text-secondary">Les commandes peuvent en indiquer une autre (zone=…, region=…).</Form.Text>
                      </Form.Group>
                    </Col>
                  </Row>
                  <Form.Check className="mt-3" type="checkbox" id="vault-scw-ro" label="Lecture seule (verbes list, get, wait et appels GET seulement, hors secrets et clés)" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                  <Form.Group className="mt-3">
                    <Form.Label>Commandes autorisées par l'outil scw_run (optionnel)</Form.Label>
                    <Form.Control as="textarea" rows={2} className="font-monospace small" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder={'instance server list\nrdb instance'} />
                    <Form.Text className="text-secondary">Un préfixe par ligne, sans « scw » ; vide = tout (dans la limite de la lecture seule). Ne concerne pas scw_api.</Form.Text>
                  </Form.Group>
                </>
              )}

              {kind === 'website' && (
                <Form.Group className="mt-3">
                  <Form.Label>Adresse du site</Form.Label>
                  <Form.Control type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://admin.exemple.fr/login" />
                  <Form.Text className="text-secondary">Le site ou, mieux, sa page de connexion : les valeurs ne sont tapées que sur ses pages.</Form.Text>
                </Form.Group>
              )}

              {(kind === 'website' || kind === 'secret') && (
                <div className="mt-3">
                  <Form.Label className="mb-1">Champs</Form.Label>
                  {fields.map((f, i) => (
                    <div key={i} className="vault-field-row">
                      <div>
                        <Form.Control size="sm" value={f.key} onChange={(e) => updateField(i, { key: e.target.value.toLowerCase() })} placeholder="clé" pattern="[a-z][a-z0-9_]*" required />
                        <div className="vault-variable">{variableOf(name.trim().toLowerCase() || kindInfo.placeholder, f.key || 'cle')}</div>
                      </div>
                      <Form.Control size="sm" value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="Libellé" />
                      <Form.Control size="sm" type={f.secret ? 'password' : 'text'} autoComplete="off" value={f.value} onChange={(e) => updateField(i, { value: e.target.value })} placeholder={f.secret && f.stored ? '(inchangé)' : 'valeur'} required={!f.secret || !f.stored} />
                      <Form.Check type="checkbox" id={`vault-secret-${i}`} label="secret" checked={f.secret} onChange={(e) => updateField(i, { secret: e.target.checked, stored: e.target.checked ? f.stored : false, value: e.target.checked ? f.value : '' })} />
                      <span className="vault-field-actions">
                        <button type="button" title="Monter" disabled={i === 0} onClick={() => moveField(i, -1)}>
                          <i className="bi bi-arrow-up" />
                        </button>
                        <button type="button" title="Descendre" disabled={i === fields.length - 1} onClick={() => moveField(i, 1)}>
                          <i className="bi bi-arrow-down" />
                        </button>
                        <button type="button" title="Retirer" onClick={() => setFields((rows) => rows.filter((_, j) => j !== i))}>
                          <i className="bi bi-x-lg" />
                        </button>
                      </span>
                    </div>
                  ))}
                  <Button variant="outline-secondary" size="sm" onClick={() => setFields((rows) => [...rows, { key: '', label: '', value: '', secret: true, stored: false }])}>
                    <i className="bi bi-plus-lg me-1" /> Ajouter un champ
                  </Button>
                  <Form.Text className="d-block text-secondary">Un champ secret est chiffré et tapé par le serveur sans jamais être montré à l'agent ; un champ public (identifiant, adresse) lui est lisible.</Form.Text>
                </div>
              )}

              <hr />
              {(kind === 'ssh' || kind === 'postgres' || kind === 'api' || kind === 'aws' || kind === 'scaleway') && (
                <Form.Check type="checkbox" id="vault-approval" label="Demander votre accord avant chaque usage par un agent — sinon les outils s'exécutent sans confirmation." checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
              )}
              {(kind === 'website' || kind === 'secret') && <div className="text-secondary small">Les actions dans le navigateur passent par les demandes d'autorisation de la session ; un secret sans site est toujours soumis à votre accord.</div>}
              {isSkipperKind(kind) && <div className="text-secondary small">Réservé à Skipper : aucun outil n'est offert aux agents, et l'élément ne peut pas être relié à un projet. Il se choisit dans vos Paramètres ou dans la configuration d'un agent à appel direct.</div>}
              <Form.Group className="mt-3" style={{ maxWidth: 260 }}>
                <Form.Label>Rappel de rotation (optionnel)</Form.Label>
                <Form.Control type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </Form.Group>
            </>
          )}
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          {isGoogle ? (
            <Button type="submit" disabled={gmail === 'NONE' && drive === 'NONE'}>
              <i className="bi bi-google me-1" /> {editing ? 'Reconnecter avec ces accès' : 'Continuer sur Google'}
            </Button>
          ) : (
            <Button type="submit" disabled={saving}>
              {saving ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Créer'}
            </Button>
          )}
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
