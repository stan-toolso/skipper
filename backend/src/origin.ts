import { config } from './config.js';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Origines autorisées à appeler l'API avec le cookie de session (CORS, WebSockets) : l'application (`APP_URL`)
 * et le poste de développement (localhost). Un autre sous-domaine du même domaine enregistrable reçoit pourtant le
 * cookie (SameSite=Lax) : c'est cette vérification, pas le cookie, qui l'écarte.
 */
export function isAllowedOrigin(origin: string | null | undefined): origin is string {
  if (!origin) return false;
  return origin === new URL(config.appUrl).origin || LOCAL_ORIGIN.test(origin);
}
