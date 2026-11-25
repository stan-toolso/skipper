import { useMutation } from '@apollo/client';
import { Alert, Button, Card, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { TEST_PROJECT_BROWSER, type BrowserCheck } from '../graphql/operations';

const seconds = (ms: number) => `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;

/**
 * Carte « Navigateur headless » des réglages d'un projet : état de l'option et bouton « Tester », qui lance dans
 * le conteneur le même navigateur qu'une session (Chromium, playwright-mcp), ouvre une page locale et en montre la capture.
 */
export default function BrowserCheckCard({ projectId, enabled, canEdit }: { projectId: string; enabled: boolean; canEdit: boolean }) {
  const [test, { data, loading, error }] = useMutation<{ testProjectBrowser: BrowserCheck }>(TEST_PROJECT_BROWSER);
  const r = data?.testProjectBrowser;
  const p = r?.probe;
  return (
    <Card className="mt-3">
      <Card.Header>Navigateur headless</Card.Header>
      <Card.Body className="small">
        <p className="mb-2">
          {enabled ? (
            <>
              <span className="text-success">Activé</span> : chaque session reçoit un Chromium sans fenêtre, piloté par le serveur MCP <code>playwright</code> et lancé au premier outil du navigateur.
            </>
          ) : (
            <>
              <span className="text-secondary">Désactivé</span> : les agents n'ont pas de navigateur (sites web et secrets du coffre inutilisables).
              {canEdit && (
                <>
                  {' '}
                  <Link to={`/projects/${projectId}/edit`}>L'activer</Link>.
                </>
              )}
            </>
          )}{' '}
          « Tester » lance ce navigateur dans le conteneur du projet (démarré au besoin), ouvre une page locale et en fait une capture, comme le ferait un agent.
        </p>
        <Button size="sm" variant="outline-primary" disabled={loading} onClick={() => test({ variables: { id: projectId } }).catch(() => undefined)}>
          {loading ? (
            <>
              <Spinner size="sm" animation="border" className="me-1" /> Test en cours…
            </>
          ) : (
            <>
              <i className="bi bi-play-circle me-1" /> Tester
            </>
          )}
        </Button>
        {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
        {r && !loading && (
          <div className="mt-3">
            <Alert variant={r.ok ? (r.problems.length ? 'warning' : 'success') : 'danger'} className="py-2">
              <i className={`bi ${r.ok ? 'bi-check-circle' : 'bi-x-circle'} me-1`} />
              {r.ok ? `Navigateur opérationnel (${seconds(r.durationMs)}).` : 'Le navigateur ne fonctionne pas dans ce conteneur.'}
              {!r.enabled && r.ok && ' L’option est désactivée : activez-la pour que les sessions le reçoivent.'}
              {r.problems.length > 0 && (
                <ul className="mb-0 mt-1">
                  {r.problems.map((pb) => (
                    <li key={pb.code}>{pb.message}</li>
                  ))}
                </ul>
              )}
            </Alert>
            <dl className="row mb-2">
              {p && (
                <>
                  <dt className="col-3">Chromium</dt>
                  <dd className="col-9">
                    {p.chromiumVersion ?? <span className="text-danger">absent</span>}
                    {p.chromiumPath && (
                      <div className="text-secondary text-break">
                        <code>{p.chromiumPath}</code>
                      </div>
                    )}
                  </dd>
                  <dt className="col-3">playwright-mcp</dt>
                  <dd className="col-9">{p.mcpPath ? (p.mcpVersion ?? 'présent') : <span className="text-danger">absent</span>}</dd>
                  <dt className="col-3">Architecture</dt>
                  <dd className="col-9">{p.arch ?? '—'}</dd>
                  <dt className="col-3">Mémoire disponible</dt>
                  <dd className="col-9">
                    {p.memoryAvailableMb !== null ? `${p.memoryAvailableMb.toLocaleString('fr-FR')} Mo` : '—'}
                    {p.memoryLimitMb !== null && (
                      <span className="text-secondary">
                        {' '}
                        (limite {p.memoryLimitMb.toLocaleString('fr-FR')} Mo{p.memoryUsedMb !== null ? `, ${p.memoryUsedMb.toLocaleString('fr-FR')} Mo utilisés` : ''})
                      </span>
                    )}
                  </dd>
                </>
              )}
              {r.image && (
                <>
                  <dt className="col-3">Image</dt>
                  <dd className="col-9">
                    <code>{r.image}</code>
                  </dd>
                </>
              )}
            </dl>
            <ol className="mb-2 ps-3">
              {r.steps.map((s) => (
                <li key={s.label}>
                  <i className={`bi ${s.ok ? 'bi-check-lg text-success' : 'bi-x-lg text-danger'} me-1`} />
                  {s.label}
                  <span className="text-secondary"> · {seconds(s.durationMs)}</span>
                  {s.detail && <div className={`text-break ${s.ok ? 'text-secondary' : 'text-danger'}`}>{s.detail}</div>}
                </li>
              ))}
            </ol>
            {r.screenshot && <img src={r.screenshot} alt="Capture de la page de test" className="img-fluid border rounded" style={{ maxWidth: 480 }} />}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
