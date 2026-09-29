import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
// Paquet CommonJS (UMD) : pas d'export nommé utilisable depuis un module ES.
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';

const { Terminal: HeadlessTerminal } = xtermHeadless;
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { settingsService } from './service.js';

/**
 * Connexion OAuth depuis l'interface : on pilote le flux officiel du CLI (`claude setup-token`),
 * qui affiche une URL d'autorisation puis attend le code que l'utilisateur obtient sur claude.com.
 * Une fois le code fourni, le CLI imprime un jeton longue durée (`sk-ant-oat01-…`) que l'on chiffre
 * et stocke : il est ensuite passé aux sessions via CLAUDE_CODE_OAUTH_TOKEN.
 * On ne réimplémente donc pas l'OAuth d'Anthropic : ce sont le client et les secrets du CLI.
 */

export interface ClaudeLogin {
  id: string;
  /** URL à ouvrir dans le navigateur pour autoriser Skipper. */
  url: string;
  /** Statut : 'awaiting_code' (URL affichée), 'done' (jeton enregistré), 'failed' (voir `error`). */
  status: 'starting' | 'awaiting_code' | 'exchanging' | 'done' | 'failed';
  error: string | null;
  createdAt: Date;
}

interface LiveLogin extends ClaudeLogin {
  proc: pty.IPty;
  /**
   * Écran reconstitué : l'interface du CLI redessine avec des déplacements de curseur, si bien
   * que le flux brut ne contient pas le texte complet. On le rejoue dans un terminal headless
   * et on lit l'écran, comme le ferait un humain.
   */
  screen: Terminal;
  output: string;
  timer: NodeJS.Timeout;
  /** Jeton repéré dans la sortie (l'enregistrement, asynchrone, suit). */
  tokenSeen: boolean;
}

const URL_RE = /https:\/\/claude\.com\/[^\s\x07\x1b]*oauth\/authorize\?[^\s\x07\x1b]+/;
const PTY_COLS = 400;
const PTY_ROWS = 60;
// Le préfixe exact du jeton varie selon les versions du CLI : on accepte tout jeton Anthropic assez long.
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/;
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

/** Retire séquences ANSI et hyperliens OSC 8 pour analyser la sortie. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\]8;[^;]*;/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[^[\]]/g, '');
}

/** Binaire Claude Code pour `setup-token` : CLAUDE_BIN, sinon le CLI installé pour l'utilisateur, sinon `claude` du PATH. */
function claudeBinary(): string {
  if (config.claudeBin) return config.claudeBin;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  return 'claude';
}

function publicView(l: LiveLogin): ClaudeLogin {
  return { id: l.id, url: l.url, status: l.status, error: l.error, createdAt: l.createdAt };
}

/** Écran du CLI pour le journal du serveur : jeton masqué, lignes vides compactées. */
function redactedTail(l: LiveLogin, chars = 1500): string {
  return screenText(l.screen).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[masqué]').replace(/\n\s*\n(\s*\n)+/g, '\n\n').trim().slice(-chars);
}

function finish(l: LiveLogin, status: 'done' | 'failed', error: string | null = null): void {
  if (l.status === 'done' || l.status === 'failed') return;
  l.status = status;
  l.error = error;
  console.log(`[login] ${l.id} ${status}${error ? ` : ${error}` : ''}\n--- sortie du CLI ---\n${redactedTail(l)}\n---`);
  clearTimeout(l.timer);
  try {
    l.proc.kill();
  } catch {
    /* déjà terminé */
  }
  // On garde le résultat quelques minutes pour que l'interface puisse le lire.
  setTimeout(() => logins.delete(l.id), 5 * 60_000).unref();
}

export const loginService = {
  /** Lance `claude setup-token` et attend l'URL d'autorisation (au plus 30 s). */
  async start(): Promise<ClaudeLogin> {
    // Une seule connexion à la fois : on annule les précédentes encore en attente.
    for (const l of logins.values()) if (l.status === 'awaiting_code' || l.status === 'starting') finish(l, 'failed', 'Remplacée par une nouvelle tentative');

    const bin = claudeBinary();
    let proc: pty.IPty;
    try {
      proc = pty.spawn(bin, ['setup-token'], {
        name: 'xterm-256color',
        // Très large pour que l'URL ne soit pas coupée par le retour à la ligne du terminal.
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: config.workspacesRoot,
        env: { ...process.env, BROWSER: '/usr/bin/true', TERM: 'xterm-256color', CI: '1' } as Record<string, string>,
      });
    } catch (err) {
      throw new AppError(`Impossible de lancer « ${bin} setup-token » : ${(err as Error).message}. Installez le CLI Claude Code sur le serveur ou définissez CLAUDE_BIN.`);
    }

    const login: LiveLogin = {
      id: randomUUID(),
      url: '',
      status: 'starting',
      error: null,
      createdAt: new Date(),
      proc,
      screen: new HeadlessTerminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 2000, allowProposedApi: true }),
      output: '',
      tokenSeen: false,
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
      const clean = stripAnsi(login.output);
      if (!login.url) {
        const m = clean.match(URL_RE);
        if (m) {
          login.url = m[0];
          login.status = 'awaiting_code';
          console.log(`[login] ${login.id} URL d'autorisation obtenue`);
          resolveUrl(login.url);
        }
      }
      if (login.status === 'exchanging' && !login.tokenSeen) {
        // L'écran est lu après que l'émulateur a traité les données (écriture asynchrone).
        login.screen.write('', () => checkScreen(login));
      }
    });
    const checkScreen = (login: LiveLogin) => {
      if (login.status !== 'exchanging' || login.tokenSeen) return;
      {
        // L'écran est entièrement redessiné après la saisie : on l'analyse en entier (avant la
        // saisie, il ne contient ni jeton ni mot d'erreur).
        const after = screenText(login.screen);
        const t = after.match(TOKEN_RE);
        if (t) {
          login.tokenSeen = true;
          void settingsService
            .setOauthToken(t[0])
            .then(() => settingsService.update({ authMode: 'oauth' }))
            .then(() => finish(login, 'done'))
            .catch((err) => finish(login, 'failed', (err as Error).message));
        } else if (/invalid|expired|failed|error/i.test(after)) {
          finish(login, 'failed', 'Code refusé par Claude : relancez la connexion et collez le code sans le modifier');
        }
      }
    };
    proc.onExit(({ exitCode }) => {
      // Les dernières données peuvent arriver après l'événement de fin : on relit l'écran avant de conclure.
      login.screen.write('', () => {
        checkScreen(login);
        setTimeout(() => {
          // Le CLI se termine juste après avoir imprimé le jeton : son enregistrement est en cours.
          if (login.status === 'done' || login.status === 'failed' || login.tokenSeen) return;
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

  /** Transmet le code d'autorisation au CLI et attend le jeton (au plus 60 s). */
  async complete(id: string, code: string): Promise<ClaudeLogin> {
    const l = logins.get(id);
    if (!l) throw new NotFoundError('Connexion introuvable ou expirée : recommencez');
    if (l.status !== 'awaiting_code') throw new AppError(`Cette connexion n'attend pas de code (état : ${l.status})`);
    const trimmed = code.trim();
    if (!trimmed) throw new AppError('Le code est vide');
    l.status = 'exchanging';
    console.log(`[login] ${l.id} code reçu (${trimmed.length} caractères), transmis au CLI`);
    // Le CLI traite une saisie rapide comme un collage : un retour chariot dans le même paquet est
    // absorbé dans le texte au lieu de valider. On envoie donc Entrée séparément, après un délai.
    l.proc.write(trimmed);
    await new Promise((r) => setTimeout(r, 600));
    l.proc.write('\r');

    const deadline = Date.now() + 60_000;
    while (l.status === 'exchanging' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (l.status === 'exchanging') finish(l, 'failed', "Pas de jeton reçu en 60 s : le code était peut-être incorrect. Recommencez.");
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
