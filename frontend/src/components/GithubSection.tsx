import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Form, InputGroup, Spinner } from 'react-bootstrap';
import {
  CANCEL_GITHUB_LOGIN,
  DISCONNECT_GITHUB,
  GITHUB_REPOSITORIES,
  GITHUB_STATUS,
  SET_GITHUB_CLIENT_ID,
  START_GITHUB_LOGIN,
  type GithubAuthStatus,
  type GithubLogin,
  type GithubRepository,
} from '../graphql/operations';

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** Saisie de l'identifiant de l'OAuth App GitHub, avec le mode d'emploi pour la créer. */
function ClientIdCard({ status }: { status: GithubAuthStatus }) {
  const [clientId, setClientId] = useState(status.clientId ?? '');
  const [save, { loading, error }] = useMutation(SET_GITHUB_CLIENT_ID, { refetchQueries: ['GithubStatus', 'Settings'] });
  useEffect(() => setClientId(status.clientId ?? ''), [status.clientId]);
  const fromEnv = status.clientIdSource === 'env';
  return (
    <Card className="mb-3">
      <Card.Header>Application GitHub</Card.Header>
      <Card.Body>
        <p className="small text-secondary">
          La connexion passe par une « OAuth App » GitHub qui vous appartient. Aucun secret n'est nécessaire : seul son identifiant public (client id) est
          demandé. À créer une seule fois :
        </p>
        <ol className="small text-secondary ps-3">
          <li>
            Sur GitHub : <strong>Settings → Developer settings → OAuth Apps → New OAuth App</strong>.
          </li>
          <li>
            Nom libre (ex. « Skipper »), Homepage URL et Authorization callback URL : l'adresse de Skipper (le callback n'est pas utilisé mais GitHub l'exige).
          </li>
          <li>
            Cochez <strong>Enable Device Flow</strong>, enregistrez, puis copiez le <strong>Client ID</strong> ci-dessous.
          </li>
        </ol>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            save({ variables: { clientId: clientId.trim() || null } });
          }}
        >
          <Form.Label className="small mb-1">Client ID</Form.Label>
          <InputGroup style={{ maxWidth: 520 }}>
            <Form.Control value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Ov23li…" disabled={fromEnv} />
            {!fromEnv && (
              <Button type="submit" variant="outline-primary" disabled={loading || clientId.trim() === (status.clientId ?? '')}>
                Enregistrer
              </Button>
            )}
          </InputGroup>
          {fromEnv && <Form.Text>Défini par la variable d'environnement GITHUB_CLIENT_ID du serveur.</Form.Text>}
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

/** Connexion par device flow : code à saisir sur github.com, suivi de la validation. */
function ConnectionCard({ status }: { status: GithubAuthStatus }) {
  const [login, setLogin] = useState<GithubLogin | null>(status.currentLogin);
  const [start, { loading: starting, error: startError }] = useMutation<{ startGithubLogin: GithubLogin }>(START_GITHUB_LOGIN, {
    onCompleted: (res) => setLogin(res.startGithubLogin),
  });
  const [cancel] = useMutation(CANCEL_GITHUB_LOGIN, { refetchQueries: ['GithubStatus', 'Settings'], onCompleted: () => setLogin(null) });
  const [disconnect, { loading: disconnecting }] = useMutation(DISCONNECT_GITHUB, { refetchQueries: ['GithubStatus', 'Settings'] });

  // Suit l'état de la connexion en cours (le backend interroge GitHub en tâche de fond).
  useEffect(() => {
    if (status.currentLogin) setLogin(status.currentLogin);
  }, [status.currentLogin]);
  const pending = login?.status === 'pending';
  const remaining = login ? Math.max(0, Math.round((new Date(login.expiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <Card className="mb-3">
      <Card.Header>Connexion GitHub</Card.Header>
      <Card.Body>
        {status.connected ? (
          <>
            <div className="d-flex align-items-center gap-3 mb-2">
              {status.avatarUrl && <img src={status.avatarUrl} alt="" width={40} height={40} className="rounded-circle" />}
              <div>
                <div>
                  <i className="bi bi-check-circle text-success me-1" /> Connecté en tant que <strong>{status.login}</strong>
                </div>
                <div className="small text-secondary">
                  Depuis le {fmtDate(status.tokenSetAt)} · portées : {status.scopes.join(', ') || '—'}
                </div>
              </div>
            </div>
            <p className="small text-secondary">
              Les projets peuvent maintenant utiliser l'adresse https d'un dépôt privé : le jeton est injecté dans les commandes git sans être écrit sur disque. Il
              est stocké chiffré en base et agit en votre nom (lecture et écriture sur vos dépôts).
            </p>
            <Button size="sm" variant="outline-danger" disabled={disconnecting} onClick={() => disconnect()}>
              Se déconnecter
            </Button>
            <div className="small text-secondary mt-2">
              Pour révoquer complètement l'accès, retirez aussi l'autorisation dans GitHub : Settings → Applications → Authorized OAuth Apps.
            </div>
          </>
        ) : !status.clientId ? (
          <p className="text-secondary mb-0">Renseignez d'abord l'identifiant de l'application ci-dessus.</p>
        ) : pending && login ? (
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
            <p className="small text-secondary">
              Vous serez redirigé vers GitHub pour autoriser Skipper à accéder à vos dépôts (portée <code>repo</code>). Aucun mot de passe ne transite par
              Skipper.
            </p>
            <Button size="sm" onClick={() => start()} disabled={starting}>
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

/** Section GitHub des Paramètres : application, connexion, dépôts accessibles. */
export default function GithubSection() {
  const { data, loading, error } = useQuery<{ settings: { github: GithubAuthStatus } }>(GITHUB_STATUS, { pollInterval: 3000 });
  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const status = data!.settings.github;
  return (
    <>
      <ClientIdCard status={status} />
      <ConnectionCard status={status} />
      {status.connected && <RepositoriesCard />}
    </>
  );
}
