import { AppError } from '../errors.js';
import { vaultService } from '../vault/service.js';
import type { TokenService } from '../vault/tokens.js';
import type { LangfuseSettings, LitellmSettings, TokenSettings } from '../vault/types.js';
import { callLlm, parseLlmConfig, sendLangfuseTrace, type LlmConfig, type LlmResult } from './llm.js';
import { extractJson } from './template.js';
import type { LlmOutputFormat } from './types.js';

/**
 * Exécution d'un nœud « appel de modèle » : la clé du coffre est résolue au nom du propriétaire de
 * l'exécution, le modèle appelé une fois avec le prompt système et l'instruction rendus, la réponse lue
 * (parsée quand du JSON est attendu) et tracée dans Langfuse le cas échéant. Ne lève jamais : `error`
 * dit ce qui s'est passé.
 */

const OUTPUT_MAX_CHARS = 200_000;

export interface LlmCallRequest {
  projectId: string;
  /** Personne dont les clés du coffre servent à l'appel. */
  ownerId: string | null;
  /** Exécution et nœud, pour le journal du coffre et la trace Langfuse. */
  runId: string;
  nodeKey: string;
  nodeLabel: string;
  workflowName: string;
  config: Record<string, unknown> | null | undefined;
  systemPrompt: string;
  prompt: string;
  outputFormat: LlmOutputFormat;
  outputSchema: string | null;
  timeoutMs: number;
}

export interface LlmCallOutcome {
  output: string;
  json: unknown | null;
  error: string | null;
  costUsd: number;
  /** Modèle qui a répondu, tel que rapporté par l'API. */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** L'instruction réellement envoyée : le modèle rendu, plus le format de réponse quand du JSON est attendu. */
export function buildLlmPrompt(prompt: string, outputFormat: LlmOutputFormat, outputSchema: string | null): string {
  const body = prompt.trim();
  if (outputFormat !== 'json') return body;
  const format = ["Format de réponse : réponds avec un seul objet JSON et rien d'autre — pas de texte avant ou après, pas de bloc de code.", outputSchema?.trim() ? `Forme attendue :\n${outputSchema.trim()}` : null].filter(Boolean).join('\n');
  return body ? `${body}\n\n---\n${format}` : format;
}

/** Clé en clair (et adresse du proxy pour LiteLLM) de l'élément du coffre que nomme le nœud, au nom du propriétaire de l'exécution. */
async function resolveLlmKey(config: LlmConfig, ownerId: string, req: LlmCallRequest): Promise<{ apiKey: string; baseUrl: string | null }> {
  const actor = { userId: ownerId, projectId: req.projectId, purpose: `Workflow « ${req.workflowName} », nœud « ${req.nodeLabel} », exécution ${req.runId}` };
  if (config.backend === 'litellm') {
    const { item, secrets } = await vaultService.useItem(ownerId, config.keyItemId, ['litellm'], actor);
    if (!secrets.token) throw new AppError(`« ${item.name} » n'a pas de clé`);
    return { apiKey: secrets.token, baseUrl: (item.settings as LitellmSettings).baseUrl };
  }
  const service: TokenService = config.backend;
  const { item, secrets } = await vaultService.useItem(ownerId, config.keyItemId, ['token'], actor);
  if ((item.settings as TokenSettings).service !== service) throw new AppError(`« ${item.name} » n'est pas une clé ${service === 'openai' ? 'OpenAI' : 'Anthropic'}`);
  if (!secrets.token) throw new AppError(`« ${item.name} » n'a pas de clé`);
  return { apiKey: secrets.token, baseUrl: null };
}

/** Trace un appel terminé dans Langfuse ; un échec est journalisé, jamais levé. */
async function traceInLangfuse(config: LlmConfig, ownerId: string, req: LlmCallRequest, prompt: string, call: { startedAt: Date; result: LlmResult | null; error: string | null }): Promise<void> {
  if (!config.langfuseItemId) return;
  const where = `${req.workflowName} / ${req.nodeLabel}, ${req.runId}`;
  try {
    const { item, secrets } = await vaultService.useItem(ownerId, config.langfuseItemId, ['langfuse'], { userId: ownerId, projectId: req.projectId, purpose: `Trace du workflow « ${req.workflowName} », nœud « ${req.nodeLabel} », exécution ${req.runId}` });
    const settings = item.settings as LangfuseSettings;
    const problem = await sendLangfuseTrace({
      host: settings.host,
      publicKey: settings.publicKey,
      secretKey: secrets.secretKey ?? '',
      traceId: `${req.runId}-${req.nodeKey}`,
      name: `${req.workflowName} / ${req.nodeLabel}`,
      userId: ownerId,
      metadata: { projectId: req.projectId, workflowRunId: req.runId, nodeKey: req.nodeKey, backend: config.backend },
      model: call.result?.model ?? config.model,
      systemPrompt: req.systemPrompt.trim(),
      prompt,
      output: call.result?.text ?? null,
      error: call.error,
      startedAt: call.startedAt,
      endedAt: new Date(),
      inputTokens: call.result?.inputTokens ?? null,
      outputTokens: call.result?.outputTokens ?? null,
      costUsd: call.result?.costUsd ?? 0,
      modelParameters: { temperature: config.temperature, maxTokens: config.maxTokens },
    });
    if (problem) console.warn(`[workflows] trace Langfuse non enregistrée (${where}) : ${problem}`);
  } catch (err) {
    console.warn(`[workflows] trace Langfuse non enregistrée (${where}) : ${(err as Error).message}`);
  }
}

/** Appelle le modèle d'un nœud une fois et renvoie sa réponse ; `error` est renseignée à tout échec (configuration, clé, API, réponse vide ou non JSON). */
export async function runLlmCall(req: LlmCallRequest): Promise<LlmCallOutcome> {
  const empty = (error: string): LlmCallOutcome => ({ output: '', json: null, error, costUsd: 0, model: null, inputTokens: null, outputTokens: null });
  let config: LlmConfig;
  let key: { apiKey: string; baseUrl: string | null };
  try {
    if (!req.ownerId) throw new AppError("Cette exécution n'a pas de personne dont utiliser les clés du coffre : enregistrez le workflow ou sa planification à nouveau depuis votre compte");
    config = parseLlmConfig(req.config ?? {});
    key = await resolveLlmKey(config, req.ownerId, req);
  } catch (err) {
    return empty((err as Error).message);
  }
  const prompt = buildLlmPrompt(req.prompt, req.outputFormat, req.outputSchema);
  const startedAt = new Date();
  let result: LlmResult | null = null;
  let callError: string | null = null;
  try {
    result = await callLlm({ config, apiKey: key.apiKey, baseUrl: key.baseUrl, systemPrompt: req.systemPrompt.trim(), prompt, timeoutMs: req.timeoutMs });
  } catch (err) {
    callError = (err as Error).message;
  }
  await traceInLangfuse(config, req.ownerId, req, prompt, { startedAt, result, error: callError });
  if (!result) return empty(callError ?? "Le modèle n'a pas répondu");

  const output = result.text.slice(0, OUTPUT_MAX_CHARS);
  let json: unknown | null = null;
  let error: string | null = null;
  if (!output.trim()) error = result.finishReason === 'length' || result.finishReason === 'max_tokens' ? 'Le modèle a épuisé ses jetons avant de répondre : augmentez la longueur maximale de la réponse' : "Le modèle n'a rien répondu";
  else if (req.outputFormat === 'json') {
    json = extractJson(output);
    if (json === null) error = "Le modèle n'a pas répondu avec un objet JSON";
  }
  return { output, json, error, costUsd: result.costUsd, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
