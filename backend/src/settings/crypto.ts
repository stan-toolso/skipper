import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Chiffrement des secrets stockés en base (clé API, jeton OAuth) : AES-256-GCM.
 * La clé vient de SKIPPER_SECRET_KEY (64 caractères hexadécimaux) ou, à défaut, d'un fichier
 * `.secret-key` généré une fois pour toutes dans WORKSPACES_ROOT (lisible par le seul propriétaire).
 */
let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.SKIPPER_SECRET_KEY;
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error('SKIPPER_SECRET_KEY doit contenir 64 caractères hexadécimaux (32 octets)');
    cachedKey = Buffer.from(fromEnv, 'hex');
    return cachedKey;
  }
  const file = path.join(config.workspacesRoot, '.secret-key');
  if (existsSync(file)) {
    cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (cachedKey.length !== 32) throw new Error(`Clé invalide dans ${file}`);
    return cachedKey;
  }
  mkdirSync(config.workspacesRoot, { recursive: true });
  cachedKey = randomBytes(32);
  writeFileSync(file, cachedKey.toString('hex') + '\n', { mode: 0o600 });
  console.log(`[settings] clé de chiffrement des secrets générée dans ${file}`);
  return cachedKey;
}

/** Renvoie "v1:<iv>:<tag>:<données>" en base64. */
export function encryptSecret(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(encoded: string): string {
  const [version, iv, tag, data] = encoded.split(':');
  // `data` est vide pour un secret vide : seule son absence est une erreur.
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Secret chiffré illisible');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
