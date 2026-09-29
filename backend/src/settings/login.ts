import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
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
  output: string;
  timer: NodeJS.Timeout;
}

const URL_RE = /https:\/\/claude\.com\/[^\s\x07\x1b]*oauth\/authorize\?[^\s\x07\x1b]+/;
const TOKEN_RE = /sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}/;
const LOGIN_TTL_MS = 15 * 60_000;

const logins = new Map<string, LiveLogin>();

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

/** Sortie du CLI pour le journal du serveur : sans séquences ANSI, jeton masqué. */
function redactedTail(l: LiveLogin, chars = 1500): string {
  return stripAnsi(l.output).replace(/sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+/g, 'sk-ant-oat**-[masqué]').replace(/\n{3,}/g, '\n\n').slice(-chars);
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
        cols: 400,
        rows: 40,
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
      output: '',
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
      if (login.status === 'exchanging') {
        const t = clean.match(TOKEN_RE);
        if (t) {
          void settingsService
            .setOauthToken(t[0])
            .then(() => settingsService.update({ authMode: 'oauth' }))
            .then(() => finish(login, 'done'))
            .catch((err) => finish(login, 'failed', (err as Error).message));
        } else if (/invalid|expired|error|échec|failed/i.test(clean.slice(-600))) {
          finish(login, 'failed', 'Code refusé par Claude : relancez la connexion et collez le code sans le modifier');
        }
      }
    });
    proc.onExit(({ exitCode }) => {
      if (login.status === 'done' || login.status === 'failed') return;
      const tail = stripAnsi(login.output).trim().split('\n').slice(-3).join(' ').trim();
      const msg = `Le CLI s'est arrêté (code ${exitCode})${tail ? ` : ${tail.slice(0, 300)}` : ''}`;
      finish(login, 'failed', msg);
      rejectUrl(new Error(msg));
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
    l.proc.write(trimmed + '\r');

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
