import { describe, expect, it, vi } from 'vitest';

// Le service touche la base par ses voisins : seules les fonctions pures sont exercées ici.
vi.mock('../projects/repository.js', () => ({ projectRepository: {} }));
vi.mock('../projects/service.js', () => ({ projectService: {} }));
vi.mock('../sessions/service.js', () => ({ sessionService: {} }));
vi.mock('../users/service.js', () => ({ userService: {} }));

const { chatName, personalSlugFor } = await import('./service.js');

describe('chatName', () => {
  it('prend la première ligne non vide, sans marqueur Markdown, raccourcie à 80 caractères', () => {
    expect(chatName('\n\n# Fais le point sur mes projets\nMerci')).toBe('Fais le point sur mes projets');
    expect(chatName('- liste')).toBe('liste');
    expect(chatName('x'.repeat(100))).toHaveLength(80);
    expect(chatName('   ')).toBe('Chat');
  });
});

describe('personalSlugFor', () => {
  const user = { id: '12345678-aaaa', email: 'Stanislas.Giraudet@example.org', name: 'Stanislas' };

  it("dérive le dossier de la partie locale de l'e-mail", async () => {
    expect(await personalSlugFor(user, async () => false)).toBe('moi-stanislas-giraudet');
  });

  it('suffixe un numéro quand le dossier existe déjà', async () => {
    const taken = new Set(['moi-stanislas-giraudet', 'moi-stanislas-giraudet-2']);
    expect(await personalSlugFor(user, async (s) => taken.has(s))).toBe('moi-stanislas-giraudet-3');
  });

  it("retombe sur le nom puis l'identifiant quand l'e-mail ne donne rien", async () => {
    expect(await personalSlugFor({ id: 'abcdef12-0000', email: '@x', name: 'Élise' }, async () => false)).toBe('moi-elise');
    expect(await personalSlugFor({ id: 'abcdef12-0000', email: '@x', name: '' }, async () => false)).toBe('moi-abcdef12');
  });
});
