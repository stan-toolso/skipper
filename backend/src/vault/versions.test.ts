import { describe, expect, it } from 'vitest';
import { diffSnapshots, type VaultSnapshot } from './versions.js';

const base = (over: Partial<VaultSnapshot> = {}): VaultSnapshot => ({
  name: 'brevo',
  description: '',
  settings: { fields: [{ key: 'user', label: 'Utilisateur', secret: false, value: 'a' }, { key: 'token', label: 'Jeton', secret: true, value: null }] } as unknown as VaultSnapshot['settings'],
  secretCiphertext: 's1:x',
  wrappedKey: 'k1:x',
  publicKey: null,
  readOnly: true,
  requireApproval: true,
  envExport: false,
  commandAllowlist: [],
  expiresAt: null,
  ...over,
});

describe('diffSnapshots', () => {
  it('liste les changements publics avec leurs valeurs et les secrets sans valeur', () => {
    const after = base({
      description: 'Brevo',
      settings: { fields: [{ key: 'user', label: 'Utilisateur', secret: false, value: 'b' }, { key: 'token', label: 'Jeton', secret: true, value: null }] } as unknown as VaultSnapshot['settings'],
      requireApproval: false,
    });
    const changes = diffSnapshots(base(), after, { token: 'ancien' }, { token: 'nouveau' });
    expect(changes).toEqual([
      { field: 'description', label: 'description', before: null, after: 'Brevo' },
      { field: 'fields.user', label: 'champ « Utilisateur »', before: 'a', after: 'b' },
      { field: 'fields.token', label: 'champ « Jeton »', secret: true },
      { field: 'requireApproval', label: 'approbation à chaque usage', before: 'oui', after: 'non' },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/ancien|nouveau/);
  });

  it('ignore les réglages et secrets renouvelés tout seuls, signale les autres secrets', () => {
    const a = base({ settings: { host: 'h', port: 22, tokenExpiresAt: '1' } as unknown as VaultSnapshot['settings'] });
    const b = base({ settings: { host: 'h2', port: 22, tokenExpiresAt: '2' } as unknown as VaultSnapshot['settings'] });
    const changes = diffSnapshots(a, b, { accessToken: '1', password: 'x' }, { accessToken: '2', password: 'y' });
    expect(changes).toEqual([
      { field: 'settings.host', label: 'hôte', before: 'h', after: 'h2' },
      { field: 'secrets.password', label: 'mot de passe', secret: true },
    ]);
  });

  it("rien à la création", () => {
    expect(diffSnapshots(null, base(), {}, {})).toEqual([]);
  });
});
