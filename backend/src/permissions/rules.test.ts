import { describe, expect, it } from 'vitest';
import { canonicalContent, covers, parseRule, ruleMatches, splitShellCommand } from './rules.js';

const rule = (text: string) => parseRule(text)!;

describe('parseRule / canonicalContent', () => {
  it('analyse un outil seul ou avec motif', () => {
    expect(parseRule('Read')).toEqual({ toolName: 'Read', ruleContent: null });
    expect(parseRule('Bash(git add *)')).toEqual({ toolName: 'Bash', ruleContent: 'git add *' });
    expect(parseRule('Bash(sed -n \'/a(b)/p\' f)')).toEqual({ toolName: 'Bash', ruleContent: "sed -n '/a(b)/p' f" });
    expect(parseRule('Bash(git')).toBeNull();
    expect(parseRule('pas un outil')).toBeNull();
  });

  it("ramène l'ancienne syntaxe de préfixe Bash à la nouvelle", () => {
    expect(canonicalContent('Bash', 'git status:*')).toBe('git status *');
    expect(canonicalContent('Bash', ' git status * ')).toBe('git status *');
    expect(canonicalContent('Read', '//tmp/**')).toBe('//tmp/**');
    expect(canonicalContent('Bash', '  ')).toBeNull();
  });
});

describe('covers', () => {
  it('reconnaît les formes équivalentes et les règles plus larges', () => {
    expect(covers(rule('Bash(git add:*)'), rule('Bash(git add *)'))).toBe(true);
    expect(covers(rule('Bash(git *)'), rule('Bash(git add *)'))).toBe(true);
    expect(covers(rule('Bash(git *)'), rule('Bash(git checkout main)'))).toBe(true);
    expect(covers(rule('Bash'), rule('Bash(ls *)'))).toBe(true);
    expect(covers(rule('Bash(git add *)'), rule('Bash(git *)'))).toBe(false);
    expect(covers(rule('Bash(git *)'), rule('Bash(gitk *)'))).toBe(false);
    expect(covers(rule('Bash(ls *)'), rule('Read'))).toBe(false);
  });
});

describe('splitShellCommand', () => {
  it('découpe aux opérateurs hors guillemets', () => {
    expect(splitShellCommand(`cat /tmp/x.log | tail -5 && echo "a|b; c" ; ls`)).toEqual(['cat /tmp/x.log', 'tail -5', 'echo "a|b; c"', 'ls']);
    expect(splitShellCommand(`sed -n '/^export const A/,/^\`;/p' f.ts`)).toEqual([`sed -n '/^export const A/,/^\`;/p' f.ts`]);
  });
});

describe('ruleMatches', () => {
  const bash = (command: string) => ['Bash', { command }] as const;
  it('applique les préfixes Bash à chaque commande', () => {
    expect(ruleMatches(rule('Bash(git checkout *)'), ...bash('git checkout -b x'), '/w')).toBe(true);
    expect(ruleMatches(rule('Bash(git checkout:*)'), ...bash('git checkout'), '/w')).toBe(true);
    expect(ruleMatches(rule('Bash(git checkout *)'), ...bash('git checkoutx'), '/w')).toBe(false);
    expect(ruleMatches(rule('Bash(git checkout *)'), ...bash('cd /w && git checkout main'), '/w')).toBe(true);
    expect(ruleMatches(rule('Bash(echo "exit $?")'), ...bash('echo "exit $?"'), '/w')).toBe(true);
    expect(ruleMatches(rule('Bash(npm run *:check)'), ...bash('npm run lint:check'), '/w')).toBe(true);
    expect(ruleMatches(rule('Bash(git *)'), 'Read', { file_path: '/w/a' }, '/w')).toBe(false);
  });

  it("reconnaît l'outil entier et les serveurs MCP", () => {
    expect(ruleMatches(rule('Write'), 'Write', {}, '/w')).toBe(true);
    expect(ruleMatches(rule('mcp__connections'), 'mcp__connections__sql_query', {}, '/w')).toBe(true);
    expect(ruleMatches(rule('mcp__connections__ssh_run'), 'mcp__connections__sql_query', {}, '/w')).toBe(false);
  });

  it('applique les motifs de chemin et les domaines', () => {
    expect(ruleMatches(rule('Read(//tmp/**)'), 'Read', { file_path: '/tmp/a/b.log' }, '/w')).toBe(true);
    expect(ruleMatches(rule('Read(//tmp/**)'), 'Grep', { path: '/tmp' }, '/w')).toBe(false);
    expect(ruleMatches(rule('Read(//sys/fs/cgroup/**)'), 'Read', { file_path: '/etc/passwd' }, '/w')).toBe(false);
    expect(ruleMatches(rule('Edit(src/**/*.ts)'), 'Write', { file_path: '/w/src/a/b.ts' }, '/w')).toBe(true);
    expect(ruleMatches(rule('Edit(src/**/*.ts)'), 'Write', { file_path: '/w/doc/b.ts' }, '/w')).toBe(false);
    expect(ruleMatches(rule('WebFetch(domain:github.com)'), 'WebFetch', { url: 'https://api.github.com/x' }, '/w')).toBe(true);
  });
});
