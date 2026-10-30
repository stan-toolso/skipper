import type { ProjectRole } from '../users/types.js';
import { PERMISSION_RANK, type VaultItem, type VaultLinkScope, type VaultPermission } from './types.js';

/** Faits d'accès d'une personne sur un élément, lus en base. */
export interface AccessFacts {
  /** Partage explicite. */
  share: VaultPermission | null;
  /** Rôle dans le projet propriétaire (élément de projet). */
  ownerProjectRole: ProjectRole | null;
  /** L'élément est relié (pour tous, ou pour cette personne) à un projet dont elle est membre. */
  linked: boolean;
}

const max = (a: VaultPermission | null, b: VaultPermission | null): VaultPermission | null => {
  if (!a) return b;
  if (!b) return a;
  return PERMISSION_RANK[a] >= PERMISSION_RANK[b] ? a : b;
};

/**
 * Permission d'une personne sur un élément : la plus forte entre propriétaire (manage), rôle dans le projet
 * propriétaire (admin → manage, sinon use), partage explicite, et lien vers un de ses projets (use).
 * null : l'élément n'existe pas pour elle.
 */
export function permissionOf(item: Pick<VaultItem, 'ownerUserId' | 'ownerProjectId'>, userId: string, facts: AccessFacts): VaultPermission | null {
  let p: VaultPermission | null = null;
  if (item.ownerUserId === userId) p = 'manage';
  if (item.ownerProjectId && facts.ownerProjectRole) p = max(p, facts.ownerProjectRole === 'admin' ? 'manage' : 'use');
  p = max(p, facts.share);
  if (facts.linked) p = max(p, 'use');
  return p;
}

export const atLeast = (p: VaultPermission | null, min: VaultPermission): boolean => p !== null && PERMISSION_RANK[p] >= PERMISSION_RANK[min];

/**
 * Accès direct : propriétaire d'un élément personnel, partage explicite, ou administrateur du projet
 * propriétaire. Être membre du projet propriétaire, ou d'un projet où l'élément est relié, n'est qu'un
 * accès à l'intérieur de ce projet : il ne permet pas de relier l'élément ailleurs.
 */
export function hasDirectAccess(item: Pick<VaultItem, 'ownerUserId' | 'ownerProjectId'>, userId: string, facts: AccessFacts): boolean {
  return item.ownerUserId === userId || facts.share !== null || (Boolean(item.ownerProjectId) && facts.ownerProjectRole === 'admin');
}

/** Peut-on relier l'élément à un projet avec cette portée ? */
export function canLink(scope: VaultLinkScope, permission: VaultPermission | null, projectRole: ProjectRole | null, direct: boolean): boolean {
  if (!projectRole) return false;
  if (scope === 'project') return atLeast(permission, 'manage') && projectRole === 'admin';
  return direct && atLeast(permission, 'use') && projectRole !== 'viewer';
}

/** Champs secrets révélables selon le type (la clé privée SSH et le jeton Google ne quittent jamais le serveur). */
export function revealableFields(item: Pick<VaultItem, 'kind' | 'settings'>, permission: VaultPermission | null, hasSecret: boolean): string[] {
  if (!atLeast(permission, 'read') || !hasSecret) return [];
  switch (item.kind) {
    case 'postgres':
      return ['password'];
    case 'api':
    case 'litellm':
      return ['token'];
    case 'token':
      // Un jeton obtenu par une connexion (abonnement Claude, GitHub OAuth) ne quitte jamais le serveur.
      return (item.settings as { obtained?: string }).obtained === 'oauth' ? [] : ['token'];
    case 'langfuse':
      return ['secretKey'];
    case 'aws':
      // Les jetons Identity Center ne quittent jamais le serveur ; la clé d'accès secrète, saisie à la main, se révèle.
      return (item.settings as { auth?: string }).auth === 'keys' ? ['secretAccessKey'] : [];
    case 'scaleway':
      return ['secretKey'];
    case 'website':
    case 'secret':
      return ((item.settings as { fields?: { key: string; secret: boolean }[] }).fields ?? []).filter((f) => f.secret).map((f) => f.key);
    default:
      return [];
  }
}
