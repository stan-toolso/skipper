import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentKeyId, openSecrets, resetKeyRingForTests, rewrapKey, sealSecrets } from './crypto.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('chiffrement par enveloppe', () => {
  beforeEach(() => {
    process.env.SKIPPER_SECRET_KEY = KEY_A;
    delete process.env.SKIPPER_SECRET_KEY_PREVIOUS;
    resetKeyRingForTests();
  });
  afterEach(() => {
    delete process.env.SKIPPER_SECRET_KEY;
    delete process.env.SKIPPER_SECRET_KEY_PREVIOUS;
    resetKeyRingForTests();
  });

  it('scelle puis rouvre les secrets d’un élément', () => {
    const sealed = sealSecrets('item-1', 'postgres', { password: 'p@ss', other: 'x' });
    expect(sealed.secretCiphertext!.startsWith('s1:')).toBe(true);
    expect(sealed.wrappedKey!.startsWith(`k1:${currentKeyId()}:`)).toBe(true);
    expect(openSecrets('item-1', 'postgres', sealed.secretCiphertext!, sealed.wrappedKey!)).toEqual({ password: 'p@ss', other: 'x' });
  });

  it('chaque scellement tire une clé de données différente', () => {
    const a = sealSecrets('item-1', 'postgres', { password: 'p' });
    const b = sealSecrets('item-1', 'postgres', { password: 'p' });
    expect(a.secretCiphertext).not.toBe(b.secretCiphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('un chiffré copié sur un autre élément ou un autre type ne s’ouvre pas', () => {
    const sealed = sealSecrets('item-1', 'postgres', { password: 'p' });
    expect(() => openSecrets('item-2', 'postgres', sealed.secretCiphertext!, sealed.wrappedKey!)).toThrow();
    expect(() => openSecrets('item-1', 'api', sealed.secretCiphertext!, sealed.wrappedKey!)).toThrow();
  });

  it('rotation : une ancienne clé maîtresse ouvre encore, et la clé de données est ré-enveloppée', () => {
    const sealed = sealSecrets('item-1', 'postgres', { password: 'p' });
    const oldKeyId = currentKeyId();
    process.env.SKIPPER_SECRET_KEY = KEY_B;
    process.env.SKIPPER_SECRET_KEY_PREVIOUS = KEY_A;
    resetKeyRingForTests();
    expect(currentKeyId()).not.toBe(oldKeyId);
    expect(openSecrets('item-1', 'postgres', sealed.secretCiphertext!, sealed.wrappedKey!)).toEqual({ password: 'p' });
    const rewrapped = rewrapKey('item-1', sealed.wrappedKey!);
    expect(rewrapped).not.toBeNull();
    expect(rewrapped!.startsWith(`k1:${currentKeyId()}:`)).toBe(true);
    expect(openSecrets('item-1', 'postgres', sealed.secretCiphertext!, rewrapped!)).toEqual({ password: 'p' });
    // Déjà sous la clé courante : rien à faire.
    expect(rewrapKey('item-1', rewrapped!)).toBeNull();
  });

  it('une clé inconnue est refusée', () => {
    const sealed = sealSecrets('item-1', 'postgres', { password: 'p' });
    process.env.SKIPPER_SECRET_KEY = KEY_B;
    resetKeyRingForTests();
    expect(() => openSecrets('item-1', 'postgres', sealed.secretCiphertext!, sealed.wrappedKey!)).toThrow();
  });
});
