import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, InputGroup, ProgressBar, Row, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import {
  CANCEL_CLAUDE_LOGIN,
  CLEAR_CLAUDE_OAUTH_TOKEN,
  COMPLETE_CLAUDE_LOGIN,
  LOGOUT_SERVER_CLAUDE,
  SET_CLAUDE_API_KEY,
  SETTINGS,
  START_CLAUDE_LOGIN,
  UPDATE_CLAUDE_SETTINGS,
  VERIFY_CLAUDE_AUTH,
  type AppSettings,
  type ClaudeAuthMode,
  type ClaudeLogin,
  type ClaudeLoginKind,
  type ClaudeModel,
} from '../graphql/operations';
import { formatCost } from '../lib/humanize';
import { useTabTitle } from '../workbench/TabsContext';

const modeLabels: Record<ClaudeAuthMode, { title: string; hint: string }> = {
  server: { title: 'Compte du serveur', hint: "Le compte connecté dans Claude Code pour l'utilisateur système qui fait tourner Skipper (connexion depuis cette page ou par SSH), ou les variables d'environnement du serveur. Recommandé : les identifiants se renouvellent seuls." },
  oauth: { title: 'Jeton OAuth (un an)', hint: 'Un jeton longue durée obtenu depuis cette page et stocké chiffré par Skipper. À refaire chaque année.' },
  api_key: { title: 'Clé API Anthropic', hint: 'Facturation à la consommation via la console Anthropic.' },
};

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function ErrorLine({ error }: { error: Error | undefined }) {
  return error ? <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert> : null;
}

/** Étapes de la connexion (OAuth ou compte du serveur) : ouvrir l'URL, coller le code. */
function ClaudeLoginFlow({ kind, label, onDone }: { kind: ClaudeLoginKind; label: string; onDone: () => void }) {
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [code, setCode] = useState('');
  const [start, { loading: starting, error: startError }] = useMutation<{ startClaudeLogin: ClaudeLogin }>(START_CLAUDE_LOGIN, {
    variables: { kind },
    onCompleted: (res) => setLogin(res.startClaudeLogin),
  });
  const [complete, { loading: completing, error: completeError }] = useMutation<{ completeClaudeLogin: ClaudeLogin }>(COMPLETE_CLAUDE_LOGIN, {
    onCompleted: (res) => {
      setLogin(res.completeClaudeLogin);
      if (res.completeClaudeLogin.status === 'done') onDone();
    },
  });
  const [cancel] = useMutation(CANCEL_CLAUDE_LOGIN);

  if (!login || login.status === 'failed') {
    return (
      <div>
        {login?.status === 'failed' && <Alert variant="warning" className="py-2">{login.error ?? 'La connexion a échoué.'}</Alert>}
        <Button size="sm" onClick={() => start()} disabled={starting}>
          {starting ? <><Spinner size="sm" className="me-1" /> Préparation…</> : <><i className="bi bi-box-arrow-in-right me-1" /> {label}</>}
        </Button>
        <ErrorLine error={startError} />
      </div>
    );
  }
  if (login.status === 'done') {
    return (
      <Alert variant="success" className="py-2 mb-0">
        <i className="bi bi-check-circle me-1" /> {kind === 'server' ? 'Connecté : le compte du serveur est actif.' : 'Connecté : le jeton est enregistré et le mode OAuth est actif.'}
      </Alert>
    );
  }
  return (
    <div className="border rounded p-3">
      <ol className="mb-2 ps-3">
        <li className="mb-2">
          Ouvrez la page d'autorisation et connectez-vous avec votre compte Claude :{' '}
          <a href={login.url} target="_blank" rel="noreferrer" className="btn btn-sm btn-outline-primary ms-1">
            <i className="bi bi-box-arrow-up-right me-1" /> Ouvrir claude.com
          </a>
        </li>
        <li>
          Copiez le code affiché à la fin, puis collez-le ici :
          <Form
            className="mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              complete({ variables: { id: login.id, code } });
            }}
          >
            <InputGroup size="sm" style={{ maxWidth: 560 }}>
              <Form.Control value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code d'autorisation" autoFocus spellCheck={false} />
              <Button type="submit" disabled={completing || !code.trim()}>
                {completing ? <><Spinner size="sm" className="me-1" /> Vérification…</> : 'Valider'}
              </Button>
              <Button
                variant="outline-secondary"
                onClick={() => {
                  cancel({ variables: { id: login.id } });
                  setLogin(null);
                  setCode('');
                }}
              >
                Annuler
              </Button>
            </InputGroup>
          </Form>
        </li>
      </ol>
      <ErrorLine error={completeError} />
    </div>
  );
}

function ApiKeyForm({ hint, setAt }: { hint: string | null; setAt: string | null }) {
  const [value, setValue] = useState('');
  const [save, { loading, error }] = useMutation(SET_CLAUDE_API_KEY, { onCompleted: () => setValue('') });
  return (
    <div>
      {hint ? (
        <div className="small text-secondary mb-2">
          Clé enregistrée <code>{hint}</code> le {fmtDate(setAt)}.{' '}
          <Button variant="link" size="sm" className="p-0 align-baseline" onClick={() => save({ variables: { apiKey: null } })}>
            Supprimer
          </Button>
        </div>
      ) : (
        <div className="small text-secondary mb-2">Aucune clé enregistrée.</div>
      )}
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save({ variables: { apiKey: value } });
        }}
      >
        <InputGroup size="sm" style={{ maxWidth: 560 }}>
          <Form.Control type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ant-api03-…" autoComplete="off" />
          <Button type="submit" disabled={loading || !value.trim()}>
            {hint ? 'Remplacer' : 'Enregistrer'}
          </Button>
        </InputGroup>
      </Form>
      <ErrorLine error={error} />
    </div>
  );
}

function AuthCard({ settings }: { settings: AppSettings }) {
  const auth = settings.claudeAuth;
  const [update, { loading: updating, error: updateError }] = useMutation(UPDATE_CLAUDE_SETTINGS);
  const [verify, { loading: verifying, error: verifyError }] = useMutation(VERIFY_CLAUDE_AUTH);
  const [clearToken, { loading: clearing }] = useMutation(CLEAR_CLAUDE_OAUTH_TOKEN);
  const [logoutServer, { loading: loggingOut, error: logoutError }] = useMutation(LOGOUT_SERVER_CLAUDE);
  const v = auth.verification;
  const server = auth.server;

  const available: Record<ClaudeAuthMode, boolean> = { server: true, oauth: auth.hasOauthToken, api_key: auth.hasApiKey };

  return (
    <Card className="mb-4">
      <Card.Header>Authentification Claude</Card.Header>
      <Card.Body>
        <p className="text-secondary small mb-3">
          Les sessions lancent Claude Code sur le serveur. Choisissez avec quel compte il travaille. Les secrets sont chiffrés en base et ne sont jamais renvoyés à l'interface.
        </p>

        <Form.Group className="mb-3">
          <Form.Label className="mb-1">Mode actif</Form.Label>
          <div>
            {(Object.keys(modeLabels) as ClaudeAuthMode[]).map((mode) => (
              <Form.Check
                key={mode}
                type="radio"
                id={`auth-${mode}`}
                name="authMode"
                className="mb-1"
                checked={auth.mode === mode}
                disabled={updating || !available[mode]}
                onChange={() => update({ variables: { input: { authMode: mode } } })}
                label={
                  <>
                    {modeLabels[mode].title}
                    {!available[mode] && <span className="text-secondary small ms-2">(à configurer ci-dessous)</span>}
                    <div className="small text-secondary">{modeLabels[mode].hint}</div>
                  </>
                }
              />
            ))}
          </div>
          <ErrorLine error={updateError} />
        </Form.Group>

        <Row className="g-3 mb-3">
          <Col lg={4}>
            <div className="fw-semibold mb-1">
              <i className="bi bi-hdd me-1" /> Compte du serveur
              {server.loggedIn ? <Badge bg="success" className="ms-2">connecté</Badge> : auth.serverHasApiKey ? <Badge bg="success" className="ms-2">variable d'environnement</Badge> : <Badge bg="secondary" className="ms-2">non connecté</Badge>}
            </div>
            {server.loggedIn ? (
              <div className="small text-secondary mb-2">
                {server.email ?? 'Compte connecté'}
                {server.subscriptionType ? ` · ${server.subscriptionType}` : ''}
                {server.authMethod ? ` · ${server.authMethod}` : ''}.{' '}
                <Button variant="link" size="sm" className="p-0 align-baseline" disabled={loggingOut} onClick={() => logoutServer()}>
                  Déconnecter
                </Button>
              </div>
            ) : (
              <div className="small text-secondary mb-2">{server.error ? `État inconnu : ${server.error}` : 'Aucun compte Claude Code connecté pour cet utilisateur système.'}</div>
            )}
            <ClaudeLoginFlow kind="server" label={server.loggedIn ? 'Changer de compte' : 'Se connecter avec Claude'} onDone={() => verify({ variables: { mode: 'server' } })} />
            <ErrorLine error={logoutError} />
          </Col>
          <Col lg={4}>
            <div className="fw-semibold mb-1">
              <i className="bi bi-person-badge me-1" /> Jeton OAuth (un an)
              {auth.hasOauthToken && <Badge bg="success" className="ms-2">jeton enregistré</Badge>}
            </div>
            {auth.hasOauthToken && (
              <div className="small text-secondary mb-2">
                Jeton enregistré le {fmtDate(auth.oauthTokenSetAt)} (valable un an).{' '}
                <Button variant="link" size="sm" className="p-0 align-baseline" disabled={clearing} onClick={() => clearToken()}>
                  Déconnecter
                </Button>
              </div>
            )}
            <ClaudeLoginFlow kind="oauth" label="Obtenir un jeton" onDone={() => verify({ variables: { mode: 'oauth' } })} />
          </Col>
          <Col lg={4}>
            <div className="fw-semibold mb-1">
              <i className="bi bi-key me-1" /> Clé API Anthropic
              {auth.hasApiKey && <Badge bg="success" className="ms-2">enregistrée</Badge>}
            </div>
            <ApiKeyForm hint={auth.apiKeyHint} setAt={auth.apiKeySetAt} />
          </Col>
        </Row>

        <div className="border-top pt-3">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline-secondary" disabled={verifying} onClick={() => verify()}>
              {verifying ? <><Spinner size="sm" className="me-1" /> Interrogation de Claude Code…</> : <><i className="bi bi-arrow-repeat me-1" /> Vérifier la connexion</>}
            </Button>
            {v && (
              <span className="small text-secondary">
                Dernière vérification ({modeLabels[v.authMode].title.toLowerCase()}) le {fmtDate(v.verifiedAt)}
              </span>
            )}
            {auth.mode === 'server' && !auth.serverHasApiKey && !server.loggedIn && (
              <span className="small text-secondary">Aucun compte du serveur : connectez-vous ci-dessus, ou choisissez un autre mode.</span>
            )}
          </div>
          {v && (
            <div className="mt-2">
              {v.ok && v.account ? (
                <Alert variant="success" className="py-2 mb-0">
                  <i className="bi bi-check-circle me-1" /> Connecté{v.account.email ? ` en tant que ${v.account.email}` : ''}
                  {v.account.subscriptionType ? ` · ${v.account.subscriptionType}` : ''}
                  {v.account.organization ? ` · ${v.account.organization}` : ''}
                  {v.account.apiProvider && v.account.apiProvider !== 'firstParty' ? ` · via ${v.account.apiProvider}` : ''}
                </Alert>
              ) : (
                <Alert variant="danger" className="py-2 mb-0">
                  <i className="bi bi-x-circle me-1" /> {v.error ?? 'Connexion impossible.'}
                </Alert>
              )}
            </div>
          )}
          <ErrorLine error={verifyError} />
        </div>
      </Card.Body>
    </Card>
  );
}

function ModelsCard({ settings }: { settings: AppSettings }) {
  const { claude, models } = settings;
  const [allowed, setAllowed] = useState<string[]>(claude.allowedModels);
  const [defaultModel, setDefaultModel] = useState(claude.defaultModel ?? '');
  const [fallbackModel, setFallbackModel] = useState(claude.fallbackModel ?? '');
  const [custom, setCustom] = useState('');
  const [update, { loading, error }] = useMutation(UPDATE_CLAUDE_SETTINGS);
  const [verify, { loading: refreshing }] = useMutation(VERIFY_CLAUDE_AUTH);

  useEffect(() => {
    setAllowed(claude.allowedModels);
    setDefaultModel(claude.defaultModel ?? '');
    setFallbackModel(claude.fallbackModel ?? '');
  }, [claude]);

  // Modèles connus + ceux autorisés à la main (identifiants absents de la liste du CLI).
  const known: ClaudeModel[] = [...models];
  for (const value of allowed) if (!known.some((m) => m.value === value)) known.push({ value, resolvedModel: null, displayName: value, description: 'Identifiant saisi à la main' });
  const dirty = JSON.stringify(allowed) !== JSON.stringify(claude.allowedModels) || defaultModel !== (claude.defaultModel ?? '') || fallbackModel !== (claude.fallbackModel ?? '');
  const selectable = allowed.length ? known.filter((m) => allowed.includes(m.value)) : known;
  const toggle = (value: string) => setAllowed((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));

  return (
    <Card className="mb-4">
      <Card.Header>Modèles</Card.Header>
      <Card.Body>
        <p className="text-secondary small mb-3">
          Cochez les modèles proposés à la création d'une session (aucun coché = tous). La liste vient de Claude Code lors de la vérification de connexion.
          {!settings.claudeAuth.verification && " Elle n'a pas encore été vérifiée : une liste de base est affichée."}
        </p>
        <Row className="g-3">
          <Col lg={7}>
            <Table size="sm" className="mb-2 align-middle">
              <tbody>
                {known.map((m) => (
                  <tr key={m.value}>
                    <td style={{ width: 32 }}>
                      <Form.Check type="checkbox" id={`model-${m.value}`} checked={allowed.includes(m.value)} onChange={() => toggle(m.value)} />
                    </td>
                    <td>
                      <label htmlFor={`model-${m.value}`} className="mb-0" style={{ cursor: 'pointer' }}>
                        {m.displayName} <code className="small text-secondary ms-1">{m.value}</code>
                        {m.resolvedModel && m.resolvedModel !== m.value && <span className="small text-secondary ms-1">→ {m.resolvedModel}</span>}
                        {m.description && <div className="small text-secondary">{m.description}</div>}
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                const v = custom.trim();
                if (v && !allowed.includes(v)) setAllowed((prev) => [...prev, v]);
                setCustom('');
              }}
            >
              <InputGroup size="sm" style={{ maxWidth: 420 }}>
                <Form.Control value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Autre identifiant, ex. claude-opus-4-8" />
                <Button type="submit" variant="outline-secondary" disabled={!custom.trim()}>Ajouter</Button>
              </InputGroup>
            </Form>
          </Col>
          <Col lg={5}>
            <Form.Group className="mb-3">
              <Form.Label className="mb-1">Modèle par défaut des sessions</Form.Label>
              <Form.Select size="sm" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
                <option value="">Défaut de Claude Code</option>
                {selectable.map((m) => (
                  <option key={m.value} value={m.value}>{m.displayName} ({m.value})</option>
                ))}
              </Form.Select>
              <Form.Text>Utilisé quand la session ne précise pas de modèle.</Form.Text>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label className="mb-1">Modèle de repli</Form.Label>
              <Form.Select size="sm" value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)}>
                <option value="">Aucun</option>
                {selectable.map((m) => (
                  <option key={m.value} value={m.value}>{m.displayName} ({m.value})</option>
                ))}
              </Form.Select>
              <Form.Text>Pris si le modèle principal est surchargé ou indisponible.</Form.Text>
            </Form.Group>
            <div className="d-flex gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={loading || !dirty}
                onClick={() => update({ variables: { input: { allowedModels: allowed, defaultModel: defaultModel || null, fallbackModel: fallbackModel || null } } })}
              >
                {loading ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <Button size="sm" variant="outline-secondary" disabled={refreshing} onClick={() => verify()}>
                {refreshing ? <><Spinner size="sm" className="me-1" /> Actualisation…</> : <><i className="bi bi-arrow-repeat me-1" /> Actualiser la liste</>}
              </Button>
            </div>
            <ErrorLine error={error} />
          </Col>
        </Row>
      </Card.Body>
    </Card>
  );
}

function BudgetCard({ settings }: { settings: AppSettings }) {
  const { claude, usage } = settings;
  const [monthly, setMonthly] = useState(claude.monthlyBudgetUsd?.toString() ?? '');
  const [perSession, setPerSession] = useState(claude.sessionBudgetUsd?.toString() ?? '');
  const [maxTurns, setMaxTurns] = useState(claude.defaultMaxTurns?.toString() ?? '');
  const [update, { loading, error }] = useMutation(UPDATE_CLAUDE_SETTINGS);
  useEffect(() => {
    setMonthly(claude.monthlyBudgetUsd?.toString() ?? '');
    setPerSession(claude.sessionBudgetUsd?.toString() ?? '');
    setMaxTurns(claude.defaultMaxTurns?.toString() ?? '');
  }, [claude]);

  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));
  const dirty = num(monthly) !== claude.monthlyBudgetUsd || num(perSession) !== claude.sessionBudgetUsd || num(maxTurns) !== claude.defaultMaxTurns;
  const cap = claude.monthlyBudgetUsd;
  const ratio = cap ? Math.min(100, (usage.monthUsd / cap) * 100) : 0;
  const monthLabel = new Date(usage.monthStart).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  return (
    <Card className="mb-4">
      <Card.Header>Facturation et consommation</Card.Header>
      <Card.Body>
        <Row className="g-4">
          <Col lg={5}>
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                update({ variables: { input: { monthlyBudgetUsd: num(monthly), sessionBudgetUsd: num(perSession), defaultMaxTurns: num(maxTurns) } } });
              }}
            >
              <Form.Group className="mb-3">
                <Form.Label className="mb-1">Plafond mensuel (USD)</Form.Label>
                <Form.Control size="sm" type="number" min={0} step="0.5" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="Aucun" />
                <Form.Text>Atteint, plus aucune session ne démarre ni ne reçoit d'instruction jusqu'au mois suivant (ou jusqu'à ce que vous l'augmentiez).</Form.Text>
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label className="mb-1">Budget par session (USD)</Form.Label>
                <Form.Control size="sm" type="number" min={0} step="0.5" value={perSession} onChange={(e) => setPerSession(e.target.value)} placeholder="Aucun" />
                <Form.Text>Valeur par défaut, modifiable dans les options avancées de chaque session. L'agent s'arrête quand il l'atteint.</Form.Text>
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label className="mb-1">Nombre maximum d'étapes par session</Form.Label>
                <Form.Control size="sm" type="number" min={1} step={1} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder="Illimité" />
              </Form.Group>
              <Button size="sm" type="submit" disabled={loading || !dirty}>
                {loading ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <ErrorLine error={error} />
            </Form>
          </Col>
          <Col lg={7}>
            <div className="d-flex justify-content-between align-items-baseline mb-1">
              <span className="fw-semibold">Consommation de {monthLabel}</span>
              <span>
                {formatCost(usage.monthUsd)}
                {cap ? <span className="text-secondary"> / {formatCost(cap)}</span> : null}
              </span>
            </div>
            {cap ? <ProgressBar now={ratio} variant={ratio >= 100 ? 'danger' : ratio >= 80 ? 'warning' : undefined} className="mb-2" style={{ height: 8 }} /> : null}
            <div className="small text-secondary mb-3">
              Estimation calculée par Claude Code au tarif API. Avec un abonnement Claude (OAuth), rien n'est facturé en plus : c'est un indicateur d'usage. Total depuis le début : {formatCost(usage.totalUsd)}.
            </div>
            {usage.byModel.length > 0 && (
              <Table size="sm" className="mb-3">
                <thead>
                  <tr>
                    <th>Par modèle</th>
                    <th className="text-end">Ce mois</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((r) => (
                    <tr key={r.model}>
                      <td><code>{r.model}</code></td>
                      <td className="text-end">{formatCost(r.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {usage.bySession.length > 0 && (
              <Table size="sm" className="mb-0">
                <thead>
                  <tr>
                    <th>Sessions les plus coûteuses</th>
                    <th className="text-end">Ce mois</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.bySession.map((r, i) => (
                    <tr key={r.sessionId ?? i}>
                      <td>
                        {r.sessionId ? <Link to={`/sessions/${r.sessionId}`}>{r.sessionName ?? 'Session supprimée'}</Link> : <span className="text-secondary">Session supprimée</span>}
                        {r.projectName && <span className="text-secondary small ms-2">{r.projectName}</span>}
                      </td>
                      <td className="text-end">{formatCost(r.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {usage.byModel.length === 0 && <div className="text-secondary small">Aucune consommation enregistrée ce mois-ci.</div>}
          </Col>
        </Row>
      </Card.Body>
    </Card>
  );
}

/** Configuration générale : authentification Claude, modèles, budgets et consommation. */
export default function SettingsPage() {
  useTabTitle('Paramètres');
  const { data, loading, error } = useQuery<{ settings: AppSettings }>(SETTINGS, { pollInterval: 15_000 });
  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!data) return null;
  return (
    <>
      <h1 className="h3 mb-3">Paramètres</h1>
      <div style={{ maxWidth: 1100 }}>
        <AuthCard settings={data.settings} />
        <ModelsCard settings={data.settings} />
        <BudgetCard settings={data.settings} />
      </div>
    </>
  );
}
