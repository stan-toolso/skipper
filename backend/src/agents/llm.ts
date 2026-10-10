import { AppError } from '../errors.js';
import { safeRequest } from '../vault/http.js';

/**
 * Agents qui appellent un modèle de langage directement (sans session) : à travers un proxy LiteLLM, ou droit
 * vers OpenAI ou Anthropic. La clé vient du coffre ; l'appel est tracé dans Langfuse quand l'agent nomme un
 * élément Langfuse. L'agent range cette configuration dans `agents.config` avec le fournisseur `llm`.
 */

export const LLM_PROVIDER = 'llm';
export type LlmBackend = 'litellm' | 'openai' | 'anthropic';
export const LLM_BACKENDS: LlmBackend[] = ['litellm', 'openai', 'anthropic'];

export interface LlmConfig {
  backend: LlmBackend;
  /** Élément du coffre qui détient la clé : un élément `litellm`, ou un jeton applicatif du service. */
  keyItemId: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  /** Élément `langfuse` du coffre où tracer les appels, le cas échéant. */
  langfuseItemId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const backendLabel = (b: LlmBackend) => (b === 'litellm' ? 'LiteLLM' : b === 'openai' ? 'OpenAI' : 'Anthropic');

function optionalNumber(raw: unknown, label: string, min: number, max: number, integer: boolean): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new AppError(`${label} doit être ${integer ? 'un entier' : 'un nombre'} entre ${min} et ${max}`);
  return n;
}

/** Valide et normalise la configuration enregistrée d'un agent `llm`. */
export function parseLlmConfig(raw: Record<string, unknown>): LlmConfig {
  const backend = String(raw.backend ?? '') as LlmBackend;
  if (!LLM_BACKENDS.includes(backend)) throw new AppError('Choisissez comment joindre le modèle : LiteLLM, OpenAI ou Anthropic');
  const keyItemId = String(raw.keyItemId ?? '').trim();
  if (!UUID.test(keyItemId)) throw new AppError(`Choisissez la clé ${backendLabel(backend)} dans le coffre`);
  const model = String(raw.model ?? '').trim();
  if (!model) throw new AppError('Le modèle est obligatoire');
  if (model.length > 200 || /\s/.test(model)) throw new AppError('Nom de modèle invalide');
  const langfuseItemId = String(raw.langfuseItemId ?? '').trim() || null;
  if (langfuseItemId && !UUID.test(langfuseItemId)) throw new AppError('Élément Langfuse invalide');
  return {
    backend,
    keyItemId,
    model,
    temperature: optionalNumber(raw.temperature, 'La température', 0, 2, false),
    maxTokens: optionalNumber(raw.maxTokens, 'La longueur maximale de la réponse', 1, 1_000_000, true),
    langfuseItemId,
  };
}

export interface LlmCall {
  config: LlmConfig;
  /** Secret de l'élément clé (`token`) et, pour LiteLLM, l'URL de base du proxy. */
  apiKey: string;
  baseUrl: string | null;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
}

export interface LlmResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  finishReason: string | null;
  /** Modèle qui a répondu, tel que rapporté par l'API. */
  model: string;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Motif court et sans secret d'un corps d'erreur de l'API. */
function apiError(provider: string, status: number, body: Buffer): AppError {
  let detail = '';
  try {
    const json = JSON.parse(body.toString('utf8')) as Json;
    const err = json.error as Json | string | undefined;
    detail = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : '';
  } catch {
    detail = body.toString('utf8').slice(0, 200);
  }
  return new AppError(`${provider} a répondu HTTP ${status}${detail ? ` : ${detail.slice(0, 500)}` : ''}`);
}

function parseBody(body: Buffer, provider: string): Json {
  try {
    return JSON.parse(body.toString('utf8')) as Json;
  } catch {
    throw new AppError(`Réponse illisible de ${provider}`);
  }
}

/** Appelle le modèle et renvoie sa réponse texte. Lève une `AppError` à tout échec. */
export async function callLlm(call: LlmCall): Promise<LlmResult> {
  const { config } = call;
  const common = { timeoutMs: call.timeoutMs, maxBytes: 16 * 1024 * 1024 };
  if (config.backend === 'anthropic') {
    const body: Json = { model: config.model, max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS, messages: [{ role: 'user', content: call.prompt }] };
    if (call.systemPrompt) body.system = call.systemPrompt;
    if (config.temperature !== null) body.temperature = Math.min(config.temperature, 1);
    const res = await safeRequest(new URL(ANTHROPIC_URL), { ...common, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': call.apiKey, 'anthropic-version': '2023-06-01', 'user-agent': 'Skipper agents' }, body: JSON.stringify(body) });
    if (res.status >= 400) throw apiError('Anthropic', res.status, res.body);
    const json = parseBody(res.body, 'Anthropic');
    const blocks = Array.isArray(json.content) ? (json.content as Json[]) : [];
    const usage = (json.usage ?? {}) as Json;
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join(''),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      costUsd: 0,
      finishReason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
      model: typeof json.model === 'string' ? json.model : config.model,
    };
  }

  // OpenAI et LiteLLM parlent la même API de complétions de conversation.
  const label = backendLabel(config.backend);
  const url = config.backend === 'openai' ? OPENAI_URL : `${(call.baseUrl ?? '').replace(/\/+$/, '')}/v1/chat/completions`;
  const messages = [...(call.systemPrompt ? [{ role: 'system', content: call.systemPrompt }] : []), { role: 'user', content: call.prompt }];
  const body: Json = { model: config.model, messages };
  if (config.temperature !== null) body.temperature = config.temperature;
  if (config.maxTokens !== null) body.max_tokens = config.maxTokens;
  const res = await safeRequest(new URL(url), { ...common, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${call.apiKey}`, 'user-agent': 'Skipper agents' }, body: JSON.stringify(body) });
  if (res.status >= 400) throw apiError(label, res.status, res.body);
  const json = parseBody(res.body, label);
  const choice = (Array.isArray(json.choices) ? (json.choices[0] as Json | undefined) : undefined) ?? {};
  const message = (choice.message ?? {}) as Json;
  const usage = (json.usage ?? {}) as Json;
  const cost = Number(res.headers.get('x-litellm-response-cost'));
  return {
    text: typeof message.content === 'string' ? message.content : '',
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    costUsd: Number.isFinite(cost) && cost > 0 ? cost : 0,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    model: typeof json.model === 'string' ? json.model : config.model,
  };
}

export interface LangfuseTrace {
  host: string;
  publicKey: string;
  secretKey: string;
  traceId: string;
  name: string;
  userId: string | null;
  metadata: Json;
  model: string;
  systemPrompt: string;
  prompt: string;
  output: string | null;
  error: string | null;
  startedAt: Date;
  endedAt: Date;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  modelParameters: Json;
}

/** Enregistre l'appel dans Langfuse (une trace et une génération). Renvoie un message d'erreur au lieu de lever : le traçage ne fait jamais échouer une exécution. */
export async function sendLangfuseTrace(t: LangfuseTrace): Promise<string | null> {
  const input = [...(t.systemPrompt ? [{ role: 'system', content: t.systemPrompt }] : []), { role: 'user', content: t.prompt }];
  const eventId = (suffix: string) => `${t.traceId}-${suffix}`;
  const batch = [
    { id: eventId('trace'), type: 'trace-create', timestamp: t.startedAt.toISOString(), body: { id: t.traceId, name: t.name, userId: t.userId ?? undefined, input, output: t.output ?? undefined, metadata: t.metadata, tags: ['skipper'] } },
    {
      id: eventId('generation'),
      type: 'generation-create',
      timestamp: t.startedAt.toISOString(),
      body: {
        id: eventId('gen'),
        traceId: t.traceId,
        name: t.name,
        model: t.model,
        modelParameters: t.modelParameters,
        input,
        output: t.output ?? undefined,
        startTime: t.startedAt.toISOString(),
        endTime: t.endedAt.toISOString(),
        level: t.error ? 'ERROR' : 'DEFAULT',
        statusMessage: t.error ?? undefined,
        usage: t.inputTokens !== null || t.outputTokens !== null ? { input: t.inputTokens ?? undefined, output: t.outputTokens ?? undefined, unit: 'TOKENS', totalCost: t.costUsd || undefined } : undefined,
      },
    },
  ];
  try {
    const res = await safeRequest(new URL(`${t.host.replace(/\/+$/, '')}/api/public/ingestion`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${t.publicKey}:${t.secretKey}`).toString('base64')}`, 'user-agent': 'Skipper agents' },
      body: JSON.stringify({ batch }),
      timeoutMs: 15_000,
    });
    // 207 : certains événements ont pu être refusés.
    if (res.status >= 400) return `Langfuse a répondu HTTP ${res.status}`;
    if (res.status === 207) {
      const errors = (parseBody(res.body, 'Langfuse').errors ?? []) as Json[];
      if (errors.length) return `Langfuse a refusé ${errors.length} événement(s)`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
