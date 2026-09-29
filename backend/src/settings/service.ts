import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { settingsRepository } from './repository.js';
import {
  claudeAuthModes,
  defaultClaudeSettings,
  type ClaudeAccount,
  type ClaudeAuthMode,
  type ClaudeAuthStatus,
  type ClaudeModel,
  type ClaudeSecrets,
  type ClaudeSettings,
  type ClaudeVerification,
} from './types.js';
import { usageService } from './usage.js';

const KEY_SETTINGS = 'claude';
const KEY_SECRETS = 'claude.secrets';
const KEY_VERIFICATION = 'claude.verification';

export interface ClaudeSettingsPatch {
  authMode?: ClaudeAuthMode;
  defaultModel?: string | null;
  allowedModels?: string[];
  fallbackModel?: string | null;
  monthlyBudgetUsd?: number | null;
  sessionBudgetUsd?: number | null;
  defaultMaxTurns?: number | null;
}

/** Modèles proposés par défaut tant que la connexion n'a pas été vérifiée (liste rafraîchie par `verify()`). */
const builtinModels: ClaudeModel[] = [
  { value: 'default', resolvedModel: null, displayName: 'Modèle par défaut du CLI', description: 'Celui que Claude Code choisit (Opus actuel).' },
  { value: 'opus', resolvedModel: null, displayName: 'Opus', description: 'Travail complexe et tâches quotidiennes.' },
  { value: 'sonnet', resolvedModel: null, displayName: 'Sonnet', description: 'Plus économique pour les tâches simples.' },
  { value: 'haiku', resolvedModel: null, displayName: 'Haiku', description: 'Le plus rapide pour les réponses courtes.' },
];

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

/**
 * Configuration générale de Claude : authentification (compte du serveur, jeton OAuth obtenu depuis
 * l'interface, ou clé API), modèles autorisés, budgets. Les réglages sont gardés en mémoire pour que
 * les providers y accèdent de façon synchrone (`describe()`), et persistés en base.
 */
class SettingsService {
  private settings: ClaudeSettings = { ...defaultClaudeSettings };
  private secrets: ClaudeSecrets = {};
  private verification: ClaudeVerification | null = null;
  private verifying: Promise<ClaudeVerification> | null = null;

  /** À appeler au démarrage, après les migrations. */
  async load(): Promise<void> {
    this.settings = { ...defaultClaudeSettings, ...((await settingsRepository.get<Partial<ClaudeSettings>>(KEY_SETTINGS)) ?? {}) };
    this.secrets = (await settingsRepository.get<ClaudeSecrets>(KEY_SECRETS)) ?? {};
    this.verification = await settingsRepository.get<ClaudeVerification>(KEY_VERIFICATION);
  }

  get claude(): ClaudeSettings {
    return this.settings;
  }

  /** Modèles connus : ceux rapportés par le CLI à la dernière vérification, sinon une liste de base. */
  models(): ClaudeModel[] {
    return this.verification?.models.length ? this.verification.models : builtinModels;
  }

  /** Modèles proposés à la création d'une session (restreints par `allowedModels` si renseigné). */
  selectableModels(): ClaudeModel[] {
    const all = this.models();
    if (!this.settings.allowedModels.length) return all;
    const allowed = new Set(this.settings.allowedModels);
    const known = all.filter((m) => allowed.has(m.value) || (m.resolvedModel && allowed.has(m.resolvedModel)));
    // Un modèle autorisé mais absent de la liste connue (identifiant saisi à la main) reste proposé.
    for (const value of this.settings.allowedModels) {
      if (!known.some((m) => m.value === value || m.resolvedModel === value)) known.push({ value, resolvedModel: null, displayName: value, description: '' });
    }
    return known;
  }

  /** Vérifie qu'un modèle demandé par une session est autorisé. */
  assertModelAllowed(model: string | undefined | null): void {
    if (!model || !this.settings.allowedModels.length) return;
    if (!this.selectableModels().some((m) => m.value === model || m.resolvedModel === model)) {
      throw new AppError(`Modèle non autorisé par la configuration : ${model}`, 'MODEL_NOT_ALLOWED');
    }
  }

  async update(patch: ClaudeSettingsPatch): Promise<ClaudeSettings> {
    const next: ClaudeSettings = { ...this.settings };
    if (patch.authMode !== undefined) {
      if (!claudeAuthModes.includes(patch.authMode)) throw new AppError(`Mode d'authentification inconnu : ${patch.authMode}`);
      if (patch.authMode === 'oauth' && !this.secrets.oauthToken) throw new AppError("Aucun jeton OAuth enregistré : connectez-vous d'abord");
      if (patch.authMode === 'api_key' && !this.secrets.apiKey) throw new AppError("Aucune clé API enregistrée : saisissez-la d'abord");
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
    if (next.allowedModels.length) {
      const ok = (m: string | null) => !m || this.modelIsIn(m, next.allowedModels);
      if (!ok(next.defaultModel)) throw new AppError('Le modèle par défaut doit figurer parmi les modèles autorisés');
      if (!ok(next.fallbackModel)) throw new AppError('Le modèle de repli doit figurer parmi les modèles autorisés');
    }
    await settingsRepository.set(KEY_SETTINGS, next);
    this.settings = next;
    return next;
  }

  private modelIsIn(model: string, list: string[]): boolean {
    if (list.includes(model)) return true;
    const info = this.models().find((m) => m.value === model || m.resolvedModel === model);
    return Boolean(info && (list.includes(info.value) || (info.resolvedModel && list.includes(info.resolvedModel))));
  }

  // ---- Secrets -------------------------------------------------------------------------------

  async setApiKey(apiKey: string | null): Promise<void> {
    const trimmed = apiKey?.trim() ?? '';
    if (!trimmed) {
      delete this.secrets.apiKey;
      delete this.secrets.apiKeyHint;
      delete this.secrets.apiKeySetAt;
      if (this.settings.authMode === 'api_key') await this.update({ authMode: 'server' });
    } else {
      if (!/^sk-ant-/.test(trimmed)) throw new AppError('Une clé API Anthropic commence par « sk-ant- »');
      this.secrets.apiKey = encryptSecret(trimmed);
      this.secrets.apiKeyHint = `…${trimmed.slice(-6)}`;
      this.secrets.apiKeySetAt = new Date().toISOString();
    }
    await settingsRepository.set(KEY_SECRETS, this.secrets);
    this.invalidateVerification();
  }

  async setOauthToken(token: string): Promise<void> {
    if (!/^sk-ant-[A-Za-z0-9_-]{40,}$/.test(token.trim())) throw new AppError('Jeton OAuth inattendu');
    this.secrets.oauthToken = encryptSecret(token.trim());
    this.secrets.oauthTokenSetAt = new Date().toISOString();
    await settingsRepository.set(KEY_SECRETS, this.secrets);
    this.invalidateVerification();
  }

  async clearOauthToken(): Promise<void> {
    delete this.secrets.oauthToken;
    delete this.secrets.oauthTokenSetAt;
    await settingsRepository.set(KEY_SECRETS, this.secrets);
    if (this.settings.authMode === 'oauth') await this.update({ authMode: 'server' });
    this.invalidateVerification();
  }

  private invalidateVerification(): void {
    this.verification = null;
    void settingsRepository.delete(KEY_VERIFICATION).catch((err) => console.error('[settings] purge vérification', err));
  }

  authStatus(): ClaudeAuthStatus {
    return {
      mode: this.settings.authMode,
      hasOauthToken: Boolean(this.secrets.oauthToken),
      oauthTokenSetAt: this.secrets.oauthTokenSetAt ? new Date(this.secrets.oauthTokenSetAt) : null,
      hasApiKey: Boolean(this.secrets.apiKey),
      apiKeyHint: this.secrets.apiKeyHint ?? null,
      apiKeySetAt: this.secrets.apiKeySetAt ? new Date(this.secrets.apiKeySetAt) : null,
      serverHasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
      verification: this.verification,
    };
  }

  /**
   * Environnement à donner au processus Claude Code selon le mode d'authentification.
   * En mode « server », on laisse l'environnement du serveur tel quel (connexion `claude` de
   * l'utilisateur système ou variables d'environnement) ; sinon on impose le secret choisi et on
   * retire l'autre pour éviter toute ambiguïté.
   */
  authEnv(mode: ClaudeAuthMode = this.settings.authMode): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    if (mode === 'oauth') {
      if (!this.secrets.oauthToken) throw new AppError("Mode OAuth choisi mais aucun jeton enregistré : connectez-vous dans Paramètres", 'CLAUDE_AUTH');
      delete env.ANTHROPIC_API_KEY;
      env.CLAUDE_CODE_OAUTH_TOKEN = decryptSecret(this.secrets.oauthToken);
    } else if (mode === 'api_key') {
      if (!this.secrets.apiKey) throw new AppError('Mode clé API choisi mais aucune clé enregistrée : saisissez-la dans Paramètres', 'CLAUDE_AUTH');
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      env.ANTHROPIC_API_KEY = decryptSecret(this.secrets.apiKey);
    }
    return env;
  }

  // ---- Vérification -------------------------------------------------------------------------

  /**
   * Lance Claude Code sans prompt pour lire le compte connecté et la liste des modèles, avec
   * l'authentification du mode indiqué (par défaut le mode courant). Le résultat est mémorisé.
   */
  verify(mode: ClaudeAuthMode = this.settings.authMode): Promise<ClaudeVerification> {
    if (this.verifying) return this.verifying;
    this.verifying = this.runVerification(mode).finally(() => (this.verifying = null));
    return this.verifying;
  }

  private async runVerification(mode: ClaudeAuthMode): Promise<ClaudeVerification> {
    const at = new Date().toISOString();
    let result: ClaudeVerification;
    try {
      const env = this.authEnv(mode);
      const q = query({
        prompt: noMessages(),
        options: { cwd: config.workspacesRoot, env, maxTurns: 1, pathToClaudeCodeExecutable: config.claudeBin },
      });
      try {
        const [account, models] = await Promise.race([
          Promise.all([q.accountInfo(), q.supportedModels()]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code ne répond pas (délai de 60 s dépassé)')), 60_000)),
        ]);
        const info: ClaudeAccount = {
          email: account.email ?? null,
          organization: account.organization ?? null,
          subscriptionType: account.subscriptionType ?? null,
          apiProvider: account.apiProvider ?? null,
        };
        const list: ClaudeModel[] = models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel ?? null, displayName: m.displayName, description: m.description }));
        // Lire le compte ne contacte pas l'API : seule une vraie requête prouve que les identifiants marchent.
        const probe = await this.probeInference(env);
        result = { verifiedAt: at, authMode: mode, ok: probe.ok, error: probe.error, account: info, models: list };
      } finally {
        q.close();
      }
    } catch (err) {
      result = { verifiedAt: at, authMode: mode, ok: false, error: (err as Error).message, account: null, models: this.verification?.models ?? [] };
    }
    this.verification = result;
    await settingsRepository.set(KEY_VERIFICATION, result);
    return result;
  }

  /** Envoie un prompt minimal (un tour, sans outil) et lit le résultat : c'est le seul test fiable des identifiants. */
  private async probeInference(env: Record<string, string | undefined>): Promise<{ ok: boolean; error: string | null }> {
    let stderr = '';
    const q = query({
      prompt: 'Réponds uniquement « OK ».',
      options: {
        cwd: config.workspacesRoot,
        env,
        maxTurns: 1,
        permissionMode: 'dontAsk',
        tools: [],
        pathToClaudeCodeExecutable: config.claudeBin,
        abortController: new AbortController(),
        stderr: (data) => (stderr = (stderr + data).slice(-2000)),
      },
    });
    const timer = setTimeout(() => q.close(), 90_000);
    const lastStderr = () => stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').trim();
    try {
      let assistantError: string | null = null;
      let lastRetry: { error_status?: number; error?: string } | null = null;
      for await (const message of q) {
        if (message.type === 'assistant' && 'error' in message && message.error) assistantError = String(message.error);
        if (message.type === 'system' && message.subtype === 'api_retry') {
          // Le CLI réessaie jusqu'à dix fois : inutile d'attendre des minutes pour un 401.
          lastRetry = message as { error_status?: number; error?: string };
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

  // ---- Budget --------------------------------------------------------------------------------

  /** Lève une erreur si le plafond mensuel est atteint. */
  async assertBudgetAvailable(): Promise<void> {
    const cap = this.settings.monthlyBudgetUsd;
    if (!cap) return;
    const spent = await usageService.monthTotal();
    if (spent >= cap) {
      throw new AppError(`Plafond mensuel atteint (${spent.toFixed(2)} $ sur ${cap.toFixed(2)} $) : augmentez-le dans Paramètres pour continuer`, 'BUDGET_EXCEEDED');
    }
  }
}

export const settingsService = new SettingsService();
