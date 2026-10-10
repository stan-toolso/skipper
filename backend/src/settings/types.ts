/**
 * Comment les sessions d'une personne s'authentifient auprès de Claude : `oauth` = jeton longue durée de
 * son abonnement (obtenu depuis l'interface, `claude setup-token`), `api_key` = clé API Anthropic. Les deux
 * vivent dans le COFFRE (jetons applicatifs, vault/tokens.ts) : les réglages ne font que référencer les
 * éléments, et chaque usage vérifie que la personne peut toujours s'en servir. Il n'y a pas de compte
 * partagé : une session sans identifiants utilisables de son propriétaire ne démarre pas.
 */
export type ClaudeAuthMode = 'oauth' | 'api_key';

export const claudeAuthModes: ClaudeAuthMode[] = ['oauth', 'api_key'];

/** Réglages Claude d'une personne (clé `claude` de user_settings). */
export interface ClaudeSettings {
  authMode: ClaudeAuthMode;
  /** Modèle utilisé quand une session n'en précise pas (alias ou identifiant complet). null = défaut du CLI. */
  defaultModel: string | null;
  /** Modèles proposés à la création d'une session ; vide = tous ceux connus. */
  allowedModels: string[];
  /** Modèle de repli si le principal est surchargé. */
  fallbackModel: string | null;
  /** Plafond de dépense estimée sur le mois calendaire (USD), toutes ses sessions confondues. */
  monthlyBudgetUsd: number | null;
  /** Budget par défaut d'une session (USD) si elle n'en fixe pas. */
  sessionBudgetUsd: number | null;
  /** Nombre maximum d'étapes par défaut d'une session. */
  defaultMaxTurns: number | null;
  /** Éléments du coffre des identifiants (jetons applicatifs 'claude' et 'anthropic'). */
  oauthItemId: string | null;
  apiKeyItemId: string | null;
}

export const defaultClaudeSettings: ClaudeSettings = {
  authMode: 'oauth',
  defaultModel: null,
  allowedModels: [],
  fallbackModel: null,
  monthlyBudgetUsd: null,
  sessionBudgetUsd: null,
  defaultMaxTurns: null,
  oauthItemId: null,
  apiKeyItemId: null,
};

export interface ClaudeAccount {
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  apiProvider: string | null;
}

export interface ClaudeModel {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  description: string;
}

/** Résultat de la dernière vérification de connexion d'une personne (clé `claude.verification`). */
export interface ClaudeVerification {
  verifiedAt: string;
  /** Mode d'authentification vérifié. */
  authMode: ClaudeAuthMode;
  ok: boolean;
  error: string | null;
  account: ClaudeAccount | null;
  models: ClaudeModel[];
}

export interface ClaudeAuthStatus {
  mode: ClaudeAuthMode;
  hasOauthToken: boolean;
  oauthTokenSetAt: Date | null;
  hasApiKey: boolean;
  apiKeySetAt: Date | null;
  /** Éléments du coffre référencés (null : aucun, ou plus utilisable par la personne). */
  oauthItemId: string | null;
  oauthItemName: string | null;
  apiKeyItemId: string | null;
  apiKeyItemName: string | null;
  verification: ClaudeVerification | null;
}

export interface UsageSummary {
  monthStart: Date;
  monthUsd: number;
  totalUsd: number;
  byModel: { model: string; usd: number }[];
  bySession: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
}
