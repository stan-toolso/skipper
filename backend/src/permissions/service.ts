import { AppError, NotFoundError } from '../errors.js';
import { permissionRuleRepository } from './repository.js';
import { canonicalContent, covers, parseRule, ruleMatches, type ParsedRule } from './rules.js';
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
 * Remplace les règles suggérées par le SDK par celles que l'humain a relues (et souvent généralisées :
 * `Bash(git checkout *)` au lieu de la commande exacte) dans le prompt d'autorisation. Les suggestions de
 * changement de mode sont conservées. Les règles invalides sont ignorées.
 */
export function withEditedRules(suggestions: unknown[], rules: string[]): unknown[] {
  const parsed = rules.map(parseRule).filter((r): r is ParsedRule => r !== null);
  const kept = (suggestions as RuleSuggestion[]).filter((s) => !(s?.type === 'addRules' && (s.behavior ?? 'allow') === 'allow'));
  if (!parsed.length) return kept;
  const edited = { type: 'addRules', behavior: 'allow', destination: 'session', rules: parsed.map((r) => ({ toolName: r.toolName, ruleContent: canonicalContent(r.toolName, r.ruleContent) ?? undefined })) };
  return [...kept, edited];
}

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

  /**
   * Mémorise une règle sous sa forme canonique, sans doublon : si une règle existante l'autorise déjà
   * (même règle sous une autre forme, outil entier, préfixe plus large), c'est elle qui est renvoyée ; les
   * règles existantes que la nouvelle rend inutiles (plus étroites) sont retirées.
   */
  async add(projectId: string, toolName: string, ruleContent: string | null, sessionId: string | null = null): Promise<PermissionRule> {
    const tool = toolName.trim();
    if (!TOOL_RE.test(tool)) throw new AppError(`Nom d'outil invalide : ${toolName}`);
    const rule = { toolName: tool, ruleContent: canonicalContent(tool, ruleContent) };
    const existing = await permissionRuleRepository.list(projectId);
    const covering = existing.find((r) => covers(r, rule));
    if (covering) return covering;
    const created = await permissionRuleRepository.upsert(projectId, rule.toolName, rule.ruleContent, sessionId);
    const narrower = existing.filter((r) => r.id !== created.id && covers(rule, r)).map((r) => r.id);
    await permissionRuleRepository.deleteMany(projectId, narrower);
    return created;
  },

  /** Remplace une règle par sa version modifiée (texte complet, ex. `Bash(git checkout *)`). */
  async update(id: string, text: string): Promise<PermissionRule> {
    const current = await this.get(id);
    const parsed = parseRule(text);
    if (!parsed || !TOOL_RE.test(parsed.toolName)) throw new AppError(`Règle invalide : ${text}. Forme attendue : Outil ou Outil(motif), ex. Bash(git status *).`);
    const rule = { toolName: parsed.toolName, ruleContent: canonicalContent(parsed.toolName, parsed.ruleContent) };
    const duplicate = (await permissionRuleRepository.list(current.projectId)).find((r) => r.id !== id && covers(r, rule) && covers(rule, r));
    if (duplicate) throw new AppError(`Cette règle existe déjà : ${formatRule(duplicate)}`);
    return (await permissionRuleRepository.update(id, rule.toolName, rule.ruleContent)) ?? current;
  },

  /**
   * Relève l'utilisation des règles : un appel d'outil exécuté sans demande d'autorisation est compté pour
   * chaque règle du projet qui lui correspond.
   */
  async recordUse(rules: PermissionRule[], toolName: string, input: Record<string, unknown>, cwd: string): Promise<void> {
    await permissionRuleRepository.markUsed(rules.filter((r) => ruleMatches(r, toolName, input, cwd)).map((r) => r.id));
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

  removeMany: (projectId: string, ids: string[]) => permissionRuleRepository.deleteMany(projectId, ids),
};
