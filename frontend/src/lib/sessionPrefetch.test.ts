import { describe, expect, it, vi } from 'vitest';
import type { ApolloClient } from '@apollo/client';
import { prefetchSession, sessionIdOfHref, takePrefetchedEvents } from './sessionPrefetch';

const fakeClient = () => {
  const query = vi.fn(async ({ variables }: { variables: { id: string; after?: string | null } }) => ({ data: { session: { id: variables.id, events: [], liveDraft: null } } }));
  return { client: { query } as unknown as ApolloClient<object>, query };
};

describe('sessionIdOfHref', () => {
  it('reconnaît une session ou un chat, pas leurs sous-pages', () => {
    expect(sessionIdOfHref('/sessions/abc')).toBe('abc');
    expect(sessionIdOfHref('/chats/xyz')).toBe('xyz');
    expect(sessionIdOfHref('/sessions/abc/files')).toBeNull();
    expect(sessionIdOfHref('/projects/abc')).toBeNull();
    expect(sessionIdOfHref(null)).toBeNull();
  });
});

describe('prefetchSession', () => {
  it('précharge la session et la première page de son fil, une fois par période', async () => {
    const { client, query } = fakeClient();
    prefetchSession(client, 's1');
    prefetchSession(client, 's1');
    expect(query).toHaveBeenCalledTimes(2); // Session + SessionEvents, pas de doublon
    const page = takePrefetchedEvents('s1');
    expect(page).not.toBeNull();
    await expect(page).resolves.toMatchObject({ session: { id: 's1' } });
    // Consommée une seule fois : le relevé suivant interroge le serveur.
    expect(takePrefetchedEvents('s1')).toBeNull();
  });

  it("ne renvoie rien pour une session qui n'a pas été préchargée", () => {
    expect(takePrefetchedEvents('inconnue')).toBeNull();
  });
});
