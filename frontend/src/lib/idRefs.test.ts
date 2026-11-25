import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { bareId, candidateRefs, refUrl, splitKnown, splitRefs, trailingKeyword } from './idRefs';
import remarkRefs from './remarkRefs';

const refs = (text: string) => splitRefs(text).filter((s) => 'kind' in s);

describe('splitRefs', () => {
  it('reconnaît les identifiants courts annoncés par « tâche » ou « session »', () => {
    expect(refs('Tâche 313c1101 (urgente), lancée dans la session 2927a9fc.')).toEqual([
      { text: '313c1101', kind: 'task', id: '313c1101' },
      { text: '2927a9fc', kind: 'session', id: '2927a9fc' },
    ]);
    expect(splitRefs('la tâche 313c1101 !').map((s) => s.text).join('')).toBe('la tâche 313c1101 !');
  });
  it('suit les listes après le mot', () => {
    expect(refs('tâches 8acd64bd, 07c5ded4 et a146e804').map((r) => r.id)).toEqual(['8acd64bd', '07c5ded4', 'a146e804']);
    expect(refs('sessions d’agent : 2927a9fc / 313c1101').map((r) => r.kind)).toEqual(['session', 'session']);
  });
  it('ne prend pas un commit, un mot ou un identifiant sans mot qui l’annonce', () => {
    expect(refs('commit ddec3a84 poussé')).toEqual([]);
    expect(refs('la session deadbeef')).toEqual([]);
    expect(refs('soustâche 313c1101')).toEqual([]);
    expect(refs('la tâche 313c1101abcdef99')).toEqual([]);
  });
  it('reconnaît un UUID complet, avec ou sans mot', () => {
    expect(refs('voir c87aacf3-30ac-4860-8a01-e9a48f1fa2f0.')).toEqual([{ text: 'c87aacf3-30ac-4860-8a01-e9a48f1fa2f0', kind: 'any', id: 'c87aacf3-30ac-4860-8a01-e9a48f1fa2f0' }]);
    expect(refs('session C87AACF3-30AC-4860-8A01-E9A48F1FA2F0')[0]).toMatchObject({ kind: 'session', id: 'c87aacf3-30ac-4860-8a01-e9a48f1fa2f0' });
  });
});

describe('refUrl, trailingKeyword, bareId', () => {
  it('lien direct pour un identifiant complet typé, résolution sinon', () => {
    expect(refUrl('task', 'c87aacf3-30ac-4860-8a01-e9a48f1fa2f0')).toBe('/tasks/c87aacf3-30ac-4860-8a01-e9a48f1fa2f0');
    expect(refUrl('session', '2927a9fc')).toBe('/r/session/2927a9fc');
    expect(refUrl('any', 'c87aacf3-30ac-4860-8a01-e9a48f1fa2f0')).toBe('/r/any/c87aacf3-30ac-4860-8a01-e9a48f1fa2f0');
  });
  it('mot en fin de texte et identifiant seul', () => {
    expect(trailingKeyword('lancée dans la session ')).toBe('session');
    expect(trailingKeyword('voir la tâche (')).toBe('task');
    expect(trailingKeyword('voir le commit ')).toBeNull();
    expect(bareId(' 313c1101 ')).toBe('313c1101');
    expect(bareId('npm')).toBeNull();
  });
});

describe('remarkRefs', () => {
  const links = (md: string) => {
    const proc = unified().use(remarkParse).use(remarkRefs);
    const tree = proc.runSync(proc.parse(md)) as unknown as { children: { children?: { type: string; url?: string }[] }[] };
    return tree.children.flatMap((p) => p.children ?? []).filter((n) => n.type === 'link').map((n) => n.url);
  };
  it('texte courant et identifiants en code', () => {
    expect(links('Tâche 313c1101 lancée dans la session `2927a9fc`.')).toEqual(['/r/task/313c1101', '/r/session/2927a9fc']);
    expect(links('tâches `8acd64bd`, `07c5ded4`')).toEqual(['/r/task/8acd64bd', '/r/task/07c5ded4']);
    expect(links('commit `ddec3a84`')).toEqual([]);
  });
  it('laisse les liens existants', () => {
    expect(links('[la tâche 313c1101](https://x.io)')).toEqual(['https://x.io']);
  });
});

describe('identifiants cités seuls, reconnus par le serveur', () => {
  const known = new Map([
    ['56f64f35', { kind: 'task' as const, id: '56f64f35-1111-4222-8333-444455556666' }],
    ['2927a9fc', { kind: 'session' as const, id: '2927a9fc-1111-4222-8333-444455556666' }],
  ]);
  const links = (md: string) => {
    const proc = unified().use(remarkParse).use(remarkRefs, { known });
    const tree = proc.runSync(proc.parse(md)) as unknown as { children: unknown[] };
    const urls: string[] = [];
    const walk = (n: { type?: string; url?: string; children?: unknown[] }) => {
      if (n.type === 'link' && n.url) urls.push(n.url);
      (n.children ?? []).forEach((c) => walk(c as never));
    };
    walk(tree as never);
    return urls;
  };
  it('relève les candidats plausibles', () => {
    expect(candidateRefs('**56f64f35** : renfo, 97754E7A, deadbeef, c87aacf3-30ac-4860-8a01-e9a48f1fa2f0')).toEqual(['56f64f35', '97754e7a']);
  });
  it('lie un identifiant reconnu, seul, en gras ou en code', () => {
    expect(links('- **56f64f35** : 6 nouvelles séances\n- `2927a9fc` relancée')).toEqual([
      '/tasks/56f64f35-1111-4222-8333-444455556666',
      '/sessions/2927a9fc-1111-4222-8333-444455556666',
    ]);
    expect(links('la tâche 56f64f35')).toEqual(['/tasks/56f64f35-1111-4222-8333-444455556666']);
  });
  it('laisse un identifiant inconnu (commit) en texte', () => {
    expect(links('**97754e7a**, commit `ddec3a84`')).toEqual([]);
    expect(splitKnown('voir 97754e7a', known)).toEqual([{ text: 'voir 97754e7a' }]);
  });
});
