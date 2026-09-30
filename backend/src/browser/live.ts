import WebSocket from 'ws';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import type { BrowserMcpServer } from '../runners/types.js';
import { CdpClient } from './cdp.js';

/**
 * Vue en direct du navigateur headless des sessions.
 *
 * Le provider Claude enregistre le Chromium de chaque session (port CDP dans le conteneur du projet).
 * Tant qu'au moins une personne regarde (WebSocket `/browsers/<session>`), le backend s'attache au
 * navigateur par CDP et diffuse le screencast de l'onglet que pilote l'agent : Chromium n'envoie une
 * image (JPEG) que lorsque la page change. Personne ne regarde : aucune connexion, aucun coût.
 *
 * Messages envoyés au client : images JPEG en binaire ; en texte, du JSON :
 * - `{ type: 'status', state: 'waiting' | 'live' | 'ended' | 'error', message? }`
 * - `{ type: 'page', url, title, tabs }` (onglet suivi, nombre d'onglets ouverts).
 */

interface LiveBrowser {
  project: Project;
  cdp: BrowserMcpServer['cdp'];
  /** L'agent a utilisé le navigateur (un outil `mcp__playwright__*`) : la vue est proposée dans la sidebar. */
  used: boolean;
}

type StatusState = 'waiting' | 'live' | 'ended' | 'error';

interface PageTarget {
  targetId: string;
  url: string;
  title: string;
}

/** Au-delà, un spectateur lent ne reçoit plus d'images jusqu'à ce qu'il ait rattrapé son retard. */
const MAX_BUFFERED = 2 * 1024 * 1024;
/** Délai avant de fermer la connexion CDP quand le dernier spectateur part (rechargement, changement d'onglet). */
const IDLE_CLOSE_MS = 10_000;
const RETRY_MS = 3_000;

/** Connexion CDP d'une session et diffusion du screencast de l'onglet suivi. */
class BrowserStream {
  private cdp: CdpClient | null = null;
  private stopped = false;
  private readonly pages = new Map<string, PageTarget>();
  private current: { targetId: string; sessionId: string } | null = null;
  lastFrame: Buffer | null = null;

  constructor(
    private readonly browser: LiveBrowser,
    private readonly broadcast: (data: Buffer | string, isFrame: boolean) => void,
    private readonly onFailure: (err: Error) => void,
  ) {}

  async start(): Promise<void> {
    const cdp = await CdpClient.connect(runner.cdpTunnelCommand(this.browser.project, this.browser.cdp.port), this.browser.cdp.browserPath);
    if (this.stopped) return cdp.close();
    this.cdp = cdp;
    cdp.on('event', (method: string, params: Record<string, unknown>, sessionId?: string) => void this.onEvent(method, params, sessionId).catch(() => undefined));
    cdp.on('error', () => undefined);
    cdp.on('close', () => {
      if (!this.stopped) this.onFailure(new Error('Connexion au navigateur perdue'));
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') this.pages.set(t.targetId, { targetId: t.targetId, url: t.url, title: t.title });
    // L'onglet le plus récent est celui que l'agent a ouvert en dernier.
    const last = [...this.pages.keys()].at(-1);
    if (last) await this.follow(last);
  }

  stop(): void {
    this.stopped = true;
    this.cdp?.close();
    this.cdp = null;
  }

  pageMessage(): string | null {
    const page = this.current ? this.pages.get(this.current.targetId) : null;
    return page ? JSON.stringify({ type: 'page', url: page.url, title: page.title, tabs: this.pages.size }) : null;
  }

  private async onEvent(method: string, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    switch (method) {
      case 'Page.screencastFrame': {
        if (sessionId !== this.current?.sessionId) return;
        void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => undefined);
        this.lastFrame = Buffer.from(String(params.data), 'base64');
        this.broadcast(this.lastFrame, true);
        return;
      }
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const t = params.targetInfo as TargetInfo;
        if (t.type !== 'page') return;
        const known = this.pages.has(t.targetId);
        this.pages.set(t.targetId, { targetId: t.targetId, url: t.url, title: t.title });
        // Un nouvel onglet (browser_tabs, lien target=_blank) : l'agent y travaille désormais.
        if (!known) await this.follow(t.targetId);
        else if (t.targetId === this.current?.targetId) this.sendPage();
        return;
      }
      case 'Target.targetDestroyed': {
        const id = String(params.targetId);
        this.pages.delete(id);
        if (id === this.current?.targetId) {
          this.current = null;
          const next = [...this.pages.keys()].at(-1);
          if (next) await this.follow(next);
        } else this.sendPage();
        return;
      }
    }
  }

  private async follow(targetId: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp || this.current?.targetId === targetId) return;
    if (this.current) {
      const previous = this.current.sessionId;
      await cdp.send('Page.stopScreencast', {}, previous).catch(() => undefined);
      await cdp.send('Target.detachFromTarget', { sessionId: previous }).catch(() => undefined);
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.current = { targetId, sessionId };
    this.sendPage();
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800 }, sessionId);
  }

  private sendPage(): void {
    const msg = this.pageMessage();
    if (msg) this.broadcast(msg, false);
  }
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

class LiveBrowserService {
  private readonly browsers = new Map<string, LiveBrowser>();
  private readonly viewers = new Map<string, Set<WebSocket>>();
  private readonly streams = new Map<string, BrowserStream>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  /** Chromium de la session démarré (début de session). */
  register(sessionId: string, project: Project, cdp: BrowserMcpServer['cdp']): void {
    this.browsers.set(sessionId, { project, cdp, used: false });
    if (this.viewers.get(sessionId)?.size) this.startStream(sessionId);
  }

  /** L'agent a utilisé un outil du navigateur. */
  markUsed(sessionId: string): void {
    const b = this.browsers.get(sessionId);
    if (b) b.used = true;
  }

  /** Chromium de la session arrêté (fin de session) : les spectateurs gardent la dernière image. */
  unregister(sessionId: string): void {
    if (!this.browsers.delete(sessionId)) return;
    this.stopStream(sessionId);
    this.send(sessionId, status('ended', 'Session terminée : navigateur fermé'));
  }

  /** Vue proposée dans l'interface : un navigateur tourne pour la session et l'agent s'en est servi. */
  isActive(sessionId: string): boolean {
    return this.browsers.get(sessionId)?.used ?? false;
  }

  attach(sessionId: string, ws: WebSocket): void {
    let set = this.viewers.get(sessionId);
    if (!set) this.viewers.set(sessionId, (set = new Set()));
    set.add(ws);
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
    ws.on('close', () => this.detach(sessionId, ws));
    ws.on('error', () => undefined);

    const stream = this.streams.get(sessionId);
    if (stream) {
      ws.send(status('live'));
      const page = stream.pageMessage();
      if (page) ws.send(page);
      if (stream.lastFrame) ws.send(stream.lastFrame);
    } else if (this.browsers.has(sessionId)) this.startStream(sessionId);
    else ws.send(status('waiting', "Pas de navigateur ouvert pour cette session : il démarre avec la session si l'option navigateur du projet est activée"));
  }

  private detach(sessionId: string, ws: WebSocket): void {
    const set = this.viewers.get(sessionId);
    set?.delete(ws);
    if (set?.size) return;
    this.viewers.delete(sessionId);
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.set(
      sessionId,
      setTimeout(() => {
        this.idleTimers.delete(sessionId);
        if (!this.viewers.get(sessionId)?.size) this.stopStream(sessionId);
      }, IDLE_CLOSE_MS),
    );
  }

  private startStream(sessionId: string): void {
    const browser = this.browsers.get(sessionId);
    if (!browser || this.streams.has(sessionId)) return;
    clearTimeout(this.retryTimers.get(sessionId));
    this.retryTimers.delete(sessionId);
    const fail = (err: Error) => {
      if (this.streams.get(sessionId) !== stream) return;
      this.stopStream(sessionId);
      this.send(sessionId, status('error', err.message));
      // Nouvelle tentative tant que la session tourne et que quelqu'un regarde.
      if (this.browsers.has(sessionId) && this.viewers.get(sessionId)?.size) {
        this.retryTimers.set(
          sessionId,
          setTimeout(() => {
            this.retryTimers.delete(sessionId);
            if (this.viewers.get(sessionId)?.size) this.startStream(sessionId);
          }, RETRY_MS),
        );
      }
    };
    const stream = new BrowserStream(browser, (data, isFrame) => this.send(sessionId, data, isFrame), fail);
    this.streams.set(sessionId, stream);
    stream
      .start()
      .then(() => this.streams.get(sessionId) === stream && this.send(sessionId, status('live')))
      .catch((err: Error) => {
        console.warn(`[browser] vue en direct de la session ${sessionId} : ${err.message}`);
        fail(err);
      });
  }

  private stopStream(sessionId: string): void {
    this.streams.get(sessionId)?.stop();
    this.streams.delete(sessionId);
    clearTimeout(this.retryTimers.get(sessionId));
    this.retryTimers.delete(sessionId);
  }

  private send(sessionId: string, data: Buffer | string, isFrame = false): void {
    for (const ws of this.viewers.get(sessionId) ?? []) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (isFrame && ws.bufferedAmount > MAX_BUFFERED) continue;
      ws.send(data);
    }
  }
}

function status(state: StatusState, message?: string): string {
  return JSON.stringify({ type: 'status', state, ...(message ? { message } : {}) });
}

export const liveBrowserService = new LiveBrowserService();
