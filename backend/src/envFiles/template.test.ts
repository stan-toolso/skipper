import { describe, expect, it } from 'vitest';
import { isDotenv, normalizePath, parseDotenv, references, render, setDotenvKey, unsetDotenvKey } from './template.js';

describe('modèles des fichiers d’environnement', () => {
  it('repère les références au coffre, sans doublon', () => {
    expect(references('A={{vault:rds.url}}\nB={{ vault:rds.url }}\nC=x{{vault:stripe.secret_key}}y')).toEqual([
      { item: 'rds', field: 'url', raw: '{{vault:rds.url}}' },
      { item: 'stripe', field: 'secret_key', raw: '{{vault:stripe.secret_key}}' },
    ]);
  });

  it('reconnaît les fichiers dotenv', () => {
    expect(isDotenv('.env')).toBe(true);
    expect(isDotenv('backend/.env.local')).toBe(true);
    expect(isDotenv('config/prod.env')).toBe(true);
    expect(isDotenv('config.json')).toBe(false);
  });

  it('normalise les chemins et refuse ceux qui sortent du dossier', () => {
    expect(normalizePath('./backend//.env')).toBe('backend/.env');
    for (const bad of ['', '/etc/passwd', '../.env', 'a/../../b', '.git/config', 'dir/']) expect(() => normalizePath(bad)).toThrow();
  });

  it('lit les clés : export, guillemets, commentaires, dernière définition gagnante', () => {
    const keys = parseDotenv('# commentaire\nexport A=1\nB="deux mots"\nC=x # note\nA=3\nD={{vault:rds.password}}\n');
    expect(keys.map((k) => [k.key, k.value])).toEqual([
      ['B', 'deux mots'],
      ['C', 'x'],
      ['A', '3'],
      ['D', '{{vault:rds.password}}'],
    ]);
    expect(keys[3].refs).toHaveLength(1);
  });

  it('ajoute, remplace et retire une clé', () => {
    let c = setDotenvKey('A=1\n', 'B', 'deux mots');
    expect(c).toBe('A=1\nB="deux mots"\n');
    c = setDotenvKey(c, 'A', '{{vault:rds.url}}');
    expect(c).toBe('A={{vault:rds.url}}\nB="deux mots"\n');
    c = setDotenvKey('A=1\nA=2\n', 'A', '3');
    expect(c).toBe('A=3\n');
    expect(unsetDotenvKey('A=1\nB=2\n', 'A')).toBe('B=2\n');
    expect(unsetDotenvKey('A=1\n', 'Z')).toBeNull();
    expect(() => setDotenvKey('', '1A', 'x')).toThrow();
  });

  it('rend les références et cite une valeur dotenv qui en a besoin', () => {
    const values: Record<string, string> = { 'rds.password': 'p@ss w#"rd', 'rds.host': 'db' };
    const resolve = (i: string, f: string) => values[`${i}.${f}`] ?? '';
    expect(render('PW={{vault:rds.password}}\nURL=postgres://{{vault:rds.host}}/x\n', true, resolve)).toBe('PW="p@ss w#\\"rd"\nURL=postgres://db/x\n');
    expect(render('{"pw": "{{vault:rds.host}}"}', false, resolve)).toBe('{"pw": "db"}');
  });
});
