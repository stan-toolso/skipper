import { describe, expect, it } from 'vitest';
import { canLink, hasDirectAccess, permissionOf, revealableFields, type AccessFacts } from './access.js';
import type { VaultItemKind, VaultSettings } from './types.js';

/** Élément minimal pour revealableFields (les réglages ne sont lus que pour les sites et les jetons). */
const item = (kind: VaultItemKind, settings: object = {}) => ({ kind, settings: settings as VaultSettings });

const none: AccessFacts = { share: null, ownerProjectRole: null, linked: false };
const personal = { ownerUserId: 'alice', ownerProjectId: null };
const projectItem = { ownerUserId: null, ownerProjectId: 'p1' };

describe('permissionOf', () => {
  it('le propriétaire d’un élément personnel le gère', () => {
    expect(permissionOf(personal, 'alice', none)).toBe('manage');
  });
  it('sans aucun fait, un étranger ne voit pas l’élément', () => {
    expect(permissionOf(personal, 'bob', none)).toBeNull();
    expect(permissionOf(projectItem, 'bob', none)).toBeNull();
  });
  it('rôle dans le projet propriétaire : admin gère, les autres utilisent', () => {
    expect(permissionOf(projectItem, 'bob', { ...none, ownerProjectRole: 'admin' })).toBe('manage');
    expect(permissionOf(projectItem, 'bob', { ...none, ownerProjectRole: 'member' })).toBe('use');
    expect(permissionOf(projectItem, 'bob', { ...none, ownerProjectRole: 'viewer' })).toBe('use');
  });
  it('le partage explicite donne sa permission, et la plus forte l’emporte', () => {
    expect(permissionOf(personal, 'bob', { ...none, share: 'read' })).toBe('read');
    expect(permissionOf(projectItem, 'bob', { ...none, share: 'read', ownerProjectRole: 'member' })).toBe('read');
    expect(permissionOf(projectItem, 'bob', { ...none, share: 'use', ownerProjectRole: 'admin' })).toBe('manage');
  });
  it('un lien vers un de ses projets ne donne que l’usage', () => {
    expect(permissionOf(personal, 'bob', { ...none, linked: true })).toBe('use');
    expect(permissionOf(personal, 'bob', { ...none, linked: true, share: 'manage' })).toBe('manage');
  });
});

describe('hasDirectAccess', () => {
  it('propriétaire, partage ou administrateur du projet propriétaire', () => {
    expect(hasDirectAccess(personal, 'alice', none)).toBe(true);
    expect(hasDirectAccess(personal, 'bob', { ...none, share: 'use' })).toBe(true);
    expect(hasDirectAccess(projectItem, 'bob', { ...none, ownerProjectRole: 'admin' })).toBe(true);
  });
  it('être membre du projet propriétaire ou d’un projet relié ne suffit pas', () => {
    expect(hasDirectAccess(projectItem, 'bob', { ...none, ownerProjectRole: 'member' })).toBe(false);
    expect(hasDirectAccess(personal, 'bob', { ...none, linked: true })).toBe(false);
  });
});

describe('canLink', () => {
  it('pour tout le projet : gérer l’élément et administrer le projet', () => {
    expect(canLink('project', 'manage', 'admin', false)).toBe(true);
    expect(canLink('project', 'read', 'admin', true)).toBe(false);
    expect(canLink('project', 'manage', 'member', true)).toBe(false);
  });
  it('pour ses sessions : accès direct, au moins utiliser, et ne pas être simple lecteur', () => {
    expect(canLink('personal', 'use', 'member', true)).toBe(true);
    expect(canLink('personal', 'use', 'member', false)).toBe(false);
    expect(canLink('personal', 'use', 'viewer', true)).toBe(false);
    expect(canLink('personal', 'use', null, true)).toBe(false);
  });
});

describe('revealableFields', () => {
  it('rien sans permission de lecture ni sans secret', () => {
    expect(revealableFields(item('postgres'), 'use', true)).toEqual([]);
    expect(revealableFields(item('postgres'), 'read', false)).toEqual([]);
  });
  it('mot de passe, jeton, ou champs secrets selon le type ; jamais la clé SSH ni le jeton Google', () => {
    expect(revealableFields(item('postgres'), 'read', true)).toEqual(['password']);
    expect(revealableFields(item('api'), 'manage', true)).toEqual(['token']);
    expect(revealableFields(item('website', { fields: [{ key: 'username', label: 'Identifiant', secret: false, value: 'alice' }, { key: 'password', label: 'Mot de passe', secret: true, value: null }] }), 'read', true)).toEqual(['password']);
    expect(revealableFields(item('ssh'), 'manage', true)).toEqual([]);
    expect(revealableFields(item('google'), 'manage', true)).toEqual([]);
  });
});
