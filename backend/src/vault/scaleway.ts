/**
 * Comptes Scaleway du coffre, partie sans état : validation des réglages, découpage et politique des commandes
 * du CLI `scw` (`scw_run`), appels à l'API HTTP (`scw_api`, par le module api.ts : même sécurité que les API du
 * coffre) et exécution du CLI dans un conteneur jetable du runner. Aucune dépendance au service du coffre.
 *
 * Authentification : une clé d'API IAM (clé d'accès publique `SCW…`, clé secrète UUID), rattachée à un utilisateur
 * ou à une application IAM ; de préférence une application dédiée aux agents, aux droits limités par une politique.
 */
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import type { IsolatedResult } from '../runners/types.js';
import * as api from './api.js';
import { tokenize } from './aws.js';
import type { ApiCredentials, ScalewayCredentials, ScalewaySettings } from './types.js';

export const SCALEWAY_API_URL = 'https://api.scaleway.com';

// ---- Réglages ----------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Régions (fr-par, nl-ams, pl-waw) et zones (fr-par-1…) de Scaleway. */
const REGION_RE = /^[a-z]{2}-[a-z]{3}$/;
const ZONE_RE = /^[a-z]{2}-[a-z]{3}-\d$/;

export function validateAccessKey(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!/^SCW[A-Z0-9]{17}$/.test(v)) throw new AppError("Clé d'accès Scaleway invalide : « SCW » suivi de 17 caractères (ex. SCWXXXXXXXXXXXXXXXXX)");
  return v;
}

export function validateSecretKey(value: string | null | undefined): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!UUID_RE.test(v)) throw new AppError('Clé secrète Scaleway invalide : un identifiant UUID est attendu');
  return v;
}

export function validateUuid(value: string | null | undefined, label: string): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!UUID_RE.test(v)) throw new AppError(`${label} invalide : un identifiant UUID est attendu`);
  return v;
}

export function validateRegion(value: string | null | undefined): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!REGION_RE.test(v)) throw new AppError('Région Scaleway invalide (ex. fr-par, nl-ams, pl-waw)');
  return v;
}

/** Zone, cohérente avec la région (fr-par → fr-par-1, fr-par-2, fr-par-3). */
export function validateZone(value: string | null | undefined, region: string): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!ZONE_RE.test(v)) throw new AppError('Zone Scaleway invalide (ex. fr-par-1, fr-par-2, nl-ams-1)');
  if (!v.startsWith(`${region}-`)) throw new AppError(`La zone ${v} n'est pas dans la région ${region}`);
  return v;
}

// ---- Commandes du CLI --------------------------------------------------------------------------------

/** Options globales du CLI qui prennent une valeur (sans `=`). */
const GLOBAL_VALUE_OPTIONS = new Set(['-o', '--output', '-p', '--profile', '-c', '--config']);

/** Options refusées : profils et fichiers de configuration de l'hôte, traces détaillées (identifiants dans les journaux), navigateur. */
const FORBIDDEN_OPTIONS = new Set(['-p', '--profile', '-c', '--config', '-D', '--debug', '--web']);

/**
 * Commandes refusées, par préfixe de chemin (espace de noms, ressource…) : configuration et connexion locales
 * (`init`, `config`, `login`, `info` affiche le profil), connexions interactives (`ssh`, `console`), fichiers de
 * configuration qui contiennent la clé secrète (`object config`, `k8s kubeconfig`, `registry login`).
 */
const FORBIDDEN_PATHS: string[][] = [
  ['init'],
  ['config'],
  ['login'],
  ['logout'],
  ['info'],
  ['autocomplete'],
  ['feedback'],
  ['alias'],
  ['shell'],
  ['object', 'config'],
  ['k8s', 'kubeconfig'],
  ['registry', 'login'],
  ['instance', 'server', 'ssh'],
  ['instance', 'server', 'console'],
  ['baremetal', 'server', 'ssh'],
  ['apple-silicon', 'server', 'ssh'],
];

/** Verbes de consultation du CLI : la commande ne modifie rien chez Scaleway. */
const READ_VERBS = new Set(['list', 'get', 'wait']);
/** Chemins dont les lectures livrent des secrets ou des accès (refusés en lecture seule, même avec un verbe de lecture). */
const SENSITIVE_PATHS: string[][] = [
  ['secret', 'version'],
  ['iam', 'api-key'],
  ['mnq', 'sqs', 'credentials'],
  ['mnq', 'sns', 'credentials'],
  ['mnq', 'nats', 'credentials'],
  ['rdb', 'user'],
  ['redis', 'cluster', 'get-certificate'],
];

export interface Invocation {
  /** Arguments remis au CLI, sans `scw`. */
  tokens: string[];
  /** Mots de la commande avant le verbe (espace de noms, ressource, sous-ressource). */
  path: string[];
  /** Verbe (list, get, create, delete, start…), null si aucun verbe connu n'apparaît. */
  verb: string | null;
  /** Demande d'aide (`help …`, `-h`, `--help`) ou de version : rien n'est appelé chez Scaleway. */
  help: boolean;
}

/** Verbes repérés dans la commande ; `help` et `version` ne sont des verbes qu'en tête (`scw help`, `scw version`). */
const KNOWN_VERBS = new Set([
  'list', 'get', 'wait',
  'create', 'update', 'delete', 'start', 'stop', 'reboot', 'standby', 'terminate', 'attach', 'detach', 'enable', 'disable',
  'set', 'add', 'remove', 'restore', 'clone', 'apply', 'migrate', 'upgrade', 'backup', 'access', 'install', 'uninstall',
  'ssh', 'console', 'login', 'logout', 'init', 'generate', 'check', 'export', 'import', 'reset', 'renew', 'send', 'exec', 'deploy', 'wait',
]);

/** Retire un éventuel `scw` initial et repère le chemin et le verbe, en sautant les options et les arguments `clé=valeur`. */
export function parseInvocation(command: string): Invocation {
  let tokens = tokenize(command);
  if (tokens[0] === 'scw') tokens = tokens.slice(1);
  if (!tokens.length) throw new AppError('Commande vide : indique la ressource et le verbe, ex. « instance server list » ou « account project list »');
  const words: string[] = [];
  let help = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (t === '-h' || t === '--help') help = true;
      const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (GLOBAL_VALUE_OPTIONS.has(name) && !t.includes('=')) i++;
      continue;
    }
    if (t.includes('=')) continue;
    words.push(t);
  }
  if (words[0] === 'help' || (words.length === 1 && words[0] === 'version')) return { tokens, path: [], verb: words[0], help: true };
  const verbIndex = words.findIndex((w) => KNOWN_VERBS.has(w));
  if (verbIndex === -1) return { tokens, path: words, verb: null, help };
  return { tokens, path: words.slice(0, verbIndex), verb: words[verbIndex], help };
}

const hasPrefix = (path: string[], prefix: string[]) => prefix.length <= path.length && prefix.every((p, i) => path[i] === p);

/** La commande est-elle une simple consultation (verbe de lecture, hors chemins sensibles) ? */
export function isReadInvocation(inv: Invocation): boolean {
  if (inv.help) return true;
  if (!inv.verb || !READ_VERBS.has(inv.verb)) return false;
  return !SENSITIVE_PATHS.some((p) => hasPrefix(inv.path, p));
}

/**
 * Politique d'une commande : options et chemins toujours refusés, lecture seule selon l'élément, liste blanche de
 * préfixes (sur la commande sans `scw`, ex. « instance server list », « rdb instance »). Lève FORBIDDEN.
 */
export function checkPolicy(inv: Invocation, item: { name: string; readOnly: boolean; commandAllowlist: string[] }): void {
  for (const t of inv.tokens) {
    const name = t.startsWith('-') ? (t.includes('=') ? t.slice(0, t.indexOf('=')) : t) : null;
    if (name && FORBIDDEN_OPTIONS.has(name)) throw new AppError(`Option ${name} refusée sur « ${item.name} » : les identifiants viennent du coffre, sans profil local, traces détaillées ni navigateur`, 'FORBIDDEN');
  }
  const full = inv.verb ? [...inv.path, inv.verb] : inv.path;
  for (const p of FORBIDDEN_PATHS) {
    if (hasPrefix(full, p)) throw new AppError(`Commande « scw ${p.join(' ')} » refusée : configuration locale, connexion interactive ou fichier d'identifiants`, 'FORBIDDEN');
  }
  if (item.readOnly && !isReadInvocation(inv)) {
    throw new AppError(`Commande refusée : « ${item.name} » est en lecture seule (verbes list, get, wait seulement, hors secrets et clés) ; « ${full.join(' ')} » modifierait le compte ou révélerait un accès`, 'FORBIDDEN');
  }
  if (item.commandAllowlist.length) {
    const line = inv.tokens.join(' ');
    if (!item.commandAllowlist.some((prefix) => line === prefix || line.startsWith(`${prefix} `))) {
      throw new AppError(`Commande refusée par la politique de « ${item.name} » : seules les commandes commençant par ${item.commandAllowlist.map((p) => `"${p}"`).join(', ')} sont autorisées`, 'FORBIDDEN');
    }
  }
}

/** Environnement du CLI : identifiants, organisation, projet, région et zone par défaut ; ni télémétrie ni vérification de version. */
export function commandEnv(creds: ScalewayCredentials): Record<string, string> {
  return {
    SCW_ACCESS_KEY: creds.accessKey,
    SCW_SECRET_KEY: creds.secretKey,
    ...(creds.organizationId ? { SCW_DEFAULT_ORGANIZATION_ID: creds.organizationId } : {}),
    ...(creds.projectId ? { SCW_DEFAULT_PROJECT_ID: creds.projectId } : {}),
    SCW_DEFAULT_REGION: creds.region,
    SCW_DEFAULT_ZONE: creds.zone,
    SCW_API_URL: SCALEWAY_API_URL,
    SCW_DISABLE_CHECK_VERSION: 'true',
    SCW_SEND_TELEMETRY: 'false',
    NO_COLOR: '1',
  };
}

/** Exécute `scw <args>` dans un conteneur jetable, `cwd` monté (fichiers lus ou écrits par la commande). */
export function runCli(project: Project | null, cwd: string, creds: ScalewayCredentials, args: string[], timeoutMs: number): Promise<IsolatedResult> {
  return runner.runIsolated(project, { cwd, command: ['scw', ...args], env: commandEnv(creds), timeoutMs });
}

// ---- API HTTP ----------------------------------------------------------------------------------------

/** Identifiants d'API au format des éléments « API HTTP » : api.ts applique sa sécurité (origine, redirections, tailles, masquage de la clé). */
export function apiCredentials(creds: Pick<ScalewayCredentials, 'secretKey'>): ApiCredentials {
  return { baseUrl: SCALEWAY_API_URL, authScheme: 'header', authName: 'X-Auth-Token', username: null, token: creds.secretKey };
}

/** Chemins de l'API dont la lecture livre des secrets ou des accès : refusés en lecture seule. */
const SENSITIVE_API_RE = /^\/?(secret-manager\/[^/]+\/.*\/access|k8s\/[^/]+\/.*\/kubeconfig|iam\/[^/]+\/api-keys|mnq\/[^/]+\/.*credentials|redis\/[^/]+\/.*\/certificate|rdb\/[^/]+\/.*\/certificate)/i;

/** Valide un appel d'API pour un élément : chemin sous api.scaleway.com, lecture seule (GET, HEAD, OPTIONS, hors chemins sensibles). */
export function checkApiCall(readOnly: boolean, call: api.ApiCall, itemName: string): void {
  const target = api.resolveTarget(SCALEWAY_API_URL, call.path, call.query);
  if (readOnly && SENSITIVE_API_RE.test(target.pathname)) {
    throw new AppError(`Appel refusé : « ${itemName} » est en lecture seule et ${target.pathname} révèle un secret ou un accès`, 'FORBIDDEN');
  }
}

/** Sortie JSON d'une commande réussie, ou erreur lisible (stderr du CLI). */
export function cliError(result: IsolatedResult): string {
  const lines = result.stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? `code de sortie ${result.exitCode ?? result.signal}`;
}

// ---- Identité (test de l'élément) --------------------------------------------------------------------

export interface ScalewayIdentity {
  /** « application agents » ou « utilisateur x@y » : le principal de la clé. */
  principal: string;
  organizationId: string | null;
  defaultProjectId: string | null;
  description: string | null;
  expiresAt: string | null;
}

async function apiGet<T>(secretKey: string, path: string): Promise<T> {
  const res = await fetch(`${SCALEWAY_API_URL}${path}`, { headers: { 'x-auth-token': secretKey, accept: 'application/json', 'user-agent': 'Skipper (coffre)' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; type?: string };
  if (res.status === 401 || res.status === 403) throw new AppError(`Scaleway refuse la clé (HTTP ${res.status})${data.message ? ` : ${data.message}` : ''}`);
  if (!res.ok) throw new AppError(`Scaleway : HTTP ${res.status}${data.message ? ` ${data.message}` : ''}`);
  return data;
}

/** Vérifie la clé auprès d'IAM : principal (application ou utilisateur), organisation, projet par défaut. */
export async function identity(creds: Pick<ScalewayCredentials, 'accessKey' | 'secretKey'>): Promise<ScalewayIdentity> {
  const key = await apiGet<{ application_id?: string | null; user_id?: string | null; default_project_id?: string | null; description?: string; expires_at?: string | null }>(creds.secretKey, `/iam/v1alpha1/api-keys/${encodeURIComponent(creds.accessKey)}`);
  let principal = 'clé sans principal';
  let organizationId: string | null = null;
  if (key.application_id) {
    const app = await apiGet<{ name?: string; organization_id?: string }>(creds.secretKey, `/iam/v1alpha1/applications/${key.application_id}`);
    principal = `application ${app.name ?? key.application_id}`;
    organizationId = app.organization_id ?? null;
  } else if (key.user_id) {
    const user = await apiGet<{ email?: string; organization_id?: string }>(creds.secretKey, `/iam/v1alpha1/users/${key.user_id}`);
    principal = `utilisateur ${user.email ?? key.user_id}`;
    organizationId = user.organization_id ?? null;
  }
  return { principal, organizationId, defaultProjectId: key.default_project_id ?? null, description: key.description || null, expiresAt: key.expires_at ?? null };
}

/** Réglages par défaut d'un compte Scaleway. */
export const DEFAULT_REGION = 'fr-par';
export const DEFAULT_ZONE = 'fr-par-1';

export type { ScalewaySettings };
