import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRule } from './types.js';

// Dépôt simulé en mémoire, sans base.
const state = vi.hoisted(() => ({ rules: [] as PermissionRule[], used: [] as string[] }));
vi.mock('./repository.js', () => ({
  permissionRuleRepository: {
    list: async () => [...state.rules],
    findById: async (id: string) => state.rules.find((r) => r.id === id) ?? null,
    upsert: async (projectId: string, toolName: string, ruleContent: string | null, sessionId: string | null) => {
      const found = state.rules.find((r) => r.toolName === toolName && r.ruleContent === ruleContent);
      if (found) return found;
      const r = { id: `r${state.rules.length + 1}`, projectId, toolName, ruleContent, createdBySessionId: sessionId, createdAt: new Date(), lastUsedAt: null, useCount: 0, usageTrackedSince: new Date() };
      state.rules.push(r);
      return r;
    },
    update: async (id: string, toolName: string, ruleContent: string | null) => {
      const r = state.rules.find((x) => x.id === id)!;
      Object.assign(r, { toolName, ruleContent });
      return r;
    },
    deleteMany: async (_p: string, ids: string[]) => {
      state.rules = state.rules.filter((r) => !ids.includes(r.id));
      return ids;
    },
    markUsed: async (ids: string[]) => void state.used.push(...ids),
  },
}));

const { permissionRuleService, withEditedRules } = await import('./service.js');
const texts = () => state.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));

beforeEach(() => {
  state.rules = [];
  state.used = [];
});

describe('permissionRuleService.add', () => {
  it('ne mémorise pas deux fois la même règle sous des formes équivalentes', async () => {
    const a = await permissionRuleService.add('p', 'Bash', 'git add:*');
    const b = await permissionRuleService.add('p', 'Bash', 'git add *');
    expect(b.id).toBe(a.id);
    expect(texts()).toEqual(['Bash(git add *)']);
  });

  it('ignore une règle couverte et retire les règles rendues inutiles', async () => {
    await permissionRuleService.add('p', 'Bash', 'git add *');
    await permissionRuleService.add('p', 'Bash', 'git checkout main');
    await permissionRuleService.add('p', 'Bash', 'ls *');
    await permissionRuleService.add('p', 'Bash', 'git *');
    expect(texts()).toEqual(['Bash(ls *)', 'Bash(git *)']);
    await permissionRuleService.add('p', 'Bash', 'git status');
    expect(texts()).toEqual(['Bash(ls *)', 'Bash(git *)']);
  });
});

describe('permissionRuleService.update', () => {
  it('modifie la règle et refuse un doublon', async () => {
    const r = await permissionRuleService.add('p', 'Bash', "sed -n '/x/p' f.ts");
    await permissionRuleService.add('p', 'Bash', 'cat *');
    expect((await permissionRuleService.update(r.id, 'Bash(sed:*)')).ruleContent).toBe('sed *');
    await expect(permissionRuleService.update(r.id, 'Bash(cat:*)')).rejects.toThrow(/existe déjà/);
    await expect(permissionRuleService.update(r.id, 'Bash(sed')).rejects.toThrow(/invalide/);
  });
});

describe('withEditedRules', () => {
  it('remplace les règles suggérées par les règles relues et garde les changements de mode', () => {
    const suggestions = [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'git checkout main' }] },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ];
    expect(withEditedRules(suggestions, ['Bash(git checkout:*)', 'invalide('])).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'git checkout *' }] },
    ]);
  });

  it('après « ne plus demander » sur une commande git, les commandes du même type sont comptées pour la règle', async () => {
    const [rule] = await permissionRuleService.addFromSuggestions('p', withEditedRules([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git checkout main' }] }], ['Bash(git checkout *)']), 's');
    expect(texts()).toEqual(['Bash(git checkout *)']);
    await permissionRuleService.recordUse(state.rules, 'Bash', { command: 'git checkout -b autre' }, '/w');
    await permissionRuleService.recordUse(state.rules, 'Bash', { command: 'git push' }, '/w');
    expect(state.used).toEqual([rule.id]);
  });
});
