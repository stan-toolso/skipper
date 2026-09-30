// Valide les requêtes GraphQL du front (gql`…`) contre le schéma du backend : syntaxe, champs, arguments,
// fragments. Exécuté par `npm run typecheck` et `npm run build` : tsc ne voit pas l'intérieur des gabarits
// gql, qui ne sont analysés qu'à l'exécution, dans le navigateur (une accolade perdue dans une fusion
// donnait une page blanche en production).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema, Kind, parse, validate, visit } from 'graphql';

const root = fileURLToPath(new URL('..', import.meta.url));
const schema = buildSchema(readFileSync(path.join(root, '../backend/src/graphql/schema.graphql'), 'utf8'));

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

// Documents gql`…` : les inclusions de fragments (`${SESSION_FIELDS}`) sont retirées, les fragments étant
// rattachés ensuite par leur nom. Un document construit à partir d'autres valeurs (paramètres d'une
// fonction) ne se valide pas statiquement : il est ignoré.
const documents = [];
let dynamic = 0;
for (const file of sources(path.join(root, 'src'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/gql`([\s\S]*?)`/g)) {
    const interpolations = [...match[1].matchAll(/\$\{\s*([^}]*?)\s*\}/g)].map((m) => m[1]);
    if (interpolations.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
      dynamic++;
      continue;
    }
    documents.push({ file: path.relative(root, file), text: match[1].replace(/\$\{[^}]*\}/g, '') });
  }
}

const errors = [];
const fragments = new Map();
for (const doc of documents) {
  try {
    doc.ast = parse(doc.text);
    for (const def of doc.ast.definitions) if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  } catch (err) {
    errors.push(`${doc.file} : ${err.message}`);
  }
}

/** Fragments utilisés par un nœud, y compris ceux utilisés par ces fragments. */
function usedFragments(node, found = new Map()) {
  visit(node, {
    FragmentSpread(spread) {
      const name = spread.name.value;
      if (found.has(name) || !fragments.has(name)) return;
      found.set(name, fragments.get(name));
      usedFragments(fragments.get(name), found);
    },
  });
  return found;
}

let operations = 0;
for (const doc of documents) {
  const ops = doc.ast?.definitions.filter((def) => def.kind === Kind.OPERATION_DEFINITION) ?? [];
  if (!ops.length) continue;
  operations += ops.length;
  const definitions = [...ops, ...usedFragments({ kind: Kind.DOCUMENT, definitions: ops }).values()];
  for (const err of validate(schema, { kind: Kind.DOCUMENT, definitions })) {
    errors.push(`${doc.file} (${ops.map((op) => op.name?.value ?? 'anonyme').join(', ')}) : ${err.message}`);
  }
}

if (errors.length) {
  console.error(`[graphql] ${errors.length} erreur(s) dans les requêtes du front :\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`[graphql] ${operations} requêtes et ${fragments.size} fragments valides${dynamic ? ` (${dynamic} construite(s) dynamiquement, non vérifiée(s))` : ''}`);
