import os from 'node:os';
import path from 'node:path';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

export const config = {
  port: Number(env('PORT', '4000')),
  databaseUrl: env('DATABASE_URL', 'postgres://skipper:skipper@localhost:5432/skipper'),
  /** Binaire Claude Code du serveur, pour l'authentification du compte uniquement ; sinon celui du SDK. */
  claudeBin: process.env.CLAUDE_BIN || undefined,
  /** Image Docker des conteneurs de projet (seul environnement d'exécution) et limites par défaut. */
  runnerImage: process.env.SKIPPER_RUNNER_IMAGE || 'skipper-runner:latest',
  runnerMemory: process.env.SKIPPER_RUNNER_MEMORY || '1g',
  runnerCpus: process.env.SKIPPER_RUNNER_CPUS || '1',
  /** Dossier commun contenant un sous-dossier par projet (workspace). */
  workspacesRoot: path.resolve(env('WORKSPACES_ROOT', path.join(os.homedir(), 'skipper-workspaces'))),
  /** URL publique de l'application (front) : cible des redirections après connexion, origine autorisée en CORS. */
  appUrl: env('APP_URL', 'http://localhost:5173').replace(/\/+$/, ''),
  /** URL publique de l'API (callback OAuth `${API_URL}/auth/google/callback`, attribut Secure des cookies). */
  apiUrl: env('API_URL', `http://localhost:${env('PORT', '4000')}`).replace(/\/+$/, ''),
  /** Identifiants OAuth Google (console Google Cloud, type « application Web »). */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
};
