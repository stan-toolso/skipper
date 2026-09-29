import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Collapse, Form, InputGroup, Spinner } from 'react-bootstrap';
import {
  CANCEL_GITHUB_LOGIN,
  DISCONNECT_GITHUB,
  GITHUB_REPOSITORIES,
  GITHUB_STATUS,
  SET_GITHUB_CLIENT_ID,
  SET_GITHUB_PERSONAL_TOKEN,
  START_GITHUB_LOGIN,
  type GithubAuthStatus,
  type GithubLogin,
  type GithubRepository,
} from '../graphql/operations';

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** Compte connecté : identité, portées, déconnexion. */
function ConnectedCard({ status }: { status: GithubAuthStatus }) {
  const [disconnect, { loading }] = useMutation(DISCONNECT_GITHUB, { refetchQueries: ['GithubStatus', 'Settings'] });
  return (
    <Card className="mb-3">
      <Card.Header>Compte GitHub</Card.Header>
      <Card.Body>
        <div className="d-flex align-items-center gap-3 mb-2">
          {status.avatarUrl && <img src={status.avatarUrl} alt="" width={40} height={40} className="rounded-circle" />}
          <div>
            <div>
              <i className="bi bi-check-circle text-success me-1" /> Connecté en tant que <strong>{status.login}</strong>
              <Badge bg="secondary" className="ms-2">
                {status.method === 'pat' ? 'jeton personnel' : 'OAuth'}
              </Badge>
            </div>
            <div className="small text-secondary">
              Depuis le {fmtDate(status.tokenSetAt)} · portées : {status.scopes.join(', ') || '—'}
            </div>
          </div>
        </div>
        <p className="small text-secondary">
          Les projets peuvent utiliser l'adresse https d'un dépôt privé : le jeton est injecté dans les commandes git sans être écrit sur disque. Il est stocké
          chiffré en base et agit en votre nom.
        </p>
        <Button size="sm" variant="outline-danger" disabled={loading} onClick={() => disconnect()}>
          Se déconnecter
        </Button>
        <div className="small text-secondary mt-2">
          Pour révoquer complètement l'accès, supprimez aussi le jeton côté GitHub (Settings → Developer settings → Personal access tokens, ou Applications pour
          OAuth).
        </div>
      </Card.Body>
    </Card>
  );
}

/** Méthode simple : coller un jeton d'accès personnel. */
function PersonalTokenCard() {
  const [token, setToken] = useState('');
  const [save, { loading, error }] = useMutation(SET_GITHUB_PERSONAL_TOKEN, { refetchQueries: ['GithubStatus', 'Settings'], onCompleted: () => setToken('') });
  return (
    <Card className="mb-3">
      <Card.Header>Jeton d'accès personnel (le plus simple)</Card.Header>
      <Card.Body>
        <ol className="small text-secondary ps-3">
          <li>
            Sur GitHub : <strong>Settings → Developer settings → Personal access tokens</strong>. Un jeton « Fine-grained » limité aux dépôts voulus avec le droit{' '}
            <em>Contents : Read and write</em> est idéal ; un jeton « classic » avec la portée <code>repo</code> fonctionne aussi.
          </li>
          <li>Collez-le ici. Skipper le vérifie auprès de GitHub puis le stocke chiffré.</li>
        </ol>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) save({ variables: { token: token.trim() } });
          }}
        >
          <InputGroup style={{ maxWidth: 620 }}>
            <Form.Control type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… ou github_pat_…" autoComplete="off" />
            <Button type="submit" disabled={loading || !token.trim()}>
              {loading ? (
                <>
                  <Spinner size="sm" className="me-1" /> Vérification…
                </>
              ) : (
                'Connecter'
              )}
            </Button>
          </InputGroup>
          {error && (
            <Alert variant="danger" className="mt-2 mb-0 py-2">
              {error.message}
            </Alert>
          )}
        </Form>
      </Card.Body>
    </Card>
  );
}

/** Méthode alternative : OAuth App et device flow (pas de jeton à manipuler). */
function OAuthCard({ status }: { status: GithubAuthStatus }) {
  const [open, setOpen] = useState(Boolean(status.clientId) || Boolean(status.currentLogin));
  const [clientId, setClientId] = useState(status.clientId ?? '');
  const [saveClientId, { loading: savingId, error: idError }] = useMutation(SET_GITHUB_CLIENT_ID, { refetchQueries: ['GithubStatus', 'Settings'] });
  const [login, setLogin] = useState<GithubLogin | null>(status.currentLogin);
  const [start, { loading: starting, error: startError }] = useMutation<{ startGithubLogin: GithubLogin }>(START_GITHUB_LOGIN, { onCompleted: (res) => setLogin(res.startGithubLogin) });
  const [cancel] = useMutation(CANCEL_GITHUB_LOGIN, { refetchQueries: ['GithubStatus', 'Settings'], onCompleted: () => setLogin(null) });
  useEffect(() => setClientId(status.clientId ?? ''), [status.clientId]);
  useEffect(() => {
    if (status.currentLogin) setLogin(status.currentLogin);
  }, [status.currentLogin]);
  const fromEnv = status.clientIdSource === 'env';
  const pending = login?.status === 'pending';
  const remaining = login ? Math.max(0, Math.round((new Date(login.expiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <Card className="mb-3">
      <Card.Header>
        <Button variant="link" className="p-0 text-reset text-decoration-none" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <i className={`bi bi-chevron-${open ? 'down' : 'right'} me-1`} /> Alternative : connexion OAuth sans jeton à copier
        </Button>
      </Card.Header>
      <Collapse in={open}>
        <div>
          <Card.Body>
            <p className="small text-secondary">
              Passe par une « OAuth App » GitHub à vous (Settings → Developer settings → OAuth Apps → New OAuth App, avec <strong>Enable Device Flow</strong> coché).
              Seul son identifiant public est nécessaire.
            </p>
            <Form
              className="mb-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveClientId({ variables: { clientId: clientId.trim() || null } });
              }}
            >
              <Form.Label className="small mb-1">Client ID de l'OAuth App</Form.Label>
              <InputGroup style={{ maxWidth: 520 }}>
                <Form.Control value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Ov23li…" disabled={fromEnv} />
                {!fromEnv && (
                  <Button type="submit" variant="outline-primary" disabled={savingId || clientId.trim() === (status.clientId ?? '')}>
                    Enregistrer
                  </Button>
                )}
              </InputGroup>
              {fromEnv && <Form.Text>Défini par la variable d'environnement GITHUB_CLIENT_ID du serveur.</Form.Text>}
              {idError && (
                <Alert variant="danger" className="mt-2 mb-0 py-2">
                  {idError.message}
                </Alert>
              )}
            </Form>
            {pending && login ? (
              <div className="border rounded p-3">
                <ol className="mb-2 ps-3">
                  <li className="mb-2">
                    Ouvrez{' '}
                    <a href={login.verificationUri} target="_blank" rel="noreferrer">
                      {login.verificationUri}
                    </a>{' '}
                    et saisissez ce code :
                    <div className="display-6 font-monospace my-2" style={{ letterSpacing: '0.15em' }}>
                      {login.userCode}
                    </div>
                    <Button size="sm" variant="outline-secondary" onClick={() => navigator.clipboard?.writeText(login.userCode)}>
                      <i className="bi bi-clipboard me-1" /> Copier le code
                    </Button>
                  </li>
                  <li>Autorisez l'application. Cette page se mettra à jour toute seule.</li>
                </ol>
                <div className="small text-secondary">
                  <Spinner size="sm" className="me-1" /> En attente de votre validation sur GitHub{remaining ? ` (code valable encore ${remaining} min)` : ''}.
                  <Button size="sm" variant="link" className="p-0 ms-2" onClick={() => cancel()}>
                    Annuler
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {login && login.status !== 'done' && login.status !== 'cancelled' && (
                  <Alert variant="warning" className="py-2">
                    {login.error ?? 'La connexion a échoué.'}
                  </Alert>
                )}
                <Button size="sm" variant="outline-primary" onClick={() => start()} disabled={starting || !status.clientId}>
                  {starting ? (
                    <>
                      <Spinner size="sm" className="me-1" /> Préparation…
                    </>
                  ) : (
                    <>
                      <i className="bi bi-github me-1" /> Se connecter avec GitHub
                    </>
                  )}
                </Button>
                {startError && (
                  <Alert variant="danger" className="mt-2 mb-0 py-2">
                    {startError.message}
                  </Alert>
                )}
              </>
            )}
          </Card.Body>
        </div>
      </Collapse>
    </Card>
  );
}

/** Aperçu des dépôts accessibles, pour vérifier la connexion. */
function RepositoriesCard() {
  const [query, setQuery] = useState('');
  const { data, loading, error } = useQuery<{ githubRepositories: GithubRepository[] }>(GITHUB_REPOSITORIES, { variables: { query }, fetchPolicy: 'cache-and-network' });
  const repos = data?.githubRepositories ?? [];
  return (
    <Card className="mb-3">
      <Card.Header>Vos dépôts</Card.Header>
      <Card.Body>
        <Form.Control size="sm" placeholder="Filtrer…" value={query} onChange={(e) => setQuery(e.target.value)} className="mb-2" style={{ maxWidth: 320 }} />
        {error && <Alert variant="danger" className="py-2">{error.message}</Alert>}
        {loading && !data && <Spinner animation="border" size="sm" />}
        <div className="small" style={{ maxHeight: 280, overflow: 'auto' }}>
          {repos.slice(0, 50).map((r) => (
            <div key={r.fullName} className="d-flex justify-content-between border-bottom py-1">
              <span>
                <a href={r.htmlUrl} target="_blank" rel="noreferrer">
                  {r.fullName}
                </a>
                {r.private && (
                  <Badge bg="secondary" className="ms-2">
                    privé
                  </Badge>
                )}
                {r.description && <span className="text-secondary"> — {r.description}</span>}
              </span>
              <span className="text-secondary text-nowrap ms-2">{r.defaultBranch}</span>
            </div>
          ))}
          {data && repos.length === 0 && <div className="text-secondary">Aucun dépôt.</div>}
          {repos.length > 50 && <div className="text-secondary mt-1">… et {repos.length - 50} autres, affinez le filtre.</div>}
        </div>
      </Card.Body>
    </Card>
  );
}

/** Section GitHub des Paramètres : jeton personnel, ou OAuth App en alternative, puis dépôts accessibles. */
export default function GithubSection() {
  const { data, loading, error } = useQuery<{ settings: { github: GithubAuthStatus } }>(GITHUB_STATUS, { pollInterval: 3000 });
  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const status = data!.settings.github;
  return status.connected ? (
    <>
      <ConnectedCard status={status} />
      <RepositoriesCard />
    </>
  ) : (
    <>
      <PersonalTokenCard />
      <OAuthCard status={status} />
    </>
  );
}
