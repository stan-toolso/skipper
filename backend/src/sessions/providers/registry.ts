import { AppError } from '../../errors.js';
import { claudeSettings } from '../../settings/claude.js';
import { opencodeSettings } from '../../settings/opencode.js';
import type { DescribeContext, ProviderDescription, SessionProvider } from './provider.js';
import { ClaudeProvider } from './claude.js';
import { OpencodeProvider } from './opencode.js';
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

/** Descriptions des types de session ; avec `userId`, les formulaires reflètent les réglages de la personne (modèles autorisés, défauts). */
export async function listProviders(userId?: string | null): Promise<ProviderDescription[]> {
  const ctx: DescribeContext = userId ? { claude: await claudeSettings.forUser(userId), opencode: await opencodeSettings.forUser(userId) } : {};
  return [...providers.values()].map((p) => p.describe(ctx));
}

export const providerTypes = (): string[] => [...providers.keys()];

// Providers fournis par défaut. Pour en ajouter un : implémenter SessionProvider et l'enregistrer ici.
registerProvider(new ClaudeProvider());
registerProvider(new OpencodeProvider());
registerProvider(new ShellProvider());
