import { describe, expect, it } from 'vitest';
import { idPrefixOf } from './idPrefix.js';

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
