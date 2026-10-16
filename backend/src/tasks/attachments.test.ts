import { describe, expect, it, vi } from 'vitest';

vi.mock('./repository.js', () => ({ taskRepository: {} }));
const { describeAttachments, fitInInstruction, shownToAgent } = await import('./attachments.js');

const file = (id: string, size: number, mediaType = 'image/png') => ({ id, taskId: 't', commentId: null, name: `${id}.png`, mediaType, size, createdAt: new Date() });
const MB = 1024 * 1024;

describe('fichiers joints aux tâches', () => {
  it("garde ce qu'une instruction peut porter et met le reste à part", () => {
    const { kept, leftOut } = fitInInstruction([file('a', 5 * MB), file('b', 11 * MB), file('c', 6 * MB), file('d', 2 * MB)]);
    expect(kept.map((f) => f.id)).toEqual(['a', 'c']);
    expect(leftOut.map((f) => f.id)).toEqual(['b', 'd']);
  });
  it("montre à l'agent les images assez petites seulement", () => {
    expect(shownToAgent(file('a', MB))).toBe(true);
    expect(shownToAgent(file('a', 6 * MB))).toBe(false);
    expect(shownToAgent(file('a', MB, 'application/pdf'))).toBe(false);
  });
  it('nomme les fichiers et dit comment ils parviennent à l’agent', () => {
    expect(describeAttachments([file('a', 2048)], 'instruction')).toEqual(['Fichiers joints :', '- a.png (image/png, 2 Ko) — joint à cette instruction']);
    expect(describeAttachments([], 'tool')).toEqual([]);
  });
});
