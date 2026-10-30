import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Texte d'un appel `useQuery…(` jusqu'à sa parenthèse fermante (parenthèses équilibrées, sans analyser les chaînes). */
function callText(src: string, from: number): string {
  const open = src.indexOf('(', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

/**
 * Les pages du workbench restent montées mais cachées (`<Activity mode="hidden">`) quand on change d'onglet.
 * Apollo arrête alors le sondage d'un `useQuery` (plus d'abonné) et met `pollInterval` à 0 pour de bon :
 * au retour sur la page, plus rien ne se rafraîchit (demandes d'une session invisibles, statut figé).
 * Tout sondage doit passer par `usePollingQuery`, qui relance le sondage à chaque affichage.
 */
describe('usePollingQuery', () => {
  it('aucun useQuery avec pollInterval en dehors de usePollingQuery', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const src = readFileSync(file, 'utf8');
      if (file.endsWith('usePollingQuery.ts')) continue;
      const re = /\buseQuery\s*(<|\()/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        if (/\bpollInterval\s*:/.test(callText(src, m.index))) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
