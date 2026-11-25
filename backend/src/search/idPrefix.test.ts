import { describe, expect, it } from 'vitest';
import { idPrefixOf, shortRefOf, uuidRange } from './idPrefix.js';

describe('idPrefixOf', () => {
  it('reconnaît un identifiant court ou complet', () => {
    expect(idPrefixOf('313c1101')).toBe('313c1101');
    expect(idPrefixOf(' 2927A9FC ')).toBe('2927a9fc');
    expect(idPrefixOf('c87aacf3-30ac-4860-8a01-e9a48f1fa2f0')).toBe('c87aacf3-30ac-4860-8a01-e9a48f1fa2f0');
    expect(idPrefixOf('c87aacf3-30ac')).toBe('c87aacf3-30ac');
  });
  it('ignore les mots ordinaires', () => {
    expect(idPrefixOf('facade')).toBeNull();
    expect(idPrefixOf('12')).toBeNull();
    expect(idPrefixOf('session 313c1101')).toBeNull();
    expect(idPrefixOf('déploiement')).toBeNull();
  });
});

describe('uuidRange', () => {
  it('borne les UUID qui commencent par le préfixe', () => {
    expect(uuidRange('313c1101')).toEqual(['313c1101-0000-0000-0000-000000000000', '313c1101-ffff-ffff-ffff-ffffffffffff']);
    expect(uuidRange('313C1101AB')).toEqual(['313c1101-ab00-0000-0000-000000000000', '313c1101-abff-ffff-ffff-ffffffffffff']);
  });
});

describe('shortRefOf', () => {
  it('ne garde que les débuts d’identifiants plausibles', () => {
    expect(shortRefOf('56F64F35')).toBe('56f64f35');
    expect(shortRefOf('deadbeef')).toBeNull();
    expect(shortRefOf('1234567')).toBeNull();
    expect(shortRefOf('1234567890abc')).toBeNull();
  });
});
