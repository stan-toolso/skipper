import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, InputGroup, Nav, ProgressBar, Row, Spinner, Table } from 'react-bootstrap';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import GithubSection from '../components/GithubSection';
import PageLoading from '../components/PageLoading';
import RateLimitGauges from '../components/RateLimitGauges';
import ServerHealthCard from '../components/ServerHealthCard';
import OpencodeSection from '../components/settings/OpencodeSection';
import VaultTokenPicker from '../components/settings/VaultTokenPicker';
import {
  CANCEL_CLAUDE_LOGIN,
  CLEAR_CLAUDE_OAUTH_TOKEN,
  COMPLETE_CLAUDE_LOGIN,
  SET_CLAUDE_API_KEY_ITEM,
  SET_CLAUDE_OAUTH_ITEM,
  SET_MAINTENANCE_MODE,
  SETTINGS,
  START_CLAUDE_LOGIN,
  UPDATE_CLAUDE_SETTINGS,
  UPDATE_SERVER_SETTINGS,
  VERIFY_CLAUDE_AUTH,
  type AppSettings,
  type ClaudeAuthMode,
  type ClaudeLogin,
  type ClaudeModel,
  type ServerState,
} from '../graphql/settings';
import { canAutoFocus } from '../lib/device';
import { formatCost } from '../lib/humanize';
import { resolveTheme, useThemePreference, type ThemePreference } from '../lib/theme';
import { useTabTitle } from '../workbench/TabsContext';

const modeLabels: Record<ClaudeAuthMode, { title: string; hint: string }> = {
  oauth: { title: 'Abonnement Claude (jeton OAuth)', hint: 'Un jeton de votre abonnement, obtenu depuis cette page et rangé dans votre coffre. Rien n’est facturé en plus de l’abonnement.' },
  api_key: { title: 'Clé API Anthropic', hint: 'Facturation à la consommation via la console Anthropic ; la clé est un jeton applicatif de votre coffre.' },
};

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function ErrorLine({ error }: { error: Error | undefined }) {
  return error ? <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert> : null;
}

/** Étapes de la connexion de l'abonnement : ouvrir l'URL d'autorisation, coller le code. */
function ClaudeLoginFlow({ label, onDone }: { label: string; onDone: () => void }) {
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [code, setCode] = useState('');
  const [start, { loading: starting, error: startError }] = useMutation<{ startClaudeLogin: ClaudeLogin }>(START_CLAUDE_LOGIN, { onCompleted: (res) => setLogin(res.startClaudeLogin) });
  const [complete, { loading: completing, error: completeError }] = useMutation<{ completeClaudeLogin: ClaudeLogin }>(COMPLETE_CLAUDE_LOGIN, {
    refetchQueries: ['Settings', 'VaultItems'],
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
        <Button size="sm" onClick={() => void start().catch(() => undefined)} disabled={starting}>
          {starting ? <><Spinner size="sm" className="me-1" /> Préparation…</> : <><i className="bi bi-box-arrow-in-right me-1" /> {label}</>}
        </Button>
        <ErrorLine error={startError} />
      </div>
    );
  }
  if (login.status === 'done') {
    return (
      <Alert variant="success" className="py-2 mb-0">
        <i className="bi bi-check-circle me-1" /> Connecté : le jeton est rangé dans votre coffre et le mode « abonnement » est actif.
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
              void complete({ variables: { id: login.id, code } }).catch(() => undefined);
            }}
          >
            <InputGroup size="sm" style={{ maxWidth: 560 }}>
              <Form.Control value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code d'autorisation" autoFocus={canAutoFocus()} spellCheck={false} />
              <Button type="submit" disabled={completing || !code.trim()}>
                {completing ? <><Spinner size="sm" className="me-1" /> Vérification…</> : 'Valider'}
              </Button>
              <Button
                variant="outline-secondary"
                onClick={() => {
                  void cancel({ variables: { id: login.id } }).catch(() => undefined);
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

/** Mode actif, jeton d'abonnement (connexion ou élément du coffre), clé API du coffre, vérification. */
function AuthCard({ settings }: { settings: AppSettings }) {
  const auth = settings.claudeAuth;
  const [update, { loading: updating, error: updateError }] = useMutation(UPDATE_CLAUDE_SETTINGS);
  const [verify, { loading: verifying, error: verifyError }] = useMutation(VERIFY_CLAUDE_AUTH);
  const [clearToken, { loading: clearing, error: clearError }] = useMutation(CLEAR_CLAUDE_OAUTH_TOKEN);
  const [setOauthItem, { loading: settingOauth, error: oauthError }] = useMutation(SET_CLAUDE_OAUTH_ITEM);
  const [setApiKeyItem, { loading: settingKey, error: keyError }] = useMutation(SET_CLAUDE_API_KEY_ITEM);
  const [pickOauth, setPickOauth] = useState(false);
  const v = auth.verification;
  const available: Record<ClaudeAuthMode, boolean> = { oauth: auth.hasOauthToken, api_key: auth.hasApiKey };
  const run = (p: Promise<unknown>) => void p.catch(() => undefined);

  return (
    <Card className="mb-4">
      <Card.Header>Authentification Claude</Card.Header>
      <Card.Body>
        <p className="text-secondary small mb-3">
          Vos sessions lancent Claude Code avec vos propres identifiants, rangés dans votre coffre comme jetons applicatifs : ils ne sont jamais montrés aux agents ni renvoyés à l'interface.
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
                onChange={() => run(update({ variables: { input: { authMode: mode } } }))}
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

        <Row className="g-4 mb-3">
          <Col lg={6}>
            <div className="fw-semibold mb-1">
              <i className="bi bi-person-badge me-1" /> Abonnement Claude
              {auth.hasOauthToken ? <Badge bg="success" className="ms-2">jeton enregistré</Badge> : auth.oauthItemId ? <Badge bg="danger" className="ms-2">jeton inaccessible</Badge> : null}
            </div>
            {auth.oauthItemId && (
              <div className="small text-secondary mb-2">
                Jeton du coffre « {auth.oauthItemName ?? '?'} »{auth.oauthTokenSetAt ? `, enregistré le ${fmtDate(auth.oauthTokenSetAt)}` : ''}.{' '}
                <Button variant="link" size="sm" className="p-0 align-baseline" disabled={clearing} onClick={() => run(clearToken())}>
                  Ne plus l'utiliser
                </Button>
              </div>
            )}
            <ClaudeLoginFlow label={auth.hasOauthToken ? 'Se reconnecter avec Claude' : 'Se connecter avec Claude'} onDone={() => run(verify({ variables: { mode: 'oauth' } }))} />
            <div className="mt-2 small">
              {pickOauth ? (
                <div style={{ maxWidth: 420 }}>
                  <VaultTokenPicker
                    service="claude"
                    size="sm"
                    label="Ou utiliser un jeton d'abonnement déjà dans le coffre"
                    value={auth.oauthItemId}
                    disabled={settingOauth}
                    onChange={(itemId) => run(setOauthItem({ variables: { itemId } }).finally(() => setPickOauth(false)))}
                  />
                </div>
              ) : (
                <Button variant="link" size="sm" className="p-0" onClick={() => setPickOauth(true)}>
                  Choisir un jeton d'abonnement déjà dans le coffre…
                </Button>
              )}
            </div>
            <ErrorLine error={clearError ?? oauthError} />
          </Col>
          <Col lg={6}>
            <div className="fw-semibold mb-1">
              <i className="bi bi-key me-1" /> Clé API Anthropic
              {auth.hasApiKey ? <Badge bg="success" className="ms-2">enregistrée</Badge> : auth.apiKeyItemId ? <Badge bg="danger" className="ms-2">clé inaccessible</Badge> : null}
            </div>
            <div className="small text-secondary mb-2">
              {auth.apiKeyItemId ? `Clé du coffre « ${auth.apiKeyItemName ?? '?'} »${auth.apiKeySetAt ? `, mise à jour le ${fmtDate(auth.apiKeySetAt)}` : ''}.` : 'Aucune clé choisie.'}
            </div>
            <div style={{ maxWidth: 420 }}>
              <VaultTokenPicker service="anthropic" size="sm" value={auth.apiKeyItemId} disabled={settingKey} onChange={(itemId) => run(setApiKeyItem({ variables: { itemId } }))} />
            </div>
            <ErrorLine error={keyError} />
          </Col>
        </Row>

        <div className="border-top pt-3">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline-secondary" disabled={verifying} onClick={() => run(verify())}>
              {verifying ? <><Spinner size="sm" className="me-1" /> Interrogation de Claude Code…</> : <><i className="bi bi-arrow-repeat me-1" /> Vérifier la connexion</>}
            </Button>
            {v && (
              <span className="small text-secondary">
                Dernière vérification ({modeLabels[v.authMode].title.toLowerCase()}) le {fmtDate(v.verifiedAt)}
              </span>
            )}
            {!available[auth.mode] && <span className="small text-secondary">Aucun identifiant pour le mode actif : vos sessions ne pourront pas démarrer.</span>}
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
                onClick={() => void update({ variables: { input: { allowedModels: allowed, defaultModel: defaultModel || null, fallbackModel: fallbackModel || null } } }).catch(() => undefined)}
              >
                {loading ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <Button size="sm" variant="outline-secondary" disabled={refreshing} onClick={() => void verify().catch(() => undefined)}>
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

/** Limites d'utilisation de l'abonnement (fenêtres 5 h / 7 j), d'après le dernier événement reçu d'une session (administrateurs). */
function RateLimitsCard({ settings }: { settings: AppSettings }) {
  const limits = settings.rateLimits;
  return (
    <Card className="mb-4" border={limits?.status === 'rejected' ? 'danger' : limits?.status === 'allowed_warning' ? 'warning' : undefined}>
      <Card.Header>Limites d'utilisation de l'abonnement</Card.Header>
      <Card.Body>
        <div style={{ maxWidth: 560 }}>
          <RateLimitGauges limits={limits} />
        </div>
        <div className="small text-secondary mt-2">
          Les administrateurs sont notifiés quand une fenêtre dépasse 75 % puis 90 %, et quand Anthropic refuse les tours.
        </div>
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
                void update({ variables: { input: { monthlyBudgetUsd: num(monthly), sessionBudgetUsd: num(perSession), defaultMaxTurns: num(maxTurns) } } }).catch(() => undefined);
              }}
            >
              <Form.Group className="mb-3">
                <Form.Label className="mb-1">Plafond mensuel (USD)</Form.Label>
                <Form.Control size="sm" type="number" min={0} step="0.5" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="Aucun" />
                <Form.Text>Atteint, plus aucune de vos sessions ne démarre ni ne reçoit d'instruction jusqu'au mois suivant (ou jusqu'à ce que vous l'augmentiez).</Form.Text>
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
              <span className="fw-semibold">Votre consommation de {monthLabel}</span>
              <span>
                {formatCost(usage.monthUsd)}
                {cap ? <span className="text-secondary"> / {formatCost(cap)}</span> : null}
              </span>
            </div>
            {cap ? <ProgressBar now={ratio} variant={ratio >= 100 ? 'danger' : ratio >= 80 ? 'warning' : undefined} className="mb-2" style={{ height: 8 }} /> : null}
            <div className="small text-secondary mb-3">
              Estimation calculée par Claude Code au tarif API. Avec un abonnement Claude, rien n'est facturé en plus : c'est un indicateur d'usage. Total depuis le début : {formatCost(usage.totalUsd)}.
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

/** Limite de sessions simultanées, arrêt des sessions inactives et seuil d'alerte mémoire. */
function SessionLimitsCard({ server }: { server: ServerState }) {
  const [maxSessions, setMaxSessions] = useState(String(server.maxConcurrentSessions));
  const [idleMinutes, setIdleMinutes] = useState(String(server.idleSessionTimeoutMinutes));
  const [alertMb, setAlertMb] = useState(String(server.memoryAlertThresholdMb));
  const [updateServer, { loading: saving, error }] = useMutation(UPDATE_SERVER_SETTINGS);
  useEffect(() => {
    setMaxSessions(String(server.maxConcurrentSessions));
    setIdleMinutes(String(server.idleSessionTimeoutMinutes));
    setAlertMb(String(server.memoryAlertThresholdMb));
  }, [server.maxConcurrentSessions, server.idleSessionTimeoutMinutes, server.memoryAlertThresholdMb]);
  const dirty =
    maxSessions !== String(server.maxConcurrentSessions) || idleMinutes !== String(server.idleSessionTimeoutMinutes) || alertMb !== String(server.memoryAlertThresholdMb);
  const toInt = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  return (
    <Card className="mb-4">
      <Card.Header>
        Sessions simultanées
        {server.queuedSessions > 0 && (
          <Badge bg="info" className="ms-2">
            {server.queuedSessions} en file d'attente
          </Badge>
        )}
      </Card.Header>
      <Card.Body>
        <p className="text-secondary small">
          Chaque session d'agent fait tourner un processus de plusieurs centaines de Mo. Au-delà de la limite, une session qui devrait
          démarrer (lancée à la main, par une tâche, par une planification ou par un autre agent, ou relancée par un message) passe « en file
          d'attente » et démarre dès qu'une place se libère, dans l'ordre d'arrivée. Chaque projet peut fixer sa propre limite dans ses options
          avancées.
        </p>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void updateServer({
              variables: { maxConcurrentSessions: toInt(maxSessions), idleSessionTimeoutMinutes: toInt(idleMinutes), memoryAlertThresholdMb: toInt(alertMb) },
            }).catch(() => undefined);
          }}
        >
          <Row className="g-3 mb-3">
            <Col md={4}>
              <Form.Label className="small mb-1">Sessions simultanées au maximum</Form.Label>
              <Form.Control type="number" min={0} max={100} value={maxSessions} onChange={(e) => setMaxSessions(e.target.value)} />
              <Form.Text>0 : illimité. Sur ce serveur, compter environ 400 Mo par session.</Form.Text>
            </Col>
            <Col md={4}>
              <Form.Label className="small mb-1">Terminer une session inactive après</Form.Label>
              <InputGroup>
                <Form.Control type="number" min={0} value={idleMinutes} onChange={(e) => setIdleMinutes(e.target.value)} />
                <InputGroup.Text>min</InputGroup.Text>
              </InputGroup>
              <Form.Text>Sans instruction depuis ce délai, la session se termine et libère sa place ; un message la reprend. 0 : jamais.</Form.Text>
            </Col>
            <Col md={4}>
              <Form.Label className="small mb-1">Alerter sous</Form.Label>
              <InputGroup>
                <Form.Control type="number" min={0} value={alertMb} onChange={(e) => setAlertMb(e.target.value)} />
                <InputGroup.Text>Mo disponibles</InputGroup.Text>
              </InputGroup>
              <Form.Text>Notification aux administrateurs quand la mémoire disponible passe sous ce seuil. 0 : jamais.</Form.Text>
            </Col>
          </Row>
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </Form>
        <ErrorLine error={error} />
      </Card.Body>
    </Card>
  );
}

/** Serveur (administrateurs) : santé, sessions simultanées, mode maintenance avant un redémarrage, reprise automatique des sessions interrompues. */
function ServerSection({ server }: { server: ServerState }) {
  const [message, setMessage] = useState(server.maintenanceMessage ?? '');
  const [setMaintenance, { loading: switching, error: maintenanceError }] = useMutation(SET_MAINTENANCE_MODE);
  const [updateServer, { loading: saving, error: serverError }] = useMutation(UPDATE_SERVER_SETTINGS);
  useEffect(() => setMessage(server.maintenanceMessage ?? ''), [server.maintenanceMessage]);
  const idle = server.activeSessions - server.busySessions;

  return (
    <>
      <ServerHealthCard memoryAlertThresholdMb={server.memoryAlertThresholdMb} />
      <SessionLimitsCard server={server} />
      <Card className="mb-4">
        <Card.Header>
          Mode maintenance
          {server.maintenance ? <Badge bg="warning" text="dark" className="ms-2">actif</Badge> : <Badge bg="secondary" className="ms-2">inactif</Badge>}
        </Card.Header>
        <Card.Body>
          <p className="text-secondary small">
            Avant de redémarrer le backend, activez la maintenance : aucune session ne démarre plus (création, relance par un message,
            tâche confiée à un agent), les sessions en cours continuent. Quand plus aucun agent ne travaille, redémarrez : les sessions
            encore ouvertes passent à « interrompue » et reprennent au prochain message. Le redémarrage lève la maintenance.
          </p>
          <div className="mb-3">
            <strong>{server.activeSessions}</strong> session{server.activeSessions > 1 ? 's' : ''} active{server.activeSessions > 1 ? 's' : ''} sur ce serveur
            {server.activeSessions > 0 && (
              <span className="text-secondary">
                {' '}: {server.busySessions} au travail, {idle} en attente d’instructions
              </span>
            )}
            {server.maintenance && server.busySessions === 0 && <Badge bg="success" className="ms-2">redémarrage possible</Badge>}
          </div>
          {server.maintenance && server.maintenanceSince && <div className="small text-secondary mb-2">Active depuis le {fmtDate(server.maintenanceSince)}.</div>}
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void setMaintenance({ variables: { enabled: !server.maintenance, message: message.trim() || null } }).catch(() => undefined);
            }}
          >
            <InputGroup>
              <Form.Control
                placeholder="Message affiché aux utilisateurs (optionnel), ex. mise à jour vers 18 h"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={server.maintenance}
              />
              <Button type="submit" variant={server.maintenance ? 'outline-secondary' : 'warning'} disabled={switching}>
                {server.maintenance ? 'Lever la maintenance' : 'Activer la maintenance'}
              </Button>
            </InputGroup>
          </Form>
          <ErrorLine error={maintenanceError} />
        </Card.Body>
      </Card>
      <Card className="mb-4">
        <Card.Header>Sessions interrompues par un redémarrage</Card.Header>
        <Card.Body>
          <Form.Check
            type="switch"
            id="auto-resume-interrupted"
            label="Relancer automatiquement au démarrage les sessions coupées en plein travail"
            checked={server.autoResumeInterrupted}
            disabled={saving}
            onChange={(e) => void updateServer({ variables: { autoResumeInterrupted: e.target.checked } }).catch(() => undefined)}
          />
          <Form.Text className="text-secondary">
            Seules les sessions dont l’agent travaillait au moment de l’arrêt sont relancées, trois au plus et si l’arrêt date de moins
            d’une heure. L’agent reçoit une instruction lui expliquant la coupure. Chaque session relancée occupe plusieurs centaines de Mo
            de mémoire : désactiver la reprise si le serveur en manque. Les sessions qui attendaient des instructions restent
            interrompues : un message suffit à les reprendre.
          </Form.Text>
          <ErrorLine error={serverError} />
        </Card.Body>
      </Card>
    </>
  );
}

type SettingsSection = 'claude' | 'opencode' | 'github' | 'server' | 'appearance';

/** Thème clair / sombre / système, mémorisé dans ce navigateur seulement. */
function AppearanceSection() {
  const [pref, setPref] = useThemePreference();
  const options: { value: ThemePreference; label: string; hint: string }[] = [
    { value: 'system', label: `Système (actuellement ${resolveTheme('system') === 'light' ? 'clair' : 'sombre'})`, hint: 'Suit le réglage du système ou du navigateur.' },
    { value: 'light', label: 'Clair', hint: 'Surfaces claires partout, y compris le fil des sessions et les terminaux.' },
    { value: 'dark', label: 'Sombre', hint: 'Surfaces sombres, le thème par défaut.' },
  ];
  return (
    <Card className="mb-4">
      <Card.Header>Thème</Card.Header>
      <Card.Body>
        {options.map((o) => (
          <Form.Check key={o.value} type="radio" id={`theme-${o.value}`} name="theme" className="mb-2" checked={pref === o.value} onChange={() => setPref(o.value)} label={<><span>{o.label}</span><div className="small text-secondary">{o.hint}</div></>} />
        ))}
        <Form.Text className="text-secondary">Ce choix est mémorisé dans ce navigateur seulement : il peut différer d'un appareil à l'autre.</Form.Text>
      </Card.Body>
    </Card>
  );
}

/** Paramètres de la personne connectée : Claude (identifiants, modèles, budgets), OpenCode, GitHub, apparence ; serveur pour les administrateurs. */
export default function SettingsPage() {
  useTabTitle('Paramètres');
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section') as SettingsSection | null;
  const section: SettingsSection = requested && (requested !== 'server' || isAdmin) ? requested : 'claude';
  const { data, loading, error } = useQuery<{ settings: AppSettings }>(SETTINGS, { pollInterval: 15_000 });
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!data) return null;
  const s = data.settings;
  const claudeReady = s.claudeAuth.mode === 'oauth' ? s.claudeAuth.hasOauthToken : s.claudeAuth.hasApiKey;
  return (
    <>
      <h1 className="h3 mb-3">Paramètres</h1>
      <Nav variant="tabs" activeKey={section} onSelect={(k) => setSearchParams({ section: k ?? 'claude' })} className="mb-3">
        <Nav.Item>
          <Nav.Link eventKey="claude">
            <i className="bi bi-stars me-1" /> Claude
            {!claudeReady ? <Badge bg="secondary" className="ms-2">à configurer</Badge> : s.claudeAuth.verification?.ok === false && <Badge bg="danger" className="ms-2">à vérifier</Badge>}
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="opencode">
            <i className="bi bi-terminal me-1" /> OpenCode
            {s.opencode.apiKeys.some((k) => !k.usable) && <Badge bg="danger" className="ms-2">clé inaccessible</Badge>}
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="github">
            <i className="bi bi-github me-1" /> GitHub
            {s.github.connected ? <Badge bg="success" className="ms-2">{s.github.accounts.length > 1 ? `${s.github.accounts.length} comptes` : 'connecté'}</Badge> : <Badge bg="secondary" className="ms-2">non connecté</Badge>}
          </Nav.Link>
        </Nav.Item>
        {isAdmin && s.server && (
          <Nav.Item>
            <Nav.Link eventKey="server">
              <i className="bi bi-hdd-rack me-1" /> Serveur
              {s.server.maintenance && <Badge bg="warning" text="dark" className="ms-2">maintenance</Badge>}
            </Nav.Link>
          </Nav.Item>
        )}
        <Nav.Item>
          <Nav.Link eventKey="appearance">
            <i className="bi bi-palette me-1" /> Apparence
          </Nav.Link>
        </Nav.Item>
      </Nav>
      <div style={{ maxWidth: 1100 }}>
        {section === 'claude' && (
          <>
            <AuthCard settings={s} />
            <ModelsCard settings={s} />
            {isAdmin && s.rateLimits !== null && <RateLimitsCard settings={s} />}
            <BudgetCard settings={s} />
          </>
        )}
        {section === 'opencode' && <OpencodeSection settings={s} />}
        {section === 'github' && <GithubSection />}
        {section === 'server' && s.server && <ServerSection server={s.server} />}
        {section === 'appearance' && <AppearanceSection />}
      </div>
    </>
  );
}
