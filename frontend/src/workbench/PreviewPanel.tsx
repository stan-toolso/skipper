import { useMutation } from '@apollo/client';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal } from 'react-bootstrap';
import { useDialogs } from '../components/Dialogs';
import { PREVIEW, PREVIEW_ACCESS_URL, PREVIEW_LOG, SEND_SESSION_MESSAGE, START_PREVIEW, STOP_PREVIEW } from '../graphql/operations';
import { CONFIGURE_PREVIEW_PROMPT, formatDuration, previewBusy, previewStepLabel, previewSummary, type PreviewInfo } from '../lib/preview';
import { usePollingQuery } from '../lib/usePollingQuery';

/** QR code en SVG (cases sombres sur fond clair, couleurs du thème réservées aux QR codes pour rester lisibles). */
function QrCode({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2},${r + 2}h1v1h-1z`;
    return { n: n + 4, d };
  }, [text]);
  return (
    <svg className="preview-qr" viewBox={`0 0 ${svg.n} ${svg.n}`} role="img" aria-label="QR code de l'aperçu" shapeRendering="crispEdges">
      <rect width={svg.n} height={svg.n} className="preview-qr-bg" />
      <path d={svg.d} className="preview-qr-fg" />
    </svg>
  );
}

/**
 * Onglet « Aperçu » du panneau de droite : l'application de la branche, servie par son serveur de développement dans le
 * conteneur du projet. Lancement (dépendances liées depuis le cache ou installées, puis serveur), progression et journal,
 * application dans un cadre, nouvel onglet, plein écran, QR code pour l'ouvrir sur un téléphone, relance et arrêt.
 */
export default function PreviewPanel({ worksessionId, sessionId }: { worksessionId: string; sessionId: string | null }) {
  const { showError, confirm } = useDialogs();
  const [logOpen, setLogOpen] = useState(false);
  const q = usePollingQuery<{ preview: PreviewInfo }>(PREVIEW, { variables: { worksessionId }, pollInterval: 2500 });
  const p = q.data?.preview;
  const busy = previewBusy(p?.status);
  const showLog = logOpen || busy || p?.status === 'FAILED';
  const logQ = usePollingQuery<{ previewLog: string }>(PREVIEW_LOG, { variables: { worksessionId }, skip: !showLog, pollInterval: busy ? 1500 : 5000 });
  const [start, { loading: starting }] = useMutation<{ startPreview: PreviewInfo }>(START_PREVIEW, { variables: { worksessionId }, onError: (e) => void showError(e), onCompleted: () => void logQ.refetch() });
  const [stop, { loading: stopping }] = useMutation<{ stopPreview: PreviewInfo }>(STOP_PREVIEW, { variables: { worksessionId }, onError: (e) => void showError(e) });
  const [accessUrl] = useMutation<{ previewAccessUrl: string }>(PREVIEW_ACCESS_URL);
  const [sendMessage, { loading: sending }] = useMutation(SEND_SESSION_MESSAGE);

  // Cadre : la première ouverture passe par un lien d'accès (pose le cookie du sous-domaine), les suivantes par l'adresse directe.
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [granted, setGranted] = useState(false);
  const [full, setFull] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const running = p?.status === 'RUNNING';
  const startedAt = p?.startedAt ?? null;
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    if (granted && p?.url) {
      setFrameSrc(p.url);
      return;
    }
    accessUrl({ variables: { worksessionId } })
      .then((res) => {
        if (cancelled || !res.data) return;
        setFrameSrc(res.data.previewAccessUrl);
        setGranted(true);
      })
      .catch((e) => void showError(e));
    return () => {
      cancelled = true;
    };
    // Un nouveau lancement (startedAt) recharge le cadre ; le lien d'accès n'est demandé qu'une fois.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, startedAt, worksessionId]);

  // Temps écoulé pendant le lancement, rafraîchi chaque seconde.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logQ.data?.previewLog]);

  const openInTab = async () => {
    // Fenêtre ouverte tout de suite (sinon bloquée comme fenêtre surgissante), adresse donnée quand le lien est prêt.
    const w = window.open('about:blank', '_blank');
    try {
      const res = await accessUrl({ variables: { worksessionId } });
      if (w && res.data) w.location.href = res.data.previewAccessUrl;
    } catch (e) {
      w?.close();
      void showError(e);
    }
  };
  const showQr = async () => {
    try {
      const res = await accessUrl({ variables: { worksessionId } });
      if (res.data) setQr(res.data.previewAccessUrl);
    } catch (e) {
      void showError(e);
    }
  };
  const askAgent = async () => {
    if (!sessionId) return;
    const ok = await confirm({ title: "Configurer l'aperçu", message: "L'agent de cette session reçoit la consigne de créer .skipper/preview.json (commande du serveur de développement, port $PORT) et de vérifier qu'il démarre.", confirmLabel: 'Envoyer la consigne' });
    if (ok) await sendMessage({ variables: { id: sessionId, text: CONFIGURE_PREVIEW_PROMPT } }).catch((e) => void showError(e));
  };
  const reload = () => {
    if (p?.url && granted) setFrameSrc(p.url);
    setFrameKey((k) => k + 1);
  };

  if (!p) {
    return <div className="git-body"><div className="git-empty p-2">{q.error ? q.error.message : "Chargement de l'aperçu…"}</div></div>;
  }
  if (!p.enabled) {
    return (
      <div className="git-body preview-panel">
        <div className="preview-empty">
          <i className="bi bi-window" />
          <p>Les aperçus en direct ne sont pas activés sur ce serveur.</p>
          <p className="text-muted small">Il faut définir <code>PREVIEW_URL</code> (adresse générique des aperçus, DNS et certificat) : voir DEPLOY.md.</p>
        </div>
      </div>
    );
  }
  if (!p.configured) {
    return (
      <div className="git-body preview-panel">
        <div className="preview-empty">
          <i className="bi bi-window" />
          <p>Voir l'application de cette branche en direct, sans rien déployer.</p>
          {p.configError ? (
            <Alert variant="warning" className="py-1 small text-start">{p.configError}</Alert>
          ) : (
            <p className="text-muted small">Skipper n'a pas trouvé comment lancer le serveur de développement : ajoutez <code>.skipper/preview.json</code> au dépôt (une commande qui écoute sur <code>$PORT</code>), ou laissez l'agent le faire.</p>
          )}
          {sessionId && (
            <button type="button" className="cc-btn accent" disabled={sending} onClick={() => void askAgent()}>
              <i className="bi bi-robot me-1" /> Demander à l'agent de le configurer
            </button>
          )}
        </div>
      </div>
    );
  }

  const elapsed = busy && p.startedAt ? formatDuration(Math.max(0, now - new Date(p.startedAt).getTime())) : null;
  return (
    <div className="preview-panel">
      <div className="preview-bar">
        {running ? (
          <>
            <span className="preview-state ok" title={`${previewSummary(p)}\n${p.command ?? ''}`}><i className="bi bi-circle-fill" /> {previewSummary(p)}</span>
            <span className="preview-actions">
              <button type="button" className="git-icon-btn" title="Recharger" onClick={reload}><i className="bi bi-arrow-clockwise" /></button>
              <button type="button" className="git-icon-btn" title="Plein écran" onClick={() => setFull(true)}><i className="bi bi-arrows-fullscreen" /></button>
              <button type="button" className="git-icon-btn" title="Ouvrir dans un nouvel onglet" onClick={() => void openInTab()}><i className="bi bi-box-arrow-up-right" /></button>
              <button type="button" className="git-icon-btn" title="Ouvrir sur un téléphone (QR code)" onClick={() => void showQr()}><i className="bi bi-qr-code" /></button>
              <button type="button" className="git-icon-btn" title="Journal" onClick={() => setLogOpen((v) => !v)}><i className="bi bi-terminal" /></button>
              <button type="button" className="git-icon-btn" title="Relancer (réinstalle si les dépendances ont changé)" disabled={starting} onClick={() => void start()}><i className="bi bi-arrow-repeat" /></button>
              <button type="button" className="git-icon-btn" title="Arrêter" disabled={stopping} onClick={() => void stop()}><i className="bi bi-stop-fill" /></button>
            </span>
          </>
        ) : busy ? (
          <>
            <span className="preview-state busy"><i className="bi bi-arrow-repeat spin" /> {previewStepLabel(p.status)}{elapsed ? ` ${elapsed}` : ''}</span>
            <span className="preview-actions">
              <button type="button" className="git-icon-btn" title="Arrêter" disabled={stopping} onClick={() => void stop()}><i className="bi bi-stop-fill" /></button>
            </span>
          </>
        ) : (
          <>
            <span className={`preview-state${p.status === 'FAILED' ? ' failed' : ''}`}>{previewStepLabel(p.status)}</span>
            <span className="preview-actions">
              <button type="button" className="git-icon-btn" title="Journal" onClick={() => setLogOpen((v) => !v)}><i className="bi bi-terminal" /></button>
            </span>
          </>
        )}
      </div>

      {!running && !busy && (
        <div className="preview-empty">
          <i className="bi bi-window" />
          {p.error && <Alert variant={p.status === 'FAILED' ? 'danger' : 'secondary'} className="py-1 small text-start">{p.error}</Alert>}
          <button type="button" className="cc-btn accent" disabled={starting} onClick={() => void start()}>
            <i className={`bi ${starting ? 'bi-arrow-repeat spin' : 'bi-play-fill'} me-1`} /> {p.status === 'FAILED' ? "Relancer l'aperçu" : "Lancer l'aperçu"}
          </button>
          <p className="text-muted small mt-2">
            <code>{p.command}</code>
            <br />
            {p.configSource}
          </p>
        </div>
      )}

      {running && frameSrc && (
        <iframe key={frameKey} className="preview-frame" src={frameSrc} title="Aperçu de l'application" allow="clipboard-read; clipboard-write; fullscreen; microphone" />
      )}

      {showLog && (
        <pre ref={logRef} className={`preview-log${running ? ' docked' : ''}`}>{logQ.data?.previewLog || '…'}</pre>
      )}

      <Modal show={full} onHide={() => setFull(false)} fullscreen>
        <Modal.Header closeButton>
          <Modal.Title className="fs-6">Aperçu · {previewSummary(p)}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="p-0">{full && p.url && <iframe className="preview-frame full" src={p.url} allow="clipboard-read; clipboard-write; fullscreen; microphone" title="Aperçu de l'application (plein écran)" />}</Modal.Body>
      </Modal>

      <Modal show={qr !== null} onHide={() => setQr(null)} centered size="sm">
        <Modal.Header closeButton>
          <Modal.Title className="fs-6">Ouvrir sur un téléphone</Modal.Title>
        </Modal.Header>
        <Modal.Body className="text-center">
          {qr && <QrCode text={qr} />}
          <p className="small text-muted mt-2 mb-0">Lien personnel, à usage unique, valable 10 minutes : il ouvre l'aperçu sans connexion à Skipper.</p>
        </Modal.Body>
      </Modal>
    </div>
  );
}
