import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { userRepository } from '../users/repository.js';
import type { User } from '../users/types.js';

export const SESSION_COOKIE = 'skipper_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 jours, prolongés à chaque utilisation
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Sessions de connexion : jeton aléatoire dans un cookie HttpOnly, hachage en base. */
export const authSession = {
  async create(user: User): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await userRepository.createSession(hash(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
    return token;
  },

  /** Utilisateur de la session portée par le jeton, ou null. Prolonge la session de temps en temps. */
  async resolve(token: string | null | undefined): Promise<User | null> {
    if (!token) return null;
    const found = await userRepository.findSessionUser(hash(token));
    if (!found) return null;
    if (Date.now() - found.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      void userRepository.touchSession(hash(token), new Date(Date.now() + SESSION_TTL_MS)).catch(() => undefined);
    }
    return found.user;
  },

  async destroy(token: string | null | undefined): Promise<void> {
    if (token) await userRepository.deleteSession(hash(token));
  },

  purgeExpired: () => userRepository.deleteExpiredSessions(),

  /** En-tête Set-Cookie de la session (ou de sa suppression avec `null`). */
  cookie(token: string | null): string {
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (config.apiUrl.startsWith('https://')) attrs.push('Secure');
    attrs.push(token ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : 'Max-Age=0');
    return `${SESSION_COOKIE}=${token ?? ''}; ${attrs.join('; ')}`;
  },
};

/** Lit un cookie dans un en-tête Cookie brut. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
