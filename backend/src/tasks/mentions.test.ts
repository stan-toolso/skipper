import { describe, expect, it } from 'vitest';
import { findMentions, fold, replaceMentions, sessionMentionable, userMentionable } from './mentions.js';

const alice = userMentionable({ id: 'u1', name: 'Alice Martin', email: 'alice@example.com' });
const al = userMentionable({ id: 'u2', name: 'Al', email: 'al@example.com' });
const session = sessionMentionable({ id: 'd8ae4082-298a-48a4-9b24-122fab0f7816', name: 'Corriger le panier', status: 'running' });
const all = [alice, al, session];

describe('fold', () => {
  it('replie casse, accents et espaces', () => {
    expect(fold('  Éléonore   Dupré ')).toBe('eleonore dupre');
  });
});

describe('findMentions', () => {
  it('reconnaît un membre par son nom (sans casse ni accents) et par son e-mail', () => {
    expect(findMentions('Vu avec @alice martin, et @AL@EXAMPLE.COM aussi', all)).toEqual([
      { kind: 'user', id: 'u1', label: 'Alice Martin', text: '@alice martin' },
      { kind: 'user', id: 'u2', label: 'Al', text: '@AL@EXAMPLE.COM' },
    ]);
  });
  it('préfère l’alias le plus long et exige une fin de mot', () => {
    // « @Al » seul est Al ; « @Alice Martin » n'est pas Al suivi de « ice ».
    expect(findMentions('@Al ?', all).map((m) => m.id)).toEqual(['u2']);
    expect(findMentions('@Alice Martin ?', all).map((m) => m.id)).toEqual(['u1']);
    expect(findMentions('@Alfred', all)).toEqual([]);
  });
  it('ignore un @ collé à un mot (adresse écrite dans le texte) et ne garde chaque cible qu’une fois', () => {
    expect(findMentions('écris à alice@example.com', all)).toEqual([]);
    expect(findMentions('@Al et encore @Al', all)).toHaveLength(1);
  });
  it('reconnaît une session par son identifiant complet, court, ou son nom', () => {
    const want = { kind: 'session', id: session.id, label: 'Corriger le panier' };
    expect(findMentions('@session:d8ae4082 regarde', all)[0]).toMatchObject({ ...want, text: '@session:d8ae4082' });
    expect(findMentions(`@session:${session.id}`, all)[0]).toMatchObject({ ...want, text: `@session:${session.id}` });
    expect(findMentions('cc @Corriger le panier', all)[0]).toMatchObject({ ...want, text: '@Corriger le panier' });
    expect(session.text).toBe('@session:d8ae4082');
  });
  it('fonctionne en début et en fin de texte, et après une ponctuation', () => {
    expect(findMentions('@Al', all)).toHaveLength(1);
    expect(findMentions('(@Al)', all)).toHaveLength(1);
    expect(findMentions('bonjour @Al.', all)).toHaveLength(1);
  });
});

describe('replaceMentions', () => {
  it('remplace chaque fragment de mention par son rendu, sans toucher aux mots qui le contiennent', () => {
    const mentions = findMentions('@Al et @Alice Martin ; pas @Alfred', all);
    expect(replaceMentions('@Al et @Alice Martin ; pas @Alfred', mentions, (m) => `[${m.label}]`)).toBe('[Al] et [Alice Martin] ; pas @Alfred');
  });
});
