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
  databaseUrl: env('DATABASE_URL', 'postgres://agents:agents@localhost:5432/agents'),
  /** Chemin d'un binaire Claude Code spécifique ; sinon le SDK utilise celui qu'il embarque. */
  claudeBin: process.env.CLAUDE_BIN || undefined,
  /** Dossier commun contenant un sous-dossier par projet (workspace). */
  workspacesRoot: path.resolve(env('WORKSPACES_ROOT', path.join(os.homedir(), 'agents-workspaces'))),
};
