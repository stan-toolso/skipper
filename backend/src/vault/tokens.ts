/**
 * Jetons applicatifs du coffre (type `token`) : les identifiants que Skipper lui-même utilise pour le
 * compte d'une personne — son identifiant Claude, les clés d'API de ses fournisseurs de modèles OpenCode,
 * ses comptes GitHub. Jamais offerts aux agents (ni outil MCP, ni secret de navigateur, ni lien à un projet) :
 * les réglages d'une personne les référencent, et Skipper les relit à chaque usage après avoir vérifié
 * qu'elle peut toujours s'en servir.
 */

export interface TokenServiceInfo {
  label: string;
  /** Début attendu d'un jeton saisi à la main, quand le service en a un. */
  prefix: string | null;
  /** Motif d'un jeton saisi à la main, quand il est plus strict que le préfixe. */
  pattern?: RegExp;
  /** Le service est un fournisseur de modèles d'OpenCode (sa clé sert aux sessions OpenCode). */
  opencode?: boolean;
}

export const TOKEN_SERVICES = {
  anthropic: { label: 'Anthropic (clé API)', prefix: 'sk-ant-', opencode: true },
  claude: { label: 'Abonnement Claude (jeton OAuth)', prefix: 'sk-ant-', pattern: /^sk-ant-[A-Za-z0-9_-]{40,}$/ },
  github: { label: 'GitHub', prefix: null, pattern: /^(ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}$/ },
  openai: { label: 'OpenAI', prefix: 'sk-', opencode: true },
  google: { label: 'Google (Gemini)', prefix: null, opencode: true },
  openrouter: { label: 'OpenRouter', prefix: 'sk-or-', opencode: true },
  opencode: { label: 'OpenCode Zen', prefix: null, opencode: true },
  mistral: { label: 'Mistral', prefix: null, opencode: true },
  deepseek: { label: 'DeepSeek', prefix: 'sk-', opencode: true },
  xai: { label: 'xAI (Grok)', prefix: 'xai-', opencode: true },
  groq: { label: 'Groq', prefix: 'gsk_', opencode: true },
} satisfies Record<string, TokenServiceInfo>;

export type TokenService = keyof typeof TOKEN_SERVICES;
export const TOKEN_SERVICE_IDS = Object.keys(TOKEN_SERVICES) as TokenService[];

export const isTokenService = (s: string): s is TokenService => Object.prototype.hasOwnProperty.call(TOKEN_SERVICES, s);

/** Fournisseurs de modèles d'OpenCode dont la clé peut venir du coffre. */
export const OPENCODE_TOKEN_SERVICES = TOKEN_SERVICE_IDS.filter((s) => (TOKEN_SERVICES[s] as TokenServiceInfo).opencode);

export const tokenServiceLabel = (service: string): string => (isTokenService(service) ? TOKEN_SERVICES[service].label : service);

/** Pourquoi un jeton saisi à la main ne correspond pas à son service ; null s'il convient. */
export function tokenMismatch(service: TokenService, token: string): string | null {
  const info: TokenServiceInfo = TOKEN_SERVICES[service];
  if (info.pattern && !info.pattern.test(token)) return service === 'github' ? "Ce n'est pas un jeton GitHub (attendu : ghp_… ou github_pat_…)" : `Ce n'est pas un jeton ${info.label}`;
  if (info.prefix && !token.startsWith(info.prefix)) return `Une clé ${info.label} commence par « ${info.prefix} »`;
  return null;
}
