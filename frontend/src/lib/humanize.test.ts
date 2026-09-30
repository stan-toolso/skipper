import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeTool, editableRules, formatCost, formatDuration, generalizeBashRule, parseRuleLines, requestTitle, sessionStateHint, suggestedRules, timeAgo } from './humanize';

describe('describeTool', () => {
  it('décrit une commande Bash et tronque une longue commande dans la demande', () => {
    const long = `npm run build ${'x'.repeat(80)}`;
    const d = describeTool('Bash', { command: long, description: 'Build' });
    expect(d.label).toBe('Commande : Build');
    expect(d.detail).toBe(long);
    expect(d.action).toBe(`exécuter la commande ${long.slice(0, 57)}…`);
  });

  it('nomme les fichiers par leur nom court', () => {
    expect(describeTool('Read', { file_path: '/repo/src/index.ts' })).toMatchObject({ label: 'Lecture du fichier index.ts', detail: '/repo/src/index.ts' });
    expect(describeTool('Edit', { file_path: '/repo/a.md' }).action).toBe('modifier le fichier a.md');
  });

  it('décrit les outils MCP de Skipper', () => {
    expect(describeTool('mcp__tasks__create', { title: 'Écrire les tests' }).label).toBe('Création de la tâche « Écrire les tests »');
    expect(describeTool('mcp__context__read', { path: 'dev/tests' }).action).toBe("lire l'instruction dev/tests");
    expect(describeTool('mcp__connections__sql_query', { connection: 'base', sql: 'SELECT 1' })).toMatchObject({ label: 'Requête SQL sur base', detail: 'SELECT 1' });
    expect(describeTool('mcp__worktrees__delete', { name: 'wt', delete_branch: true }).label).toBe('Suppression du worktree wt et de sa branche');
  });

  it('se rabat sur le nom et les arguments JSON pour un outil inconnu', () => {
    expect(describeTool('Inconnu', { a: 1 })).toEqual({ label: 'Outil Inconnu', detail: '{"a":1}', action: "utiliser l'outil Inconnu" });
  });
});

describe('requestTitle', () => {
  it("formule une demande d'autorisation à partir de l'outil", () => {
    expect(requestTitle({ type: 'permission', title: 'Bash', payload: { toolName: 'Read', input: { file_path: '/x/notes.txt' } } })).toBe(
      'Autorisation de lire le fichier notes.txt',
    );
  });

  it('garde le titre des autres demandes', () => {
    expect(requestTitle({ type: 'question', title: 'Quelle base ?', payload: {} })).toBe('Quelle base ?');
  });
});

describe('formats', () => {
  afterEach(() => vi.useRealTimers());

  it('formatDuration', () => {
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(1500)).toBe('1,5 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('formatCost', () => {
    expect(formatCost(0.0123)).toBe('0,012 $');
    expect(formatCost(1.5)).toBe('1,50 $');
  });

  it('timeAgo', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    expect(timeAgo('2026-09-30T11:59:30Z')).toBe("à l'instant");
    expect(timeAgo('2026-09-30T11:55:00Z')).toBe('il y a 5 min');
    expect(timeAgo('2026-09-30T09:00:00Z')).toBe('il y a 3 h');
    expect(timeAgo('2026-09-28T12:00:00Z')).toBe('il y a 2 j');
    expect(timeAgo('2026-10-01T12:00:00Z')).toBe("à l'instant");
  });
});

describe('sessionStateHint', () => {
  it('donne la priorité aux demandes en attente', () => {
    expect(sessionStateHint('RUNNING', 'BUSY', 1)).toBe('a besoin de vous');
    expect(sessionStateHint('RUNNING', 'BUSY', 0)).toBe('travaille');
    expect(sessionStateHint('RUNNING', 'IDLE', 0)).toBe('attend vos instructions');
    expect(sessionStateHint('FAILED', null, 0)).toBe('en erreur');
    expect(sessionStateHint('COMPLETED', null, 0)).toBeNull();
  });
});

describe('suggestedRules', () => {
  it('liste les règles « allow » et le mode acceptEdits, ignore le reste', () => {
    expect(
      suggestedRules([
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }, { toolName: 'Read' }] },
        { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Write' }] },
        { type: 'setMode', mode: 'acceptEdits' },
        { type: 'addDirectories' },
      ]),
    ).toEqual(['Bash(git status:*)', 'Read', 'Modifications de fichiers (Edit, Write, NotebookEdit)']);
    expect(suggestedRules(null)).toEqual([]);
  });
});

describe('generalizeBashRule / editableRules', () => {
  it('généralise une commande exacte par préfixe', () => {
    expect(generalizeBashRule(`sed -n '/^export const SIDEBAR/,/^\`;/p' frontend/src/graphql/operations.ts`)).toEqual(['sed *']);
    expect(generalizeBashRule('git checkout main')).toEqual(['git checkout *']);
    expect(generalizeBashRule('git -C /w status')).toEqual(['git *']);
    expect(generalizeBashRule('echo "exit $?"')).toEqual(['echo *']);
    expect(generalizeBashRule('cat /tmp/skipper-agentic-tc-backend.log | tail -5')).toEqual(['cat *', 'tail *']);
    expect(generalizeBashRule('cd backend && NODE_OPTIONS=--max-old-space-size=400 npm run typecheck')).toEqual(['NODE_OPTIONS=--max-old-space-size=400 npm run *']);
  });

  it('garde les motifs existants et les commandes dangereuses', () => {
    expect(generalizeBashRule('git add *')).toEqual(['git add *']);
    expect(generalizeBashRule('npm test:*')).toEqual(['npm test *']);
    expect(generalizeBashRule('rm -rf dist')).toEqual(['rm -rf dist']);
  });

  it('propose les règles des suggestions du SDK, sans doublon', () => {
    const suggestions = [
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'git checkout main' }, { toolName: 'Bash', ruleContent: 'git checkout -b x' }, { toolName: 'Read', ruleContent: '//tmp/**' }] },
      { type: 'setMode', mode: 'acceptEdits' },
    ];
    expect(editableRules(suggestions)).toEqual(['Bash(git checkout *)', 'Read(//tmp/**)']);
    expect(parseRuleLines(' Bash(git *)\n\n Read \n')).toEqual(['Bash(git *)', 'Read']);
  });
});
