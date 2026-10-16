import { SKIPPER_KINDS, type VaultItem, type VaultItemKind, type VaultPermission } from '../../graphql/vault';

/** Libellés, icônes et aides des types d'éléments du coffre. */
export const KINDS: Record<VaultItemKind, { label: string; icon: string; hint: string; placeholder: string }> = {
  ssh: { label: 'Serveur SSH', icon: 'bi-hdd-network', hint: 'Commandes et transferts de fichiers sur un serveur distant.', placeholder: 'prod' },
  postgres: { label: 'Base PostgreSQL', icon: 'bi-database', hint: 'Requêtes SQL, en lecture seule par défaut, éventuellement via un tunnel SSH.', placeholder: 'rds-prod' },
  api: { label: 'API HTTP', icon: 'bi-cloud', hint: "Appels HTTP vers une API ; le serveur ajoute l'authentification.", placeholder: 'stripe' },
  website: { label: 'Site web', icon: 'bi-globe2', hint: 'Identifiants tapés par le serveur dans le navigateur headless, jamais lus par l’agent.', placeholder: 'admin-site' },
  secret: { label: 'Secret', icon: 'bi-key', hint: 'Valeurs quelconques tapées dans le navigateur, chaque usage étant soumis à votre accord.', placeholder: 'otp-backup' },
  google: { label: 'Compte Google', icon: 'bi-google', hint: 'Gmail et Drive, connectés par OAuth ; les écritures demandent une approbation.', placeholder: 'google-moi' },
  token: { label: 'Jeton applicatif', icon: 'bi-person-badge', hint: 'Identifiant que Skipper utilise pour vous : abonnement ou clé Claude, fournisseurs OpenCode, GitHub. Jamais offert aux agents.', placeholder: 'claude-moi' },
  litellm: { label: 'Proxy LiteLLM', icon: 'bi-hdd-stack', hint: 'Adresse et clé d’un proxy LiteLLM, pour les agents qui appellent un modèle directement. Jamais offert aux agents des sessions.', placeholder: 'litellm' },
  langfuse: { label: 'Projet Langfuse', icon: 'bi-graph-up', hint: 'Hôte et clés d’un projet Langfuse, où Skipper trace ses appels de modèle. Jamais offert aux agents des sessions.', placeholder: 'langfuse' },
};

/** Types proposés aux agents, puis ceux réservés à Skipper. */
export const KIND_ORDER: VaultItemKind[] = ['ssh', 'postgres', 'api', 'website', 'secret', 'google', ...SKIPPER_KINDS];
export const AGENT_KINDS: VaultItemKind[] = KIND_ORDER.filter((k) => !SKIPPER_KINDS.includes(k));

/** Élément réservé à Skipper : référencé par les réglages d'une personne, jamais utilisable par un agent ni relié à un projet. */
export const isSkipperKind = (kind: VaultItemKind): boolean => SKIPPER_KINDS.includes(kind);
/** Jeton obtenu par une connexion depuis Skipper : non modifiable ici, renouvelé par Skipper. */
export const isOauthToken = (item: Pick<VaultItem, 'kind' | 'token'>): boolean => item.kind === 'token' && item.token?.obtained === 'oauth';

/** Où un élément réservé à Skipper se choisit. */
export function skipperUsageOf(item: VaultItem): string {
  switch (item.kind) {
    case 'token': {
      const service = item.token?.service;
      if (service === 'claude' || service === 'anthropic') return 'Paramètres → Claude';
      if (service === 'github') return 'Paramètres → GitHub';
      return 'Paramètres → OpenCode (clés des fournisseurs) et agents à appel direct';
    }
    case 'litellm':
      return 'agents à appel direct (modèle via LiteLLM)';
    case 'langfuse':
      return 'agents à appel direct (traces des appels)';
    default:
      return '';
  }
}

export const PERMISSION_LABELS: Record<VaultPermission, string> = { USE: 'utiliser', READ: 'lire', MANAGE: 'gérer' };

export const DEFAULT_PORTS: Partial<Record<VaultItemKind, number>> = { ssh: 22, postgres: 5432 };

/** Ligne de cible : hôte, URL, adresse Google… */
export function targetOf(item: VaultItem): string {
  switch (item.kind) {
    case 'ssh':
    case 'postgres': {
      const port = item.port && item.port !== DEFAULT_PORTS[item.kind] ? `:${item.port}` : '';
      const db = item.kind === 'postgres' ? (item.database ? `/${item.database}` : ' · toutes les bases') : '';
      const via = item.via ? ` · via ${item.via.name}` : '';
      return `${item.username ?? ''}@${item.host ?? ''}${port}${db}${via}`;
    }
    case 'website':
    case 'api':
      return item.url ?? '';
    case 'google':
      return item.google?.email ?? '';
    case 'secret':
      return `${item.fields.length} champ${item.fields.length > 1 ? 's' : ''}`;
    case 'token':
      return [item.token?.serviceLabel ?? 'jeton', item.token?.account].filter(Boolean).join(' · ');
    case 'litellm':
      return item.url ?? '';
    case 'langfuse':
      return [item.url, item.langfusePublicKey].filter(Boolean).join(' · ');
  }
}

export function ownerLabelOf(item: VaultItem, meId: string | undefined): string {
  if (item.ownerProject) return `Projet ${item.ownerProject.name}`;
  if (item.ownerProjectName) return `Projet ${item.ownerProjectName}`;
  if (item.ownerUser) return item.ownerUser.id === meId ? 'Personnel' : item.ownerUser.name;
  return '—';
}

/** Délai avant expiration, en jours (négatif : expiré) ; null sans date. */
export function daysToExpiry(item: VaultItem): number | null {
  if (!item.expiresAt) return null;
  return Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / 86_400_000);
}

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { dateStyle: 'medium' }) : '');

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** Nom de variable présenté pour un champ (continuité d'affichage avec l'ancien mode direct). */
export function variableOf(name: string, key: string): string {
  return `${name}_${key}`.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}

/** Outils offerts aux agents, par type. */
export function agentToolsOf(item: VaultItem): string {
  switch (item.kind) {
    case 'ssh':
      return item.commandAllowlist.length ? 'ssh_exec (commandes autorisées seulement) ; transferts désactivés' : 'ssh_exec, ssh_upload, ssh_download';
    case 'postgres':
      return `sql_query${item.readOnly ? ' (lecture seule)' : ''}, sql_schema${item.database ? '' : ' — serveur entier : l’agent nomme la base à chaque appel (postgres par défaut) et peut lister les bases'}`;
    case 'api':
      return `http_request${item.readOnly ? ' (GET, HEAD, OPTIONS)' : ''}`;
    case 'website':
      return `browser_fill : le serveur tape la valeur demandée dans le champ que l'agent a sélectionné, sur une page du site seulement${item.requireApproval ? ', après votre accord' : ''}`;
    case 'secret':
      return "browser_fill : chaque saisie vous est présentée avec la page concernée, pour accord";
    case 'google': {
      const parts: string[] = [];
      if (item.google?.gmailAccess !== 'NONE') parts.push(`Gmail : lecture${item.google?.gmailAccess === 'WRITE' ? ', envoi (avec approbation)' : ''}`);
      if (item.google?.driveAccess !== 'NONE') parts.push(`Drive : lecture${item.google?.driveAccess === 'WRITE' ? ', écriture (avec approbation)' : ''}`);
      return parts.length ? `${parts.join(' · ')} — paramètre account = « ${item.name} »` : 'aucun accès';
    }
    case 'token':
    case 'litellm':
    case 'langfuse':
      return `aucun : réservé à Skipper (${skipperUsageOf(item)})`;
  }
}
