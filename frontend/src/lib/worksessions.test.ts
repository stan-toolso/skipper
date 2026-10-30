import { describe, expect, it } from 'vitest';
import { branchFromName, namesFromText, suggestWorksessionName } from './worksessions';

describe('noms des work sessions', () => {
  it('dérive libellé et dossier de la première ligne de la consigne', () => {
    expect(namesFromText('Ajoute une page de contact au site\navec un formulaire')).toEqual({ label: 'Ajoute une page de contact au site', name: 'ajoute-une-page-de-contact-au' });
  });
  it('retombe sur « travail » sans texte', () => {
    expect(namesFromText('  ').name).toBe('travail');
  });
  it('garde les barres obliques d’une branche', () => {
    expect(branchFromName('Feature/Contact Été')).toBe('feature/contact-ete');
  });
  it('propose un nom en deux mots', () => {
    expect(suggestWorksessionName()).toMatch(/^[a-z]+-[a-z]+$/);
  });
});
