import { describe, expect, it } from 'vitest';
import { namesFromText, uniqueName } from './names.js';

describe('namesFromText', () => {
  it('prend la première ligne comme libellé et un slug de ses premiers mots comme dossier', () => {
    expect(namesFromText('Corriger l’export CSV des factures\navec les détails')).toEqual({ label: 'Corriger l’export CSV des factures', name: 'corriger-l-export-csv-des-factures' });
  });
  it('limite le slug à six mots et 40 caractères', () => {
    const { name } = namesFromText('un deux trois quatre cinq six sept huit');
    expect(name).toBe('un-deux-trois-quatre-cinq-six');
    expect(namesFromText('a'.repeat(80)).name.length).toBeLessThanOrEqual(40);
  });
  it('ajoute le préfixe et retombe sur « travail » sans texte utilisable', () => {
    expect(namesFromText('   ', 'task-').name).toBe('task-travail');
    expect(namesFromText('Export', 'task-').name).toBe('task-export');
  });
});

describe('uniqueName', () => {
  it('ajoute un suffixe numérique quand le nom est pris', () => {
    expect(uniqueName([{ name: 'export' }, { name: 'export-2' }], 'export')).toBe('export-3');
    expect(uniqueName([], 'export')).toBe('export');
  });
});
