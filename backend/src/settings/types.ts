/** Comment le backend s'authentifie auprès de Claude pour lancer les sessions. */
export type ClaudeAuthMode = 'server' | 'oauth' | 'api_key';

export const claudeAuthModes: ClaudeAuthMode[] = ['server', 'oauth', 'api_key'];

/** Réglages Claude modifiables dans l'interface (clé `claude` de app_settings). */
export interface ClaudeSettings {
  authMode: ClaudeAuthMode;
  /** Modèle utilisé quand une session n'en précise pas (alias ou identifiant complet). null = défaut du CLI. */
  defaultModel: string | null;
  /** Modèles proposés à la création d'une session ; vide = tous ceux connus. */
  allowedModels: string[];
  /** Modèle de repli si le principal est surchargé. */
  fallbackModel: string | null;
  /** Plafond de dépense estimée sur le mois calendaire (USD), toutes sessions confondues. */
  monthlyBudgetUsd: number | null;
  /** Budget par défaut d'une session (USD) si elle n'en fixe pas. */
  sessionBudgetUsd: number | null;
  /** Nombre maximum d'étapes par défaut d'une session. */
  defaultMaxTurns: number | null;
}

export const defaultClaudeSettings: ClaudeSettings = {
  authMode: 'server',
  defaultModel: null,
  allowedModels: [],
  fallbackModel: null,
  monthlyBudgetUsd: null,
  sessionBudgetUsd: null,
  defaultMaxTurns: null,
};

/** Secrets chiffrés (clé `claude.secrets`). */
export interface ClaudeSecrets {
  oauthToken?: string;
  oauthTokenSetAt?: string;
  apiKey?: string;
  apiKeySetAt?: string;
  /** Derniers caractères de la clé API, pour l'afficher sans la révéler. */
  apiKeyHint?: string;
}

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

/** Résultat de la dernière vérification de connexion (clé `claude.verification`). */
export interface ClaudeVerification {
  verifiedAt: string;
  /** Mode d'authentification vérifié. */
  authMode: ClaudeAuthMode;
  ok: boolean;
  error: string | null;
  account: ClaudeAccount | null;
  models: ClaudeModel[];
}

/** Compte connecté dans le magasin du CLI de l'utilisateur système (mode « server »). */
export interface ServerAuthStatus {
  loggedIn: boolean;
  /** 'claude.ai' (abonnement) ou 'console' (clé API gérée), selon le CLI. */
  authMethod: string | null;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  error: string | null;
}

export interface ClaudeAuthStatus {
  mode: ClaudeAuthMode;
  hasOauthToken: boolean;
  oauthTokenSetAt: Date | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  apiKeySetAt: Date | null;
  /** Le serveur lui-même a-t-il une clé dans son environnement (mode « server »). */
  serverHasApiKey: boolean;
  verification: ClaudeVerification | null;
}

export interface UsageSummary {
  monthStart: Date;
  monthUsd: number;
  totalUsd: number;
  byModel: { model: string; usd: number }[];
  bySession: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
}
