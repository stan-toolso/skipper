import { createSchema, createYoga } from 'graphql-yoga';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError, NotFoundError } from '../errors.js';
import { logOutput, setLogLevel } from '../log.js';
import { appErrorLogPlugin, maskGraphQLError, yogaLogger } from './logging.js';

// Serveur yoga minimal branché comme dans index.ts : logger, plugin et masquage des erreurs.
const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        ok: String!
        refused: String!
        missing: String!
        broken: String!
      }
    `,
    resolvers: {
      Query: {
        ok: () => 'ok',
        refused: () => {
          throw new AppError('Aucune branche de base à comparer');
        },
        missing: () => {
          throw new NotFoundError('Tâche introuvable');
        },
        broken: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'id')");
        },
      },
    },
  }),
  logging: yogaLogger,
  plugins: [appErrorLogPlugin()],
  maskedErrors: { maskError: maskGraphQLError },
  context: () => ({ user: { email: 'stan@example.com' } }),
});

const out: string[] = [];
const err: string[] = [];
logOutput.stdout = (line) => void out.push(line);
logOutput.stderr = (line) => void err.push(line);

async function query(document: string) {
  const res = await yoga.fetch('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: document }) });
  return { status: res.status, body: (await res.json()) as { data: Record<string, unknown> | null; errors?: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }> } };
}

beforeEach(() => {
  setLogLevel('info');
  out.length = 0;
  err.length = 0;
});

describe('journal GraphQL', () => {
  it("une erreur métier : une ligne warn avec l'opération, le chemin et l'utilisateur, sans trace", async () => {
    const { status, body } = await query('query GitBranchChanges { refused }');
    expect(status).toBe(200);
    expect(body.errors).toEqual([expect.objectContaining({ message: 'Aucune branche de base à comparer', path: ['refused'], extensions: { code: 'BAD_REQUEST' } })]);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).not.toContain('\n');
    expect(err[0]).toMatch(/ WARN  \[graphql\] GitBranchChanges · refused · stan@example.com : Aucune branche de base à comparer$/);
  });

  it('une erreur NotFound est renvoyée avec son code et journalisée de la même façon', async () => {
    const { body } = await query('{ missing }');
    expect(body.errors?.[0]).toMatchObject({ message: 'Tâche introuvable', extensions: { code: 'NOT_FOUND' } });
    expect(err).toEqual([expect.stringMatching(/WARN  \[graphql\] \(anonyme\) · missing · stan@example.com : Tâche introuvable$/)]);
  });

  it('une erreur inattendue est masquée pour le client et journalisée en error avec sa trace', async () => {
    const { body } = await query('query Broken { broken }');
    expect(body.errors?.[0].message).toBe('Unexpected error.');
    expect(err).toHaveLength(1);
    const lines = err[0].split('\n');
    expect(lines[0]).toMatch(/ ERROR \[graphql\] broken : TypeError : Cannot read properties of undefined \(reading 'id'\)$/);
    expect(lines.slice(1).some((l) => /^\s+at /.test(l))).toBe(true);
  });

  it('une requête réussie ne journalise rien au niveau info', async () => {
    const { body } = await query('{ ok }');
    expect(body.data).toEqual({ ok: 'ok' });
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });
});

describe('yogaLogger hors exécution', () => {
  it("journalise une erreur métier non vue par le plugin en une ligne warn, sans la répéter si elle l'a été", () => {
    yogaLogger.error(new AppError('Connexion requise'));
    expect(err).toEqual([expect.stringMatching(/WARN  \[graphql\] Connexion requise$/)]);
    yogaLogger.error('Request failed', new Error('socket hang up'));
    expect(err[1]).toMatch(/ERROR \[graphql\] Request failed Error : socket hang up\n/);
  });
});
