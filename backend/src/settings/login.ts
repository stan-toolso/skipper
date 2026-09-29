import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
// Paquet CommonJS (UMD) : pas d'export nommé utilisable depuis un module ES.
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { claudeBinary, serverAuthStatus } from './cli.js';
import { settingsService } from './service.js';

const { Terminal: HeadlessTerminal } = xtermHeadless;

/**
 * Connexion à Claude depuis l'interface, en pilotant les flux officiels du CLI dans un
 * pseudo-terminal (on ne réimplémente pas l'OAuth d'Anthropic) :
 * - `oauth`  : `claude setup-token` imprime un jeton longue durée, que l'on chiffre et stocke, puis
 *              passe aux sessions via CLAUDE_CODE_OAUTH_TOKEN ;
 * - `server` : `claude auth login` range les identifiants (avec jeton de rafraîchissement) dans le
 *              magasin du CLI de l'utilisateur système ; les sessions les trouvent d'elles-mêmes.
 * Dans les deux cas le CLI affiche une URL d'autorisation puis attend le code obtenu sur claude.com.
 *
 * L'interface du CLI redessine l'écran avec des déplacements de curseur : le flux brut ne contient
 * pas le texte complet. On le rejoue donc dans un terminal headless et on lit l'écran.
 */

export type ClaudeLoginKind = 'oauth' | 'server';

export interface ClaudeLogin {
  id: string;
  kind: ClaudeLoginKind;
  /** URL à ouvrir dans le navigateur pour autoriser Skipper. */
  url: string;
  /** 'awaiting_code' (URL affichée), 'exchanging' (code envoyé), 'done', 'failed' (voir `error`). */
  status: 'starting' | 'awaiting_code' | 'exchanging' | 'done' | 'failed';
  error: string | null;
  createdAt: Date;
}

interface LiveLogin extends ClaudeLogin {
  proc: pty.IPty;
  screen: Terminal;
  output: string;
  timer: NodeJS.Timeout;
  /** Succès repéré (jeton ou message de connexion) : l'enregistrement, asynchrone, suit. */
  successSeen: boolean;
  exited: boolean;
}

const URL_RE = /https:\/\/claude\.com\/[^\s\x07\x1b]*oauth\/authorize\?[^\s\x07\x1b]+/;
// Le préfixe exact du jeton varie selon les versions du CLI : on accepte tout jeton Anthropic assez long.
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/;
const ERROR_RE = /invalid|expired|failed|error/i;
const LOGGED_IN_RE = /logged in|login successful|successfully logged|signed in/i;
const PTY_COLS = 400;
const PTY_ROWS = 60;
const LOGIN_TTL_MS = 15 * 60_000;

const logins = new Map<string, LiveLogin>();

/** Texte de l'écran reconstitué (lignes repliées recollées, espaces de fin retirés). */
function screenText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n');
}

/** Attend que l'émulateur ait traité tout ce qui lui a été écrit. */
function screenSettled(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', () => resolve()));
}

/** Retire séquences ANSI et hyperliens OSC 8 (pour extraire l'URL du flux brut). */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\]8;[^;]*;/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[^[\]]/g, '');
}

/** Écran du CLI pour le journal du serveur : jeton masqué, lignes vides compactées. */
function redactedTail(l: LiveLogin, chars = 1500): string {
  return screenText(l.screen).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[masqué]').replace(/\n\s*\n(\s*\n)+/g, '\n\n').trim().slice(-chars);
}

function publicView(l: LiveLogin): ClaudeLogin {
  return { id: l.id, kind: l.kind, url: l.url, status: l.status, error: l.error, createdAt: l.createdAt };
}

function finish(l: LiveLogin, status: 'done' | 'failed', error: string | null = null): void {
  if (l.status === 'done' || l.status === 'failed') return;
  l.status = status;
  l.error = error;
  console.log(`[login] ${l.id} (${l.kind}) ${status}${error ? ` : ${error}` : ''}\n--- écran du CLI ---\n${redactedTail(l)}\n---`);
  clearTimeout(l.timer);
  try {
    l.proc.kill();
  } catch {
    /* déjà terminé */
  }
  // On garde le résultat quelques minutes pour que l'interface puisse le lire.
  setTimeout(() => logins.delete(l.id), 5 * 60_000).unref();
}

/** Succès du parcours `server` : le CLI doit confirmer qu'un compte est connecté. */
async function confirmServerLogin(l: LiveLogin): Promise<void> {
  const status = await serverAuthStatus();
  if (status.loggedIn) {
    await settingsService.update({ authMode: 'server' });
    settingsService.invalidateVerification();
    finish(l, 'done');
  } else {
    finish(l, 'failed', `Le CLI ne confirme pas la connexion${status.error ? ` : ${status.error}` : ''}`);
  }
}

/** Analyse l'écran après l'envoi du code ; renvoie true si une issue a été trouvée. */
async function checkScreen(l: LiveLogin): Promise<void> {
  if (l.status !== 'exchanging' || l.successSeen) return;
  await screenSettled(l.screen);
  if (l.status !== 'exchanging' || l.successSeen) return;
  // L'écran est entièrement redessiné après la saisie : on l'analyse en entier (avant la saisie,
  // il ne contient ni jeton, ni message de connexion, ni mot d'erreur).
  const text = screenText(l.screen);
  if (l.kind === 'oauth') {
    const t = text.match(TOKEN_RE);
    if (t) {
      l.successSeen = true;
      void settingsService
        .setOauthToken(t[0])
        .then(() => settingsService.update({ authMode: 'oauth' }))
        .then(() => finish(l, 'done'))
        .catch((err) => finish(l, 'failed', (err as Error).message));
      return;
    }
  } else if (LOGGED_IN_RE.test(text) || l.exited) {
    l.successSeen = true;
    void confirmServerLogin(l).catch((err) => finish(l, 'failed', (err as Error).message));
    return;
  }
  if (ERROR_RE.test(text)) finish(l, 'failed', 'Code refusé par Claude : relancez la connexion et collez le code sans le modifier');
}

export const loginService = {
  /** Lance le CLI et attend l'URL d'autorisation (au plus 30 s). */
  async start(kind: ClaudeLoginKind = 'oauth'): Promise<ClaudeLogin> {
    // Une seule connexion à la fois : on annule les précédentes encore en attente.
    for (const l of logins.values()) if (l.status === 'awaiting_code' || l.status === 'starting') finish(l, 'failed', 'Remplacée par une nouvelle tentative');

    const bin = claudeBinary();
    const args = kind === 'server' ? ['auth', 'login', '--claudeai'] : ['setup-token'];
    let proc: pty.IPty;
    try {
      proc = pty.spawn(bin, args, {
        name: 'xterm-256color',
        // Très large pour que l'URL ne soit pas coupée par le retour à la ligne du terminal.
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: config.workspacesRoot,
        env: { ...process.env, BROWSER: '/usr/bin/true', TERM: 'xterm-256color', CI: '1' } as Record<string, string>,
      });
    } catch (err) {
      throw new AppError(`Impossible de lancer « ${bin} ${args.join(' ')} » : ${(err as Error).message}. Installez le CLI Claude Code sur le serveur ou définissez CLAUDE_BIN.`);
    }

    const login: LiveLogin = {
      id: randomUUID(),
      kind,
      url: '',
      status: 'starting',
      error: null,
      createdAt: new Date(),
      proc,
      screen: new HeadlessTerminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 2000, allowProposedApi: true }),
      output: '',
      successSeen: false,
      exited: false,
      timer: setTimeout(() => finish(login, 'failed', 'Délai dépassé : recommencez la connexion'), LOGIN_TTL_MS),
    };
    logins.set(login.id, login);

    let resolveUrl: (url: string) => void = () => {};
    let rejectUrl: (err: Error) => void = () => {};
    const urlFound = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    proc.onData((data) => {
      login.output = (login.output + data).slice(-200_000);
      login.screen.write(data);
      if (!login.url) {
        const m = stripAnsi(login.output).match(URL_RE);
        if (m) {
          login.url = m[0];
          login.status = 'awaiting_code';
          console.log(`[login] ${login.id} (${kind}) URL d'autorisation obtenue`);
          resolveUrl(login.url);
        }
      }
      if (login.status === 'exchanging') void checkScreen(login);
    });
    proc.onExit(({ exitCode }) => {
      login.exited = true;
      // Les dernières données peuvent arriver après l'événement de fin : on relit l'écran avant de conclure.
      void checkScreen(login).then(() => {
        setTimeout(() => {
          // Le CLI se termine juste après le succès : son enregistrement est peut-être en cours.
          if (login.status === 'done' || login.status === 'failed' || login.successSeen) return;
          const tail = redactedTail(login, 300).split('\n').filter(Boolean).slice(-3).join(' ').trim();
          const msg = `Le CLI s'est arrêté (code ${exitCode})${tail ? ` : ${tail}` : ''}`;
          finish(login, 'failed', msg);
          rejectUrl(new Error(msg));
        }, 500);
      });
    });

    try {
      login.url = await Promise.race([
        urlFound,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Le CLI n'a pas affiché d'URL d'autorisation en 30 s")), 30_000)),
      ]);
    } catch (err) {
      finish(login, 'failed', (err as Error).message);
      throw new AppError((err as Error).message);
    }
    return publicView(login);
  },

  get(id: string): ClaudeLogin {
    const l = logins.get(id);
    if (!l) throw new NotFoundError('Connexion introuvable ou expirée : recommencez');
    return publicView(l);
  },

  /** Transmet le code d'autorisation au CLI et attend l'issue (au plus 60 s). */
  async complete(id: string, code: string): Promise<ClaudeLogin> {
    const l = logins.get(id);
    if (!l) throw new NotFoundError('Connexion introuvable ou expirée : recommencez');
    if (l.status !== 'awaiting_code') throw new AppError(`Cette connexion n'attend pas de code (état : ${l.status})`);
    const trimmed = code.trim();
    if (!trimmed) throw new AppError('Le code est vide');
    l.status = 'exchanging';
    console.log(`[login] ${l.id} (${l.kind}) code reçu (${trimmed.length} caractères), transmis au CLI`);
    // Le CLI traite une saisie rapide comme un collage : un retour chariot dans le même paquet est
    // absorbé dans le texte au lieu de valider. On envoie donc Entrée séparément, après un délai.
    l.proc.write(trimmed);
    await new Promise((r) => setTimeout(r, 600));
    l.proc.write('\r');

    const deadline = Date.now() + 60_000;
    while (l.status === 'exchanging' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (l.status === 'exchanging') finish(l, 'failed', 'Pas de confirmation reçue en 60 s : le code était peut-être incorrect. Recommencez.');
    return publicView(l);
  },

  cancel(id: string): boolean {
    const l = logins.get(id);
    if (!l) return false;
    finish(l, 'failed', 'Annulée');
    return true;
  },

  /** À l'arrêt du serveur : tue les processus en attente. */
  shutdown(): void {
    for (const l of logins.values()) finish(l, 'failed', 'Serveur arrêté');
  },
};
