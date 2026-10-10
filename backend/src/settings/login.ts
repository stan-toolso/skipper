import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
// Paquet CommonJS (UMD) : pas d'export nommé utilisable depuis un module ES.
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { claudeSettings, cliEnv } from './claude.js';

const { Terminal: HeadlessTerminal } = xtermHeadless;

/** Binaire Claude Code pour la connexion : CLAUDE_BIN, sinon le CLI installé pour l'utilisateur système, sinon `claude` du PATH. */
export function claudeBinary(): string {
  if (config.claudeBin) return config.claudeBin;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  return 'claude';
}

/**
 * Connexion de l'abonnement Claude d'UNE personne depuis l'interface, en pilotant le flux officiel du CLI
 * dans un pseudo-terminal (on ne réimplémente pas l'OAuth d'Anthropic) : `claude setup-token` imprime un
 * jeton longue durée, rangé chiffré dans le coffre personnel de la personne qui a lancé la connexion, puis
 * passé à ses sessions via CLAUDE_CODE_OAUTH_TOKEN. Le magasin du CLI du serveur n'est jamais écrit.
 * Une connexion appartient à la personne qui l'a lancée : nul autre ne peut la lire, la compléter ni l'annuler.
 *
 * L'interface du CLI redessine l'écran avec des déplacements de curseur : le flux brut ne contient pas le
 * texte complet. On le rejoue donc dans un terminal headless et on lit l'écran.
 */

export interface ClaudeLogin {
  id: string;
  /** Personne qui a lancé la connexion (propriétaire). */
  userId: string;
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
  /** Succès repéré (jeton) : l'enregistrement, asynchrone, suit. */
  successSeen: boolean;
  exited: boolean;
}

const URL_RE = /https:\/\/claude\.com\/[^\s\x07\x1b]*oauth\/authorize\?[^\s\x07\x1b]+/;
// Le préfixe exact du jeton varie selon les versions du CLI : on accepte tout jeton Anthropic assez long.
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/;
const ERROR_RE = /invalid|expired|failed|error/i;
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
  return { id: l.id, userId: l.userId, url: l.url, status: l.status, error: l.error, createdAt: l.createdAt };
}

/** La connexion `id`, si elle appartient à `userId`. */
function ownedLogin(id: string, userId: string): LiveLogin {
  const l = logins.get(id);
  if (!l) throw new NotFoundError('Connexion introuvable ou expirée : recommencez');
  if (l.userId !== userId) throw new AppError("Cette connexion appartient à quelqu'un d'autre", 'FORBIDDEN');
  return l;
}

function finish(l: LiveLogin, status: 'done' | 'failed', error: string | null = null): void {
  if (l.status === 'done' || l.status === 'failed') return;
  l.status = status;
  l.error = error;
  console.log(`[login] ${l.id} ${status}${error ? ` : ${error}` : ''}\n--- écran du CLI ---\n${redactedTail(l)}\n---`);
  clearTimeout(l.timer);
  try {
    l.proc.kill();
  } catch {
    /* déjà terminé */
  }
  // On garde le résultat quelques minutes pour que l'interface puisse le lire.
  setTimeout(() => logins.delete(l.id), 5 * 60_000).unref();
}

/** Analyse l'écran après l'envoi du code : jeton obtenu (rangé dans le coffre de la personne) ou erreur. */
async function checkScreen(l: LiveLogin): Promise<void> {
  if (l.status !== 'exchanging' || l.successSeen) return;
  await screenSettled(l.screen);
  if (l.status !== 'exchanging' || l.successSeen) return;
  const text = screenText(l.screen);
  const t = text.match(TOKEN_RE);
  if (t) {
    l.successSeen = true;
    void claudeSettings
      .forUser(l.userId)
      .then((s) => s.setOauthToken(t[0]))
      .then(() => finish(l, 'done'))
      .catch((err) => finish(l, 'failed', (err as Error).message));
    return;
  }
  if (ERROR_RE.test(text)) finish(l, 'failed', 'Code refusé par Claude : relancez la connexion et collez le code sans le modifier');
}

export const loginService = {
  /** Lance le CLI pour la personne et attend l'URL d'autorisation (au plus 30 s). */
  async start(userId: string): Promise<ClaudeLogin> {
    // Une seule connexion en attente par personne : les précédentes sont annulées.
    for (const l of logins.values()) if (l.userId === userId && (l.status === 'awaiting_code' || l.status === 'starting')) finish(l, 'failed', 'Remplacée par une nouvelle tentative');

    const bin = claudeBinary();
    const args = ['setup-token'];
    let proc: pty.IPty;
    try {
      proc = pty.spawn(bin, args, {
        name: 'xterm-256color',
        // Très large pour que l'URL ne soit pas coupée par le retour à la ligne du terminal.
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: config.workspacesRoot,
        env: { ...cliEnv({}), BROWSER: '/usr/bin/true', TERM: 'xterm-256color', CI: '1' } as Record<string, string>,
      });
    } catch (err) {
      throw new AppError(`Impossible de lancer « ${bin} ${args.join(' ')} » : ${(err as Error).message}. Installez le CLI Claude Code sur le serveur ou définissez CLAUDE_BIN.`);
    }

    const login: LiveLogin = {
      id: randomUUID(),
      userId,
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
          if (login.status === 'done' || login.status === 'failed' || login.successSeen) return;
          const tail = redactedTail(login, 300).split('\n').filter(Boolean).slice(-3).join(' ').trim();
          const msg = `Le CLI s'est arrêté (code ${exitCode})${tail ? ` : ${tail}` : ''}`;
          finish(login, 'failed', msg);
          rejectUrl(new Error(msg));
        }, 500);
      });
    });

    try {
      login.url = await Promise.race([urlFound, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Le CLI n'a pas affiché d'URL d'autorisation en 30 s")), 30_000))]);
    } catch (err) {
      finish(login, 'failed', (err as Error).message);
      throw new AppError((err as Error).message);
    }
    return publicView(login);
  },

  get(id: string, userId: string): ClaudeLogin {
    return publicView(ownedLogin(id, userId));
  },

  /** Transmet le code d'autorisation au CLI et attend l'issue (au plus 60 s). */
  async complete(id: string, code: string, userId: string): Promise<ClaudeLogin> {
    const l = ownedLogin(id, userId);
    if (l.status !== 'awaiting_code') throw new AppError(`Cette connexion n'attend pas de code (état : ${l.status})`);
    const trimmed = code.trim();
    if (!trimmed) throw new AppError('Le code est vide');
    l.status = 'exchanging';
    // Le CLI traite une saisie rapide comme un collage : Entrée est envoyée séparément, après un délai.
    l.proc.write(trimmed);
    await new Promise((r) => setTimeout(r, 600));
    l.proc.write('\r');
    const deadline = Date.now() + 60_000;
    while (l.status === 'exchanging' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (l.status === 'exchanging') finish(l, 'failed', 'Pas de confirmation reçue en 60 s : le code était peut-être incorrect. Recommencez.');
    return publicView(l);
  },

  cancel(id: string, userId: string): boolean {
    if (!logins.has(id)) return false;
    finish(ownedLogin(id, userId), 'failed', 'Annulée');
    return true;
  },

  /** À l'arrêt du serveur : tue les processus en attente. */
  shutdown(): void {
    for (const l of logins.values()) finish(l, 'failed', 'Serveur arrêté');
  },
};
