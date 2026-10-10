/**
 * Modèles de prompt : des emplacements `{{ chemin }}` résolus contre un objet de contexte, pour les modèles
 * d'instruction des agents et les entrées des nœuds de workflow. Fonctions pures, sans dépendance.
 *
 * Les chemins sont pointés : `input.ticket`, `nodes.review.output`, `nodes.review.json.approved`. Une clé nue
 * (`{{ticket}}`) retombe sur `input.<clé>`. Objets et tableaux sont rendus en JSON, une valeur absente en
 * chaîne vide. `{{ chemin | default: "texte" }}` rend le repli quand la valeur est vide.
 */

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Lit un chemin pointé dans un contexte (`a.b.0.c`) ; undefined si un segment manque. */
export function lookup(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Résout un chemin, avec le raccourci `input.` pour les clés nues. */
export function resolve(context: unknown, path: string): unknown {
  const direct = lookup(context, path);
  if (direct !== undefined) return direct;
  if (!path.includes('.') && context && typeof context === 'object' && 'input' in (context as Record<string, unknown>)) return lookup(context, `input.${path}`);
  return undefined;
}

/** Forme textuelle d'une valeur dans un prompt : chaînes telles quelles, scalaires convertis, structures en JSON. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

function parseDefault(modifier: string): string | null {
  const m = modifier.match(/^default\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.*))$/);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? '';
  return raw.replace(/\\(.)/g, '$1');
}

/** Rend un modèle contre un contexte. Les emplacements inconnus rendent une chaîne vide. */
export function render(template: string, context: unknown): string {
  return template.replace(PLACEHOLDER, (_m, inner: string) => {
    const [pathPart, ...modifiers] = inner.split('|').map((s) => s.trim());
    const value = resolve(context, pathPart);
    if (isEmpty(value)) {
      for (const modifier of modifiers) {
        const fallback = parseDefault(modifier);
        if (fallback !== null) return fallback;
      }
      return '';
    }
    return stringify(value);
  });
}

/** Chemins référencés par un modèle, dans l'ordre d'apparition (dédoublonnés). */
export function placeholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const path = m[1].split('|')[0].trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Extrait une valeur JSON de la réponse d'un agent : tout le texte, un bloc ```json, ou le premier objet/tableau équilibré. Null si rien ne se lit. */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1].trim());
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const balanced = balancedSlice(trimmed, start);
    if (balanced) candidates.push(balanced);
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      /* candidat suivant */
    }
  }
  return null;
}

/** La sous-chaîne de `start` au crochet fermant correspondant, chaînes respectées. */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
