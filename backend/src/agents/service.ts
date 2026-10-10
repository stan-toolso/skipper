import { AppError, NotFoundError } from '../errors.js';
import { projectService } from '../projects/service.js';
import { CronError, isValidTimeZone, nextRun, parseCron } from '../schedules/cron.js';
import { getProvider } from '../sessions/providers/registry.js';
import type { Session } from '../sessions/types.js';
import { worktreeService } from '../worktrees/service.js';
import { LLM_PROVIDER, parseLlmConfig } from './llm.js';
import { agentRepository, type AgentValues } from './repository.js';
import { placeholders, render } from './template.js';
import type { Agent, AgentInput, AutomationScheduleInput, InputVariable } from './types.js';

const DEFAULT_TIMEZONE = 'UTC';
const MAX_TIMEOUT_MINUTES = 24 * 60;
const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Assainit les variables déclarées d'un agent ou d'un déclencheur de workflow : clés uniques, en forme d'identifiant. */
export function normalizeInputs(raw: InputVariable[] | null | undefined): InputVariable[] {
  const seen = new Set<string>();
  const out: InputVariable[] = [];
  for (const v of raw ?? []) {
    const key = String(v.key ?? '').trim();
    if (!key) continue;
    if (!KEY_PATTERN.test(key)) throw new AppError(`Nom de variable invalide « ${key} » : lettres, chiffres et soulignés seulement, sans commencer par un chiffre`);
    if (seen.has(key)) throw new AppError(`La variable « ${key} » est déclarée deux fois`);
    seen.add(key);
    out.push({ key, label: String(v.label ?? '').trim() || key, description: v.description?.trim() || null, required: Boolean(v.required), defaultValue: v.defaultValue == null || v.defaultValue === '' ? null : String(v.defaultValue) });
  }
  return out;
}

/**
 * Valeurs des variables déclarées pour une exécution : les valeurs données, sinon les défauts ; une
 * variable obligatoire manquante est refusée. Les clés inconnues sont gardées (un workflow peut passer
 * plus que ce que l'agent déclare).
 */
export function resolveInputs(declared: InputVariable[], given: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(given ?? {}) };
  const missing: string[] = [];
  for (const v of declared) {
    const value = out[v.key];
    if (value === undefined || value === null || value === '') {
      if (v.defaultValue !== null) out[v.key] = v.defaultValue;
      else if (v.required) missing.push(v.label || v.key);
      else out[v.key] = '';
    }
  }
  if (missing.length) throw new AppError(`Variable${missing.length > 1 ? 's' : ''} obligatoire${missing.length > 1 ? 's' : ''} manquante${missing.length > 1 ? 's' : ''} : ${missing.join(', ')}`);
  return out;
}

export function parseCronOrThrow(cron: string) {
  try {
    return parseCron(cron);
  } catch (err) {
    if (err instanceof CronError) throw new AppError(err.message);
    throw err;
  }
}

/** Valide une planification et calcule sa première échéance. Partagé par les agents et les workflows. */
export function prepareSchedule(input: AutomationScheduleInput): { cron: string; timezone: string; enabled: boolean; nextRunAt: Date | null } {
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) throw new AppError(`Fuseau horaire inconnu : ${timezone}`);
  const spec = parseCronOrThrow(input.cron);
  const enabled = input.enabled ?? true;
  return { cron: spec.source, timezone, enabled, nextRunAt: enabled ? nextRun(spec, new Date(), timezone) : null };
}

/** L'instruction réellement envoyée à l'agent : le modèle rendu, plus le format de réponse quand du JSON est attendu (pas pour une commande shell, dont la sortie est lue telle quelle). */
export function buildPrompt(agent: Pick<Agent, 'provider' | 'promptTemplate' | 'outputFormat' | 'outputSchema'>, inputs: Record<string, unknown>): string {
  const body = render(agent.promptTemplate, { input: inputs }).trim();
  if (agent.outputFormat !== 'json' || agent.provider === 'shell') return body;
  const format = ['Format de réponse : réponds avec un seul objet JSON et rien d\'autre — pas de texte avant ou après, pas de bloc de code.', agent.outputSchema?.trim() ? `Forme attendue :\n${agent.outputSchema.trim()}` : null].filter(Boolean).join('\n');
  return body ? `${body}\n\n---\n${format}` : format;
}

async function validate(projectId: string, input: AgentInput, current?: Agent): Promise<AgentValues> {
  const name = (input.name ?? current?.name ?? '').trim();
  if (!name) throw new AppError("Le nom de l'agent est obligatoire");
  const provider = input.provider ?? current?.provider ?? LLM_PROVIDER;
  let config = { ...(input.config ?? current?.config ?? {}) };
  for (const key of Object.keys(config)) if (config[key] === '' || config[key] === null) delete config[key];
  // Un agent `llm` appelle un modèle directement ; les autres fournisseurs sont des sessions.
  if (provider === LLM_PROVIDER) {
    const llm = parseLlmConfig(config);
    config = { backend: llm.backend, keyItemId: llm.keyItemId, model: llm.model, ...(llm.temperature !== null && { temperature: llm.temperature }), ...(llm.maxTokens !== null && { maxTokens: llm.maxTokens }), ...(llm.langfuseItemId && { langfuseItemId: llm.langfuseItemId }) };
  } else getProvider(provider).validateConfig?.(config);
  const outputFormat = input.outputFormat ?? current?.outputFormat ?? 'text';
  if (outputFormat !== 'text' && outputFormat !== 'json') throw new AppError(`Format de sortie invalide : ${String(outputFormat)}`);
  const timeoutMinutes = input.timeoutMinutes ?? current?.timeoutMinutes ?? 60;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > MAX_TIMEOUT_MINUTES) throw new AppError(`Le délai doit être entre 1 et ${MAX_TIMEOUT_MINUTES} minutes`);
  const worktreeId = provider === LLM_PROVIDER ? null : input.worktreeId === undefined ? (current?.worktreeId ?? null) : input.worktreeId;
  if (worktreeId) {
    const worktree = await worktreeService.get(worktreeId);
    if (worktree.projectId !== projectId) throw new AppError('Ce worktree appartient à un autre projet');
  }
  const inputs = input.inputs === undefined ? (current?.inputs ?? []) : normalizeInputs(input.inputs);
  const promptTemplate = input.promptTemplate ?? current?.promptTemplate ?? '';
  const declared = new Set(inputs.map((v) => v.key));
  for (const path of placeholders(promptTemplate)) {
    const key = path.startsWith('input.') ? path.slice(6).split('.')[0] : path.includes('.') ? null : path;
    if (key && !declared.has(key)) throw new AppError(`Le modèle d'instruction utilise {{${path}}} mais aucune variable « ${key} » n'est déclarée`);
  }
  return {
    name,
    description: (input.description ?? current?.description ?? '').trim(),
    provider,
    config,
    systemPrompt: input.systemPrompt ?? current?.systemPrompt ?? '',
    promptTemplate,
    inputs,
    outputFormat,
    outputSchema: outputFormat === 'json' ? (input.outputSchema === undefined ? (current?.outputSchema ?? null) : input.outputSchema?.trim() || null) : null,
    worktreeId,
    timeoutMinutes,
  };
}

export const agentService = {
  list: (filter?: { projectId?: string; projectIds?: string[] }) => agentRepository.list(filter),
  find: (id: string) => agentRepository.findById(id),

  async get(id: string): Promise<Agent> {
    const agent = await agentRepository.findById(id);
    if (!agent) throw new NotFoundError('Agent introuvable');
    return agent;
  },

  async create(projectId: string, input: AgentInput, userId: string | null): Promise<Agent> {
    await projectService.get(projectId);
    return agentRepository.create(projectId, await validate(projectId, input), userId);
  },

  async update(id: string, input: AgentInput): Promise<Agent> {
    const current = await this.get(id);
    const updated = await agentRepository.update(id, await validate(current.projectId, input, current));
    if (!updated) throw new NotFoundError('Agent introuvable');
    return updated;
  },

  async delete(id: string): Promise<boolean> {
    await this.get(id);
    return agentRepository.delete(id);
  },

  /** Aperçu de l'instruction qu'un agent recevrait avec ces entrées (défauts appliqués, obligatoires vérifiées). */
  renderPrompt(agent: Agent, inputs: Record<string, unknown> | null | undefined): { inputs: Record<string, unknown>; prompt: string } {
    const resolved = resolveInputs(agent.inputs, inputs);
    return { inputs: resolved, prompt: buildPrompt(agent, resolved) };
  },

  async setSchedule(id: string, input: AutomationScheduleInput, inputs: Record<string, unknown> | null | undefined, userId: string | null): Promise<Agent> {
    const agent = await this.get(id);
    const schedule = prepareSchedule(input);
    // Les entrées planifiées doivent être complètes maintenant : personne ne les remplira à l'échéance.
    const resolved = resolveInputs(agent.inputs, inputs);
    const updated = await agentRepository.setSchedule(id, { ...schedule, inputs: resolved, ownerId: userId });
    if (!updated) throw new NotFoundError('Agent introuvable');
    return updated;
  },

  async clearSchedule(id: string): Promise<Agent> {
    const agent = await this.get(id);
    const updated = await agentRepository.setSchedule(id, { cron: null, timezone: agent.schedule?.timezone ?? DEFAULT_TIMEZONE, enabled: false, inputs: {}, ownerId: null, nextRunAt: null });
    if (!updated) throw new NotFoundError('Agent introuvable');
    return updated;
  },

  /** Rôle et consignes de l'agent d'une session (après le prompt système du projet) ; null pour une session sans agent. */
  async systemPromptFor(session: Pick<Session, 'agentId'>): Promise<string | null> {
    if (!session.agentId) return null;
    const agent = await agentRepository.findById(session.agentId);
    return agent?.systemPrompt.trim() || null;
  },
};
