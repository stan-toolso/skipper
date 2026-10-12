import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Form, Spinner, Table } from 'react-bootstrap';
import { useDialogs } from './Dialogs';
import { usePollingQuery } from '../lib/usePollingQuery';
import {
  CONNECT_GITHUB_FROM_VAULT,
  DISCONNECT_GITHUB,
  GITHUB_REPOSITORIES,
  GITHUB_STATUS,
  POLL_GITHUB_DEVICE_LOGIN,
  SET_DEFAULT_GITHUB_ACCOUNT,
  START_GITHUB_DEVICE_LOGIN,
  type GithubAccount,
  type GithubAuthStatus,
  type GithubDeviceLogin,
  type GithubDevicePoll,
  type GithubRepository,
} from '../graphql/settings';
import VaultTokenPicker from './settings/VaultTokenPicker';

const REFETCH = ['GithubStatus', 'Settings'];

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function ErrorLine({ error }: { error: Error | undefined }) {
  return error ? <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert> : null;
}

/** Comptes connectés : identité, méthode, organisations, compte par défaut, déconnexion. */
function AccountsCard({ status }: { status: GithubAuthStatus }) {
  const { confirm } = useDialogs();
  const [setDefault, { loading: settingDefault, error: defaultError }] = useMutation(SET_DEFAULT_GITHUB_ACCOUNT, { refetchQueries: REFETCH });
  const [disconnect, { loading: disconnecting, error: disconnectError }] = useMutation(DISCONNECT_GITHUB, { refetchQueries: REFETCH });
  const remove = async (a: GithubAccount) => {
    const ok = await confirm({
      title: 'Déconnecter le compte',
      message: `Les projets dont les dépôts appartiennent à « ${a.login} » (ou à ses organisations) ne seront plus atteints avec ce compte. Le jeton reste dans le coffre : supprimez-le là-bas pour le retirer tout à fait.`,
      confirmLabel: 'Déconnecter',
      danger: true,
    });
    if (ok) void disconnect({ variables: { accountId: a.id } }).catch(() => undefined);
  };
  return (
    <Card className="mb-3">
      <Card.Header>Vos comptes GitHub</Card.Header>
      <Card.Body>
        <p className="small text-secondary">
          Un dépôt est atteint avec le compte dont l'identifiant ou les organisations le possèdent, sinon avec le compte par défaut. Le jeton est injecté dans les commandes git de vos sessions et de vos actions sans être écrit sur disque ; il agit en votre nom.
        </p>
        <Table size="sm" className="align-middle mb-2">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Méthode</th>
              <th>Organisations</th>
              <th>Portées</th>
              <th>Connecté le</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.accounts.map((a) => {
              const expiry = a.tokenExpiresAt ? new Date(a.tokenExpiresAt) : null;
              const expired = expiry ? expiry.getTime() < Date.now() : false;
              return (
                <tr key={a.id}>
                  <td>
                    <span className="d-inline-flex align-items-center gap-2">
                      {a.avatarUrl && <img src={a.avatarUrl} alt="" width={24} height={24} className="rounded-circle" />}
                      <strong>{a.login}</strong>
                      {a.isDefault ? (
                        <Badge bg="primary" title="Compte utilisé quand aucun autre ne possède le dépôt">
                          <i className="bi bi-star-fill me-1" />
                          par défaut
                        </Badge>
                      ) : (
                        <Button size="sm" variant="link" className="p-0" disabled={settingDefault} onClick={() => void setDefault({ variables: { accountId: a.id } }).catch(() => undefined)}>
                          Par défaut
                        </Button>
                      )}
                    </span>
                  </td>
                  <td>
                    <Badge bg="secondary">{a.method === 'PAT' ? 'jeton personnel' : 'OAuth'}</Badge>
                    {expiry && (
                      <div className={`small ${expired ? 'text-danger' : 'text-secondary'}`}>{expired ? 'jeton expiré' : `expire le ${fmtDate(a.tokenExpiresAt)}`}</div>
                    )}
                  </td>
                  <td className="small">{a.organizations.join(', ') || '—'}</td>
                  <td className="small text-secondary">{a.scopes.join(', ') || '—'}</td>
                  <td className="small text-secondary text-nowrap">{fmtDate(a.connectedAt)}</td>
                  <td className="text-end">
                    <Button size="sm" variant="outline-danger" disabled={disconnecting} onClick={() => void remove(a)}>
                      Déconnecter
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <div className="small text-secondary">
          Pour révoquer complètement l'accès, supprimez aussi le jeton côté GitHub (Settings → Developer settings → Personal access tokens, ou Applications pour OAuth).
        </div>
        <ErrorLine error={defaultError ?? disconnectError} />
      </Card.Body>
    </Card>
  );
}

/** Connexion par code (device flow) : GitHub affiche un code à saisir, puis on interroge jusqu'à la validation. */
function DeviceLoginCard({ onConnected }: { onConnected: () => void }) {
  const [login, setLogin] = useState<GithubDeviceLogin | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [start, { loading: starting, error: startError }] = useMutation<{ startGithubDeviceLogin: GithubDeviceLogin }>(START_GITHUB_DEVICE_LOGIN, {
    onCompleted: (res) => {
      setOutcome(null);
      setLogin(res.startGithubDeviceLogin);
    },
  });
  const [poll] = useMutation<{ pollGithubDeviceLogin: GithubDevicePoll }>(POLL_GITHUB_DEVICE_LOGIN);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Interrogation périodique tant que GitHub répond « en attente » ; l'intervalle vient de la réponse.
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    const tick = async (delay: number) => {
      timer.current = setTimeout(async () => {
        if (cancelled) return;
        try {
          const res = await poll({ variables: { id: login.id } });
          const r = res.data?.pollGithubDeviceLogin;
          if (!r || cancelled) return;
          if (r.status === 'PENDING') return void tick(Math.max(2, r.interval) * 1000);
          setLogin(null);
          if (r.status === 'CONNECTED') {
            setOutcome({ ok: true, text: `Compte « ${r.account?.login ?? '?'} » connecté.` });
            onConnected();
          } else if (r.status === 'EXPIRED') setOutcome({ ok: false, text: 'Le code a expiré : recommencez.' });
          else if (r.status === 'DENIED') setOutcome({ ok: false, text: "L'autorisation a été refusée sur GitHub." });
          else setOutcome({ ok: false, text: `État inattendu : ${r.status}` });
        } catch (err) {
          if (cancelled) return;
          setLogin(null);
          setOutcome({ ok: false, text: (err as Error).message });
        }
      }, delay);
    };
    void tick(Math.max(2, login.interval) * 1000);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [login, poll, onConnected]);

  const remaining = login ? Math.max(0, Math.round((new Date(login.expiresAt).getTime() - Date.now()) / 60000)) : 0;
  return (
    <Card className="mb-3">
      <Card.Header>Se connecter avec GitHub (sans jeton à copier)</Card.Header>
      <Card.Body>
        {login ? (
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
              <Button size="sm" variant="link" className="p-0 ms-2" onClick={() => setLogin(null)}>
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="small text-secondary mb-2">
              GitHub affiche un code à saisir sur son site ; une fois l'application autorisée, le jeton est rangé dans votre coffre (jeton applicatif « GitHub ») et renouvelé automatiquement.
            </p>
            {outcome && (
              <Alert variant={outcome.ok ? 'success' : 'warning'} className="py-2">
                {outcome.text}
              </Alert>
            )}
            <Button size="sm" variant="outline-primary" onClick={() => void start().catch(() => undefined)} disabled={starting}>
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
            <ErrorLine error={startError} />
          </>
        )}
      </Card.Body>
    </Card>
  );
}

/** Jeton d'accès personnel : un jeton applicatif « GitHub » du coffre, vérifié auprès de GitHub puis enregistré comme compte. */
function PersonalTokenCard() {
  const [itemId, setItemId] = useState<string | null>(null);
  const [connect, { loading, error }] = useMutation<{ connectGithubFromVault: GithubAccount }>(CONNECT_GITHUB_FROM_VAULT, { refetchQueries: REFETCH, onCompleted: () => setItemId(null) });
  return (
    <Card className="mb-3">
      <Card.Header>Jeton d'accès personnel</Card.Header>
      <Card.Body>
        <ol className="small text-secondary ps-3">
          <li>
            Sur GitHub : <strong>Settings → Developer settings → Personal access tokens</strong>. Un jeton « Fine-grained » limité aux dépôts voulus avec le droit <em>Contents : Read and write</em> est idéal ; un jeton « classic » avec la portée <code>repo</code> fonctionne aussi.
          </li>
          <li>Rangez-le dans votre coffre comme jeton applicatif de service « GitHub », puis choisissez-le ici : Skipper le vérifie auprès de GitHub et l'enregistre comme compte.</li>
        </ol>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            if (itemId) void connect({ variables: { itemId } }).catch(() => undefined);
          }}
        >
          <div style={{ maxWidth: 520 }}>
            <VaultTokenPicker service="github" value={itemId} onChange={setItemId} size="sm" noneLabel="Choisir un jeton du coffre…" />
          </div>
          <Button type="submit" size="sm" className="mt-2" disabled={loading || !itemId}>
            {loading ? (
              <>
                <Spinner size="sm" className="me-1" /> Vérification…
              </>
            ) : (
              'Connecter'
            )}
          </Button>
          <ErrorLine error={error} />
        </Form>
      </Card.Body>
    </Card>
  );
}

/** Aperçu des dépôts accessibles, pour vérifier la connexion. */
function RepositoriesCard({ several }: { several: boolean }) {
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
            <div key={`${r.account}/${r.fullName}`} className="d-flex justify-content-between border-bottom py-1">
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
              <span className="text-secondary text-nowrap ms-2">
                {several && <span className="me-2" title="Compte avec lequel le dépôt est listé">{r.account}</span>}
                {r.defaultBranch}
              </span>
            </div>
          ))}
          {data && repos.length === 0 && <div className="text-secondary">Aucun dépôt.</div>}
          {repos.length > 50 && <div className="text-secondary mt-1">… et {repos.length - 50} autres, affinez le filtre.</div>}
        </div>
      </Card.Body>
    </Card>
  );
}

/** Section GitHub des Paramètres : comptes connectés, ajout d'un compte (connexion par code ou jeton du coffre), dépôts accessibles. */
export default function GithubSection() {
  const { data, loading, error, refetch } = usePollingQuery<{ settings: { github: GithubAuthStatus } }>(GITHUB_STATUS, { pollInterval: 15_000 });
  const [adding, setAdding] = useState(false);
  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const status = data!.settings.github;
  const showAdd = !status.connected || adding;
  return (
    <>
      {status.connected && <AccountsCard status={status} />}
      {status.connected && !adding && (
        <div className="mb-3">
          <Button size="sm" variant="outline-primary" onClick={() => setAdding(true)}>
            <i className="bi bi-plus-lg me-1" /> Ajouter un compte
          </Button>
        </div>
      )}
      {showAdd && (
        <>
          {status.deviceAvailable ? (
            <DeviceLoginCard
              onConnected={() => {
                setAdding(false);
                void refetch();
              }}
            />
          ) : (
            <Alert variant="light" className="py-2 small border">
              La connexion par code n'est pas disponible sur ce serveur (variable GITHUB_CLIENT_ID absente ou désactivée) : utilisez un jeton d'accès personnel.
            </Alert>
          )}
          <PersonalTokenCard />
        </>
      )}
      {status.connected && <RepositoriesCard several={status.accounts.length > 1} />}
    </>
  );
}
