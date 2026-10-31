import os from 'node:os';
import path from 'node:path';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

function logLevel(): LogLevel {
  const value = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (!(logLevels as readonly string[]).includes(value)) {
    throw new Error(`LOG_LEVEL invalide : ${value} (attendu : ${logLevels.join(', ')})`);
  }
  return value as LogLevel;
}

const logTimestamps = ['auto', 'on', 'off'] as const;
export type LogTimestamp = (typeof logTimestamps)[number];

function logTimestamp(): LogTimestamp {
  const value = (process.env.LOG_TIMESTAMP || 'auto').trim().toLowerCase();
  if (!(logTimestamps as readonly string[]).includes(value)) {
    throw new Error(`LOG_TIMESTAMP invalide : ${value} (attendu : ${logTimestamps.join(', ')})`);
  }
  return value as LogTimestamp;
}

export const config = {
  port: Number(env('PORT', '4000')),
  databaseUrl: env('DATABASE_URL', 'postgres://skipper:skipper@localhost:5432/skipper'),
  /** Binaire Claude Code du serveur, pour l'authentification du compte uniquement ; sinon celui du SDK. */
  claudeBin: process.env.CLAUDE_BIN || undefined,
  /** Image Docker des conteneurs de projet (seul environnement d'exécution) et limites par défaut. */
  runnerImage: process.env.SKIPPER_RUNNER_IMAGE || 'skipper-runner:latest',
  runnerMemory: process.env.SKIPPER_RUNNER_MEMORY || '1g',
  /** Plafond CPU par défaut des conteneurs (`--cpus`) ; vide : aucun plafond, les cœurs de l'hôte sont partagés équitablement (CFS) entre conteneurs et backend. */
  runnerCpus: process.env.SKIPPER_RUNNER_CPUS || '',
  /** Dossier commun contenant un sous-dossier par projet (workspace). */
  workspacesRoot: path.resolve(env('WORKSPACES_ROOT', path.join(os.homedir(), 'skipper-workspaces'))),
  /** URL publique de l'application (front) : cible des redirections après connexion, origine autorisée en CORS. */
  appUrl: env('APP_URL', 'http://localhost:5173').replace(/\/+$/, ''),
  /** URL publique de l'API (callback OAuth `${API_URL}/auth/google/callback`, attribut Secure des cookies). */
  apiUrl: env('API_URL', `http://localhost:${env('PORT', '4000')}`).replace(/\/+$/, ''),
  /** Identifiants OAuth Google (console Google Cloud, type « application Web »). */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  /** Niveau minimal du journal (debug, info, warn, error). */
  logLevel: logLevel(),
  /** Horodatage des lignes du journal : auto (absent quand pm2 ou journald datent déjà chaque ligne), on, off. */
  logTimestamp: logTimestamp(),
  /**
   * Forge Forgejo qui héberge les dépôts des projets « hébergés » (voir gitServer/). Sans `FORGEJO_URL` ni `FORGEJO_TOKEN`,
   * l'hébergement de dépôts est indisponible.
   */
  forgejo: {
    /** Adresse publique (navigateurs, conteneurs des sessions, URL de clone), ex. https://skipper.toolso.io/forge. */
    url: (process.env.FORGEJO_URL ?? '').replace(/\/+$/, ''),
    /** Adresse directe depuis le serveur (sans nginx), ex. http://127.0.0.1:3000 ; défaut : l'adresse publique. */
    internalUrl: (process.env.FORGEJO_INTERNAL_URL || process.env.FORGEJO_URL || '').replace(/\/+$/, ''),
    /** Jeton d'un compte administrateur de Forgejo (portée « all »). */
    token: process.env.FORGEJO_TOKEN ?? '',
    /** Organisation qui possède les dépôts des projets. */
    org: process.env.FORGEJO_ORG || 'skipper',
    /** Commande de la CLI Forgejo, pour créer les jetons des personnes (l'API ne le permet pas à un administrateur). */
    cli: (process.env.FORGEJO_CLI || 'docker exec forgejo forgejo').split(/\s+/).filter(Boolean),
    /** Secret des webhooks Forgejo → Skipper (signature HMAC). */
    webhookSecret: process.env.FORGEJO_WEBHOOK_SECRET ?? '',
    /** Adresse à laquelle Forgejo joint Skipper pour ses webhooks ; défaut : le backend en local. */
    webhookUrl: process.env.FORGEJO_WEBHOOK_URL || `http://127.0.0.1:${env('PORT', '4000')}/api/forge/webhook`,
  },
};

/** Forgejo est-il configuré (hébergement de dépôts disponible) ? */
export const forgejoConfigured = (): boolean => Boolean(config.forgejo.url && config.forgejo.token);
