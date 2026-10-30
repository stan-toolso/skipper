import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { vaultService } from '../vault/service.js';
import type { VaultActor } from '../vault/types.js';
import { claudeAuthModes, defaultClaudeSettings, type ClaudeAccount, type ClaudeAuthMode, type ClaudeAuthStatus, type ClaudeModel, type ClaudeSettings, type ClaudeVerification } from './types.js';
import { usageService } from './usage.js';
import { userSettingsStore } from './userStore.js';

const KEY_SETTINGS = 'claude';
const KEY_VERIFICATION = 'claude.verification';

export interface ClaudeSettingsPatch {
  authMode?: ClaudeAuthMode;
  defaultModel?: string | null;
  allowedModels?: string[];
  fallbackModel?: string | null;
  monthlyBudgetUsd?: number | null;
  sessionBudgetUsd?: number | null;
  defaultMaxTurns?: number | null;
  contextWarnTokens?: number | null;
}

/** Modèles proposés tant que la connexion n'a pas été vérifiée (liste rafraîchie par `verify()`). */
export const builtinModels: ClaudeModel[] = [
  { value: 'default', resolvedModel: null, displayName: 'Modèle par défaut du CLI', description: 'Celui que Claude Code choisit.' },
  { value: 'opus', resolvedModel: null, displayName: 'Opus', description: 'Travail complexe et tâches quotidiennes.' },
  { value: 'sonnet', resolvedModel: null, displayName: 'Sonnet', description: 'Plus économique pour les tâches simples.' },
  { value: 'haiku', resolvedModel: null, displayName: 'Haiku', description: 'Le plus rapide pour les réponses courtes.' },
];

const NO_CREDENTIALS = 'Aucun identifiant Claude : connectez votre abonnement ou choisissez une clé API du coffre dans Paramètres → Claude.';

const authErrorLabels: Record<string, string> = {
  authentication_failed: 'Identifiants refusés par Anthropic (clé ou jeton invalide, révoqué ou expiré).',
  oauth_org_not_allowed: "Ce compte n'est pas autorisé à utiliser Claude Code.",
  account_on_hold: 'Compte suspendu.',
  verification_required: 'Le compte demande une vérification supplémentaire (à faire sur claude.ai).',
  billing_error: 'Problème de facturation sur le compte Anthropic (crédit épuisé ?).',
  rate_limit: 'Limite de débit atteinte : réessayez dans quelques minutes.',
  model_not_found: 'Modèle introuvable pour ce compte.',
};

function humanizeAuthError(code: string | null, detail: string): string {
  const label = code ? authErrorLabels[code] : undefined;
  if (label) return `${label}${detail ? ` (${detail.slice(0, 300)})` : ''}`;
  return detail.slice(0, 500) || 'Échec de la vérification.';
}

/** Flux d'entrée vide : permet d'interroger le CLI (compte, modèles) sans lui soumettre de prompt. */
async function* noMessages(): AsyncIterable<SDKUserMessage> {
  await new Promise<void>(() => {});
}

/** Environnement du CLI : celui du serveur sans ses éventuels secrets Anthropic, plus les identifiants de la personne seuls. */
export function cliEnv(credentials: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return { ...env, ...credentials };
}

/** Envoie un prompt minimal (un tour, sans outil) et lit le résultat : c'est le seul test fiable des identifiants. */
async function probeInference(env: Record<string, string | undefined>): Promise<{ ok: boolean; error: string | null }> {
  let stderr = '';
  const q = query({
    prompt: 'Réponds uniquement « OK ».',
    options: { cwd: config.workspacesRoot, env, maxTurns: 1, permissionMode: 'dontAsk', tools: [], pathToClaudeCodeExecutable: config.claudeBin, abortController: new AbortController(), stderr: (data) => (stderr = (stderr + data).slice(-2000)) },
  });
  const timer = setTimeout(() => q.close(), 90_000);
  const lastStderr = () => stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').trim();
  try {
    let assistantError: string | null = null;
    let lastRetry: { error_status?: number | null; error?: string } | null = null;
    for await (const message of q) {
      if (message.type === 'assistant' && 'error' in message && message.error) assistantError = String(message.error);
      if (message.type === 'system' && message.subtype === 'api_retry') {
        lastRetry = message as { error_status?: number | null; error?: string };
        if (lastRetry.error_status === 401 || lastRetry.error_status === 403 || lastRetry.error === 'authentication_failed') {
          return { ok: false, error: humanizeAuthError(lastRetry.error ?? null, `HTTP ${lastRetry.error_status ?? '?'}`) };
        }
      }
      if (message.type === 'result') {
        if (!message.is_error) return { ok: true, error: null };
        const detail = message.subtype === 'success' ? message.result : message.errors.join(' ; ');
        return { ok: false, error: humanizeAuthError(assistantError, detail) };
      }
    }
    if (lastRetry) return { ok: false, error: humanizeAuthError(lastRetry.error ?? null, `HTTP ${lastRetry.error_status ?? '?'}, après plusieurs tentatives`) };
    return { ok: false, error: humanizeAuthError(assistantError, lastStderr() || 'Claude Code s’est arrêté sans résultat') };
  } catch (err) {
    return { ok: false, error: humanizeAuthError(null, [(err as Error).message, lastStderr()].filter(Boolean).join(' — ')) };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/** Lance Claude Code sans prompt pour lire le compte et les modèles avec ces identifiants, puis les éprouve. */
export async function checkClaudeCredentials(credentials: Record<string, string>, mode: ClaudeAuthMode, previousModels: ClaudeModel[]): Promise<ClaudeVerification> {
  const at = new Date().toISOString();
  try {
    const env = cliEnv(credentials);
    const q = query({ prompt: noMessages(), options: { cwd: config.workspacesRoot, env, maxTurns: 1, pathToClaudeCodeExecutable: config.claudeBin } });
    try {
      const [account, models] = await Promise.race([
        Promise.all([q.accountInfo(), q.supportedModels()]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code ne répond pas (délai de 60 s dépassé)')), 60_000)),
      ]);
      const info: ClaudeAccount = { email: account.email ?? null, organization: account.organization ?? null, subscriptionType: account.subscriptionType ?? null, apiProvider: account.apiProvider ?? null };
      const list: ClaudeModel[] = models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel ?? null, displayName: m.displayName, description: m.description }));
      // Lire le compte ne contacte pas l'API : seule une vraie requête prouve que les identifiants marchent.
      const probe = await probeInference(env);
      return { verifiedAt: at, authMode: mode, ok: probe.ok, error: probe.error, account: info, models: list };
    } finally {
      q.close();
    }
  } catch (err) {
    return { verifiedAt: at, authMode: mode, ok: false, error: (err as Error).message, account: null, models: previousModels };
  }
}

/**
 * Configuration Claude d'UNE personne : authentification (éléments du coffre), modèles, budgets, dernière
 * vérification. Relue en base à la demande (`claudeSettings.forUser(id)`) : rien n'est partagé entre les
 * personnes, et les sessions d'une personne tournent avec ses identifiants seuls.
 */
export class UserClaudeSettings {
  settings: ClaudeSettings = { ...defaultClaudeSettings };
  verification: ClaudeVerification | null = null;

  constructor(readonly userId: string) {}

  async load(): Promise<this> {
    const [settings, verification] = await Promise.all([userSettingsStore.get<Partial<ClaudeSettings>>(this.userId, KEY_SETTINGS), userSettingsStore.get<ClaudeVerification>(this.userId, KEY_VERIFICATION)]);
    this.settings = { ...defaultClaudeSettings, ...(settings ?? {}) };
    this.verification = verification;
    return this;
  }

  /** Modèles connus : ceux rapportés par le CLI à la dernière vérification, sinon la liste de base. */
  models(): ClaudeModel[] {
    return this.verification?.models.length ? this.verification.models : builtinModels;
  }

  /** Modèles proposés à la création d'une session (restreints par `allowedModels` si renseigné). */
  selectableModels(): ClaudeModel[] {
    const all = this.models();
    if (!this.settings.allowedModels.length) return all;
    const allowed = new Set(this.settings.allowedModels);
    const known = all.filter((m) => allowed.has(m.value) || (m.resolvedModel && allowed.has(m.resolvedModel)));
    for (const value of this.settings.allowedModels) {
      if (!known.some((m) => m.value === value || m.resolvedModel === value)) known.push({ value, resolvedModel: null, displayName: value, description: '' });
    }
    return known;
  }

  /** La personne a-t-elle des identifiants pour son mode d'authentification ? */
  hasCredentials(): boolean {
    const { authMode, oauthItemId, apiKeyItemId } = this.settings;
    return authMode === 'oauth' ? Boolean(oauthItemId) : Boolean(apiKeyItemId);
  }

  /** Lève si la personne n'a pas d'identifiants Claude pour son mode d'authentification. */
  assertCredentials(): void {
    if (!this.hasCredentials()) throw new AppError(NO_CREDENTIALS, 'CLAUDE_AUTH');
  }

  /** Lève si un modèle demandé par une session n'est pas autorisé par les réglages de la personne. */
  assertModelAllowed(model: string | undefined | null): void {
    if (!model || !this.settings.allowedModels.length) return;
    if (!this.selectableModels().some((m) => m.value === model || m.resolvedModel === model)) {
      throw new AppError(`Modèle non autorisé par vos réglages Claude : ${model}`, 'MODEL_NOT_ALLOWED');
    }
  }

  private modelIsIn(model: string, list: string[]): boolean {
    if (list.includes(model)) return true;
    const info = this.models().find((m) => m.value === model || m.resolvedModel === model);
    return Boolean(info && (list.includes(info.value) || (info.resolvedModel && list.includes(info.resolvedModel))));
  }

  async update(patch: ClaudeSettingsPatch): Promise<ClaudeSettings> {
    await this.load();
    const next: ClaudeSettings = { ...this.settings };
    if (patch.authMode !== undefined) {
      if (!claudeAuthModes.includes(patch.authMode)) throw new AppError(`Mode d'authentification inconnu : ${patch.authMode}`);
      if (patch.authMode === 'oauth' && !this.settings.oauthItemId) throw new AppError("Aucun jeton d'abonnement : connectez-vous d'abord");
      if (patch.authMode === 'api_key' && !this.settings.apiKeyItemId) throw new AppError("Aucune clé API : choisissez-en une dans le coffre d'abord");
      next.authMode = patch.authMode;
    }
    if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel?.trim() || null;
    if (patch.fallbackModel !== undefined) next.fallbackModel = patch.fallbackModel?.trim() || null;
    if (patch.allowedModels !== undefined) next.allowedModels = [...new Set(patch.allowedModels.map((m) => m.trim()).filter(Boolean))];
    for (const key of ['monthlyBudgetUsd', 'sessionBudgetUsd'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new AppError(`${key} doit être un montant positif`);
      next[key] = value;
    }
    if (patch.defaultMaxTurns !== undefined) {
      const v = patch.defaultMaxTurns;
      if (v !== null && (!Number.isInteger(v) || v <= 0)) throw new AppError('defaultMaxTurns doit être un entier positif');
      next.defaultMaxTurns = v;
    }
    if (patch.contextWarnTokens !== undefined) {
      const v = patch.contextWarnTokens;
      if (v !== null && (!Number.isInteger(v) || v <= 0)) throw new AppError('contextWarnTokens doit être un nombre entier de tokens positif, ou null pour ne jamais signaler');
      next.contextWarnTokens = v;
    }
    if (next.allowedModels.length) {
      const ok = (m: string | null) => !m || this.modelIsIn(m, next.allowedModels);
      if (!ok(next.defaultModel)) throw new AppError('Le modèle par défaut doit figurer parmi les modèles autorisés');
      if (!ok(next.fallbackModel)) throw new AppError('Le modèle de repli doit figurer parmi les modèles autorisés');
    }
    await userSettingsStore.set(this.userId, KEY_SETTINGS, next);
    this.settings = next;
    return next;
  }

  // ---- Identifiants (coffre) ---------------------------------------------------------------------

  /** Mode de repli quand un identifiant est retiré : l'autre s'il existe, sinon `oauth` (inutilisable jusqu'à la prochaine connexion). */
  private fallbackMode(): ClaudeAuthMode {
    if (this.settings.oauthItemId) return 'oauth';
    if (this.settings.apiKeyItemId) return 'api_key';
    return 'oauth';
  }

  private async saveCredentials(patch: Partial<Pick<ClaudeSettings, 'oauthItemId' | 'apiKeyItemId' | 'authMode'>>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await userSettingsStore.set(this.userId, KEY_SETTINGS, this.settings);
    await this.invalidateVerification();
  }

  /** Clé API Anthropic : un élément du coffre (jeton applicatif 'anthropic') que la personne peut utiliser ; null retire le choix. */
  async setApiKeyItem(itemId: string | null): Promise<void> {
    await this.load();
    if (!itemId) {
      await this.saveCredentials({ apiKeyItemId: null });
      if (this.settings.authMode === 'api_key') await this.saveCredentials({ authMode: this.fallbackMode() });
      return;
    }
    await vaultService.assertTokenItem(this.userId, itemId, ['anthropic']);
    // Une clé fraîchement choisie est celle que la personne veut utiliser.
    await this.saveCredentials({ apiKeyItemId: itemId, authMode: 'api_key' });
  }

  /** Jeton d'abonnement : un élément du coffre (jeton applicatif 'claude') que la personne peut utiliser ; null retire le choix. */
  async setOauthItem(itemId: string | null): Promise<void> {
    await this.load();
    if (!itemId) {
      await this.saveCredentials({ oauthItemId: null });
      if (this.settings.authMode === 'oauth') await this.saveCredentials({ authMode: this.fallbackMode() });
      return;
    }
    await vaultService.assertTokenItem(this.userId, itemId, ['claude']);
    await this.saveCredentials({ oauthItemId: itemId, authMode: 'oauth' });
  }

  /** Jeton de la connexion Claude (`claude setup-token`) : rangé dans le coffre personnel de la personne, puis choisi. */
  async setOauthToken(token: string): Promise<void> {
    if (!/^sk-ant-[A-Za-z0-9_-]{40,}$/.test(token.trim())) throw new AppError('Jeton OAuth inattendu');
    await this.load();
    const item = await vaultService.storeOauthToken(this.userId, {
      service: 'claude',
      name: 'claude-abonnement',
      account: null,
      secrets: { token: token.trim() },
      tokenExpiresAt: null,
      refreshExpiresAt: null,
      existingId: this.settings.oauthItemId,
    });
    await this.saveCredentials({ oauthItemId: item.id, authMode: 'oauth' });
  }

  /** Oublie le jeton d'abonnement : l'élément obtenu par Skipper est supprimé du coffre, un élément choisi à la main y reste. */
  async clearOauthToken(): Promise<void> {
    await this.load();
    const itemId = this.settings.oauthItemId;
    await this.setOauthItem(null);
    if (itemId) await vaultService.deleteOauthToken(this.userId, itemId);
  }

  async invalidateVerification(): Promise<void> {
    this.verification = null;
    await userSettingsStore.delete(this.userId, KEY_VERIFICATION).catch((err) => console.error('[settings] purge de la vérification', err));
  }

  /** Un élément référencé, si la personne peut encore l'utiliser. */
  private async itemOf(itemId: string | null) {
    if (!itemId) return null;
    return vaultService.getFor(this.userId, itemId, 'use').catch(() => null);
  }

  async authStatus(): Promise<ClaudeAuthStatus> {
    const [oauth, apiKey] = await Promise.all([this.itemOf(this.settings.oauthItemId), this.itemOf(this.settings.apiKeyItemId)]);
    return {
      mode: this.settings.authMode,
      hasOauthToken: Boolean(oauth),
      oauthTokenSetAt: oauth?.secretUpdatedAt ?? null,
      hasApiKey: Boolean(apiKey),
      apiKeySetAt: apiKey?.secretUpdatedAt ?? null,
      oauthItemId: oauth?.id ?? null,
      oauthItemName: oauth?.name ?? null,
      apiKeyItemId: apiKey?.id ?? null,
      apiKeyItemName: apiKey?.name ?? null,
      verification: this.verification,
    };
  }

  /**
   * Variable d'identification du processus Claude Code pour le mode donné, lue dans le coffre (la personne
   * doit encore pouvoir utiliser l'élément ; un usage par une session est journalisé). Ajoutée à un
   * environnement sans les secrets du serveur : le compte du serveur n'est jamais utilisé.
   */
  async credentialEnv(mode: ClaudeAuthMode = this.settings.authMode, actor: Omit<VaultActor, 'userId'> = {}): Promise<Record<string, string>> {
    if (mode === 'oauth') {
      if (!this.settings.oauthItemId) throw new AppError(`Mode abonnement (OAuth) choisi mais aucun jeton. ${NO_CREDENTIALS}`, 'CLAUDE_AUTH');
      const { secrets } = await vaultService.useToken(this.userId, this.settings.oauthItemId, ['claude'], { ...actor, userId: this.userId, purpose: 'Session Claude Code (abonnement)' });
      return { CLAUDE_CODE_OAUTH_TOKEN: secrets.token };
    }
    if (mode === 'api_key') {
      if (!this.settings.apiKeyItemId) throw new AppError(`Mode clé API choisi mais aucune clé. ${NO_CREDENTIALS}`, 'CLAUDE_AUTH');
      const { secrets } = await vaultService.useToken(this.userId, this.settings.apiKeyItemId, ['anthropic'], { ...actor, userId: this.userId, purpose: 'Session Claude Code (clé API)' });
      return { ANTHROPIC_API_KEY: secrets.token };
    }
    throw new AppError(`Mode d'authentification inconnu : ${String(mode)}`, 'CLAUDE_AUTH');
  }

  // ---- Vérification -----------------------------------------------------------------------------

  /** Éprouve les identifiants du mode indiqué (le CLI est lancé) et mémorise le résultat pour la personne. */
  async verify(mode: ClaudeAuthMode = this.settings.authMode): Promise<ClaudeVerification> {
    await this.load();
    let result: ClaudeVerification;
    try {
      const credentials = await this.credentialEnv(mode);
      result = await checkClaudeCredentials(credentials, mode, this.verification?.models ?? []);
    } catch (err) {
      result = { verifiedAt: new Date().toISOString(), authMode: mode, ok: false, error: (err as Error).message, account: null, models: this.verification?.models ?? [] };
    }
    this.verification = result;
    await userSettingsStore.set(this.userId, KEY_VERIFICATION, result);
    return result;
  }

  // ---- Budget --------------------------------------------------------------------------------

  /** Lève une erreur si le plafond mensuel de la personne est atteint. */
  async assertBudgetAvailable(): Promise<void> {
    const cap = this.settings.monthlyBudgetUsd;
    if (!cap) return;
    const spent = await usageService.monthTotal(this.userId);
    if (spent >= cap) throw new AppError(`Plafond mensuel atteint (${spent.toFixed(2)} $ sur ${cap.toFixed(2)} $) : augmentez-le dans Paramètres → Claude pour continuer`, 'BUDGET_EXCEEDED');
  }
}

/** Une vérification à la fois par personne (le test lance le CLI). */
const verifying = new Map<string, Promise<ClaudeVerification>>();

export const claudeSettings = {
  /** Réglages frais d'une personne (lecture en base). */
  forUser: (userId: string): Promise<UserClaudeSettings> => new UserClaudeSettings(userId).load(),

  /** Réglages d'une session : ceux de son propriétaire. Une session sans propriétaire ne peut pas s'authentifier. */
  async forSession(ownerId: string | null): Promise<UserClaudeSettings> {
    if (!ownerId) throw new AppError("Cette session n'a pas de propriétaire : relancez-la depuis votre compte pour qu'elle utilise vos identifiants Claude", 'CLAUDE_AUTH');
    return this.forUser(ownerId);
  },

  /** Vérification des identifiants d'une personne (une à la fois par personne). */
  verify(userId: string, mode: ClaudeAuthMode | null): Promise<ClaudeVerification> {
    const pending = verifying.get(userId);
    if (pending) return pending;
    const run = this.forUser(userId)
      .then((s) => s.verify(mode ?? undefined))
      .finally(() => verifying.delete(userId));
    verifying.set(userId, run);
    return run;
  },
};
