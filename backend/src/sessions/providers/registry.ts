import { AppError } from '../../errors.js';
import type { ProviderDescription, SessionProvider } from './provider.js';
import { ClaudeProvider } from './claude.js';
import { ShellProvider } from './shell.js';

const providers = new Map<string, SessionProvider>();

export function registerProvider(provider: SessionProvider): void {
  providers.set(provider.type, provider);
}

export function getProvider(type: string): SessionProvider {
  const provider = providers.get(type);
  if (!provider) throw new AppError(`Provider inconnu : ${type}`);
  return provider;
}

export function listProviders(): ProviderDescription[] {
  return [...providers.values()].map((p) => p.describe());
}

// Providers fournis par défaut. Pour en ajouter un : implémenter SessionProvider et l'enregistrer ici.
registerProvider(new ClaudeProvider());
registerProvider(new ShellProvider());
