import { userRepository } from '../users/repository.js';
import { vaultService } from '../vault/service.js';
import { claudeSettings } from './claude.js';
import { decryptSecret } from './crypto.js';
import { githubService } from './github.js';
import { settingsRepository } from './repository.js';
import type { ClaudeSettings } from './types.js';

/**
 * Reprise des réglages Claude et GitHub de l'application (une version antérieure les gardait pour tout le
 * monde dans `app_settings`) : ils deviennent ceux du premier administrateur, dans son coffre personnel
 * (jetons applicatifs) et ses réglages, puis sont effacés de `app_settings`. Exécuté une fois au démarrage.
 */

interface LegacyClaudeSecrets {
  oauthToken?: string;
  apiKey?: string;
}

interface LegacyGithubSecrets {
  token: string;
  login: string;
  scopes?: string[];
  avatarUrl?: string | null;
  method?: 'pat' | 'oauth';
}

const LEGACY_KEYS = ['claude', 'claude.secrets', 'claude.verification', 'github', 'github.secrets'];

export async function migrateLegacyCredentials(): Promise<string[]> {
  const [claudeSecrets, claude, github] = await Promise.all([
    settingsRepository.get<LegacyClaudeSecrets>('claude.secrets'),
    settingsRepository.get<Partial<ClaudeSettings> & { authMode?: string }>('claude'),
    settingsRepository.get<LegacyGithubSecrets>('github.secrets'),
  ]);
  if (!claudeSecrets && !claude && !github) return [];
  const admin = (await userRepository.list()).filter((u) => u.isAdmin).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  const done: string[] = [];
  if (admin) {
    const settings = await claudeSettings.forUser(admin.id);
    if (claude) {
      const { authMode: _mode, ...rest } = claude;
      await settings.update({ defaultModel: rest.defaultModel ?? null, allowedModels: rest.allowedModels ?? [], fallbackModel: rest.fallbackModel ?? null, monthlyBudgetUsd: rest.monthlyBudgetUsd ?? null, sessionBudgetUsd: rest.sessionBudgetUsd ?? null, defaultMaxTurns: rest.defaultMaxTurns ?? null }).catch(() => undefined);
      done.push('réglages Claude');
    }
    if (claudeSecrets?.oauthToken) {
      try {
        await settings.setOauthToken(decryptSecret(claudeSecrets.oauthToken));
        done.push('jeton Claude');
      } catch (err) {
        console.error('[settings] reprise du jeton Claude impossible', err);
      }
    }
    if (claudeSecrets?.apiKey) {
      try {
        const item = await vaultService.create({ userId: admin.id }, null, { name: 'anthropic-api', kind: 'token', service: 'anthropic', token: decryptSecret(claudeSecrets.apiKey), description: 'Clé API Anthropic reprise des anciens paramètres' });
        await settings.setApiKeyItem(item.id);
        done.push('clé API Anthropic');
      } catch (err) {
        console.error('[settings] reprise de la clé API Anthropic impossible', err);
      }
    }
    if (claude?.authMode === 'oauth' || claude?.authMode === 'api_key') await settings.update({ authMode: claude.authMode }).catch(() => undefined);
    if (github?.token && github.login) {
      try {
        const item = await vaultService.create({ userId: admin.id }, null, { name: `github-${github.login.toLowerCase()}`, kind: 'token', service: 'github', token: decryptSecret(github.token), description: `GitHub · ${github.login} (repris des anciens paramètres)` });
        await githubService.connectKnown(admin.id, item.id, { login: github.login, avatarUrl: github.avatarUrl ?? null, scopes: github.scopes ?? [], method: 'pat' });
        done.push(`compte GitHub ${github.login}`);
      } catch (err) {
        console.error('[settings] reprise du compte GitHub impossible', err);
      }
    }
  }
  for (const key of LEGACY_KEYS) await settingsRepository.delete(key);
  return done;
}
