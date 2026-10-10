// Serveur factice pour vérifier l'interface sans backend ni base : sert le build du frontend et répond à
// /graphql avec des données générées depuis le vrai schéma (textes longs, listes de 3 éléments, dates…).
//
//   cd frontend && VITE_GRAPHQL_URL=http://127.0.0.1:4555/graphql NODE_OPTIONS=--max-old-space-size=900 \
//     npx vite build --outDir /tmp/skipper-mobile-dist
//   DIST=/tmp/skipper-mobile-dist node scripts/mobile-audit/mock-server.mjs     # PORT=4555 par défaut
//
// Les données sont inventées : les écrans servent à juger la mise en page, pas le contenu.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const { buildSchema, parse, execute, isNonNullType, isListType, isObjectType, isInterfaceType, isUnionType, isEnumType, isScalarType } = require('graphql');

const DIST = process.env.DIST || '/tmp/skipper-mobile-dist';
const PORT = Number(process.env.PORT || 4555);
const schema = buildSchema(fs.readFileSync(path.join(repo, 'backend/src/graphql/schema.graphql'), 'utf8'));

let counter = 0;
const LONG = "Je voudrais que tu me prépares un rapport détaillé sur la trésorerie du groupe pour l'année 2026-2027, avec les camps et les cotisations";
const PARA = `${LONG}. Deuxième phrase assez longue pour vérifier le retour à la ligne sur un écran étroit, avec un chemin /home/skipper/skipper-workspaces/projet/sous-dossier/fichier-au-nom-tres-long.html et une URL https://example.com/un/chemin/assez/long/pour/deborder.`;

/** Valeur d'un scalaire d'après son type et le nom du champ. */
function scalar(type, field, parentType) {
  const f = field.toLowerCase();
  counter++;
  switch (type.name) {
    case 'ID':
      // Dossiers parents absents : les éléments apparaissent à la racine des arbres (contexte, explorateur).
      return /folderid$|^parentid$/.test(f) ? null : `${parentType}-${field}-${counter}`;
    case 'Int':
      return f.includes('count') || f.includes('total') ? 12 : f.includes('percent') ? 75 : 3;
    case 'Float':
      return f.includes('cost') || f.includes('usd') ? 12.3456 : 0.5;
    case 'Boolean':
      return /exists|enabled|active|configured|connected|^is|^has|^can|visible|^ok|healthy|available|^staged/.test(f);
    case 'DateTime':
      return new Date(Date.now() - counter * 3600_000).toISOString();
    case 'JSON':
      return f === 'definition' ? { nodes: [], edges: [] } : {};
    default:
      if (f === 'email' || f.endsWith('email')) return 'prenom.nom@exemple.fr';
      if (f.includes('avatar')) return null;
      if (f.includes('url') || f.includes('link')) return 'https://github.com/stan-toolso/skipper/pull/123';
      if (f === 'path' || f.endsWith('path') || f === 'cwd' || f.includes('dir')) return '/home/skipper/skipper-workspaces/projet/sous-dossier/fichier-au-nom-tres-long.html';
      if (f.includes('branch')) return 'feature/une-branche-au-nom-assez-long';
      if (f.includes('slug')) return 'projet-slug';
      if (f === 'hash' || f.includes('sha') || f.includes('commit')) return 'abc1234def5678';
      if (f === 'name' && /^File/.test(parentType)) return counter % 2 ? 'Previsionnel_2026-2027.html' : 'index.ts';
      if (f === 'name' || f === 'label' || f === 'title' || f === 'subject') return `${LONG.slice(0, 48)} ${counter}`;
      if (f.includes('model')) return 'claude-opus-4-1';
      if (f.includes('version')) return '1.2.3';
      if (f.includes('color')) return '#d97757';
      if (/content|text|body|description|message|prompt|instruction|summary|output|error|reason|question|answer|command|stdout|stderr|markdown|transcript|notes|html/.test(f)) return PARA;
      if (f.includes('kind') || f.includes('type') || f.includes('status') || f.includes('state') || f.includes('role')) return 'claude';
      return `Texte ${counter}`;
  }
}
function value(type, field, parentType, depth) {
  if (isNonNullType(type)) return value(type.ofType, field, parentType, depth);
  if (isListType(type)) return Array.from({ length: depth > 6 ? 0 : 3 }, () => value(type.ofType, field, parentType, depth + 1));
  if (isEnumType(type)) {
    const vals = type.getValues().map((v) => v.name);
    return vals[counter++ % vals.length];
  }
  if (isScalarType(type)) return scalar(type, field, parentType);
  if (isObjectType(type)) return { __typename: type.name, __depth: depth };
  if (isInterfaceType(type) || isUnionType(type)) {
    const impls = schema.getPossibleTypes(type);
    return { __typename: impls[counter++ % impls.length].name, __depth: depth };
  }
  return null;
}
const fieldResolver = (source, _args, _ctx, info) => {
  if (source && typeof source === 'object' && info.fieldName in source) return source[info.fieldName];
  return value(info.returnType, info.fieldName, info.parentType.name, ((source && source.__depth) || 0) + 1);
};
const typeResolver = (v) => v.__typename;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (url.pathname === '/graphql' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      try {
        const { query, variables } = JSON.parse(body);
        return res.end(JSON.stringify(await execute({ schema, document: parse(query), variableValues: variables, fieldResolver, typeResolver, rootValue: {} })));
      } catch (e) {
        return res.end(JSON.stringify({ errors: [{ message: String(e) }] }));
      }
    }
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
      res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:sans-serif;padding:16px"><h1>Aperçu</h1><p>Contenu de la page servie par le backend.</p></body></html>');
    }
    let p = path.join(DIST, decodeURIComponent(url.pathname));
    if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Serveur factice sur http://127.0.0.1:${PORT} (build : ${DIST})`));
