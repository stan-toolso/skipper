import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_A = 'a'.repeat(64);
const KEY_B = '0123456789abcdef'.repeat(4);

let workspaces: string;

/** Charge une copie neuve du module (la clé est mise en cache au premier usage). */
async function loadCrypto(env: { key?: string } = {}) {
  vi.resetModules();
  if (env.key === undefined) delete process.env.SKIPPER_SECRET_KEY;
  else process.env.SKIPPER_SECRET_KEY = env.key;
  process.env.WORKSPACES_ROOT = workspaces;
  return import('./crypto.js');
}

beforeEach(async () => {
  workspaces = await mkdtemp(path.join(os.tmpdir(), 'skipper-crypto-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SKIPPER_SECRET_KEY;
  await rm(workspaces, { recursive: true, force: true });
});

describe('encryptSecret / decryptSecret (AES-256-GCM)', () => {
  it.each([
    ['chaîne vide', ''],
    ['clé API', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['texte accentué et emoji', 'Mot de passe : éàü ✓ 🔑'],
    ['long texte', 'x'.repeat(100_000)],
  ])('aller-retour : %s', async (_label, plain) => {
    const { decryptSecret, encryptSecret } = await loadCrypto({ key: KEY_A });
    const encoded = encryptSecret(plain);
    if (plain) expect(encoded).not.toContain(plain);
    expect(decryptSecret(encoded)).toBe(plain);
  });

  it('produit le format v1:<iv>:<tag>:<données> avec un IV de 12 octets et un tag de 16 octets', async () => {
    const { encryptSecret } = await loadCrypto({ key: KEY_A });
    const [version, iv, tag, data] = encryptSecret('secret').split(':');
    expect(version).toBe('v1');
    expect(Buffer.from(iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(data, 'base64')).toHaveLength('secret'.length);
  });

  it('tire un IV différent à chaque chiffrement', async () => {
    const { decryptSecret, encryptSecret } = await loadCrypto({ key: KEY_A });
    const a = encryptSecret('même valeur');
    const b = encryptSecret('même valeur');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('rejette des données ou un tag altérés', async () => {
    const { decryptSecret, encryptSecret } = await loadCrypto({ key: KEY_A });
    const [version, iv, tag, data] = encryptSecret('secret').split(':');
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] ^= 0x01;
      return buf.toString('base64');
    };
    expect(() => decryptSecret([version, iv, tag, flip(data)].join(':'))).toThrow();
    expect(() => decryptSecret([version, iv, flip(tag), data].join(':'))).toThrow();
    expect(() => decryptSecret([version, flip(iv), tag, data].join(':'))).toThrow();
  });

  it('rejette un secret chiffré avec une autre clé', async () => {
    const encoded = (await loadCrypto({ key: KEY_A })).encryptSecret('secret');
    const { decryptSecret } = await loadCrypto({ key: KEY_B });
    expect(() => decryptSecret(encoded)).toThrow();
  });

  it.each(['', 'texte en clair', 'v2:a:b:c', 'v1:a:b', 'v1::b:c', 'v1:a::c'])('rejette un format illisible : %j', async (encoded) => {
    const { decryptSecret } = await loadCrypto({ key: KEY_A });
    expect(() => decryptSecret(encoded)).toThrow('Secret chiffré illisible');
  });
});

describe('clé de chiffrement', () => {
  it('refuse une SKIPPER_SECRET_KEY qui ne fait pas 64 caractères hexadécimaux', async () => {
    for (const key of ['abc', 'z'.repeat(64), 'a'.repeat(63)]) {
      const { encryptSecret } = await loadCrypto({ key });
      expect(() => encryptSecret('x')).toThrow(/SKIPPER_SECRET_KEY/);
    }
  });

  it('génère sans variable une clé dans WORKSPACES_ROOT/.secret-key, lisible du seul propriétaire, et la réutilise', async () => {
    const first = await loadCrypto();
    const encoded = first.encryptSecret('secret');
    const file = path.join(workspaces, '.secret-key');
    expect((await readFile(file, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Nouveau processus (module rechargé) : la même clé est relue depuis le fichier.
    const second = await loadCrypto();
    expect(second.decryptSecret(encoded)).toBe('secret');
  });

  it('accepte une clé en majuscules et donne le même résultat que la clé en minuscules', async () => {
    const encoded = (await loadCrypto({ key: KEY_B.toUpperCase() })).encryptSecret('secret');
    expect((await loadCrypto({ key: KEY_B })).decryptSecret(encoded)).toBe('secret');
  });

  it('refuse un fichier .secret-key invalide', async () => {
    await writeFile(path.join(workspaces, '.secret-key'), 'abcd\n');
    const { encryptSecret } = await loadCrypto();
    expect(() => encryptSecret('x')).toThrow(/Clé invalide/);
  });
});
