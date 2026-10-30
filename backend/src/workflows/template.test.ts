import { describe, expect, it } from 'vitest';
import { extractJson, lookup, placeholders, render, resolve } from './template.js';

const ctx = { input: { ticket: 'T-12', env: 'prod', tags: ['a', 'b'], empty: '' }, nodes: { review: { output: 'OK', json: { approved: true, count: 3 } } } };

describe('lookup / resolve', () => {
  it('suit un chemin pointé, y compris dans les tableaux', () => {
    expect(lookup(ctx, 'nodes.review.json.approved')).toBe(true);
    expect(lookup(ctx, 'input.tags.1')).toBe('b');
    expect(lookup(ctx, 'nodes.absent.output')).toBeUndefined();
    expect(lookup('texte', 'a')).toBeUndefined();
  });
  it('une clé nue retombe sur input.<clé>', () => {
    expect(resolve(ctx, 'ticket')).toBe('T-12');
    expect(resolve(ctx, 'nodes')).toBe(ctx.nodes);
    expect(resolve(ctx, 'inconnu')).toBeUndefined();
  });
});

describe('render', () => {
  it('remplace les emplacements, rend les structures en JSON et les absents en vide', () => {
    expect(render('Ticket {{ ticket }} sur {{input.env}} : {{nodes.review.output}}', ctx)).toBe('Ticket T-12 sur prod : OK');
    expect(render('{{nodes.review.json}}', ctx)).toBe(JSON.stringify({ approved: true, count: 3 }, null, 2));
    expect(render('[{{input.absent}}] {{nodes.review.json.count}}', ctx)).toBe('[] 3');
  });
  it('applique le repli default quand la valeur est vide', () => {
    expect(render('{{ input.empty | default: "rien" }}', ctx)).toBe('rien');
    expect(render("{{ absent | default: 'n/a' }}", ctx)).toBe('n/a');
    expect(render('{{ ticket | default: "x" }}', ctx)).toBe('T-12');
  });
  it('liste les chemins référencés, dédoublonnés et sans modificateur', () => {
    expect(placeholders('{{a}} {{ b.c | default: "x" }} {{a}}')).toEqual(['a', 'b.c']);
  });
});

describe('extractJson', () => {
  it('lit du JSON nu, un bloc ```json, ou le premier objet équilibré', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Voici :\n```json\n{"a": [1, 2]}\n```\nfin')).toEqual({ a: [1, 2] });
    expect(extractJson('Résultat : {"ok": true, "msg": "a } b"} et la suite')).toEqual({ ok: true, msg: 'a } b' });
    expect(extractJson('rien ici')).toBeNull();
    expect(extractJson('42')).toBeNull();
  });
});
