import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import * as aws from './aws.js';
import { sealSecrets } from './crypto.js';
import { vaultRepository } from './repository.js';
import { vaultService } from './service.js';
import type { AwsCredentials, AwsSettings, VaultActor, VaultItem } from './types.js';

/**
 * Comptes AWS du coffre, partie avec état : connexion par code à IAM Identity Center (jetons chiffrés dans
 * l'élément, renouvelés par Skipper), identifiants temporaires du rôle ou des clés (cache en mémoire),
 * exécution d'une commande du CLI pour un agent, test et déconnexion. Le service est le seul à voir les
 * identifiants en clair : l'agent ne reçoit que la sortie de la commande.
 */

/**
 * Identifiants temporaires par élément (jamais persistés) : rôle Identity Center ou rôle endossé avec des clés.
 * `version` : date de modification de l'élément, pour oublier les identifiants quand ses réglages changent.
 */
const credentialCache = new Map<string, AwsCredentials & { version: number }>();
/** Marge avant expiration en deçà de laquelle on renouvelle (identifiants et jeton d'accès). */
const MARGIN_MS = 5 * 60_000;
const ASSUME_ROLE_SECONDS = 3600;

export interface AwsLogin {
  id: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: Date;
  interval: number;
}

export type AwsLoginStatus = 'pending' | 'connected' | 'expired' | 'denied';

export interface AwsLoginPoll {
  status: AwsLoginStatus;
  interval: number;
  item: VaultItem | null;
}

export interface AwsAccountChoice extends aws.AwsAccount {
  roles: string[];
}

/** État d'une connexion en cours, chiffré avec la clé du serveur et remis à la page (nul autre ne peut l'interroger). */
interface LoginState {
  /** Élément. */
  i: string;
  /** Personne qui a lancé la connexion. */
  u: string;
  /** Code d'appareil. */
  d: string;
  /** Expiration (ms epoch). */
  e: number;
}

const settingsOf = (item: VaultItem): AwsSettings => {
  if (item.kind !== 'aws') throw new AppError(`« ${item.name} » n'est pas un compte AWS`);
  return item.settings as AwsSettings;
};

function readState(id: string, userId: string): LoginState {
  let state: LoginState;
  try {
    state = JSON.parse(decryptSecret(id)) as LoginState;
  } catch {
    throw new AppError('Connexion AWS introuvable : recommencez');
  }
  if (state.u !== userId) throw new AppError('Connexion AWS introuvable : recommencez');
  return state;
}

/** Dossier de l'hôte monté pour les commandes lancées hors session (test, endossement de rôle) : vide, propre à Skipper. */
async function scratchDir(): Promise<string> {
  const dir = path.join(config.workspacesRoot, '.runners', 'aws-scratch');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const awsService = {
  settingsOf,

  /** Le compte est-il connecté (sso : jeton de renouvellement ou jeton d'accès en cours ; keys : clé présente) ? */
  connected(item: VaultItem, secrets?: Record<string, string>): boolean {
    const s = settingsOf(item);
    if (s.auth === 'keys') return vaultService.hasSecret(item);
    if (!s.tokenExpiresAt) return false;
    const sec = secrets ?? safeSecrets(item);
    return Boolean(sec?.refreshToken) || new Date(s.tokenExpiresAt).getTime() > Date.now();
  },

  /**
   * Jeton d'accès Identity Center en cours de validité, renouvelé avec le jeton de renouvellement quand il
   * approche de son expiration (nouveaux jetons chiffrés dans l'élément, sans action humaine).
   */
  async accessToken(item: VaultItem): Promise<{ token: string; item: VaultItem }> {
    const s = settingsOf(item);
    if (s.auth !== 'sso') throw new AppError(`« ${item.name} » n'utilise pas IAM Identity Center`);
    if (!s.ssoRegion) throw new AppError(`« ${item.name} » : région Identity Center manquante`);
    let secrets: Record<string, string>;
    try {
      secrets = vaultService.secretsOf(item);
    } catch {
      throw new AppError(`Jetons AWS de « ${item.name} » illisibles (clé de chiffrement changée ?) : reconnectez le compte`, 'AWS_RECONNECT');
    }
    const expiresAt = s.tokenExpiresAt ? new Date(s.tokenExpiresAt).getTime() : 0;
    if (secrets.accessToken && expiresAt - Date.now() > MARGIN_MS) return { token: secrets.accessToken, item };
    if (!secrets.refreshToken || !secrets.clientId || !secrets.clientSecret) throw new AppError(`La connexion AWS de « ${item.name} » a expiré : reconnectez le compte (page du coffre)`, 'AWS_RECONNECT');
    let tokens: aws.TokenSet;
    try {
      tokens = await aws.refreshAccessToken(s.ssoRegion, { clientId: secrets.clientId, clientSecret: secrets.clientSecret }, secrets.refreshToken);
    } catch (err) {
      if (err instanceof aws.AwsOidcError) {
        // Jeton de renouvellement révoqué ou expiré : la connexion est perdue jusqu'à une nouvelle connexion par code.
        const settings: AwsSettings = { ...s, tokenExpiresAt: null };
        await vaultRepository.update(item.id, { settings, ...sealSecrets(item.id, 'aws', { clientId: secrets.clientId, clientSecret: secrets.clientSecret }) });
        await vaultService.audit(item, 'updated', null, `connexion AWS perdue (${err.error}) : reconnexion nécessaire`, false);
        throw new AppError(`La connexion AWS de « ${item.name} » a expiré ou a été révoquée : reconnectez le compte (page du coffre)`, 'AWS_RECONNECT');
      }
      throw err;
    }
    const settings: AwsSettings = { ...s, tokenExpiresAt: new Date(tokens.expiresAt).toISOString() };
    const updated = await vaultRepository.update(item.id, { settings, ...sealSecrets(item.id, 'aws', { ...secrets, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? secrets.refreshToken }) });
    return { token: tokens.accessToken, item: updated };
  },

  /**
   * Identifiants pour exécuter une commande : rôle Identity Center (identifiants temporaires du portail), ou
   * clés d'accès, éventuellement échangées contre celles d'un rôle endossé (`sts assume-role`, lancé par Skipper).
   * Les identifiants temporaires sont gardés en mémoire jusqu'à cinq minutes avant leur expiration.
   */
  async credentials(item: VaultItem, project: Project | null): Promise<AwsCredentials> {
    const s = settingsOf(item);
    const cached = credentialCache.get(item.id);
    if (cached && cached.version === item.updatedAt.getTime() && cached.expiresAt !== null && cached.expiresAt - Date.now() > MARGIN_MS) return cached;
    let creds: AwsCredentials;
    if (s.auth === 'sso') {
      if (!s.accountId || !s.roleName) throw new AppError(`« ${item.name} » : choisissez le compte et le rôle après la connexion (page du coffre)`);
      const { token } = await this.accessToken(item);
      creds = await aws.roleCredentials(s.ssoRegion!, token, s.accountId, s.roleName, s.region);
    } else {
      const secret = vaultService.secretsOf(item).secretAccessKey;
      if (!s.accessKeyId || !secret) throw new AppError(`« ${item.name} » n'a pas de clés d'accès`);
      const base: AwsCredentials = { accessKeyId: s.accessKeyId, secretAccessKey: secret, sessionToken: null, region: s.region, expiresAt: null };
      if (!s.roleArn) return base;
      const result = await aws.runCli(project, await scratchDir(), base, ['sts', 'assume-role', '--role-arn', s.roleArn, '--role-session-name', `skipper-${item.name}`.slice(0, 64), '--duration-seconds', String(ASSUME_ROLE_SECONDS), '--output', 'json'], 60_000);
      const out = aws.parseJsonOutput<{ Credentials?: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: string } }>(result, `Endossement du rôle ${s.roleArn} impossible`);
      const c = out.Credentials;
      if (!c) throw new AppError(`Endossement du rôle ${s.roleArn} : réponse sans identifiants`);
      creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, region: s.region, expiresAt: new Date(c.Expiration).getTime() || Date.now() + ASSUME_ROLE_SECONDS * 1000 };
    }
    credentialCache.set(item.id, { ...creds, version: item.updatedAt.getTime() });
    return creds;
  },

  /** Oublie les identifiants temporaires d'un élément (réglages changés, suppression). */
  forget(itemId: string): void {
    credentialCache.delete(itemId);
  },

  /**
   * Commande du CLI pour un agent : découpage sans shell, politique (lecture seule, préfixes autorisés,
   * commandes interdites), identifiants, puis exécution dans un conteneur jetable où `cwd` est monté.
   */
  async run(item: VaultItem, project: Project | null, cwd: string, command: string, timeoutMs: number) {
    const inv = aws.parseInvocation(command);
    aws.checkPolicy(inv, item);
    const creds = await this.credentials(item, project);
    return aws.runCli(project, cwd, creds, inv.tokens, timeoutMs);
  },

  /** Vérifie la commande d'un agent sans l'exécuter (avant la demande d'approbation). */
  check(item: VaultItem, command: string): aws.Invocation {
    const inv = aws.parseInvocation(command);
    aws.checkPolicy(inv, item);
    return inv;
  },

  // ---- Connexion par code (IAM Identity Center) -----------------------------------------------------

  /** Démarre la connexion : enregistrement du client OIDC (réutilisé s'il est encore valable), puis code à saisir sur le portail. */
  async startLogin(actor: VaultActor & { userId: string }, itemId: string): Promise<AwsLogin> {
    const item = await vaultService.getFor(actor.userId, itemId, 'manage');
    const s = settingsOf(item);
    if (s.auth !== 'sso' || !s.startUrl || !s.ssoRegion) throw new AppError(`« ${item.name} » n'est pas configuré pour IAM Identity Center (portail d'accès et région)`);
    const secrets = safeSecrets(item) ?? {};
    let client: Pick<aws.ClientRegistration, 'clientId' | 'clientSecret'>;
    const clientExpires = s.clientExpiresAt ? new Date(s.clientExpiresAt).getTime() : 0;
    if (secrets.clientId && secrets.clientSecret && clientExpires - Date.now() > 24 * 3600_000) {
      client = { clientId: secrets.clientId, clientSecret: secrets.clientSecret };
    } else {
      const reg = await aws.registerClient(s.ssoRegion);
      client = reg;
      const settings: AwsSettings = { ...s, clientExpiresAt: new Date(reg.expiresAt).toISOString() };
      await vaultRepository.update(item.id, { settings, ...sealSecrets(item.id, 'aws', { ...secrets, clientId: reg.clientId, clientSecret: reg.clientSecret }) });
    }
    const auth = await aws.startDeviceAuthorization(s.ssoRegion, client, s.startUrl);
    return {
      id: encryptSecret(JSON.stringify({ i: item.id, u: actor.userId, d: auth.deviceCode, e: auth.expiresAt } satisfies LoginState)),
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      expiresAt: new Date(auth.expiresAt),
      interval: auth.interval,
    };
  },

  /** Une interrogation : enregistre les jetons quand l'autorisation a été donnée sur le portail. */
  async pollLogin(actor: VaultActor & { userId: string }, id: string): Promise<AwsLoginPoll> {
    const state = readState(id, actor.userId);
    if (state.e < Date.now()) return { status: 'expired', interval: 0, item: null };
    const item = await vaultService.getFor(actor.userId, state.i, 'manage');
    const s = settingsOf(item);
    const secrets = vaultService.secretsOf(item);
    if (!secrets.clientId || !secrets.clientSecret || !s.ssoRegion) throw new AppError('Connexion AWS introuvable : recommencez');
    let tokens: aws.TokenSet;
    try {
      tokens = await aws.createTokenFromDevice(s.ssoRegion, { clientId: secrets.clientId, clientSecret: secrets.clientSecret }, state.d);
    } catch (err) {
      if (!(err instanceof aws.AwsOidcError)) throw err;
      switch (err.error) {
        case 'authorization_pending':
          return { status: 'pending', interval: 5, item: null };
        case 'slow_down':
          return { status: 'pending', interval: 10, item: null };
        case 'expired_token':
          return { status: 'expired', interval: 0, item: null };
        case 'access_denied':
          return { status: 'denied', interval: 0, item: null };
        default:
          throw err;
      }
    }
    const settings: AwsSettings = { ...s, tokenExpiresAt: new Date(tokens.expiresAt).toISOString() };
    const next: Record<string, string> = { clientId: secrets.clientId, clientSecret: secrets.clientSecret, accessToken: tokens.accessToken };
    if (tokens.refreshToken) next.refreshToken = tokens.refreshToken;
    const updated = await vaultRepository.update(item.id, { settings, ...sealSecrets(item.id, 'aws', next) });
    credentialCache.delete(item.id);
    await vaultService.audit(updated, 'connected', actor, `IAM Identity Center ${s.startUrl}${tokens.refreshToken ? '' : ' (sans jeton de renouvellement : reconnexion à l’expiration)'}`);
    return { status: 'connected', interval: 0, item: updated };
  },

  /** Comptes et rôles accessibles avec la connexion en cours (choix du compte et du rôle après la connexion). */
  async accounts(actor: VaultActor & { userId: string }, itemId: string): Promise<AwsAccountChoice[]> {
    const item = await vaultService.getFor(actor.userId, itemId, 'manage');
    const s = settingsOf(item);
    if (s.auth !== 'sso') throw new AppError(`« ${item.name} » n'utilise pas IAM Identity Center`);
    const { token } = await this.accessToken(item);
    const accounts = await aws.listAccounts(s.ssoRegion!, token);
    const out: AwsAccountChoice[] = [];
    for (const a of accounts.slice(0, 50)) out.push({ ...a, roles: await aws.listRoles(s.ssoRegion!, token, a.accountId) });
    return out;
  },

  // ---- Test et suppression --------------------------------------------------------------------------

  /** `sts get-caller-identity` avec les identifiants de l'élément ; l'identité constatée est mémorisée. */
  async probe(item: VaultItem): Promise<string> {
    const s = settingsOf(item);
    credentialCache.delete(item.id);
    const owner = item.ownerProjectId ? await projectOf(item.ownerProjectId) : null;
    const creds = await this.credentials(item, owner);
    const result = await aws.runCli(owner, await scratchDir(), creds, ['sts', 'get-caller-identity', '--output', 'json'], 60_000);
    const who = aws.parseJsonOutput<{ Arn?: string; Account?: string }>(result, 'Identité AWS impossible à vérifier');
    if (!who.Arn) throw new AppError('Identité AWS impossible à vérifier : réponse sans ARN');
    // L'élément a pu être mis à jour entre-temps (jeton d'accès renouvelé) : on repart de ses réglages actuels.
    const fresh = settingsOf(await vaultService.getInternal(item.id));
    await vaultRepository.update(item.id, { settings: { ...fresh, identity: who.Arn } satisfies AwsSettings });
    return `${who.Arn}${fresh.auth === 'sso' && fresh.tokenExpiresAt ? ` · connexion Identity Center valable jusqu'au ${new Date(fresh.tokenExpiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' })}` : ''}`;
  },

  /** Avant la suppression : déconnexion du portail (au mieux) et oubli des identifiants temporaires. */
  async beforeDelete(item: VaultItem): Promise<void> {
    credentialCache.delete(item.id);
    const s = settingsOf(item);
    const secrets = safeSecrets(item);
    if (s.auth === 'sso' && s.ssoRegion && secrets?.accessToken) await aws.logout(s.ssoRegion, secrets.accessToken);
  },
};

function safeSecrets(item: VaultItem): Record<string, string> | null {
  try {
    return vaultService.secretsOf(item);
  } catch {
    return null;
  }
}

async function projectOf(id: string): Promise<Project | null> {
  try {
    return await projectService.get(id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

vaultService.onBeforeDelete('aws', (item) => awsService.beforeDelete(item));
vaultService.probers.set('aws', (item) => awsService.probe(item));
