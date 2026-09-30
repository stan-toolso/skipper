import { AppError, NotFoundError } from '../errors.js';
import { permissionRuleRepository } from './repository.js';
import { formatRule, type PermissionRule } from './types.js';

/** Forme minimale d'une suggestion du SDK (PermissionUpdate) : règles (addRules) ou changement de mode (setMode). */
interface RuleSuggestion {
  type?: string;
  behavior?: string;
  rules?: Array<{ toolName?: string; ruleContent?: string | null }>;
  mode?: string;
}

const TOOL_RE = /^[A-Za-z0-9_:.-]+$/;

/**
 * Outils de modification de fichiers. Pour eux, le SDK ne suggère pas de règle mais le mode `acceptEdits`
 * de la session ; mémoriser « pour le projet » revient à autoriser ces outils dans `allowedTools`.
 */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Mode d'autorisation demandé par une suggestion `setMode` (null s'il n'y en a pas). */
export function suggestedMode(suggestions: unknown[]): string | null {
  for (const s of suggestions as RuleSuggestion[]) if (s?.type === 'setMode' && typeof s.mode === 'string') return s.mode;
  return null;
}

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

  /**
   * Enregistre les autorisations contenues dans les suggestions du SDK : règles « allow » (addRules) et, pour
   * une suggestion de mode `acceptEdits`, les outils de modification de fichiers. Renvoie les règles ajoutées.
   */
  async addFromSuggestions(projectId: string, suggestions: unknown[], sessionId: string | null): Promise<PermissionRule[]> {
    const added: PermissionRule[] = [];
    for (const s of suggestions as RuleSuggestion[]) {
      if (s?.type === 'setMode' && s.mode === 'acceptEdits') {
        for (const tool of EDIT_TOOLS) added.push(await this.add(projectId, tool, null, sessionId));
        continue;
      }
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
