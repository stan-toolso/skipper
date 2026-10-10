import { AppError } from '../errors.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { startTaskSession } from '../tasks/launch.js';
import { vaultService } from '../vault/service.js';
import type { TokenService } from '../vault/tokens.js';
import type { LitellmSettings, LangfuseSettings, TokenSettings } from '../vault/types.js';
import { callLlm, LLM_PROVIDER, parseLlmConfig, sendLangfuseTrace, type LlmConfig, type LlmResult } from './llm.js';
import { agentRepository } from './repository.js';
import { agentService } from './service.js';
import { extractJson } from './template.js';
import type { Agent, AgentRun, RunTrigger } from './types.js';

export const HEARTBEAT_MS = 30_000;
/** Une exécution dont le battement a cet âge a été perdue avec son serveur. */
export const STALE_AFTER_MS = 3 * 60_000;
const END_GRACE_MS = 60_000;
const OUTPUT_MAX_CHARS = 200_000;

export interface RunAgentOptions {
  inputs?: Record<string, unknown> | null;
  trigger: RunTrigger;
  /** Personne dont les comptes servent à la session. */
  ownerId: string | null;
  workflowRunId?: string | null;
  nodeKey?: string | null;
  /** Remplace le délai de l'agent (un nœud de workflow peut fixer le sien). */
  timeoutMinutes?: number | null;
  /** Appelé à chaque changement d'état (le moteur de workflow les journalise). */
  onUpdate?: (run: AgentRun) => void;
  /** Tâche que l'agent résout : sa session travaille dans un worktree dédié, la tâche lui est assignée, et la session reste ouverte après le tour (un humain prend le relais). */
  taskId?: string | null;
}

export interface AgentOutcome {
  run: AgentRun;
  session: Session | null;
}

const isActive = (run: AgentRun) => run.status === 'pending' || run.status === 'running';

/** La réponse de l'agent : le résultat de son dernier tour, ou la sortie du shell pour le type shell. */
export async function collectOutput(session: Session): Promise<{ output: string; error: string | null }> {
  const result = await sessionRepository.findLastEvent(session.id, ['claude.result']);
  if (result) {
    const payload = result.payload;
    const text = typeof payload.result === 'string' ? payload.result : '';
    const error = payload.is_error ? (Array.isArray(payload.errors) && payload.errors.length ? payload.errors.join(' ; ') : String(payload.subtype ?? 'erreur')) : null;
    return { output: text.slice(0, OUTPUT_MAX_CHARS), error };
  }
  if (session.provider === 'shell') {
    const events = await sessionRepository.listEvents(session.id, { limit: 5000 });
    const output = events
      .filter((e) => e.type === 'stdout')
      .map((e) => String(e.payload.text ?? ''))
      .join('\n');
    return { output: output.slice(0, OUTPUT_MAX_CHARS), error: null };
  }
  return { output: '', error: null };
}

/** Attend la fin du tour de la session (ou sa fin), en battant le cœur de l'exécution entre-temps. */
async function waitForTurn(runId: string, sessionId: string, timeoutMs: number): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return (await sessionService.get(sessionId)) ?? (await sessionService.waitForIdle(sessionId, 1));
    const session = await sessionService.waitForIdle(sessionId, Math.min(remaining, HEARTBEAT_MS));
    const run = await agentRepository.findRun(runId);
    // Annulée depuis l'interface : la session a été arrêtée, l'appelant verra l'exécution annulée.
    if (!run || !isActive(run)) return session;
    const settled = (session.status !== 'running' && session.status !== 'queued') || session.activity === 'idle';
    if (settled) return session;
    await agentRepository.updateRun(runId, { heartbeatAt: new Date() });
  }
}

/** Marque l'exécution terminée, sauf si elle a été annulée entre-temps ; renvoie l'exécution finale. */
async function finish(runId: string, patch: { status: 'succeeded' | 'failed'; output?: string | null; outputJson?: unknown | null; error?: string | null; costUsd: number; startedAt: Date | null }): Promise<AgentRun> {
  const current = await agentRepository.findRun(runId);
  if (!current) throw new AppError('Exécution introuvable', 'NOT_FOUND');
  if (!isActive(current)) return current;
  const finishedAt = new Date();
  const updated = await agentRepository.updateRun(runId, {
    status: patch.status,
    output: patch.output ?? null,
    outputJson: patch.outputJson ?? null,
    error: patch.error ?? null,
    costUsd: patch.costUsd,
    durationMs: patch.startedAt ? finishedAt.getTime() - patch.startedAt.getTime() : null,
    finishedAt,
    heartbeatAt: finishedAt,
  });
  return updated ?? current;
}

/** Enregistre une exécution sur le point de démarrer : l'instruction est rendue (défauts appliqués, obligatoires vérifiées). Une exécution impossible à rendre est enregistrée en échec, visible dans l'historique. */
async function prepareRun(agent: Agent, options: RunAgentOptions): Promise<AgentRun> {
  const base = { agentId: agent.id, projectId: agent.projectId, ownerId: options.ownerId, trigger: options.trigger, workflowRunId: options.workflowRunId, nodeKey: options.nodeKey };
  try {
    const { inputs, prompt } = agentService.renderPrompt(agent, options.inputs);
    const run = await agentRepository.createRun({ ...base, inputs, prompt });
    options.onUpdate?.(run);
    return run;
  } catch (err) {
    const run = await agentRepository.createRun({ ...base, inputs: options.inputs ?? {}, prompt: '' });
    const failed = await finish(run.id, { status: 'failed', error: (err as Error).message, costUsd: 0, startedAt: null });
    options.onUpdate?.(failed);
    return failed;
  }
}

/** Clé en clair (et adresse du proxy pour LiteLLM) de l'élément du coffre que nomme un agent `llm`, au nom du propriétaire de l'exécution. */
async function resolveLlmKey(config: LlmConfig, ownerId: string, agent: Agent, run: AgentRun): Promise<{ apiKey: string; baseUrl: string | null }> {
  const actor = { userId: ownerId, projectId: agent.projectId, purpose: `Agent « ${agent.name} », exécution ${run.id}` };
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
async function traceInLangfuse(config: LlmConfig, ownerId: string, agent: Agent, run: AgentRun, call: { startedAt: Date; result: LlmResult | null; error: string | null }): Promise<void> {
  if (!config.langfuseItemId) return;
  try {
    const { item, secrets } = await vaultService.useItem(ownerId, config.langfuseItemId, ['langfuse'], { userId: ownerId, projectId: agent.projectId, purpose: `Trace de l'agent « ${agent.name} », exécution ${run.id}` });
    const settings = item.settings as LangfuseSettings;
    const problem = await sendLangfuseTrace({
      host: settings.host,
      publicKey: settings.publicKey,
      secretKey: secrets.secretKey ?? '',
      traceId: run.id,
      name: agent.name,
      userId: ownerId,
      metadata: { agentId: agent.id, projectId: agent.projectId, trigger: run.trigger, backend: config.backend, workflowRunId: run.workflowRunId, nodeKey: run.nodeKey },
      model: call.result?.model ?? config.model,
      systemPrompt: agent.systemPrompt.trim(),
      prompt: run.prompt,
      output: call.result?.text ?? null,
      error: call.error,
      startedAt: call.startedAt,
      endedAt: new Date(),
      inputTokens: call.result?.inputTokens ?? null,
      outputTokens: call.result?.outputTokens ?? null,
      costUsd: call.result?.costUsd ?? 0,
      modelParameters: { temperature: config.temperature, maxTokens: config.maxTokens },
    });
    if (problem) console.warn(`[agents] trace Langfuse non enregistrée (${agent.name}, ${run.id}) : ${problem}`);
  } catch (err) {
    console.warn(`[agents] trace Langfuse non enregistrée (${agent.name}, ${run.id}) : ${(err as Error).message}`);
  }
}

/** Exécute une exécution qui appelle le modèle directement : pas de session, une requête, sa réponse est la sortie. */
async function executeLlmRun(agent: Agent, prepared: AgentRun, options: RunAgentOptions): Promise<AgentOutcome> {
  const timeoutMs = (options.timeoutMinutes ?? agent.timeoutMinutes) * 60_000;
  const startedAt = new Date();
  let run = prepared;
  const fail = async (message: string): Promise<AgentOutcome> => {
    const failed = await finish(run.id, { status: 'failed', error: message, costUsd: 0, startedAt });
    options.onUpdate?.(failed);
    return { run: failed, session: null };
  };
  run = (await agentRepository.updateRun(run.id, { status: 'running', startedAt, heartbeatAt: new Date() })) ?? run;
  options.onUpdate?.(run);

  let config: LlmConfig;
  let key: { apiKey: string; baseUrl: string | null };
  try {
    if (!options.ownerId) throw new AppError("Cette exécution n'a pas de personne dont utiliser les clés du coffre : réglez la planification à nouveau depuis votre compte");
    config = parseLlmConfig(agent.config);
    key = await resolveLlmKey(config, options.ownerId, agent, run);
  } catch (err) {
    return fail((err as Error).message);
  }

  const heartbeat = setInterval(() => void agentRepository.updateRun(run.id, { heartbeatAt: new Date() }).catch(() => undefined), HEARTBEAT_MS);
  let result: LlmResult | null = null;
  let callError: string | null = null;
  try {
    result = await callLlm({ config, apiKey: key.apiKey, baseUrl: key.baseUrl, systemPrompt: agent.systemPrompt.trim(), prompt: run.prompt, timeoutMs });
  } catch (err) {
    callError = (err as Error).message;
  } finally {
    clearInterval(heartbeat);
  }
  await traceInLangfuse(config, options.ownerId!, agent, run, { startedAt, result, error: callError });

  const latest = await agentRepository.findRun(run.id);
  if (latest && !isActive(latest)) {
    // Annulée pendant que le modèle répondait.
    options.onUpdate?.(latest);
    return { run: latest, session: null };
  }
  if (!result) return fail(callError ?? "Le modèle n'a pas répondu");
  const output = result.text.slice(0, OUTPUT_MAX_CHARS);
  let outputJson: unknown | null = null;
  let error: string | null = null;
  if (!output.trim()) error = result.finishReason === 'length' || result.finishReason === 'max_tokens' ? 'Le modèle a épuisé ses jetons avant de répondre : augmentez la longueur maximale de la réponse' : "Le modèle n'a rien répondu";
  else if (agent.outputFormat === 'json') {
    outputJson = extractJson(output);
    if (outputJson === null) error = "L'agent n'a pas répondu avec un objet JSON";
  }
  const finished = await finish(run.id, { status: error ? 'failed' : 'succeeded', output, outputJson, error, costUsd: result.costUsd, startedAt });
  options.onUpdate?.(finished);
  return { run: finished, session: null };
}

/**
 * Exécute une exécution préparée : une session dédiée est créée avec l'instruction rendue, démarrée, attendue
 * jusqu'à la fin du tour de l'agent (ou du délai), sa réponse lue (parsée quand du JSON est attendu), puis la
 * session est terminée — sauf quand l'agent résout une tâche : sa session (dans le worktree de la tâche) reste
 * ouverte pour l'humain qui prend le relais. Ne lève jamais pour un échec de l'agent : le statut et l'erreur
 * de l'exécution disent ce qui s'est passé.
 */
async function executeRun(agent: Agent, prepared: AgentRun, options: RunAgentOptions): Promise<AgentOutcome> {
  if (agent.provider === LLM_PROVIDER) return executeLlmRun(agent, prepared, options);
  let run = prepared;
  const timeoutMs = (options.timeoutMinutes ?? agent.timeoutMinutes) * 60_000;
  let session: Session | null = null;
  const startedAt = new Date();
  const keepSession = Boolean(options.taskId);
  try {
    session = options.taskId
      ? await startTaskSession(options.taskId, { ownerId: options.ownerId, provider: agent.provider, config: agent.config, instructions: run.prompt, agentId: agent.id, agentRunId: run.id, workflowRunId: options.workflowRunId ?? null, autoStart: false })
      : await sessionService.create({
          projectId: agent.projectId,
          worktreeId: agent.worktreeId,
          name: `${agent.name} · ${startedAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          provider: agent.provider,
          prompt: run.prompt,
          config: agent.config,
          ownerId: options.ownerId,
          agentId: agent.id,
          agentRunId: run.id,
          workflowRunId: options.workflowRunId ?? null,
          autoStart: false,
        });
    run = (await agentRepository.updateRun(run.id, { sessionId: session.id, status: 'running', startedAt, heartbeatAt: new Date() })) ?? run;
    options.onUpdate?.(run);
    await sessionService.start(session.id);
  } catch (err) {
    const failed = await finish(run.id, { status: 'failed', error: (err as Error).message, costUsd: 0, startedAt });
    if (session) void sessionService.stop(session.id).catch(() => undefined);
    options.onUpdate?.(failed);
    return { run: failed, session };
  }

  let current = await waitForTurn(run.id, session.id, timeoutMs);
  const latest = await agentRepository.findRun(run.id);
  if (latest && !isActive(latest)) {
    options.onUpdate?.(latest);
    return { run: latest, session: current };
  }
  const stillBusy = (current.status === 'running' && current.activity !== 'idle') || current.status === 'queued';
  if (stillBusy && keepSession) {
    // La tâche reste avec sa session : un humain prend le relais.
    const failed = await finish(run.id, { status: 'failed', error: `Encore au travail après ${Math.round(timeoutMs / 60_000)} min : la session reste ouverte`, costUsd: current.costUsd, startedAt });
    options.onUpdate?.(failed);
    return { run: failed, session: current };
  }
  if (stillBusy) {
    await sessionService.stop(session.id).catch(() => undefined);
    current = (await sessionService.get(session.id)) ?? current;
    const failed = await finish(run.id, { status: 'failed', error: `Délai dépassé après ${Math.round(timeoutMs / 60_000)} min : l'agent travaillait encore`, costUsd: current.costUsd, startedAt });
    options.onUpdate?.(failed);
    return { run: failed, session: current };
  }

  const { output, error: resultError } = await collectOutput(current);
  const error = resultError ?? (current.status === 'failed' ? (current.error ?? 'La session a échoué') : current.status === 'stopped' || current.status === 'interrupted' ? `La session a été ${current.status === 'stopped' ? 'arrêtée' : 'interrompue'}` : null);
  if (current.status === 'running' && !keepSession) {
    await sessionService.end(session.id).catch((err) => console.warn(`[agents] fin de la session ${session?.id} impossible : ${(err as Error).message}`));
    current = await sessionService.waitForIdle(session.id, END_GRACE_MS).catch(() => current);
  }
  let outputJson: unknown | null = null;
  let formatError: string | null = null;
  if (!error && agent.outputFormat === 'json') {
    outputJson = extractJson(output);
    if (outputJson === null) formatError = "L'agent n'a pas répondu avec un objet JSON";
  }
  const finalError = error ?? formatError;
  const finished = await finish(run.id, { status: finalError ? 'failed' : 'succeeded', output, outputJson, error: finalError, costUsd: current.costUsd, startedAt });
  options.onUpdate?.(finished);
  return { run: finished, session: current };
}

/** Exécute un agent une fois, jusqu'au bout (le moteur de workflow l'attend). */
export async function runAgent(agent: Agent, options: RunAgentOptions): Promise<AgentOutcome> {
  const run = await prepareRun(agent, options);
  return isActive(run) ? executeRun(agent, run, options) : { run, session: null };
}

/** Lance une exécution en tâche de fond (manuelle, test ou planifiée) et la renvoie aussitôt ; notifie à la fin. */
export async function startAgentRun(agent: Agent, options: Omit<RunAgentOptions, 'onUpdate'>): Promise<AgentRun> {
  const run = await prepareRun(agent, options);
  if (!isActive(run)) {
    await notifyOutcome(agent, run);
    return run;
  }
  void executeRun(agent, run, options)
    .then((outcome) => notifyOutcome(agent, outcome.run))
    .catch((err) => console.error(`[agents] exécution ${run.id} de ${agent.name}`, err));
  return run;
}

const fmtCost = (usd: number) => `${usd.toFixed(usd < 0.1 ? 3 : 2).replace('.', ',')} $`;

async function notifyOutcome(agent: Agent, run: AgentRun): Promise<void> {
  if (run.trigger === 'workflow') return;
  const project = await projectService.get(agent.projectId).catch(() => null);
  const details = [run.durationMs !== null ? `${Math.round(run.durationMs / 1000)} s` : null, fmtCost(run.costUsd), project?.name ?? null].filter(Boolean).join(' · ');
  if (run.trigger === 'schedule') await agentRepository.setLastResult(agent.id, run.status === 'succeeded' ? `Terminée · ${details}` : `${run.status === 'cancelled' ? 'Annulée' : `Erreur : ${run.error ?? 'échec'}`} · ${details}`);
  if (run.status === 'cancelled') return;
  void notificationService.notify({
    type: run.status === 'succeeded' ? 'agent.run' : 'agent.failed',
    title: run.status === 'succeeded' ? `Agent « ${agent.name} » terminé` : `Agent « ${agent.name} » en erreur`,
    message: run.status === 'succeeded' ? details : `${run.error ?? 'échec'} · ${details}`,
    link: `/agents/${agent.id}?run=${run.id}`,
    projectId: agent.projectId,
    sessionId: run.sessionId,
    userId: run.ownerId,
    payload: { agentId: agent.id, runId: run.id, costUsd: run.costUsd },
  });
}

/** Annule une exécution active : marquée annulée, sa session arrêtée. */
export async function cancelAgentRun(id: string): Promise<AgentRun> {
  const run = await agentRepository.findRun(id);
  if (!run) throw new AppError('Exécution introuvable', 'NOT_FOUND');
  if (!isActive(run)) return run;
  const finishedAt = new Date();
  const updated = (await agentRepository.updateRun(id, { status: 'cancelled', finishedAt, durationMs: run.startedAt ? finishedAt.getTime() - run.startedAt.getTime() : null, heartbeatAt: finishedAt })) ?? run;
  if (run.sessionId) await sessionService.stop(run.sessionId).catch((err) => console.warn(`[agents] arrêt de la session ${run.sessionId} impossible : ${(err as Error).message}`));
  return updated;
}

/** Les exécutions perdues par un serveur arrêté (battement périmé) passent en échec ; renvoie leur nombre. */
export async function failStaleAgentRuns(now = new Date()): Promise<number> {
  const stale = await agentRepository.listStale(new Date(now.getTime() - STALE_AFTER_MS));
  for (const run of stale) {
    await agentRepository.updateRun(run.id, { status: 'failed', error: "Perdue : le serveur s'est arrêté pendant l'exécution", finishedAt: now, heartbeatAt: now });
    if (run.sessionId) void sessionService.stop(run.sessionId).catch(() => undefined);
  }
  return stale.length;
}
