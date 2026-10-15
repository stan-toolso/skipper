import { randomUUID } from 'node:crypto';
import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { decryptSecret } from '../settings/crypto.js';
import { userRepository } from '../users/repository.js';
import { userService } from '../users/service.js';
import type { ProjectRole } from '../users/types.js';
import { atLeast, canLink, hasDirectAccess, permissionOf, revealableFields, type AccessFacts } from './access.js';
import * as api from './api.js';
import * as aws from './aws.js';
import { currentKeyId, openSecrets, rewrapKey, sealSecrets, VaultDecryptError } from './crypto.js';
import * as postgres from './postgres.js';
import { vaultRepository, type VaultItemPatch, type VaultItemRecord } from './repository.js';
import * as ssh from './ssh.js';
import * as llm from './llm.js';
import { isTokenService, TOKEN_SERVICES, tokenMismatch, type TokenService } from './tokens.js';
import {
  AGENT_KINDS,
  API_AUTH_SCHEMES,
  AWS_AUTHS,
  PERMISSION_RANK,
  SKIPPER_KINDS,
  TOOL_KINDS,
  VAULT_KINDS,
  kindLabels,
  type ApiCredentials,
  type ApiSettings,
  type AwsSettings,
  type FieldCredentials,
  type GoogleSettings,
  type LangfuseSettings,
  type LitellmSettings,
  type PostgresCredentials,
  type PostgresSettings,
  type ProjectVaultRow,
  type SecretSettings,
  type SshCredentials,
  type SshSettings,
  type TokenSettings,
  type VaultActor,
  type VaultAuditEvent,
  type VaultField,
  type VaultFieldInput,
  type VaultItem,
  type VaultItemInput,
  type VaultItemKind,
  type VaultLink,
  type VaultLinkScope,
  type VaultPermission,
  type VaultTestResult,
  type WebsiteSettings,
} from './types.js';
import * as website from './website.js';

/** Un jeton applicatif obtenu par un parcours de connexion : il ne quitte jamais le serveur et ne se modifie pas à la main. */
export const isOauthToken = (item: Pick<VaultItem, 'kind' | 'settings'>): boolean => item.kind === 'token' && (item.settings as TokenSettings).obtained === 'oauth';

/**
 * Coffre. Le service est le seul à manipuler les secrets en clair : il les déchiffre le temps d'un usage
 * (test, outil MCP, révélation) et ne les renvoie jamais à l'interface, sauf révélation explicite
 * journalisée. Toute vérification de droits passe par ici.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DEFAULT_PORTS = { ssh: 22, postgres: 5432 } as const;
const MAX_SECRET = 64 * 1024;
const MAX_FIELDS = 50;
const AUDIT_DETAIL_MAX = 500;
const REVEAL_WINDOW_MS = 10 * 60 * 1000;
const REVEAL_MAX = 30;
const AUDIT_RETENTION_DAYS = 400;

export type VaultItemWithPermission = VaultItem & { permission: VaultPermission };

function validateName(name: string | null | undefined): string {
  const n = (name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(n)) throw new AppError('Nom invalide : lettres minuscules, chiffres, tirets et soulignés, 40 caractères maximum (ex. "prod", "rds-prod")');
  return n;
}

function requireText(value: string | null | undefined, label: string): string {
  const v = value?.trim();
  if (!v) throw new AppError(`${label} obligatoire`);
  return v;
}

function validatePort(port: number | null | undefined, fallback: number): number {
  if (port == null) return fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('Port invalide');
  return port;
}

function assertSecretSize(value: string, label: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET) throw new AppError(`${label} : valeur trop longue`);
  return value;
}

function normalizeAllowlist(list: string[] | null | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean);
}

function parseExpiry(value: Date | string | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError("Date d'expiration invalide");
  return d;
}

function validateSslCa(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const blocks = v.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new AppError('Certificat de l\'autorité invalide : blocs PEM « BEGIN CERTIFICATE » attendus');
  const joined = blocks.join('\n');
  if (Buffer.byteLength(joined) > MAX_SECRET) throw new AppError('Certificat de l\'autorité trop long');
  return joined;
}

/** Hôte affiché d'un site (sans chemin). */
const hostOf = (url: string) => website.hostOf(url);

/** Déchiffre les secrets de l'ancien format (connexions). */
function legacySecretsOf(item: VaultItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(item.legacySecrets ?? {})) out[k] = decryptSecret(v);
  return out;
}

interface Ordered {
  row: ProjectVaultRow;
}
const VIA_ORDER = { own: 0, project: 1, personal: 2 } as const;

/** Révélations récentes par personne (fenêtre glissante, mémoire de l'instance). */
const reveals = new Map<string, number[]>();

type DeleteHook = (item: VaultItem) => Promise<void>;
const beforeDeleteHooks = new Map<VaultItemKind, DeleteHook>();

export const vaultService = {
  /** Branche un traitement avant la suppression d'un élément d'un type (ex. révocation Google). */
  onBeforeDelete: (kind: VaultItemKind, fn: DeleteHook) => beforeDeleteHooks.set(kind, fn),

  // ---- Accès ---------------------------------------------------------------------------------------

  /** Lecture sans contrôle de droits (outils après résolution de la portée, tunnels). */
  async getInternal(id: string): Promise<VaultItem> {
    const item = await vaultRepository.findById(id);
    if (!item) throw new NotFoundError('Élément du coffre introuvable');
    return item;
  },

  async permissionFor(userId: string, item: VaultItem): Promise<VaultPermission | null> {
    return permissionOf(item, userId, await vaultRepository.facts(item, userId));
  },

  /** Élément visible par la personne avec au moins `min` ; « introuvable » si elle ne le voit pas du tout. */
  async getFor(userId: string, id: string, min: VaultPermission = 'use'): Promise<VaultItemWithPermission> {
    const item = await vaultRepository.findById(id);
    const permission = item ? await this.permissionFor(userId, item) : null;
    if (!item || !permission) throw new NotFoundError('Élément du coffre introuvable');
    if (!atLeast(permission, min)) throw new AppError(`Cette action demande la permission « ${min} » sur cet élément`, 'FORBIDDEN');
    return { ...item, permission };
  },

  async findFor(userId: string, id: string): Promise<VaultItemWithPermission | null> {
    try {
      return await this.getFor(userId, id, 'use');
    } catch {
      return null;
    }
  },

  async listAccessible(userId: string, kind?: VaultItemKind | VaultItemKind[] | null): Promise<VaultItemWithPermission[]> {
    const items = await vaultRepository.listAccessible(userId, kind);
    const out: VaultItemWithPermission[] = [];
    for (const item of items) {
      const permission = await this.permissionFor(userId, item);
      if (permission) out.push({ ...item, permission });
    }
    return out;
  },

  hasSecret: (item: VaultItem) => Boolean(item.secretCiphertext) || Boolean(item.legacySecrets && Object.keys(item.legacySecrets).length),

  revealableFields(item: VaultItem, permission: VaultPermission | null): string[] {
    return revealableFields(item, permission, this.hasSecret(item));
  },

  // ---- Secrets -----------------------------------------------------------------------------------

  /** Secrets déchiffrés d'un élément (enveloppe, ou ancien format en attendant la conversion). */
  secretsOf(item: VaultItem): Record<string, string> {
    try {
      if (item.secretCiphertext && item.wrappedKey) return openSecrets(item.id, item.kind, item.secretCiphertext, item.wrappedKey);
      if (item.legacySecrets) return legacySecretsOf(item);
      return {};
    } catch (err) {
      if (err instanceof VaultDecryptError || /illisible/.test((err as Error).message)) {
        console.error(`[vault] secrets de ${item.name} illisibles : ${(err as Error).message}`);
        throw new AppError(`Les secrets de « ${item.name} » sont illisibles (clé de chiffrement changée ou données altérées) : saisissez-les à nouveau`, 'VAULT_DECRYPT');
      }
      throw err;
    }
  },

  // ---- Journal -----------------------------------------------------------------------------------

  async audit(item: Pick<VaultItem, 'id' | 'name' | 'kind'>, action: string, actor: VaultActor | null, detail?: string | null, ok = true): Promise<void> {
    try {
      await vaultRepository.addAudit({
        itemId: item.id,
        itemName: item.name,
        itemKind: item.kind,
        action,
        actorUserId: actor?.userId ?? null,
        sessionId: actor?.sessionId ?? null,
        projectId: actor?.projectId ?? null,
        ok,
        detail: detail ? detail.slice(0, AUDIT_DETAIL_MAX) : null,
      });
    } catch (err) {
      console.error('[vault] entrée de journal perdue', err);
    }
  },

  auditLog: (itemId: string, limit = 50, before?: string | null) => vaultRepository.listAudit(itemId, limit, before),

  // ---- Création / mise à jour ----------------------------------------------------------------------

  /** Construit les réglages et les secrets d'un élément à partir de l'entrée (création : `current` null). */
  async build(kind: VaultItemKind, current: VaultItem | null, input: VaultItemInput, owner: { userId: string | null; projectId: string | null }): Promise<{ settings: VaultItem['settings']; secrets: Record<string, string>; publicKey?: string | null }> {
    const secrets = current ? this.secretsOf(current) : {};
    switch (kind) {
      case 'ssh': {
        const base = (current?.settings ?? {}) as Partial<SshSettings>;
        const settings: SshSettings = { host: requireText(input.host ?? base.host, "L'hôte est"), port: validatePort(input.port ?? base.port ?? null, DEFAULT_PORTS.ssh), username: requireText(input.username ?? base.username, "L'utilisateur est") };
        let publicKey = current?.publicKey ?? null;
        if (input.privateKey?.trim()) {
          const privateKey = assertSecretSize(input.privateKey.trim(), 'Clé privée');
          publicKey = ssh.publicKeyOf(privateKey);
          secrets.privateKey = privateKey;
        } else if (!current) {
          const pair = ssh.generateKeyPair(`skipper-${validateName(input.name)}`);
          secrets.privateKey = pair.privateKey;
          publicKey = pair.publicKey;
        }
        return { settings, secrets, publicKey };
      }
      case 'postgres': {
        const base = (current?.settings ?? {}) as Partial<PostgresSettings>;
        const viaItemId = input.viaItemId !== undefined ? input.viaItemId || null : base.viaItemId ?? null;
        if (viaItemId) {
          const via = await vaultRepository.findById(viaItemId);
          if (!via || via.ownerUserId !== owner.userId || via.ownerProjectId !== owner.projectId) throw new AppError('Le tunnel doit être un serveur SSH du même coffre (même propriétaire)');
          if (via.kind !== 'ssh') throw new AppError('Le tunnel doit passer par un serveur SSH');
        }
        const settings: PostgresSettings = {
          host: requireText(input.host ?? base.host, "L'hôte est"),
          port: validatePort(input.port ?? base.port ?? null, DEFAULT_PORTS.postgres),
          username: requireText(input.username ?? base.username, "L'utilisateur est"),
          database: requireText(input.database ?? base.database, 'Le nom de la base est'),
          ssl: input.ssl ?? base.ssl ?? false,
          sslCa: input.sslCa !== undefined ? validateSslCa(input.sslCa) : base.sslCa ?? null,
          viaItemId,
        };
        if (input.password != null) {
          if (input.password) secrets.password = assertSecretSize(input.password, 'Mot de passe');
          else delete secrets.password;
        }
        return { settings, secrets };
      }
      case 'api': {
        const base = (current?.settings ?? {}) as Partial<ApiSettings>;
        const authScheme = input.authScheme ?? base.authScheme ?? 'bearer';
        if (!API_AUTH_SCHEMES.includes(authScheme)) throw new AppError(`Mode d'authentification inconnu : ${authScheme}`);
        let authName: string | null = input.authName !== undefined ? input.authName?.trim() || null : base.authName ?? null;
        if (authScheme === 'header' || authScheme === 'query') {
          authName = requireText(authName, authScheme === 'header' ? "Le nom de l'en-tête est" : 'Le nom du paramètre est');
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(authName)) throw new AppError(`Nom ${authScheme === 'header' ? "d'en-tête" : 'de paramètre'} invalide`);
          if (authScheme === 'header' && ['host', 'content-length', 'transfer-encoding', 'connection', 'cookie'].includes(authName.toLowerCase())) throw new AppError(`L'en-tête ${authName} ne peut pas porter le jeton`);
        } else authName = null;
        const settings: ApiSettings = {
          baseUrl: input.url != null || !current ? api.validateBaseUrl(input.url) : base.baseUrl!,
          authScheme,
          authName,
          username: authScheme === 'basic' ? requireText(input.username ?? base.username, "L'utilisateur est") : null,
        };
        const token = input.token ?? (authScheme === 'basic' ? input.password : null);
        if (token != null && token !== '') secrets.token = assertSecretSize(token, 'Jeton');
        if (!secrets.token) throw new AppError(authScheme === 'basic' ? 'Le mot de passe est obligatoire' : 'Le jeton est obligatoire');
        return { settings, secrets };
      }
      case 'website': {
        const base = current?.settings as WebsiteSettings | undefined;
        const url = input.url != null || !base ? website.validateUrl(input.url) : base.url;
        const built = this.buildFields(base?.fields ?? [], secrets, input.fields ?? base?.fields ?? []);
        return { settings: { url, fields: built.fields }, secrets: built.secrets };
      }
      case 'secret': {
        const base = current?.settings as SecretSettings | undefined;
        const built = this.buildFields(base?.fields ?? [], secrets, input.fields ?? base?.fields ?? []);
        if (!built.fields.length) throw new AppError('Ajoutez au moins un champ');
        return { settings: { fields: built.fields }, secrets: built.secrets };
      }
      case 'google':
        throw new AppError('Un compte Google se relie par Google (bouton « Connecter un compte Google »)');
      case 'aws': {
        const base = (current?.settings ?? {}) as Partial<AwsSettings>;
        const a = input.aws ?? {};
        const auth = current ? base.auth! : (a.auth ?? 'sso');
        if (!AWS_AUTHS.includes(auth)) throw new AppError(`Mode d'authentification AWS inconnu : ${auth}`);
        if (current && a.auth && a.auth !== auth) throw new AppError("Le mode d'authentification d'un compte AWS ne change pas : créez un autre élément");
        const pick = (next: string | null | undefined, prev: string | null | undefined, validate: (v: string) => string): string | null => (next !== undefined && next !== null ? (next.trim() ? validate(next) : null) : (prev ?? null));
        const settings: AwsSettings = {
          auth,
          region: aws.validateRegion(a.region ?? base.region, 'La région par défaut'),
          startUrl: null,
          ssoRegion: null,
          accountId: null,
          accountName: null,
          roleName: null,
          accessKeyId: null,
          roleArn: null,
          tokenExpiresAt: base.tokenExpiresAt ?? null,
          clientExpiresAt: base.clientExpiresAt ?? null,
          identity: base.identity ?? null,
        };
        if (auth === 'sso') {
          settings.startUrl = aws.validateStartUrl(a.startUrl ?? base.startUrl);
          settings.ssoRegion = aws.validateRegion(a.ssoRegion ?? base.ssoRegion, "La région d'IAM Identity Center");
          settings.accountId = pick(a.accountId, base.accountId, aws.validateAccountId);
          settings.roleName = pick(a.roleName, base.roleName, aws.validateRoleName);
          settings.accountName = settings.accountId === null ? null : a.accountName?.trim() || (settings.accountId === (base.accountId ?? null) ? base.accountName ?? null : null);
          if ((settings.accountId === null) !== (settings.roleName === null)) throw new AppError('Indiquez le compte et le rôle ensemble');
          // Un autre portail ou une autre région : les jetons obtenus ne valent plus, il faudra se reconnecter.
          if (current && (settings.startUrl !== base.startUrl || settings.ssoRegion !== base.ssoRegion)) {
            settings.tokenExpiresAt = null;
            settings.clientExpiresAt = null;
            for (const k of ['accessToken', 'refreshToken', 'clientId', 'clientSecret']) delete secrets[k];
          }
          if (settings.accountId !== (base.accountId ?? null) || settings.roleName !== (base.roleName ?? null)) settings.identity = null;
          delete secrets.secretAccessKey;
        } else {
          settings.accessKeyId = aws.validateAccessKeyId(a.accessKeyId ?? base.accessKeyId);
          settings.roleArn = pick(a.roleArn, base.roleArn, aws.validateRoleArn);
          if (a.secretAccessKey?.trim()) secrets.secretAccessKey = assertSecretSize(a.secretAccessKey.trim(), "Clé d'accès secrète");
          if (!secrets.secretAccessKey) throw new AppError("La clé d'accès secrète est obligatoire");
          if (settings.accessKeyId !== (base.accessKeyId ?? null) || settings.roleArn !== (base.roleArn ?? null) || a.secretAccessKey?.trim()) settings.identity = null;
          for (const k of ['accessToken', 'refreshToken', 'clientId', 'clientSecret']) delete secrets[k];
        }
        return { settings, secrets };
      }
      case 'token': {
        const prev = (current?.settings ?? {}) as Partial<TokenSettings>;
        const service = current ? (prev.service as TokenService) : (input.service ?? '').trim().toLowerCase();
        if (!isTokenService(service)) throw new AppError(`Service inconnu : ${input.service ?? ''}`);
        if (current && input.service && input.service !== service) throw new AppError("Le service d'un jeton ne change pas : créez un autre élément");
        if (current && prev.obtained === 'oauth') throw new AppError('Ce jeton a été obtenu par une connexion : reconnectez le compte pour le renouveler');
        const typed = input.token?.trim();
        if (typed) {
          const mismatch = tokenMismatch(service, typed);
          if (mismatch) throw new AppError(mismatch);
          secrets.token = assertSecretSize(typed, 'Jeton');
        }
        if (!secrets.token) throw new AppError('Le jeton est obligatoire');
        const settings: TokenSettings = { service, obtained: 'manual', account: prev.account ?? null, tokenExpiresAt: null, refreshExpiresAt: null };
        return { settings, secrets: { token: secrets.token } };
      }
      case 'litellm': {
        const base = (current?.settings ?? {}) as Partial<LitellmSettings>;
        const settings: LitellmSettings = { baseUrl: input.url != null || !current ? llm.validateBaseUrl(input.url, "L'adresse du proxy est") : base.baseUrl! };
        const typed = input.token?.trim();
        if (typed) secrets.token = assertSecretSize(typed, 'Clé');
        if (!secrets.token) throw new AppError("La clé d'API est obligatoire");
        return { settings, secrets: { token: secrets.token } };
      }
      case 'langfuse': {
        const base = (current?.settings ?? {}) as Partial<LangfuseSettings>;
        const settings: LangfuseSettings = {
          host: input.url != null || !current ? llm.validateBaseUrl(input.url, "L'hôte Langfuse est") : base.host!,
          publicKey: input.publicKey != null || !current ? llm.validatePublicKey(input.publicKey) : base.publicKey!,
        };
        const typed = input.password?.trim();
        if (typed) secrets.secretKey = assertSecretSize(llm.validateSecretKey(typed), 'Clé secrète');
        if (!secrets.secretKey) throw new AppError('La clé secrète est obligatoire');
        return { settings, secrets: { secretKey: secrets.secretKey } };
      }
    }
  },

  /**
   * Champs d'un site web ou d'un secret. La liste reçue remplace la précédente ; un champ secret sans
   * valeur conserve le secret déjà enregistré sous la même clé.
   */
  buildFields(previousFields: VaultField[], previousSecrets: Record<string, string>, entries: (VaultFieldInput | VaultField)[]): { fields: VaultField[]; secrets: Record<string, string> } {
    const fields: VaultField[] = [];
    const secrets: Record<string, string> = {};
    const seen = new Set<string>();
    const previous = new Map(previousFields.map((f) => [f.key, f]));
    for (const f of entries) {
      const key = website.validateFieldKey(f.key);
      if (seen.has(key)) throw new AppError(`Le champ « ${key} » apparaît deux fois`);
      seen.add(key);
      const secret = f.secret ?? previous.get(key)?.secret ?? false;
      const label = f.label?.trim() || previous.get(key)?.label || key;
      if (secret) {
        if (f.value) secrets[key] = assertSecretSize(f.value, label);
        else if (previousSecrets[key] && previous.get(key)?.secret) secrets[key] = previousSecrets[key];
        else throw new AppError(`Le champ secret « ${label} » n'a pas de valeur`);
        fields.push({ key, label, secret: true, value: null });
      } else {
        fields.push({ key, label, secret: false, value: f.value ?? previous.get(key)?.value ?? '' });
      }
    }
    if (fields.length > MAX_FIELDS) throw new AppError(`Au plus ${MAX_FIELDS} champs`);
    return { fields, secrets };
  },

  /** Crée un élément dans le coffre personnel de l'acteur, ou dans celui d'un projet (administrateur). */
  async create(actor: VaultActor & { userId: string }, projectId: string | null, input: VaultItemInput): Promise<VaultItemWithPermission> {
    const kind = input.kind ?? 'secret';
    if (!VAULT_KINDS.includes(kind)) throw new AppError(`Type d'élément inconnu : ${kind}`);
    if (kind === 'google') throw new AppError('Un compte Google se relie par Google (bouton « Connecter un compte Google »)');
    if (projectId) await projectService.get(projectId);
    const name = validateName(input.name);
    const owner = { userId: projectId ? null : actor.userId, projectId };
    if (projectId) await this.assertNameFree(projectId, null, name, null);
    const built = await this.build(kind, null, input, owner);
    const id = randomUUID();
    const record: VaultItemRecord = {
      id,
      ownerUserId: owner.userId,
      ownerProjectId: owner.projectId,
      name,
      kind,
      description: input.description?.trim() ?? '',
      settings: built.settings,
      ...sealSecrets(id, kind, built.secrets),
      publicKey: built.publicKey ?? null,
      readOnly: input.readOnly ?? true,
      requireApproval: input.requireApproval ?? true,
      commandAllowlist: normalizeAllowlist(input.commandAllowlist),
      expiresAt: parseExpiry(input.expiresAt),
      createdById: actor.userId,
    };
    let item: VaultItem;
    try {
      item = await vaultRepository.create(record);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un élément « ${name} » existe déjà ${projectId ? 'dans ce projet' : 'dans votre coffre'}`);
      throw err;
    }
    await this.audit(item, 'created', actor, `${kindLabels[kind]} (${projectId ? 'projet' : 'personnel'})`);
    return { ...item, permission: 'manage' };
  },

  /** Met à jour un élément (permission manage). Les champs absents sont inchangés. */
  async update(actor: VaultActor & { userId: string }, id: string, input: VaultItemInput): Promise<VaultItemWithPermission> {
    const current = await this.getFor(actor.userId, id, 'manage');
    const patch: VaultItemPatch = {};
    const changed: string[] = [];
    if (input.name != null) {
      const name = validateName(input.name);
      if (name !== current.name) {
        if (current.ownerProjectId) await this.assertNameFree(current.ownerProjectId, null, name, current.id);
        for (const link of await vaultRepository.listLinks(current.id)) await this.assertNameFree(link.projectId, link.scope === 'personal' ? link.userId : null, name, current.id);
        patch.name = name;
        changed.push('nom');
      }
    }
    if (input.description != null && input.description.trim() !== current.description) {
      patch.description = input.description.trim();
      changed.push('description');
    }
    const touchesSettings =
      (current.kind !== 'google' &&
        [input.host, input.port, input.username, input.database, input.ssl, input.sslCa, input.url, input.authScheme, input.fields, input.privateKey, input.password, input.token, input.publicKey, input.aws].some((v) => v != null)) ||
      input.viaItemId !== undefined ||
      input.authName !== undefined;
    let secretChanged = false;
    if (touchesSettings) {
      const owner = { userId: current.ownerUserId, projectId: current.ownerProjectId };
      const before = this.secretsOf(current);
      const built = await this.build(current.kind, current, input, owner);
      patch.settings = built.settings;
      if (built.publicKey !== undefined && built.publicKey !== current.publicKey) patch.publicKey = built.publicKey;
      if (JSON.stringify(built.secrets) !== JSON.stringify(before) || current.legacySecrets) {
        Object.assign(patch, sealSecrets(current.id, current.kind, built.secrets));
        secretChanged = JSON.stringify(built.secrets) !== JSON.stringify(before);
      }
      changed.push('réglages');
      if (current.kind === 'ssh') {
        const a = current.settings as SshSettings;
        const b = built.settings as SshSettings;
        if (a.host !== b.host || a.port !== b.port) Object.assign(patch, { hostKey: null, hostKeySeenAt: null });
      }
    }
    if (input.readOnly != null && input.readOnly !== current.readOnly) {
      patch.readOnly = input.readOnly;
      changed.push(input.readOnly ? 'lecture seule' : 'écriture autorisée');
    }
    if (input.requireApproval != null && input.requireApproval !== current.requireApproval) {
      patch.requireApproval = input.requireApproval;
      changed.push(input.requireApproval ? 'approbation requise' : 'sans approbation');
    }
    if (input.commandAllowlist != null) {
      patch.commandAllowlist = normalizeAllowlist(input.commandAllowlist);
      if (JSON.stringify(patch.commandAllowlist) !== JSON.stringify(current.commandAllowlist)) changed.push('commandes autorisées');
    }
    if (input.expiresAt !== undefined) {
      patch.expiresAt = parseExpiry(input.expiresAt);
      if ((patch.expiresAt?.getTime() ?? null) !== (current.expiresAt?.getTime() ?? null)) changed.push('expiration');
    }
    if (!changed.length && !Object.keys(patch).length) return current;
    let item: VaultItem;
    try {
      item = await vaultRepository.update(id, patch);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un élément « ${patch.name} » existe déjà`);
      throw err;
    }
    await this.audit(item, secretChanged ? 'secret_changed' : 'updated', actor, changed.join(', '));
    return { ...item, permission: 'manage' };
  },

  async delete(actor: VaultActor & { userId: string }, id: string): Promise<boolean> {
    const item = await this.getFor(actor.userId, id, 'manage');
    const dependents = await vaultRepository.listDependents(id);
    if (dependents.length) throw new AppError(`Cet élément sert de tunnel à : ${dependents.map((d) => d.name).join(', ')}. Modifiez-les d'abord.`);
    await beforeDeleteHooks.get(item.kind)?.(item);
    await this.audit(item, 'deleted', actor);
    return vaultRepository.delete(id);
  },

  /** Nouvelle paire de clés SSH : l'ancienne clé publique cesse de fonctionner une fois retirée du serveur. */
  async regenerateKey(actor: VaultActor & { userId: string }, id: string): Promise<VaultItemWithPermission> {
    const item = await this.getFor(actor.userId, id, 'manage');
    if (item.kind !== 'ssh') throw new AppError('Seul un serveur SSH a une paire de clés');
    const pair = ssh.generateKeyPair(`skipper-${item.name}`);
    const updated = await vaultRepository.update(id, { ...sealSecrets(id, 'ssh', { ...this.secretsOf(item), privateKey: pair.privateKey }), publicKey: pair.publicKey });
    await this.audit(item, 'key_regenerated', actor);
    return { ...updated, permission: 'manage' };
  },

  async forgetHostKey(actor: VaultActor & { userId: string }, id: string): Promise<VaultItemWithPermission> {
    const item = await this.getFor(actor.userId, id, 'manage');
    const updated = await vaultRepository.update(id, { hostKey: null, hostKeySeenAt: null });
    await this.audit(item, 'host_key_forgotten', actor, item.hostKey ? ssh.fingerprint(item.hostKey) : null);
    return { ...updated, permission: 'manage' };
  },

  /** Mémorise la clé d'hôte d'un serveur SSH qui n'en avait pas encore (première connexion réussie). */
  async rememberHostKey(item: VaultItem, hostKey: string | null): Promise<void> {
    if (!hostKey || item.hostKey) return;
    await vaultRepository.update(item.id, { hostKey, hostKeySeenAt: new Date() });
    item.hostKey = hostKey;
  },

  /** Révèle un champ secret (permission read), journalisé et limité en fréquence. */
  async reveal(actor: VaultActor & { userId: string }, id: string, field: string): Promise<string> {
    const item = await this.getFor(actor.userId, id, 'read');
    if (!this.revealableFields(item, item.permission).includes(field)) throw new AppError('Ce secret ne quitte jamais le serveur', 'FORBIDDEN');
    const now = Date.now();
    const recent = (reveals.get(actor.userId) ?? []).filter((t) => now - t < REVEAL_WINDOW_MS);
    if (recent.length >= REVEAL_MAX) throw new AppError('Trop de secrets révélés en peu de temps : réessayez dans quelques minutes', 'FORBIDDEN');
    recent.push(now);
    reveals.set(actor.userId, recent);
    const value = this.secretsOf(item)[field];
    if (value === undefined) throw new AppError('Aucune valeur enregistrée pour ce champ');
    await this.audit(item, 'revealed', actor, field);
    return value;
  },

  // ---- Partages ------------------------------------------------------------------------------------

  async share(actor: VaultActor & { userId: string }, id: string, email: string, permission: VaultPermission): Promise<VaultItemWithPermission> {
    const item = await this.getFor(actor.userId, id, 'manage');
    if (!(permission in PERMISSION_RANK)) throw new AppError(`Permission inconnue : ${permission}`);
    const target = await userRepository.findByEmail(email.trim().toLowerCase());
    if (!target) throw new AppError(`Aucun utilisateur ${email.trim()} : invitez-le d'abord sur un projet`);
    if (target.id === item.ownerUserId) throw new AppError('Cette personne est propriétaire de cet élément');
    await vaultRepository.upsertShare(id, target.id, permission, actor.userId);
    await this.audit(item, 'shared', actor, `${target.email} : ${permission}`);
    return item;
  },

  /** Retire un partage (manage), ou son propre partage. Les liens personnels de la personne tombent si elle n'a plus d'accès direct. */
  async unshare(actor: VaultActor & { userId: string }, id: string, userId: string): Promise<boolean> {
    const item = await vaultRepository.findById(id);
    if (!item) throw new NotFoundError('Élément du coffre introuvable');
    const permission = await this.permissionFor(actor.userId, item);
    if (!permission || (!atLeast(permission, 'manage') && userId !== actor.userId)) throw new NotFoundError('Élément du coffre introuvable');
    const removed = await vaultRepository.deleteShare(id, userId);
    if (removed) {
      const facts = await vaultRepository.facts(item, userId);
      if (!hasDirectAccess(item, userId, facts)) await vaultRepository.deletePersonalLinks(id, userId);
      const target = await userRepository.findById(userId);
      await this.audit(item, 'unshared', actor, target?.email ?? userId);
    }
    return removed;
  },

  shares: (itemId: string) => vaultRepository.listShares(itemId),

  // ---- Liens ---------------------------------------------------------------------------------------

  links: (itemId: string) => vaultRepository.listLinks(itemId),

  async link(actor: VaultActor & { userId: string }, id: string, projectId: string, scope: VaultLinkScope): Promise<VaultItemWithPermission> {
    if (scope !== 'project' && scope !== 'personal') throw new AppError(`Portée inconnue : ${scope}`);
    const item = await this.getFor(actor.userId, id, 'use');
    if (SKIPPER_KINDS.includes(item.kind)) throw new AppError(`${kindLabels[item.kind]} : cet élément sert Skipper lui-même (vos réglages, les agents automatisés), jamais les agents des sessions ; il ne se relie pas à un projet`);
    if (item.ownerProjectId === projectId) throw new AppError('Cet élément appartient déjà à ce projet : tous ses agents peuvent l\'utiliser');
    const project = await projectService.get(projectId);
    const role = await userService.roleFor(actor.userId, projectId);
    const facts = await vaultRepository.facts(item, actor.userId);
    const direct = hasDirectAccess(item, actor.userId, facts);
    if (!canLink(scope, item.permission, role, direct)) {
      if (scope === 'project') throw new AppError("Ouvrir un élément à tous les agents d'un projet demande de gérer l'élément et d'administrer le projet", 'FORBIDDEN');
      if (!direct) throw new AppError("Vous accédez à cet élément à travers un projet : il ne peut servir que dans ce projet. Demandez à ses gestionnaires de le partager avec vous.", 'FORBIDDEN');
      throw new AppError("Utiliser un élément dans vos sessions d'un projet demande d'en être membre", 'FORBIDDEN');
    }
    if (item.kind === 'postgres' && (item.settings as PostgresSettings).viaItemId && !(await vaultRepository.findById((item.settings as PostgresSettings).viaItemId!))) {
      throw new AppError('Le tunnel SSH de cette base n\'existe plus');
    }
    await this.assertNameFree(projectId, scope === 'personal' ? actor.userId : null, item.name, item.id);
    const link = await vaultRepository.insertLink(id, projectId, scope, scope === 'personal' ? actor.userId : null, actor.userId);
    if (link) await this.audit(item, 'linked', actor, `${project.name} : ${scope === 'project' ? 'tous les agents' : 'mes sessions'}`);
    return item;
  },

  async unlink(actor: VaultActor & { userId: string }, linkId: string): Promise<boolean> {
    const link = await vaultRepository.findLink(linkId);
    if (!link) throw new NotFoundError('Lien introuvable');
    const item = await vaultRepository.findById(link.itemId);
    if (!item) throw new NotFoundError('Lien introuvable');
    const permission = await this.permissionFor(actor.userId, item);
    const role = await userService.roleFor(actor.userId, link.projectId);
    if (!permission && !role) throw new NotFoundError('Lien introuvable');
    const allowed = atLeast(permission, 'manage') || role === 'admin' || (link.scope === 'personal' && link.userId === actor.userId);
    if (!allowed) throw new AppError('Seuls les gestionnaires de l\'élément et les administrateurs du projet peuvent retirer ce lien', 'FORBIDDEN');
    const removed = await vaultRepository.deleteLink(linkId);
    if (removed) await this.audit(item, 'unlinked', actor, link.scope === 'project' ? 'tous les agents' : 'sessions personnelles');
    return removed;
  },

  /** Copie un élément dans le coffre d'un projet (manage + administrateur du projet) ; l'original est intact. */
  async copyToProject(actor: VaultActor & { userId: string }, id: string, projectId: string, name?: string | null): Promise<VaultItemWithPermission> {
    const source = await this.getFor(actor.userId, id, 'manage');
    const project = await projectService.get(projectId);
    if (source.ownerProjectId === projectId) throw new AppError('Cet élément appartient déjà à ce projet');
    if (source.kind === 'google') throw new AppError('Un compte Google se reconnecte depuis le projet plutôt que d\'être copié');
    if (source.kind === 'aws' && (source.settings as AwsSettings).auth === 'sso') throw new AppError('Un compte AWS connecté par IAM Identity Center se reconnecte depuis le projet plutôt que d\'être copié');
    if (isOauthToken(source)) throw new AppError('Ce jeton a été obtenu par une connexion : il reste personnel (reconnectez le compte plutôt que de le copier)');
    const newName = validateName(name ?? source.name);
    const settings = JSON.parse(JSON.stringify(source.settings)) as VaultItem['settings'];
    if (source.kind === 'postgres' && (settings as PostgresSettings).viaItemId) {
      const tunnel = await vaultRepository.findById((settings as PostgresSettings).viaItemId!);
      const target = tunnel ? (await vaultRepository.listOwnedByProject(projectId)).find((i) => i.kind === 'ssh' && i.name === tunnel.name) : null;
      if (!target) throw new AppError(`Cette base passe par le tunnel SSH « ${tunnel?.name ?? '?'} » : copiez-le d'abord dans ${project.name}`);
      (settings as PostgresSettings).viaItemId = target.id;
    }
    const links = (await vaultRepository.listLinks(source.id)).filter((l) => l.projectId === projectId && (l.scope === 'project' || l.userId === actor.userId));
    await this.assertNameFree(projectId, null, newName, links.length ? source.id : null);
    const newId = randomUUID();
    const item = await vaultRepository.create({
      id: newId,
      ownerUserId: null,
      ownerProjectId: projectId,
      name: newName,
      kind: source.kind,
      description: source.description,
      settings,
      ...sealSecrets(newId, source.kind, this.secretsOf(source)),
      publicKey: source.publicKey,
      hostKey: source.hostKey,
      hostKeySeenAt: source.hostKeySeenAt,
      readOnly: source.readOnly,
      requireApproval: source.requireApproval,
      commandAllowlist: source.commandAllowlist,
      expiresAt: source.expiresAt,
      createdById: actor.userId,
    }).catch((err) => {
      if ((err as { code?: string }).code === '23505') throw new AppError(`Un élément « ${newName} » existe déjà dans ce projet`);
      throw err;
    });
    const origin = source.ownerProjectId ? `projet ${(await projectService.get(source.ownerProjectId).catch(() => null))?.name ?? '?'}` : 'coffre personnel';
    await this.audit(item, 'created', actor, `${kindLabels[item.kind]} (projet), copie de « ${source.name} » (${origin})`);
    await this.audit(source, 'copied', actor, `${project.name} : « ${newName} »`);
    for (const l of links) {
      await vaultRepository.deleteLink(l.id);
      await this.audit(source, 'unlinked', actor, `${l.scope === 'project' ? 'tous les agents' : 'sessions personnelles'} (remplacé par la copie)`);
    }
    return { ...item, permission: 'manage' };
  },

  // ---- Portée des agents ---------------------------------------------------------------------------

  /** Un nom ne doit désigner qu'un élément dans la portée des agents d'un projet. */
  async assertNameFree(projectId: string, personalUserId: string | null, name: string, itemId: string | null): Promise<void> {
    const rows = await vaultRepository.listForAgents(projectId, personalUserId);
    const clash = rows.find((r) => r.item.id !== itemId && r.item.name === name && (personalUserId !== null || r.via !== 'personal'));
    if (clash) throw new AppError(`Le nom « ${name} » est déjà utilisé par un autre élément à disposition des agents de ce projet : renommez l'un des deux`);
  },

  /** Portée résolue d'une session : le premier d'un nom gagne (élément du projet > lien projet > lien personnel). */
  resolveAgentItems(rows: ProjectVaultRow[]): ProjectVaultRow[] {
    const sorted = [...rows].filter((r) => AGENT_KINDS.includes(r.item.kind)).sort((a, b) => VIA_ORDER[a.via] - VIA_ORDER[b.via] || a.item.name.localeCompare(b.item.name));
    const seen = new Set<string>();
    const out: Ordered['row'][] = [];
    for (const r of sorted) {
      if (seen.has(r.item.name)) continue;
      seen.add(r.item.name);
      out.push(r);
    }
    return out;
  },

  async agentRows(projectId: string, ownerId: string | null): Promise<ProjectVaultRow[]> {
    return this.resolveAgentItems(await vaultRepository.listForAgents(projectId, ownerId));
  },

  async agentItems(projectId: string, ownerId: string | null): Promise<VaultItem[]> {
    return (await this.agentRows(projectId, ownerId)).map((r) => r.item);
  },

  /** Élément désigné par son nom dans la portée d'une session, relu à chaque appel (un partage retiré prend effet aussitôt). */
  async agentItemByName(projectId: string, ownerId: string | null, name: string): Promise<VaultItem> {
    const items = await this.agentItems(projectId, ownerId);
    const n = name.trim().toLowerCase();
    const item = items.find((i) => i.name === n);
    if (!item) throw new NotFoundError(`« ${name} » introuvable dans le coffre de ce projet${items.length ? ` (disponibles : ${items.map((i) => i.name).join(', ')})` : ''}`);
    return item;
  },

  /**
   * Page du coffre d'un projet : la portée des agents du spectateur, puis les éléments du projet qui servent
   * Skipper lui-même (jetons applicatifs, LiteLLM, Langfuse), gérés ici mais jamais offerts aux agents.
   */
  async projectRows(projectId: string, viewerId: string): Promise<ProjectVaultRow[]> {
    const agents = (await vaultService.agentRows(projectId, viewerId)).map((r) => ({ ...r, forAgents: true }));
    const own = (await vaultRepository.listOwnedByProject(projectId)).filter((i) => SKIPPER_KINDS.includes(i.kind)).map((item): ProjectVaultRow => ({ item, via: 'own', link: null, forAgents: false }));
    return [...agents, ...own];
  },

  /** Noms des éléments soumis à approbation parmi ceux dotés d'outils (avertissement du lanceur). */
  approvalNames: (items: VaultItem[]) => items.filter((i) => i.requireApproval && TOOL_KINDS.includes(i.kind)).map((i) => i.name),

  // ---- Identifiants déchiffrés -------------------------------------------------------------------

  sshCredentials(item: VaultItem): SshCredentials {
    if (item.kind !== 'ssh') throw new AppError(`« ${item.name} » n'est pas un serveur SSH`);
    const privateKey = this.secretsOf(item).privateKey;
    if (!privateKey) throw new AppError(`« ${item.name} » n'a pas de clé privée`);
    const s = item.settings as SshSettings;
    return { host: s.host, port: s.port, username: s.username, privateKey };
  },

  async postgresCredentials(item: VaultItem): Promise<PostgresCredentials> {
    if (item.kind !== 'postgres') throw new AppError(`« ${item.name} » n'est pas une base PostgreSQL`);
    const s = item.settings as PostgresSettings;
    let via: PostgresCredentials['via'] = null;
    if (s.viaItemId) {
      const tunnel = await this.getInternal(s.viaItemId);
      if (tunnel.ownerUserId !== item.ownerUserId || tunnel.ownerProjectId !== item.ownerProjectId) throw new AppError(`Le tunnel de « ${item.name} » n'appartient plus au même propriétaire`, 'FORBIDDEN');
      via = { item: tunnel, credentials: this.sshCredentials(tunnel) };
    }
    return { host: s.host, port: s.port, username: s.username, database: s.database, ssl: s.ssl, sslCa: s.sslCa ?? null, password: this.secretsOf(item).password ?? null, via };
  },

  apiCredentials(item: VaultItem): ApiCredentials {
    if (item.kind !== 'api') throw new AppError(`« ${item.name} » n'est pas une API HTTP`);
    const token = this.secretsOf(item).token;
    if (!token) throw new AppError(`« ${item.name} » n'a pas de jeton`);
    return { ...(item.settings as ApiSettings), token };
  },

  fieldCredentials(item: VaultItem): FieldCredentials {
    if (item.kind !== 'website' && item.kind !== 'secret') throw new AppError(`« ${item.name} » n'a pas de champs`);
    const secrets = this.secretsOf(item);
    const s = item.settings as WebsiteSettings | SecretSettings;
    return {
      url: 'url' in s ? s.url : null,
      fields: s.fields.map((f) => ({ ...f, value: f.secret ? secrets[f.key] ?? '' : f.value ?? '', variable: website.variableName(item.name, f.key) })),
    };
  },

  /** Vérifie qu'une commande respecte la liste blanche de préfixes (vide = tout). */
  assertCommandAllowed(item: VaultItem, command: string): void {
    if (item.commandAllowlist.length === 0) return;
    const trimmed = command.trim();
    if (/[;&|`\n\r]|\$\(|>|</.test(trimmed)) throw new AppError(`Commande refusée sur « ${item.name} » : enchaînements, redirections et substitutions sont interdits quand les commandes sont restreintes`, 'FORBIDDEN');
    if (!item.commandAllowlist.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))) {
      throw new AppError(`Commande refusée par la politique de « ${item.name} » : seules les commandes commençant par ${item.commandAllowlist.map((p) => `"${p}"`).join(', ')} sont autorisées`, 'FORBIDDEN');
    }
  },

  // ---- Test ----------------------------------------------------------------------------------------

  async test(actor: VaultActor & { userId: string }, id: string): Promise<{ item: VaultItemWithPermission; result: VaultTestResult }> {
    const item = await this.getFor(actor.userId, id, 'manage');
    let result: VaultTestResult;
    try {
      result = { ok: true, error: null, detail: await this.probe(item) };
    } catch (err) {
      result = { ok: false, error: (err as Error).message, detail: null };
    }
    await vaultRepository.recordTest(id, result.ok, result.error);
    await this.audit(item, 'tested', actor, result.error, result.ok);
    return { item: { ...(await this.getInternal(id)), permission: item.permission }, result };
  },

  /** Testeur d'un type non géré ici (Google) : branché par son module. */
  probers: new Map<VaultItemKind, (item: VaultItem) => Promise<string>>(),

  async probe(item: VaultItem): Promise<string> {
    switch (item.kind) {
      case 'ssh': {
        const session = await ssh.connect(this.sshCredentials(item), item.hostKey);
        try {
          const out = await ssh.exec(session, 'uname -srm && hostname', { timeoutMs: 10_000 });
          await this.rememberHostKey(item, session.hostKey);
          return out.stdout.trim().split('\n').join(' · ');
        } finally {
          session.close();
        }
      }
      case 'postgres': {
        const creds = await this.postgresCredentials(item);
        const probe = await postgres.probe(creds);
        if (creds.via) await this.rememberHostKey(creds.via.item, probe.sshHostKey);
        return probe.detail;
      }
      case 'api':
        return (await api.probe(this.apiCredentials(item))).detail;
      case 'website':
        return (await website.probe((item.settings as WebsiteSettings).url)).detail;
      case 'secret':
        return 'Rien à tester pour un secret : il est utilisé tel quel.';
      // aws : testeur branché par vault/awsService.ts (probers).
      case 'litellm': {
        const token = this.secretsOf(item).token;
        if (!token) throw new AppError(`« ${item.name} » n'a pas de clé`);
        return llm.probeLitellm((item.settings as LitellmSettings).baseUrl, token);
      }
      case 'langfuse': {
        const s = item.settings as LangfuseSettings;
        const secretKey = this.secretsOf(item).secretKey;
        if (!secretKey) throw new AppError(`« ${item.name} » n'a pas de clé secrète`);
        return llm.probeLangfuse(s.host, s.publicKey, secretKey);
      }
      case 'token': {
        const s = item.settings as TokenSettings;
        const token = this.secretsOf(item).token;
        if (!token) throw new AppError(`« ${item.name} » n'a pas de jeton`);
        if (s.service === 'github') {
          const res = await fetch('https://api.github.com/user', { headers: { Accept: 'application/json', 'User-Agent': 'skipper', Authorization: `Bearer ${token}` } });
          if (res.status === 401) throw new AppError('GitHub refuse ce jeton (invalide, expiré ou révoqué)');
          if (!res.ok) throw new AppError(`GitHub : vérification impossible (${res.status})`);
          const u = (await res.json()) as { login: string };
          return `Compte GitHub ${u.login}`;
        }
        return `Jeton ${TOKEN_SERVICES[s.service].label} enregistré ; il est vérifié par le réglage qui l'utilise.`;
      }
      default: {
        const prober = this.probers.get(item.kind);
        if (!prober) throw new AppError('Test non disponible pour ce type');
        return prober(item);
      }
    }
  },

  // ---- Jetons applicatifs et identifiants de Skipper (vault/tokens.ts, vault/llm.ts) ---------------

  /**
   * Jeton en clair d'un jeton applicatif, pour un usage de Skipper au nom de `userId` : l'élément doit
   * toujours être utilisable par la personne (propriétaire, partage, projet propriétaire) et servir l'un
   * des `services`. Un usage par une session est journalisé.
   */
  async useToken(userId: string, itemId: string, services: TokenService[], actor: VaultActor & { purpose: string }): Promise<{ item: VaultItem; secrets: Record<string, string> }> {
    const label = services.map((s) => TOKEN_SERVICES[s].label).join(' / ');
    let found: VaultItemWithPermission;
    try {
      found = await this.getFor(userId, itemId, 'use');
    } catch (err) {
      if (err instanceof NotFoundError || (err as AppError).code === 'FORBIDDEN') throw new AppError(`La clé choisie dans vos réglages (${label}) n'est plus accessible dans le coffre : choisissez-en une autre`, 'VAULT_TOKEN');
      throw err;
    }
    const settings = found.settings as TokenSettings;
    if (found.kind !== 'token' || !services.includes(settings.service)) throw new AppError(`« ${found.name} » n'est pas un jeton ${label}`, 'VAULT_TOKEN');
    const secrets = this.secretsOf(found);
    if (!secrets.token) throw new AppError(`« ${found.name} » n'a pas de jeton`, 'VAULT_TOKEN');
    if (actor.sessionId) await this.audit(found, 'used', actor, actor.purpose);
    return { item: found, secrets };
  },

  /**
   * Secrets déchiffrés d'un élément de l'un des `kinds` pour un usage de Skipper au nom de `userId`
   * (appels de modèle : LiteLLM, Langfuse, jetons applicatifs). Chaque usage est journalisé avec son motif.
   * Pour le type `token`, l'appelant vérifie lui-même `settings.service`.
   */
  async useItem(userId: string, itemId: string, kinds: VaultItemKind[], actor: VaultActor & { purpose: string }): Promise<{ item: VaultItem; secrets: Record<string, string> }> {
    const label = kinds.map((k) => kindLabels[k]).join(' / ');
    let found: VaultItemWithPermission;
    try {
      found = await this.getFor(userId, itemId, 'use');
    } catch (err) {
      if (err instanceof NotFoundError || (err as AppError).code === 'FORBIDDEN') throw new AppError(`L'élément du coffre choisi (${label}) n'est plus accessible : choisissez-en un autre`, 'VAULT_TOKEN');
      throw err;
    }
    if (!kinds.includes(found.kind)) throw new AppError(`« ${found.name} » n'est pas un élément ${label}`, 'VAULT_TOKEN');
    const secrets = this.secretsOf(found);
    await this.audit(found, 'used', actor, actor.purpose);
    return { item: found, secrets };
  },

  /** Un élément de l'un des `kinds` utilisable par `userId` (choix dans un formulaire). */
  async assertItem(userId: string, itemId: string, kinds: VaultItemKind[]): Promise<VaultItem> {
    const item = await this.getFor(userId, itemId, 'use');
    if (!kinds.includes(item.kind)) throw new AppError(`« ${item.name} » n'est pas un élément ${kinds.map((k) => kindLabels[k]).join(' / ')}`);
    return item;
  },

  /** Un jeton applicatif utilisable par `userId`, de l'un des `services` (choix dans les réglages). */
  async assertTokenItem(userId: string, itemId: string, services: TokenService[]): Promise<VaultItem> {
    const item = await this.getFor(userId, itemId, 'use');
    if (item.kind !== 'token' || !services.includes((item.settings as TokenSettings).service)) throw new AppError(`« ${item.name} » n'est pas un jeton ${services.map((s) => TOKEN_SERVICES[s].label).join(' / ')}`);
    return item;
  },

  /**
   * Jeton obtenu par un parcours de connexion de Skipper (connexion Claude, GitHub), rangé dans le coffre
   * personnel de la personne : l'élément `existingId` si elle le gère encore, sinon un nouvel élément.
   * Jamais révélable ; renouvelé par Skipper (`refreshToken`).
   */
  async storeOauthToken(
    userId: string,
    input: { service: TokenService; name: string; account: string | null; secrets: Record<string, string>; tokenExpiresAt: Date | null; refreshExpiresAt: Date | null; existingId?: string | null },
  ): Promise<VaultItem> {
    const settings: TokenSettings = {
      service: input.service,
      obtained: 'oauth',
      account: input.account,
      tokenExpiresAt: input.tokenExpiresAt?.toISOString() ?? null,
      refreshExpiresAt: input.refreshExpiresAt?.toISOString() ?? null,
    };
    if (input.existingId) {
      const current = await vaultRepository.findById(input.existingId);
      if (current && current.ownerUserId === userId && current.kind === 'token' && (current.settings as TokenSettings).service === input.service) {
        const item = await vaultRepository.update(current.id, { settings, ...sealSecrets(current.id, 'token', input.secrets) });
        await this.audit(item, 'connected', { userId }, input.account);
        return item;
      }
    }
    const id = randomUUID();
    const taken = new Set((await vaultRepository.listOwnedByUser(userId)).map((i) => i.name));
    const base = validateName(input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || input.service);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 36)}-${n}`;
    const item = await vaultRepository.create({
      id,
      ownerUserId: userId,
      ownerProjectId: null,
      name,
      kind: 'token',
      description: `${TOKEN_SERVICES[input.service].label}${input.account ? ` · ${input.account}` : ''} (connecté depuis Skipper)`,
      settings,
      ...sealSecrets(id, 'token', input.secrets),
      publicKey: null,
      readOnly: true,
      requireApproval: false,
      commandAllowlist: [],
      expiresAt: null,
      createdById: userId,
    });
    await this.audit(item, 'connected', { userId }, input.account);
    return item;
  },

  /** Retire un jeton obtenu par une connexion, s'il appartient encore à la personne (déconnexion du compte). */
  async deleteOauthToken(userId: string, itemId: string): Promise<void> {
    const item = await vaultRepository.findById(itemId);
    if (!item || item.ownerUserId !== userId || !isOauthToken(item)) return;
    await this.audit(item, 'deleted', { userId }, 'compte déconnecté');
    await vaultRepository.delete(itemId);
  },

  /** Nouveau couple de jetons d'un jeton OAuth après renouvellement (sans action humaine : pas journalisé comme un changement). */
  async refreshToken(item: VaultItem, secrets: Record<string, string>, expiry: { tokenExpiresAt: Date | null; refreshExpiresAt: Date | null }): Promise<VaultItem> {
    const settings: TokenSettings = { ...(item.settings as TokenSettings), tokenExpiresAt: expiry.tokenExpiresAt?.toISOString() ?? null, refreshExpiresAt: expiry.refreshExpiresAt?.toISOString() ?? null };
    return vaultRepository.update(item.id, { settings, ...sealSecrets(item.id, 'token', secrets) });
  },

  // ---- Démarrage -----------------------------------------------------------------------------------

  /** Convertit les secrets d'ancien format et ré-enveloppe les clés d'une clé maîtresse précédente ; élague le journal. */
  async startup(): Promise<{ converted: number; rewrapped: number; failed: number; pruned: number }> {
    let converted = 0;
    let rewrapped = 0;
    let failed = 0;
    for (const item of await vaultRepository.listToReencrypt(currentKeyId())) {
      try {
        if (item.legacySecrets && !item.secretCiphertext) {
          const secrets = legacySecretsOf(item);
          const sealed = sealSecrets(item.id, item.kind, secrets);
          if (await vaultRepository.replaceKeyMaterial(item.id, sealed.secretCiphertext, sealed.wrappedKey, null)) converted++;
        } else if (item.wrappedKey) {
          const wrapped = rewrapKey(item.id, item.wrappedKey);
          if (wrapped && (await vaultRepository.replaceKeyMaterial(item.id, item.secretCiphertext, wrapped, item.wrappedKey))) rewrapped++;
        } else {
          await vaultRepository.update(item.id, { legacySecrets: null });
        }
      } catch (err) {
        failed++;
        console.error(`[vault] reprise des secrets de ${item.name} impossible : ${(err as Error).message}`);
      }
    }
    const pruned = await vaultRepository.pruneAudit(AUDIT_RETENTION_DAYS);
    return { converted, rewrapped, failed, pruned };
  },

  // ---- Prompt des agents ---------------------------------------------------------------------------

  /** Description des éléments du coffre pour le prompt système d'une session (hors comptes Google). */
  promptSummary(items: VaultItem[], project: Pick<Project, 'runnerConfig'>): string {
    const list = items.filter((i) => i.kind !== 'google');
    if (!list.length) return '';
    const browser = Boolean((project.runnerConfig as { browser?: boolean } | null)?.browser);
    const byId = new Map(list.map((i) => [i.id, i]));
    const lines = list.map((i) => {
      const desc = i.description ? ` — ${i.description}` : '';
      switch (i.kind) {
        case 'website':
        case 'secret': {
          const s = i.settings as WebsiteSettings | SecretSettings;
          const publics = s.fields.filter((f) => !f.secret).map((f) => `${f.label} : ${JSON.stringify(f.value ?? '')}`);
          const secrets = s.fields.filter((f) => f.secret).map((f) => `${f.label} (clé \`${f.key}\`)`);
          const how = browser
            ? `dans le navigateur, clique le champ du formulaire (\`browser_click\`) puis appelle \`browser_fill\` avec l'élément et la clé du champ : le serveur y saisit la valeur, que tu ne vois jamais`
            : "le navigateur headless n'est pas activé sur ce projet : les secrets ne sont pas utilisables";
          return `- \`${i.name}\` : ${i.kind === 'website' ? `site web ${(s as WebsiteSettings).url}` : 'secret'}${desc}. ${publics.length ? `Champs connus : ${publics.join(', ')}. ` : ''}${secrets.length ? `Secrets : ${secrets.join(', ')}. ` : ''}Accès : ${how}.`;
        }
        case 'ssh': {
          const s = i.settings as SshSettings;
          const policy = i.commandAllowlist.length ? ` ; commandes limitées aux préfixes ${i.commandAllowlist.map((p) => `\`${p}\``).join(', ')}, sans enchaînement ni transfert de fichiers` : '';
          return `- \`${i.name}\` : serveur SSH ${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}${desc}. Outils \`ssh_run\`, \`ssh_upload\`, \`ssh_download\`${policy}.`;
        }
        case 'api': {
          const s = i.settings as ApiSettings;
          return `- \`${i.name}\` : API HTTP ${s.baseUrl}${desc}. Outil \`http_request\` (authentification ajoutée par le serveur)${i.readOnly ? ', lecture seule' : ''}.`;
        }
        case 'postgres': {
          const s = i.settings as PostgresSettings;
          const via = s.viaItemId ? byId.get(s.viaItemId)?.name : null;
          return `- \`${i.name}\` : base PostgreSQL ${s.database} sur ${s.host}${s.port !== 5432 ? `:${s.port}` : ''}${via ? ` (via le tunnel SSH \`${via}\`)` : ''}${desc}. ${i.readOnly ? 'Lecture seule.' : 'Écriture autorisée : prudence.'} Outils \`sql_query\`, \`sql_schema\`.`;
        }
        case 'aws': {
          const s = i.settings as AwsSettings;
          const who = s.auth === 'sso' ? `compte ${s.accountName ?? s.accountId ?? '?'}, rôle ${s.roleName ?? '?'}` : `clé ${s.accessKeyId ?? '?'}${s.roleArn ? `, rôle ${s.roleArn}` : ''}`;
          const policy = i.commandAllowlist.length ? ` ; commandes limitées aux préfixes ${i.commandAllowlist.map((p) => `\`${p}\``).join(', ')}` : '';
          return `- \`${i.name}\` : compte AWS (${who}, région ${s.region})${desc}. Outil \`aws_run\` : la commande du CLI sans \`aws\` (ex. \`s3 ls\`), exécutée par le serveur avec les fichiers du dossier de travail${i.readOnly ? ' ; lecture seule (describe, get, list…)' : ''}${policy}.`;
        }
        default:
          return '';
      }
    });
    return [
      "Le coffre du projet donne accès à des systèmes externes avec les outils du serveur MCP `vault` (le serveur détient les identifiants : tu ne les vois jamais et ne dois pas chercher à les obtenir) ou, pour les sites web et les secrets, par le navigateur headless. Un appel peut être soumis à l'approbation d'un humain. Désigne un élément par son nom (paramètre `item`).",
      ...lines.filter(Boolean),
    ].join('\n');
  },

  /** Étiquette d'un élément Google pour l'interface. */
  googleSettings: (item: VaultItem) => item.settings as GoogleSettings,
  hostOf,
};

export type { VaultAuditEvent, VaultLink, ProjectRole };
