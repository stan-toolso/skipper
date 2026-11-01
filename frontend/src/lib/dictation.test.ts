import { describe, expect, it } from 'vitest';
import { joinResults, withTranscript } from './dictation';

const result = (transcript: string, isFinal = true) => ({ isFinal, 0: { transcript } });

describe('dictée', () => {
  it('ajoute la transcription après le texte déjà saisi', () => {
    expect(withTranscript('Corrige le bouton', 'et la couleur')).toBe('Corrige le bouton et la couleur');
    expect(withTranscript('Ligne\n', 'suite')).toBe('Ligne\nsuite');
  });
  it('commence par une majuscule dans une saisie vide', () => {
    expect(withTranscript('', ' ajoute un titre ')).toBe('Ajoute un titre');
  });
  it('laisse le texte intact tant que rien n’est reconnu', () => {
    expect(withTranscript('abc', '   ')).toBe('abc');
  });
  it('joint résultats définitifs et provisoires', () => {
    expect(withTranscript('', joinResults([result('mets le titre'), result(' en gras', false)]))).toBe('Mets le titre en gras');
  });
});
