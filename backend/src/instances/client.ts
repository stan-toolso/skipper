import { AppError } from '../errors.js';
import type { InstanceInfo } from './registry.js';

/** En-têtes des appels internes : jeton de l'instance appelée, et marque qui interdit de les router de nouveau. */
export const INSTANCE_TOKEN_HEADER = 'x-skipper-instance-token';
export const FORWARDED_HEADER = 'x-skipper-forwarded';
/** Préfixe des routes internes (jamais proxifié par nginx, refusé hors de la machine). */
export const INTERNAL_PREFIX = '/internal/instance/';

const CALL_TIMEOUT_MS = 30_000;

/**
 * Appelle une autre instance du backend sur son port local (HTTP interne) : une action sur une session ou un terminal
 * que cette instance tient. L'erreur métier de l'instance appelée (message, code) est relevée telle quelle.
 */
export async function callInstance<T = unknown>(target: InstanceInfo, action: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${target.port}${INTERNAL_PREFIX}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INSTANCE_TOKEN_HEADER]: target.token, [FORWARDED_HEADER]: '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError(`L'instance du serveur qui tient cette session ne répond pas (${(err as Error).message}) : réessayez dans quelques secondes`, 'MAINTENANCE');
  }
  const data = (await res.json().catch(() => ({}))) as { result?: T; error?: string; code?: string };
  if (!res.ok) throw new AppError(data.error ?? `Instance ${target.label || target.id} : HTTP ${res.status}`, data.code);
  return data.result as T;
}
