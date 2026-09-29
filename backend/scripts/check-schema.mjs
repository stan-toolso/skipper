// Valide le schéma GraphQL (syntaxe et cohérence) : exécuté par `npm run typecheck` et `npm run build`.
import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
try {
  buildSchema(readFileSync(new URL('../src/graphql/schema.graphql', import.meta.url), 'utf8'));
  console.log('[schema] schéma GraphQL valide');
} catch (err) {
  console.error('[schema] schéma GraphQL invalide :', err.message);
  process.exit(1);
}
