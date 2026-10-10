import { describe, expect, it } from 'vitest';
import { parseModelCount, parseProjectName, validateBaseUrl, validatePublicKey, validateSecretKey } from './llm.js';

describe('LiteLLM et Langfuse', () => {
  it('normalise une adresse de base et refuse les adresses internes', () => {
    expect(validateBaseUrl('https://litellm.example.com/?x=1#f', 'Adresse')).toBe('https://litellm.example.com');
    expect(validateBaseUrl('https://litellm.example.com/v1/', 'Adresse')).toBe('https://litellm.example.com/v1');
    expect(() => validateBaseUrl('', 'Adresse')).toThrow(/obligatoire/);
    expect(() => validateBaseUrl('pas une url', 'Adresse')).toThrow(/invalide/);
    expect(() => validateBaseUrl('http://localhost:4000', 'Adresse')).toThrow(/interne/);
  });
  it('vérifie les clés Langfuse', () => {
    expect(validatePublicKey(' pk-lf-abc ')).toBe('pk-lf-abc');
    expect(() => validatePublicKey('sk-lf-abc')).toThrow(/pk-lf-/);
    expect(validateSecretKey('sk-lf-abc')).toBe('sk-lf-abc');
    expect(() => validateSecretKey('')).toThrow(/obligatoire/);
  });
  it('lit les réponses de vérification', () => {
    expect(parseModelCount(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }))).toBe(2);
    expect(() => parseModelCount('<html>')).toThrow(/JSON/);
    expect(() => parseModelCount('{}')).toThrow(/liste de modèles/);
    expect(parseProjectName(JSON.stringify({ data: [{ name: 'Skipper' }] }))).toBe('Skipper');
    expect(() => parseProjectName(JSON.stringify({ data: [] }))).toThrow(/aucun projet/);
  });
});
