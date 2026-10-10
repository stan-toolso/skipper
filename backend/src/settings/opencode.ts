import { AppError } from '../errors.js';
import { vaultService } from '../vault/service.js';
import { OPENCODE_TOKEN_SERVICES, TOKEN_SERVICES, type TokenService } from '../vault/tokens.js';
import type { VaultActor } from '../vault/types.js';
import { listOpencodeModels } from './opencodeCheck.js';
import { userSettingsStore } from './userStore.js';

const KEY_SETTINGS = 'opencode';
const KEY_MODELS = 'opencode.models';

/** Fournisseurs de modèles d'OpenCode auxquels une personne peut donner une clé (identifiants de models.dev, tels qu'OpenCode les nomme). */
export interface OpencodeProviderInfo {
  id: TokenService;
  label: string;
  /** Préfixe attendu de la clé, quand le fournisseur en a un. */
  keyPrefix: string | null;
}

export const opencodeProviders: OpencodeProviderInfo[] = OPENCODE_TOKEN_SERVICES.map((id) => ({ id, label: TOKEN_SERVICES[id].label, keyPrefix: TOKEN_SERVICES[id].prefix }));
const isProvider = (id: string): id is TokenService => opencodeProviders.some((p) => p.id === id);

/** OpenCode Zen : ses modèles gratuits acceptent les requêtes sans clé de la personne. */
export const KEYLESS_PROVIDER = 'opencode';

/** Réglages OpenCode d'une personne (clé `opencode` de user_settings). */
export interface OpencodeSettings {
  /** Modèle des sessions qui n'en précisent pas, `fournisseur/modèle` (ex. anthropic/claude-sonnet-5-5). */
  defaultModel: string | null;
  /** Budget par défaut d'une session (USD) : la session est interrompue au-delà. */
  sessionBudgetUsd: number | null;
  /** Élément du coffre (jeton applicatif) qui détient la clé de chaque fournisseur. */
  keyItems: Record<string, string>;
}

export const defaultOpencodeSettings: OpencodeSettings = { defaultModel: null, sessionBudgetUsd: null, keyItems: {} };

export interface OpencodeSettingsPatch {
  defaultModel?: string | null;
  sessionBudgetUsd?: number | null;
}

/** Modèles qu'OpenCode offre avec les clés de la personne, d'après la dernière liste (clé `opencode.models`). */
export interface OpencodeModelList {
  listedAt: string;
  ok: boolean;
  error: string | null;
  models: string[];
}

/** Clé choisie pour un fournisseur : l'élément du coffre, quand la personne peut encore l'utiliser. */
export interface OpencodeKeyStatus {
  provider: string;
  label: string;
  itemId: string;
  itemName: string | null;
  /** La personne peut encore utiliser l'élément (sinon le fournisseur n'a pas de clé utilisable). */
  usable: boolean;
  setAt: Date | null;
}

const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/\S+$/i;

/** `fournisseur/modèle` → ses parties (l'identifiant du modèle peut lui-même contenir des barres : openrouter/openai/gpt-6). */
export function splitModel(model: string): { providerID: string; modelID: string } {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) throw new AppError(`Modèle OpenCode invalide : « ${model} ». Format attendu : fournisseur/modèle, ex. anthropic/claude-sonnet-5-5`);
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/**
 * Configuration OpenCode d'UNE personne : les éléments du coffre qui détiennent ses clés d'API (une par
 * fournisseur de modèles), son modèle par défaut et son budget par session. Aucun secret ici : les clés sont
 * relues dans le coffre à chaque usage, après vérification qu'elle peut toujours s'en servir. Le plafond
 * mensuel de la personne (réglages Claude) couvre aussi ses sessions OpenCode (même relevé).
 */
export class UserOpencodeSettings {
  settings: OpencodeSettings = { ...defaultOpencodeSettings };
  modelList: OpencodeModelList | null = null;

  constructor(readonly userId: string) {}

  async load(): Promise<this> {
    const [settings, models] = await Promise.all([userSettingsStore.get<Partial<OpencodeSettings>>(this.userId, KEY_SETTINGS), userSettingsStore.get<OpencodeModelList>(this.userId, KEY_MODELS)]);
    this.settings = { ...defaultOpencodeSettings, ...(settings ?? {}) };
    this.modelList = models;
    return this;
  }

  async update(patch: OpencodeSettingsPatch): Promise<OpencodeSettings> {
    await this.load();
    const next: OpencodeSettings = { ...this.settings };
    if (patch.defaultModel !== undefined) {
      const model = patch.defaultModel?.trim() || null;
      if (model && !MODEL_RE.test(model)) throw new AppError(`Modèle invalide : « ${model} ». Format attendu : fournisseur/modèle, ex. anthropic/claude-sonnet-5-5`);
      next.defaultModel = model;
    }
    if (patch.sessionBudgetUsd !== undefined) {
      const v = patch.sessionBudgetUsd;
      if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new AppError('sessionBudgetUsd doit être un montant positif');
      next.sessionBudgetUsd = v;
    }
    await userSettingsStore.set(this.userId, KEY_SETTINGS, next);
    this.settings = next;
    return next;
  }

  /** Choisit l'élément du coffre (jeton applicatif du fournisseur) qui détient la clé d'un fournisseur ; null retire le choix. */
  async setKeyItem(provider: string, itemId: string | null): Promise<void> {
    const id = provider.trim().toLowerCase();
    if (!isProvider(id)) throw new AppError(`Fournisseur inconnu : ${provider}`);
    await this.load();
    const keyItems = { ...this.settings.keyItems };
    if (!itemId) delete keyItems[id];
    else {
      await vaultService.assertTokenItem(this.userId, itemId, [id]);
      keyItems[id] = itemId;
    }
    this.settings = { ...this.settings, keyItems };
    await userSettingsStore.set(this.userId, KEY_SETTINGS, this.settings);
    // Les modèles disponibles dépendent des clés : la liste est périmée.
    this.modelList = null;
    await userSettingsStore.delete(this.userId, KEY_MODELS);
  }

  async keyStatus(): Promise<OpencodeKeyStatus[]> {
    return Promise.all(
      Object.entries(this.settings.keyItems).map(async ([provider, itemId]) => {
        const item = await vaultService.getFor(this.userId, itemId, 'use').catch(() => null);
        return { provider, label: opencodeProviders.find((p) => p.id === provider)?.label ?? provider, itemId, itemName: item?.name ?? null, usable: Boolean(item), setAt: item?.secretUpdatedAt ?? null };
      }),
    );
  }

  hasKey(provider: string): boolean {
    return Boolean(this.settings.keyItems[provider]);
  }

  /**
   * Les clés de la personne au format d'authentification d'OpenCode (OPENCODE_AUTH_CONTENT), lues dans le
   * coffre (journalisées sur chaque élément) et remises au serveur OpenCode de la session seul. Une clé
   * que la personne ne peut plus utiliser est écartée ; `required` (fournisseur du modèle) doit y être.
   */
  async authContent(actor: Omit<VaultActor, 'userId'> = {}, required?: string | null): Promise<Record<string, { type: 'api'; key: string }>> {
    const out: Record<string, { type: 'api'; key: string }> = {};
    for (const [provider, itemId] of Object.entries(this.settings.keyItems)) {
      if (!isProvider(provider)) continue;
      try {
        const { secrets } = await vaultService.useToken(this.userId, itemId, [provider], { ...actor, userId: this.userId, purpose: 'Session OpenCode' });
        out[provider] = { type: 'api', key: secrets.token };
      } catch (err) {
        if (provider === required) throw err;
      }
    }
    return out;
  }

  /** Lève si le fournisseur du modèle n'a pas de clé de la personne (OpenCode Zen excepté : modèles gratuits). */
  assertModelUsable(model: string): void {
    const { providerID } = splitModel(model);
    if (providerID === KEYLESS_PROVIDER || this.hasKey(providerID)) return;
    throw new AppError(`Aucune clé ${opencodeProviders.find((p) => p.id === providerID)?.label ?? providerID} pour le modèle ${model} : choisissez-en une dans le coffre, Paramètres → OpenCode.`, 'OPENCODE_AUTH');
  }

  /** Le modèle d'une session, sinon le modèle par défaut de la personne ; son fournisseur doit avoir une clé. */
  resolveModel(model: string | null | undefined): string {
    const resolved = model?.trim() || this.settings.defaultModel;
    if (!resolved) throw new AppError('Aucun modèle OpenCode : choisissez-en un pour la session ou réglez votre modèle par défaut dans Paramètres → OpenCode.', 'OPENCODE_AUTH');
    this.assertModelUsable(resolved);
    return resolved;
  }

  /** Liste les modèles qu'OpenCode offre avec les clés de la personne et garde le résultat. */
  async listModels(): Promise<OpencodeModelList> {
    await this.load();
    let result: OpencodeModelList;
    try {
      const models = await listOpencodeModels(await this.authContent());
      result = { listedAt: new Date().toISOString(), ok: true, error: null, models };
    } catch (err) {
      result = { listedAt: new Date().toISOString(), ok: false, error: (err as Error).message, models: this.modelList?.models ?? [] };
    }
    this.modelList = result;
    await userSettingsStore.set(this.userId, KEY_MODELS, result);
    return result;
  }
}

export const opencodeSettings = {
  forUser: (userId: string): Promise<UserOpencodeSettings> => new UserOpencodeSettings(userId).load(),

  /** Réglages d'une session : ceux de son propriétaire. Une session sans propriétaire ne peut pas s'authentifier. */
  async forSession(ownerId: string | null): Promise<UserOpencodeSettings> {
    if (!ownerId) throw new AppError("Cette session n'a pas de propriétaire : relancez-la depuis votre compte pour qu'elle utilise vos clés OpenCode", 'OPENCODE_AUTH');
    return this.forUser(ownerId);
  },
};
