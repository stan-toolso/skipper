import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { loadMasterKey, resetMasterKeyForTests } from '../settings/crypto.js';

/**
 * Chiffrement par enveloppe des secrets du coffre, AES-256-GCM partout :
 * - les secrets d'un élément forment un document JSON chiffré avec une clé de données qui lui est propre,
 *   tirée à chaque écriture (`s1:<iv>:<tag>:<données>`) ;
 * - la clé de données est enveloppée par la clé maîtresse (`k1:<id de clé>:<iv>:<tag>:<données>`) ;
 * - les deux sont liés à l'élément (données authentifiées : identifiant, et type pour le document) :
 *   un chiffré copié sur une autre ligne ne se déchiffre pas.
 * La clé maîtresse est celle des autres secrets (SKIPPER_SECRET_KEY ou le fichier .secret-key) ;
 * SKIPPER_SECRET_KEY_PREVIOUS (liste séparée par des virgules) permet une rotation : les clés de données
 * enveloppées par une ancienne clé sont ré-enveloppées au démarrage.
 */

const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

interface KeyRing {
  current: { id: string; key: Buffer };
  byId: Map<string, Buffer>;
}

let ring: KeyRing | null = null;

function keyRing(): KeyRing {
  if (ring) return ring;
  const current = loadMasterKey();
  const byId = new Map<string, Buffer>([[keyId(current), current]]);
  for (const hex of (process.env.SKIPPER_SECRET_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('SKIPPER_SECRET_KEY_PREVIOUS doit contenir des clés de 64 caractères hexadécimaux séparées par des virgules');
    const key = Buffer.from(hex, 'hex');
    byId.set(keyId(key), key);
  }
  ring = { current: { id: keyId(current), key: current }, byId };
  return ring;
}

export class VaultDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultDecryptError';
  }
}

const dekAad = (itemId: string) => Buffer.from(`skipper-vault-dek:${itemId}`);
const payloadAad = (itemId: string, kind: string) => Buffer.from(`skipper-vault-item:${itemId}:${kind}`);

function encrypt(key: Buffer, aad: Buffer, plain: Buffer): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key: Buffer, aad: Buffer, iv: string, tag: string, data: string, what: string): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  } catch {
    throw new VaultDecryptError(`${what} ne s'authentifie pas (clé changée ou données altérées)`);
  }
}

export interface SealedSecrets {
  secretCiphertext: string | null;
  wrappedKey: string | null;
}

/** Chiffre les secrets d'un élément ; un dictionnaire vide ne produit aucun chiffré. */
export function sealSecrets(itemId: string, kind: string, secrets: Record<string, string>): SealedSecrets {
  if (Object.keys(secrets).length === 0) return { secretCiphertext: null, wrappedKey: null };
  const { current } = keyRing();
  const dek = randomBytes(32);
  try {
    const payload = encrypt(dek, payloadAad(itemId, kind), Buffer.from(JSON.stringify(secrets), 'utf8'));
    const wrapped = encrypt(current.key, dekAad(itemId), dek);
    return {
      secretCiphertext: ['s1', payload.iv, payload.tag, payload.data].join(':'),
      wrappedKey: ['k1', current.id, wrapped.iv, wrapped.tag, wrapped.data].join(':'),
    };
  } finally {
    dek.fill(0);
  }
}

function unwrap(itemId: string, wrappedKey: string): Buffer {
  const [version, id, iv, tag, data] = wrappedKey.split(':');
  if (version !== 'k1' || !id || !iv || !tag || !data) throw new VaultDecryptError('Clé enveloppée illisible');
  const key = keyRing().byId.get(id);
  if (!key) throw new VaultDecryptError(`Clé maîtresse ${id} inconnue (ajoutez-la à SKIPPER_SECRET_KEY_PREVIOUS)`);
  return decrypt(key, dekAad(itemId), iv, tag, data, 'La clé enveloppée');
}

/** Déchiffre les secrets d'un élément. */
export function openSecrets(itemId: string, kind: string, secretCiphertext: string, wrappedKey: string): Record<string, string> {
  const dek = unwrap(itemId, wrappedKey);
  try {
    const [version, iv, tag, data] = secretCiphertext.split(':');
    if (version !== 's1' || !iv || !tag || data === undefined) throw new VaultDecryptError('Secrets chiffrés illisibles');
    const parsed: unknown = JSON.parse(decrypt(dek, payloadAad(itemId, kind), iv, tag, data, 'Le document des secrets').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new VaultDecryptError('Document des secrets invalide');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    return out;
  } finally {
    dek.fill(0);
  }
}

/** Identifiant de la clé maîtresse courante (celui qu'une clé enveloppée doit porter). */
export function currentKeyId(): string {
  return keyRing().current.id;
}

/** Ré-enveloppe une clé de données sous la clé maîtresse courante ; null si c'est déjà le cas. */
export function rewrapKey(itemId: string, wrappedKey: string): string | null {
  const { current } = keyRing();
  if (wrappedKey.split(':')[1] === current.id) return null;
  const dek = unwrap(itemId, wrappedKey);
  try {
    const wrapped = encrypt(current.key, dekAad(itemId), dek);
    return ['k1', current.id, wrapped.iv, wrapped.tag, wrapped.data].join(':');
  } finally {
    dek.fill(0);
  }
}

/** Pour les tests : oublie le trousseau chargé. */
export function resetKeyRingForTests(): void {
  ring = null;
  resetMasterKeyForTests();
}
