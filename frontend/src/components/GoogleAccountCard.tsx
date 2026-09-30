import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Spinner } from 'react-bootstrap';
import { useSearchParams } from 'react-router-dom';
import { googleConnectUrl } from '../apollo';
import { useDialogs } from './Dialogs';
import { CHECK_GOOGLE_ACCOUNT, DISCONNECT_GOOGLE_ACCOUNT, PROJECT_GOOGLE_ACCOUNT, type GoogleAccess, type GoogleAccount } from '../graphql/operations';

const accessLabels: Record<GoogleAccess, string> = { NONE: 'aucun accès', READ: 'lecture', WRITE: 'lecture et écriture' };
const accessVariant: Record<GoogleAccess, string> = { NONE: 'secondary', READ: 'info', WRITE: 'warning' };

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** Choix des accès puis redirection vers l'écran de consentement Google (le retour ramène sur la page du projet). */
function ConnectForm({ projectId, current, onCancel }: { projectId: string; current: GoogleAccount | null; onCancel?: () => void }) {
  const [gmail, setGmail] = useState<GoogleAccess>(current?.gmailAccess ?? 'READ');
  const [drive, setDrive] = useState<GoogleAccess>(current?.driveAccess ?? 'READ');
  const nothing = gmail === 'NONE' && drive === 'NONE';
  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        if (!nothing) window.location.assign(googleConnectUrl(projectId, gmail.toLowerCase(), drive.toLowerCase()));
      }}
    >
      <Row className="g-2 mb-2" style={{ maxWidth: 560 }}>
        <Col sm={6}>
          <Form.Label className="mb-1">
            <i className="bi bi-envelope me-1" /> Messagerie (Gmail)
          </Form.Label>
          <Form.Select size="sm" value={gmail} onChange={(e) => setGmail(e.target.value as GoogleAccess)}>
            <option value="NONE">Aucun accès</option>
            <option value="READ">Lecture : chercher et lire les messages</option>
            <option value="WRITE">Lecture et envoi de messages</option>
          </Form.Select>
        </Col>
        <Col sm={6}>
          <Form.Label className="mb-1">
            <i className="bi bi-google me-1" /> Drive
          </Form.Label>
          <Form.Select size="sm" value={drive} onChange={(e) => setDrive(e.target.value as GoogleAccess)}>
            <option value="NONE">Aucun accès</option>
            <option value="READ">Lecture : chercher, lire, télécharger</option>
            <option value="WRITE">Lecture et écriture : aussi créer et déposer</option>
          </Form.Select>
        </Col>
      </Row>
      <div className="d-flex gap-2 align-items-center">
        <Button type="submit" size="sm" disabled={nothing}>
          <i className="bi bi-google me-1" /> {current ? 'Reconnecter avec ces accès' : 'Connecter un compte Google'}
        </Button>
        {onCancel && (
          <Button size="sm" variant="link" onClick={onCancel}>
            Annuler
          </Button>
        )}
      </div>
      <div className="text-secondary mt-2">
        Vous serez redirigé vers Google pour choisir le compte et accorder les accès ; le jeton obtenu est stocké chiffré et n'est jamais montré aux agents. Les envois de
        mails et dépôts sur le Drive par un agent sont soumis à votre approbation ; les lectures sont libres.
      </div>
    </Form>
  );
}

/** Compte Google relié au projet : accès Gmail / Drive des agents, vérification, reconnexion, déconnexion. */
export default function GoogleAccountCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { data, refetch } = useQuery<{ project: { googleAccount: GoogleAccount | null } | null }>(PROJECT_GOOGLE_ACCOUNT, { variables: { id: projectId } });
  const [check, { loading: checking, data: checkData, error: checkError, reset: resetCheck }] = useMutation<{ checkGoogleAccount: { ok: boolean; error: string | null; detail: string | null } }>(CHECK_GOOGLE_ACCOUNT, {
    refetchQueries: ['ProjectGoogleAccount'],
  });
  const { confirm } = useDialogs();
  const [disconnect, { loading: disconnecting, error: disconnectError }] = useMutation(DISCONNECT_GOOGLE_ACCOUNT, { refetchQueries: ['ProjectGoogleAccount'] });
  const [editing, setEditing] = useState(false);
  // Retour du flux OAuth : ?google=connected&email=… ou ?googleError=…, lus puis retirés de l'URL.
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const connected = params.get('google');
    const err = params.get('googleError');
    if (!connected && !err) return;
    setNotice(err ? { ok: false, text: `Connexion Google refusée : ${err}` } : { ok: true, text: `Compte Google ${params.get('email') ?? ''} relié au projet.` });
    const next = new URLSearchParams(params);
    ['google', 'googleError', 'email'].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
    void refetch();
  }, [params, setParams, refetch]);

  const account = data?.project?.googleAccount ?? null;
  const error = checkError ?? disconnectError;
  const result = checkData?.checkGoogleAccount;

  return (
    <Card className="mt-3">
      <Card.Header>Compte Google</Card.Header>
      <Card.Body className="small">
        {notice && (
          <Alert variant={notice.ok ? 'success' : 'danger'} className="py-2" dismissible onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}
        {!account ? (
          canManage ? (
            <>
              <p className="text-secondary">
                Reliez un compte Google au projet pour que les agents puissent lire (et, si vous le voulez, envoyer) ses e-mails et travailler dans son Drive, via les outils du
                serveur MCP <code>google</code>.
              </p>
              <ConnectForm projectId={projectId} current={null} />
            </>
          ) : (
            <p className="mb-0 text-secondary">Aucun compte Google relié à ce projet.</p>
          )
        ) : (
          <>
            <div className="d-flex align-items-center gap-3 mb-2">
              {account.avatarUrl && <img src={account.avatarUrl} alt="" width={40} height={40} className="rounded-circle" referrerPolicy="no-referrer" />}
              <div>
                <div>
                  <i className={`bi ${account.lastCheckOk === false ? 'bi-exclamation-circle text-danger' : 'bi-check-circle text-success'} me-1`} />
                  <strong>{account.email}</strong>
                  {account.name && <span className="text-secondary"> · {account.name}</span>}
                </div>
                <div className="text-secondary">
                  Relié le {fmtDate(account.createdAt)}
                  {account.connectedBy && ` par ${account.connectedBy.name || account.connectedBy.email}`}
                  {account.lastCheckAt && ` · vérifié le ${fmtDate(account.lastCheckAt)}`}
                </div>
              </div>
            </div>
            <dl className="row mb-2">
              <dt className="col-sm-3">
                <i className="bi bi-envelope me-1" /> Messagerie
              </dt>
              <dd className="col-sm-9">
                <Badge bg={accessVariant[account.gmailAccess]}>{accessLabels[account.gmailAccess]}</Badge>
                {account.gmailAccess !== 'NONE' && (
                  <span className="text-secondary ms-2">
                    outils <code>gmail_search</code>, <code>gmail_read</code>
                    {account.gmailAccess === 'WRITE' && (
                      <>
                        , <code>gmail_send</code> (avec approbation)
                      </>
                    )}
                  </span>
                )}
              </dd>
              <dt className="col-sm-3">
                <i className="bi bi-google me-1" /> Drive
              </dt>
              <dd className="col-sm-9">
                <Badge bg={accessVariant[account.driveAccess]}>{accessLabels[account.driveAccess]}</Badge>
                {account.driveAccess !== 'NONE' && (
                  <span className="text-secondary ms-2">
                    outils <code>drive_search</code>, <code>drive_read</code>, <code>drive_download</code>
                    {account.driveAccess === 'WRITE' && (
                      <>
                        , <code>drive_upload</code>, <code>drive_write</code> (avec approbation)
                      </>
                    )}
                  </span>
                )}
              </dd>
            </dl>
            {!result && account.lastCheckOk === false && account.lastCheckError && (
              <Alert variant="warning" className="py-2">
                {account.lastCheckError}
              </Alert>
            )}
            {result && (
              <Alert variant={result.ok ? 'success' : 'danger'} className="py-2" dismissible onClose={() => resetCheck()}>
                {result.ok ? `Le compte répond : ${result.detail}` : result.error}
              </Alert>
            )}
            {canManage && !editing && (
              <div className="d-flex gap-2 flex-wrap">
                <Button size="sm" variant="outline-primary" disabled={checking} onClick={() => check({ variables: { projectId } })}>
                  {checking ? (
                    <>
                      <Spinner size="sm" className="me-1" /> Vérification…
                    </>
                  ) : (
                    'Vérifier'
                  )}
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={() => setEditing(true)}>
                  Changer les accès ou de compte
                </Button>
                <Button
                  size="sm"
                  variant="outline-danger"
                  disabled={disconnecting}
                  onClick={async () => {
                    if (await confirm({ title: 'Déconnecter le compte Google', message: `Détacher le compte ${account.email} du projet ? L'accès accordé à Skipper sera révoqué côté Google.`, confirmLabel: 'Déconnecter', danger: true }))
                      disconnect({ variables: { projectId } });
                  }}
                >
                  {disconnecting ? 'Déconnexion…' : 'Déconnecter'}
                </Button>
              </div>
            )}
            {canManage && editing && (
              <div className="border rounded p-2 mt-2">
                <ConnectForm projectId={projectId} current={account} onCancel={() => setEditing(false)} />
              </div>
            )}
          </>
        )}
        {error && (
          <Alert variant="danger" className="mt-2 mb-0 py-2">
            {error.message}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}
