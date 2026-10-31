import { createSchema, createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';
import { maskGraphQLError } from './logging.js';
import { csrfPreventionPlugin, introspectionGuardPlugin } from './security.js';

// Serveur yoga minimal branché comme dans index.ts : l'utilisateur est « connecté » si la requête porte x-user.
const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        ok: String!
      }
      type Mutation {
        touch: String!
      }
    `,
    resolvers: { Query: { ok: () => 'ok' }, Mutation: { touch: () => 'touched' } },
  }),
  logging: false,
  plugins: [csrfPreventionPlugin(), introspectionGuardPlugin()],
  maskedErrors: { maskError: maskGraphQLError },
  context: ({ request }) => ({ user: request.headers.get('x-user') ? { id: 'u1' } : null, roles: new Map() }),
});

const post = (body: BodyInit, headers: Record<string, string>) => yoga.fetch('http://localhost/graphql', { method: 'POST', headers, body });
const json = (query: string, headers: Record<string, string> = {}) => post(JSON.stringify({ query }), { 'content-type': 'application/json', ...headers });

describe('prévention CSRF', () => {
  it('accepte une requête JSON (client Apollo)', async () => {
    const res = await json('mutation { touch }');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { touch: 'touched' } });
  });

  it('refuse une requête « simple » sans en-tête de prévention (formulaire, text/plain)', async () => {
    const form = new FormData();
    form.set('operations', JSON.stringify({ query: 'mutation { touch }' }));
    form.set('map', '{}');
    const multipart = await post(form, {});
    expect(multipart.status).toBe(403);

    const plain = await post(JSON.stringify({ query: 'mutation { touch }' }), { 'content-type': 'text/plain' });
    expect(plain.status).toBe(403);
    const urlencoded = await post('query=mutation%20%7B%20touch%20%7D', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(urlencoded.status).toBe(403);
  });

  it("laisse passer une requête simple qui porte l'en-tête de prévention", async () => {
    const res = await post(JSON.stringify({ query: '{ ok }' }), { 'content-type': 'text/plain', 'x-graphql-yoga-csrf': '1' });
    expect(res.status).not.toBe(403);
  });

  it('laisse passer les GET (sondes de déploiement), sans mutation', async () => {
    const res = await yoga.fetch('http://localhost/graphql?query=%7B__typename%7D');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { __typename: 'Query' } });
  });
});

describe('introspection', () => {
  const introspection = '{ __schema { queryType { name } } }';

  it('est refusée sans utilisateur connecté', async () => {
    const body = await (await json(introspection)).json();
    expect(body.data).toBeUndefined();
    expect(body.errors[0].message).toMatch(/réservée aux utilisateurs connectés/);
    const type = await (await json('{ __type(name: "Mutation") { fields { name } } }')).json();
    expect(type.errors[0].message).toMatch(/réservée/);
  });

  it('est refusée aussi cachée dans un fragment', async () => {
    const body = await (await json('query { ...F } fragment F on Query { __schema { types { name } } }')).json();
    expect(body.errors?.[0].message).toMatch(/réservée/);
  });

  it('répond à un utilisateur connecté', async () => {
    const body = await (await json(introspection, { 'x-user': '1' })).json();
    expect(body).toEqual({ data: { __schema: { queryType: { name: 'Query' } } } });
  });

  it('laisse __typename et les requêtes ordinaires aux visiteurs', async () => {
    expect(await (await json('{ __typename ok }')).json()).toEqual({ data: { __typename: 'Query', ok: 'ok' } });
  });
});
