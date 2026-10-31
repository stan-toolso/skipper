/**
 * Comptes AWS du coffre, partie sans état : validation des réglages, découpage et politique des commandes
 * du CLI (`aws_run`), appels HTTP à IAM Identity Center (OIDC : connexion par code, renouvellement ; portail :
 * comptes, rôles, identifiants temporaires d'un rôle) et exécution du CLI dans un conteneur jetable du runner.
 * Aucune dépendance au service du coffre : la partie avec état (jetons, caches, connexion) est dans awsService.ts.
 */
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import type { IsolatedResult } from '../runners/types.js';
import type { AwsCredentials } from './types.js';
import { log } from '../log.js';

// ---- Réglages ----------------------------------------------------------------------------------------

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function validateRegion(value: string | null | undefined, label = 'La région'): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!REGION_RE.test(v)) throw new AppError(`${label} est invalide (ex. eu-west-3, us-east-1)`);
  return v;
}

/** Adresse du portail d'accès IAM Identity Center : https obligatoire, sans fragment (`#/` ajouté par le navigateur). */
export function validateStartUrl(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new AppError("L'adresse du portail d'accès est invalide (ex. https://mon-org.awsapps.com/start)");
  }
  if (url.protocol !== 'https:') throw new AppError("L'adresse du portail d'accès doit être en https");
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function validateAccountId(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!/^\d{12}$/.test(v)) throw new AppError('Identifiant de compte AWS invalide : 12 chiffres attendus');
  return v;
}

export function validateRoleName(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!/^[\w+=,.@-]{1,64}$/.test(v)) throw new AppError("Nom de rôle (jeu d'autorisations) invalide");
  return v;
}

export function validateAccessKeyId(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!/^[A-Z0-9]{16,128}$/.test(v)) throw new AppError("Identifiant de clé d'accès invalide (ex. AKIAIOSFODNN7EXAMPLE)");
  return v;
}

export function validateRoleArn(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(v)) throw new AppError('ARN de rôle invalide (ex. arn:aws:iam::123456789012:role/agents)');
  return v;
}

// ---- Commandes ---------------------------------------------------------------------------------------

/**
 * Découpe une ligne de commande comme un shell POSIX le ferait pour les guillemets et l'échappement, sans
 * rien exécuter ni substituer : les arguments vont tels quels au CLI, aucun shell n'intervient.
 */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1])) current += command[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < command.length) {
      current += command[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(current);
      current = '';
      has = false;
    } else {
      current += c;
      has = true;
    }
  }
  if (quote) throw new AppError(`Commande mal formée : guillemet ${quote} non refermé`);
  if (has) out.push(current);
  return out;
}

/** Options globales du CLI qui prennent une valeur (pour retrouver le service et l'opération). */
const GLOBAL_VALUE_OPTIONS = new Set(['--region', '--output', '--query', '--endpoint-url', '--profile', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--cli-binary-format']);

/** Options refusées : fichiers de configuration de l'hôte, traces détaillées (identifiants et signatures dans les journaux), invite interactive. */
const FORBIDDEN_OPTIONS = new Set(['--profile', '--debug', '--cli-auto-prompt']);

/** Commandes refusées : configuration locale, connexions interactives, shells distants. */
const FORBIDDEN_SERVICES = new Set(['configure', 'sso', 'login', 'logout', 'cloudshell']);
const FORBIDDEN_OPERATIONS: Record<string, string[]> = { ssm: ['start-session'], ecs: ['execute-command'], emr: ['ssh', 'sock', 'put', 'get'], opsworks: ['register'], deploy: ['install', 'uninstall'] };

/** Opérations de lecture (sans effet sur le compte), par le préfixe de leur nom. */
const READ_OPERATION_RE = /^(describe|get|list|head|lookup|search|query|scan|batch-get|batch-describe|check|estimate|preview|validate|verify|simulate|select|filter|count|detect|discover|retrieve|view|test|tail|wait|is-|has-|can-|export)(-|$)/;
/** Lectures qui n'entrent pas dans le motif. */
const READ_SPECIAL: Record<string, Set<string>> = { s3: new Set(['ls', 'presign']), logs: new Set(['tail']) };
/** Opérations qui ressemblent à des lectures mais écrivent (ou créent des accès). */
const WRITE_DESPITE_PREFIX = new Set(['get-session-token', 'get-federation-token', 'get-login-password', 'get-authorization-token', 'export-certificate', 'export-image', 'export-snapshot', 'export-table-to-point-in-time', 'export-api', 'test-invoke-method', 'test-invoke-authorizer', 'test-connection', 'test-function', 'test-metric-filter']);

export interface Invocation {
  tokens: string[];
  service: string | null;
  operation: string | null;
}

/** Retire un éventuel `aws` initial et repère le service et l'opération, en sautant les options globales. */
export function parseInvocation(command: string): Invocation {
  let tokens = tokenize(command);
  if (tokens[0] === 'aws') tokens = tokens.slice(1);
  if (!tokens.length) throw new AppError('Commande vide : indique le service et l’opération, ex. « s3 ls » ou « sts get-caller-identity »');
  const positional: string[] = [];
  for (let i = 0; i < tokens.length && positional.length < 2; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (GLOBAL_VALUE_OPTIONS.has(name) && !t.includes('=')) i++;
      continue;
    }
    positional.push(t);
  }
  return { tokens, service: positional[0] ?? null, operation: positional[1] ?? null };
}

/** Une opération est-elle une lecture ? (`help` toujours.) */
export function isReadOperation(service: string | null, operation: string | null): boolean {
  if (service === 'help' || operation === 'help') return true;
  if (!service || !operation) return false;
  if (READ_SPECIAL[service]?.has(operation)) return true;
  if (WRITE_DESPITE_PREFIX.has(operation)) return false;
  return READ_OPERATION_RE.test(operation);
}

/**
 * Politique d'une commande : options et commandes toujours refusées, lecture seule selon l'élément, liste
 * blanche de préfixes (sur la commande sans `aws`, ex. « s3 ls », « ec2 describe »). Lève FORBIDDEN.
 */
export function checkPolicy(inv: Invocation, item: { name: string; readOnly: boolean; commandAllowlist: string[] }): void {
  for (const t of inv.tokens) {
    const name = t.startsWith('--') ? (t.includes('=') ? t.slice(0, t.indexOf('=')) : t) : null;
    if (name && FORBIDDEN_OPTIONS.has(name)) throw new AppError(`Option ${name} refusée sur « ${item.name} » : les identifiants viennent du coffre, sans profil local ni traces détaillées`, 'FORBIDDEN');
  }
  if (inv.service && FORBIDDEN_SERVICES.has(inv.service)) throw new AppError(`Commande « aws ${inv.service} » refusée : la configuration et la connexion sont gérées par le coffre`, 'FORBIDDEN');
  if (inv.service && inv.operation && FORBIDDEN_OPERATIONS[inv.service]?.includes(inv.operation)) throw new AppError(`Commande « aws ${inv.service} ${inv.operation} » refusée : les sessions interactives ne sont pas possibles ici`, 'FORBIDDEN');
  if (item.readOnly && !isReadOperation(inv.service, inv.operation)) {
    throw new AppError(`Commande refusée : « ${item.name} » est en lecture seule (opérations describe-*, get-*, list-*, s3 ls… seulement) ; « ${[inv.service, inv.operation].filter(Boolean).join(' ')} » modifierait le compte`, 'FORBIDDEN');
  }
  if (item.commandAllowlist.length) {
    const line = inv.tokens.join(' ');
    if (!item.commandAllowlist.some((prefix) => line === prefix || line.startsWith(`${prefix} `))) {
      throw new AppError(`Commande refusée par la politique de « ${item.name} » : seules les commandes commençant par ${item.commandAllowlist.map((p) => `"${p}"`).join(', ')} sont autorisées`, 'FORBIDDEN');
    }
  }
}

/** Environnement du CLI : identifiants, région, pas de pager ni d'invite, ni de métadonnées d'instance. */
export function commandEnv(creds: AwsCredentials): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
    AWS_DEFAULT_REGION: creds.region,
    AWS_REGION: creds.region,
    AWS_PAGER: '',
    AWS_CLI_AUTO_PROMPT: 'off',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_RETRY_MODE: 'standard',
  };
}

/** Exécute `aws <args>` dans un conteneur jetable, `cwd` monté (fichiers lus ou écrits par la commande). */
export function runCli(project: Project | null, cwd: string, creds: AwsCredentials, args: string[], timeoutMs: number): Promise<IsolatedResult> {
  return runner.runIsolated(project, { cwd, command: ['aws', ...args], env: commandEnv(creds), timeoutMs });
}

/** Sortie JSON d'une commande réussie, ou erreur lisible (stderr du CLI). */
export function parseJsonOutput<T>(result: IsolatedResult, what: string): T {
  if (result.exitCode !== 0) throw new AppError(`${what} : ${cliError(result)}`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new AppError(`${what} : réponse illisible du CLI`);
  }
}

/** Dernière ligne utile de stderr (le CLI y met son message d'erreur). */
export function cliError(result: IsolatedResult): string {
  const lines = result.stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? `code de sortie ${result.exitCode ?? result.signal}`;
}

// ---- IAM Identity Center : OIDC (connexion par code) et portail d'accès -----------------------------------

const oidcUrl = (region: string) => `https://oidc.${region}.amazonaws.com`;
const portalUrl = (region: string) => `https://portal.sso.${region}.amazonaws.com`;

/** Erreur OIDC avec son code (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, `invalid_grant`…). */
export class AwsOidcError extends AppError {
  constructor(
    readonly error: string,
    description: string | null,
  ) {
    super(`AWS : ${description ?? error}`, 'AWS_OIDC');
    this.name = 'AwsOidcError';
  }
}

async function oidcPost<T>(region: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${oidcUrl(region)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string; message?: string };
  if (!res.ok) throw new AwsOidcError(data.error ?? `http_${res.status}`, data.error_description ?? data.message ?? null);
  return data;
}

export interface ClientRegistration {
  clientId: string;
  clientSecret: string;
  /** Expiration de l'enregistrement (ms epoch), environ 90 jours. */
  expiresAt: number;
}

/** Enregistre Skipper comme client public d'IAM Identity Center (portée « accès aux comptes »). */
export async function registerClient(region: string): Promise<ClientRegistration> {
  const r = await oidcPost<{ clientId: string; clientSecret: string; clientSecretExpiresAt: number }>(region, '/client/register', { clientName: 'skipper', clientType: 'public', scopes: ['sso:account:access'] });
  return { clientId: r.clientId, clientSecret: r.clientSecret, expiresAt: r.clientSecretExpiresAt * 1000 };
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Expiration du code (ms epoch). */
  expiresAt: number;
  /** Secondes entre deux interrogations. */
  interval: number;
}

export async function startDeviceAuthorization(region: string, client: Pick<ClientRegistration, 'clientId' | 'clientSecret'>, startUrl: string): Promise<DeviceAuthorization> {
  const r = await oidcPost<{ deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number }>(region, '/device_authorization', { clientId: client.clientId, clientSecret: client.clientSecret, startUrl });
  return { deviceCode: r.deviceCode, userCode: r.userCode, verificationUri: r.verificationUri, verificationUriComplete: r.verificationUriComplete, expiresAt: Date.now() + (r.expiresIn ?? 600) * 1000, interval: r.interval ?? 5 };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Expiration du jeton d'accès (ms epoch). */
  expiresAt: number;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Jeton d'accès contre un code d'appareil autorisé (lève `authorization_pending` tant que l'humain n'a pas validé). */
export async function createTokenFromDevice(region: string, client: Pick<ClientRegistration, 'clientId' | 'clientSecret'>, deviceCode: string): Promise<TokenSet> {
  return tokenSet(await oidcPost<{ accessToken: string; refreshToken?: string; expiresIn: number }>(region, '/token', { clientId: client.clientId, clientSecret: client.clientSecret, grantType: DEVICE_GRANT, deviceCode }));
}

/** Renouvellement du jeton d'accès ; Identity Center peut rendre un nouveau jeton de renouvellement. */
export async function refreshAccessToken(region: string, client: Pick<ClientRegistration, 'clientId' | 'clientSecret'>, refreshToken: string): Promise<TokenSet> {
  const r = await oidcPost<{ accessToken: string; refreshToken?: string; expiresIn: number }>(region, '/token', { clientId: client.clientId, clientSecret: client.clientSecret, grantType: 'refresh_token', refreshToken });
  return { ...tokenSet(r), refreshToken: r.refreshToken ?? refreshToken };
}

const tokenSet = (r: { accessToken: string; refreshToken?: string; expiresIn: number }): TokenSet => ({ accessToken: r.accessToken, refreshToken: r.refreshToken ?? null, expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000 });

async function portalGet<T>(region: string, path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${portalUrl(region)}${path}`, { headers: { 'x-amz-sso_bearer_token': accessToken, accept: 'application/json' } });
  if (res.status === 401) throw new AppError('La connexion AWS a expiré ou a été révoquée : reconnectez le compte', 'AWS_RECONNECT');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(`AWS (portail d'accès) : ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`, 'AWS_ERROR');
  }
  return (await res.json()) as T;
}

export interface AwsAccount {
  accountId: string;
  accountName: string;
  email: string | null;
}

/** Comptes auxquels la personne connectée a accès (au plus 200). */
export async function listAccounts(region: string, accessToken: string): Promise<AwsAccount[]> {
  const out: AwsAccount[] = [];
  let next: string | null = null;
  do {
    const page: { accountList?: { accountId: string; accountName: string; emailAddress?: string }[]; nextToken?: string } = await portalGet(region, `/assignment/accounts?max_result=100${next ? `&next_token=${encodeURIComponent(next)}` : ''}`, accessToken);
    for (const a of page.accountList ?? []) out.push({ accountId: a.accountId, accountName: a.accountName, email: a.emailAddress ?? null });
    next = page.nextToken ?? null;
  } while (next && out.length < 200);
  return out;
}

/** Rôles (jeux d'autorisations) de la personne sur un compte. */
export async function listRoles(region: string, accessToken: string, accountId: string): Promise<string[]> {
  const out: string[] = [];
  let next: string | null = null;
  do {
    const page: { roleList?: { roleName: string }[]; nextToken?: string } = await portalGet(region, `/assignment/roles?account_id=${encodeURIComponent(accountId)}&max_result=100${next ? `&next_token=${encodeURIComponent(next)}` : ''}`, accessToken);
    for (const r of page.roleList ?? []) out.push(r.roleName);
    next = page.nextToken ?? null;
  } while (next && out.length < 200);
  return out;
}

/** Identifiants temporaires d'un rôle sur un compte (durée du jeu d'autorisations, 1 h par défaut). */
export async function roleCredentials(region: string, accessToken: string, accountId: string, roleName: string, defaultRegion: string): Promise<AwsCredentials> {
  const r = await portalGet<{ roleCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number } }>(region, `/federation/credentials?account_id=${encodeURIComponent(accountId)}&role_name=${encodeURIComponent(roleName)}`, accessToken);
  const c = r.roleCredentials;
  if (!c?.accessKeyId || !c.secretAccessKey) throw new AppError(`AWS n'a pas fourni d'identifiants pour le rôle ${roleName} sur le compte ${accountId}`, 'AWS_ERROR');
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken ?? null, region: defaultRegion, expiresAt: c.expiration ?? Date.now() + 3600_000 };
}

/** Déconnexion côté Identity Center (au mieux). */
export async function logout(region: string, accessToken: string): Promise<void> {
  try {
    await fetch(`${portalUrl(region)}/logout`, { method: 'POST', headers: { 'x-amz-sso_bearer_token': accessToken } });
  } catch (err) {
    log.warn('[aws] déconnexion impossible :', (err as Error).message);
  }
}
