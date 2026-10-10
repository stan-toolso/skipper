import { AppError } from '../errors.js';
import { assertAllowedUrl, safeRequest } from './http.js';

/**
 * Proxy LiteLLM et projet Langfuse : identifiants des appels de modèle de Skipper lui-même (agents qui
 * appellent un modèle directement). Comme les jetons applicatifs, jamais offerts aux agents des sessions.
 * Les appels passent par la garde réseau du coffre.
 */

/** URL de base : adresse http(s) acceptée par la garde réseau, sans paramètres, fragment ni barre finale. */
export function validateBaseUrl(url: string | null | undefined, label: string): string {
  const u = url?.trim();
  if (!u) throw new AppError(`${label} obligatoire`);
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new AppError(`Adresse invalide : ${u}`);
  }
  assertAllowedUrl(parsed);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function validatePublicKey(value: string | null | undefined): string {
  const v = value?.trim();
  if (!v) throw new AppError('La clé publique est obligatoire');
  if (!/^pk-lf-\S+$/.test(v)) throw new AppError('Clé publique Langfuse invalide : elle commence par « pk-lf- »');
  return v;
}

export function validateSecretKey(value: string | null | undefined): string {
  const v = value?.trim();
  if (!v) throw new AppError('La clé secrète est obligatoire');
  if (!/^sk-lf-\S+$/.test(v)) throw new AppError('Clé secrète Langfuse invalide : elle commence par « sk-lf- »');
  return v;
}

/** Nombre de modèles d'une réponse `/v1/models` de LiteLLM. */
export function parseModelCount(body: string): number {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("LiteLLM a répondu autre chose que du JSON : est-ce bien l'adresse du proxy ?");
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('Réponse inattendue de LiteLLM (pas de liste de modèles)');
  return data.length;
}

/** Nom du projet d'une réponse `/api/public/projects` de Langfuse. */
export function parseProjectName(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Langfuse a répondu autre chose que du JSON : vérifiez l'hôte");
  }
  const first = (json as { data?: { name?: unknown }[] } | null)?.data?.[0];
  if (!first || typeof first.name !== 'string') throw new Error('Réponse inattendue de Langfuse (aucun projet)');
  return first.name;
}

const joinUrl = (base: string, path: string) => new URL(`${base.replace(/\/+$/, '')}${path}`);

function checkStatus(service: string, status: number): void {
  if (status === 401 || status === 403) throw new Error(`${service} refuse ces identifiants (invalides, expirés ou révoqués)`);
  if (status < 200 || status >= 300) throw new Error(`${service} : vérification impossible (HTTP ${status})`);
}

export async function probeLitellm(baseUrl: string, token: string): Promise<string> {
  const res = await safeRequest(joinUrl(baseUrl, '/v1/models'), { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'Skipper vault' }, timeoutMs: 15_000 });
  checkStatus('LiteLLM', res.status);
  const count = parseModelCount(res.body.toString('utf8'));
  return `${count} modèle${count === 1 ? '' : 's'} disponible${count === 1 ? '' : 's'}`;
}

export async function probeLangfuse(host: string, publicKey: string, secretKey: string): Promise<string> {
  const basic = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const res = await safeRequest(joinUrl(host, '/api/public/projects'), { headers: { authorization: `Basic ${basic}`, accept: 'application/json', 'user-agent': 'Skipper vault' }, timeoutMs: 15_000 });
  checkStatus('Langfuse', res.status);
  return `Projet Langfuse « ${parseProjectName(res.body.toString('utf8')) } »`;
}
