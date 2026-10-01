import { useQuery } from '@apollo/client';
import type { ReactNode } from 'react';
import { Alert, Badge, Card, Col, ProgressBar, Row, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { SERVER_HEALTH, type ServerHealth } from '../graphql/operations';

/** Mo lisibles : « 850 Mo », « 1,8 Go ». */
export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return '—';
  return mb >= 1024 ? `${(mb / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go` : `${mb} Mo`;
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(seconds / 86400)} j ${Math.floor((seconds % 86400) / 3600)} h`;
}

/** Couleur d'une jauge d'occupation (part utilisée de 0 à 1). */
const gaugeVariant = (used: number) => (used >= 0.9 ? 'danger' : used >= 0.75 ? 'warning' : 'success');

function Gauge({ label, used, total, detail }: { label: string; used: number; total: number; detail: string }) {
  const ratio = total > 0 ? used / total : 0;
  return (
    <div className="mb-3">
      <div className="d-flex justify-content-between small mb-1">
        <span>{label}</span>
        <span className="text-secondary">{detail}</span>
      </div>
      <ProgressBar now={Math.round(ratio * 100)} variant={gaugeVariant(ratio)} style={{ height: 8 }} />
    </div>
  );
}

function Stat({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <Col xs={6} md={3} className="mb-3">
      <div className="fs-4 fw-semibold lh-1">{value}</div>
      <div className="small text-secondary" title={hint}>
        {label}
      </div>
    </Col>
  );
}

/** Bloc « Santé » des paramètres du serveur : mémoire, charge, sessions, processus, Docker et disque. */
export default function ServerHealthCard({ memoryAlertThresholdMb }: { memoryAlertThresholdMb: number }) {
  const { data, loading, error } = useQuery<{ serverHealth: ServerHealth }>(SERVER_HEALTH, { pollInterval: 15_000, fetchPolicy: 'cache-and-network' });
  const h = data?.serverHealth;

  return (
    <Card className="mb-4">
      <Card.Header>
        Santé du serveur
        {h && <span className="small text-secondary ms-2">{h.hostname} · relevé à {new Date(h.checkedAt).toLocaleTimeString()}</span>}
      </Card.Header>
      <Card.Body>
        {error && <Alert variant="danger" className="py-2 small">{error.message}</Alert>}
        {!h && loading && <Spinner animation="border" size="sm" />}
        {h && (
          <>
            {memoryAlertThresholdMb > 0 && h.memory.availableMb < memoryAlertThresholdMb && (
              <Alert variant="danger" className="py-2 small">
                <i className="bi bi-exclamation-triangle me-1" /> Mémoire disponible sous le seuil d'alerte ({formatMb(memoryAlertThresholdMb)}) : terminez des sessions ou abaissez la limite de sessions simultanées.
              </Alert>
            )}
            <Row>
              <Col md={6}>
                <Gauge
                  label="Mémoire"
                  used={h.memory.totalMb - h.memory.availableMb}
                  total={h.memory.totalMb}
                  detail={`${formatMb(h.memory.availableMb)} disponibles sur ${formatMb(h.memory.totalMb)}`}
                />
                <Gauge
                  label="Swap"
                  used={h.memory.swapTotalMb - h.memory.swapFreeMb}
                  total={h.memory.swapTotalMb}
                  detail={h.memory.swapTotalMb ? `${formatMb(h.memory.swapTotalMb - h.memory.swapFreeMb)} utilisés sur ${formatMb(h.memory.swapTotalMb)}` : 'aucun'}
                />
                {h.disk.totalMb !== null && h.disk.freeMb !== null && (
                  <Gauge label="Disque des workspaces" used={h.disk.totalMb - h.disk.freeMb} total={h.disk.totalMb} detail={`${formatMb(h.disk.freeMb)} libres sur ${formatMb(h.disk.totalMb)}`} />
                )}
              </Col>
              <Col md={6}>
                <Row>
                  <Stat
                    value={
                      <>
                        {h.sessions.running}
                        {h.sessions.maxConcurrent > 0 && <span className="fs-6 text-secondary"> / {h.sessions.maxConcurrent}</span>}
                      </>
                    }
                    label="sessions en cours"
                    hint={`${h.sessions.busy} au travail, ${h.sessions.idle} en attente d'instructions`}
                  />
                  <Stat value={h.sessions.queued} label="en file d'attente" />
                  <Stat value={h.terminals} label="terminaux ouverts" />
                  <Stat
                    value={h.claudeProcesses.length}
                    label="processus Claude"
                    hint={h.claudeProcesses.length ? `${formatMb(h.claudeProcesses.reduce((n, p) => n + p.rssMb, 0))} de mémoire au total` : undefined}
                  />
                  <Stat value={h.loadAverage.map((n) => n.toFixed(2)).join(' · ')} label={`charge 1/5/15 min (${h.cpuCount} CPU)`} />
                  <Stat value={formatDuration(h.uptimeSeconds)} label="depuis le démarrage" />
                </Row>
              </Col>
            </Row>

            {h.claudeProcesses.length > 0 && (
              <div className="small text-secondary mb-3">
                Processus Claude : {h.claudeProcesses.map((p) => `${formatMb(p.rssMb)} (depuis ${formatDuration(p.elapsedSeconds)})`).join(' · ')}
              </div>
            )}

            <h6 className="mt-2">
              Docker{' '}
              {h.docker.available ? <Badge bg="success">disponible{h.docker.version ? ` · ${h.docker.version}` : ''}</Badge> : <Badge bg="danger">indisponible</Badge>}
            </h6>
            {h.docker.error && <div className="small text-danger mb-2">{h.docker.error}</div>}
            {h.docker.containers.length > 0 && (
              <Table size="sm" responsive className="small mb-3">
                <thead>
                  <tr>
                    <th>Conteneur</th>
                    <th>État</th>
                    <th>Mémoire</th>
                    <th className="text-end">CPU</th>
                  </tr>
                </thead>
                <tbody>
                  {h.docker.containers.map((c) => (
                    <tr key={c.name}>
                      <td>{c.project ? <Link to={`/projects/${c.project.id}`}>{c.project.name}</Link> : <code>{c.name}</code>}</td>
                      <td>
                        <Badge bg={c.state === 'running' ? 'success' : 'secondary'}>{c.state}</Badge> <span className="text-secondary">{c.status}</span>
                      </td>
                      <td>
                        {c.memoryUsage ?? '—'}
                        {c.memoryPercent !== null && <span className={c.memoryPercent >= 90 ? 'text-danger ms-1' : 'text-secondary ms-1'}>({c.memoryPercent.toFixed(0)} %)</span>}
                      </td>
                      <td className="text-end">{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)} %` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            <h6>Espace des workspaces</h6>
            {h.disk.workspaces.length ? (
              <>
                <Table size="sm" responsive className="small mb-1">
                  <tbody>
                    {h.disk.workspaces.slice(0, 12).map((w) => (
                      <tr key={w.name}>
                        <td>{w.project ? <Link to={`/projects/${w.project.id}`}>{w.name}</Link> : <code>{w.name}</code>}</td>
                        <td className="text-end">{formatMb(w.sizeMb)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="small text-secondary">
                  <code>{h.disk.path}</code>
                  {h.disk.workspacesMeasuredAt && ` · mesuré à ${new Date(h.disk.workspacesMeasuredAt).toLocaleTimeString()}`}
                </div>
              </>
            ) : (
              <div className="small text-secondary">Mesure en cours…</div>
            )}
          </>
        )}
      </Card.Body>
    </Card>
  );
}
