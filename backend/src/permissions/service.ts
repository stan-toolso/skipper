import { AppError, NotFoundError } from '../errors.js';
import { permissionRuleRepository } from './repository.js';
import { formatRule, type PermissionRule } from './types.js';

/** Forme minimale d'une suggestion de règle du SDK (PermissionUpdate de type addRules). */
interface RuleSuggestion {
  type?: string;
  behavior?: string;
  rules?: Array<{ toolName?: string; ruleContent?: string | null }>;
}

const TOOL_RE = /^[A-Za-z0-9_:.-]+$/;

/**
 * Autorisations mémorisées par projet : répondre « ne plus demander dans ce projet » enregistre les
 * règles suggérées par le SDK ; chaque nouvelle session du projet les reçoit dans `allowedTools`.
 */
export const permissionRuleService = {
  list: (projectId: string) => permissionRuleRepository.list(projectId),

  async get(id: string): Promise<PermissionRule> {
    const rule = await permissionRuleRepository.findById(id);
    if (!rule) throw new NotFoundError('Règle introuvable');
    return rule;
  },

  /** Règles du projet au format `allowedTools` de Claude Code. */
  async allowedToolsFor(projectId: string): Promise<string[]> {
    return (await permissionRuleRepository.list(projectId)).map(formatRule);
  },

  async add(projectId: string, toolName: string, ruleContent: string | null, sessionId: string | null = null): Promise<PermissionRule> {
    const tool = toolName.trim();
    if (!TOOL_RE.test(tool)) throw new AppError(`Nom d'outil invalide : ${toolName}`);
    const content = ruleContent?.trim() || null;
    return permissionRuleRepository.upsert(projectId, tool, content, sessionId);
  },

  /** Enregistre les règles « allow » contenues dans les suggestions du SDK ; renvoie les règles ajoutées. */
  async addFromSuggestions(projectId: string, suggestions: unknown[], sessionId: string | null): Promise<PermissionRule[]> {
    const added: PermissionRule[] = [];
    for (const s of suggestions as RuleSuggestion[]) {
      if (s?.type !== 'addRules' || (s.behavior ?? 'allow') !== 'allow') continue;
      for (const r of s.rules ?? []) {
        if (!r.toolName) continue;
        added.push(await this.add(projectId, r.toolName, r.ruleContent ?? null, sessionId));
      }
    }
    return added;
  },

  async remove(id: string): Promise<boolean> {
    await this.get(id);
    return permissionRuleRepository.delete(id);
  },
};
