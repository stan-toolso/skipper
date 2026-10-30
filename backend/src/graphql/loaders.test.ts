import { describe, expect, it, vi } from 'vitest';
import { branchKey, createBatcher } from './loaders.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createBatcher', () => {
  it('rassemble les clés demandées dans le même tour en un seul chargement, sans doublon', async () => {
    const load = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, k.toUpperCase()])));
    const get = createBatcher(load);
    const results = await Promise.all([get('a'), get('b'), get('a')]);
    expect(results).toEqual(['A', 'B', 'A']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual(['a', 'b']);
  });

  it('mémorise les réponses : une clé déjà chargée ne repart pas, un nouveau tour charge seulement les nouvelles', async () => {
    const load = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, k.length])));
    const get = createBatcher(load);
    expect(await get('un')).toBe(2);
    await tick();
    const [again, other] = await Promise.all([get('un'), get('trois')]);
    expect([again, other]).toEqual([2, 5]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]).toEqual(['trois']);
  });

  it('recharge une clé dont la réponse mémorisée a expiré (contexte de subscription réutilisé)', async () => {
    let clock = 0;
    const load = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, clock])));
    const get = createBatcher(load, String, { maxAgeMs: 1000, now: () => clock });
    expect(await get('s')).toBe(0);
    clock = 500;
    expect(await get('s')).toBe(0);
    clock = 1500;
    expect(await get('s')).toBe(1500);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renvoie undefined pour une clé absente du résultat', async () => {
    const get = createBatcher<string, number>(async () => new Map());
    expect(await get('absent')).toBeUndefined();
  });

  it('rejette toutes les demandes du lot si le chargement échoue', async () => {
    const get = createBatcher<string, number>(async () => {
      throw new Error('base indisponible');
    });
    await expect(Promise.all([get('a'), get('b')])).rejects.toThrow('base indisponible');
  });

  it('accepte des clés composées, identifiées par keyOf', async () => {
    const load = vi.fn(async (keys: { projectId: string; branch: string }[]) => new Map(keys.map((k) => [branchKey(k), k.branch])));
    const get = createBatcher(load, branchKey);
    const [a, b, c] = await Promise.all([get({ projectId: 'p', branch: 'x' }), get({ projectId: 'p', branch: 'y' }), get({ projectId: 'p', branch: 'x' })]);
    expect([a, b, c]).toEqual(['x', 'y', 'x']);
    expect(load.mock.calls[0][0]).toHaveLength(2);
  });
});
