import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

/**
 * Règles d'autorisation au format Claude Code : `Outil` ou `Outil(motif)`. Ce module les analyse, les ramène à
 * une forme canonique (pour ne pas mémoriser deux fois la même règle) et reproduit, de façon approchée, la
 * correspondance entre une règle et un appel d'outil (pour dater la dernière utilisation d'une règle).
 */

export interface ParsedRule {
  toolName: string;
  ruleContent: string | null;
}

const TOOL_RE = /^[A-Za-z0-9_:.*-]+$/;

/** Analyse `Bash(git add *)`, `Read` ou `mcp__tasks` ; null si la forme est invalide. */
export function parseRule(text: string): ParsedRule | null {
  const s = text.trim();
  const open = s.indexOf('(');
  if (open === -1) return TOOL_RE.test(s) ? { toolName: s, ruleContent: null } : null;
  if (!s.endsWith(')')) return null;
  const toolName = s.slice(0, open).trim();
  if (!TOOL_RE.test(toolName)) return null;
  return { toolName, ruleContent: s.slice(open + 1, -1).trim() || null };
}

/**
 * Forme canonique du motif : espaces superflus retirés et, pour Bash, préfixe écrit `git add *` (syntaxe
 * actuelle de Claude Code) plutôt que `git add:*` (ancienne syntaxe, équivalente).
 */
export function canonicalContent(toolName: string, content: string | null | undefined): string | null {
  const c = content?.trim();
  if (!c) return null;
  if (toolName !== 'Bash') return c;
  return c.replace(/\s*:\*$/, ' *');
}

/** Préfixe d'un motif Bash `préfixe *` (null si le motif n'est pas un simple préfixe). */
function bashPrefix(content: string): string | null {
  if (content === '*') return '';
  if (!content.endsWith(' *')) return null;
  const prefix = content.slice(0, -2).trim();
  return prefix.includes('*') ? null : prefix;
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Correspondance d'une commande (un segment, sans opérateur) avec un motif Bash canonique. */
export function bashMatches(content: string, command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, ' ');
  const prefix = bashPrefix(content);
  if (prefix !== null) return prefix === '' || cmd === prefix || cmd.startsWith(`${prefix} `);
  if (!content.includes('*')) return cmd === content;
  return new RegExp(`^${content.split('*').map(escapeRe).join('.*')}$`, 's').test(cmd);
}

/**
 * Découpe une commande shell en commandes simples, aux opérateurs `&&`, `||`, `;`, `|` et aux retours à la
 * ligne situés hors des guillemets.
 */
export function splitShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** La règle `a` autorise-t-elle tout ce qu'autorise `b` (même outil) ? Sert à éviter les doublons. */
export function covers(a: ParsedRule, b: ParsedRule): boolean {
  if (a.toolName !== b.toolName) return false;
  const ca = canonicalContent(a.toolName, a.ruleContent);
  const cb = canonicalContent(b.toolName, b.ruleContent);
  if (ca === null) return true;
  if (cb === null) return false;
  if (ca === cb) return true;
  if (a.toolName !== 'Bash') return false;
  const pa = bashPrefix(ca);
  if (pa === null) return false;
  const pb = bashPrefix(cb);
  // `git *` couvre `git add *` et `git add -A` ; un motif à jokers internes n'est comparé qu'à l'identique.
  if (pb !== null) return pa === '' || pb === pa || pb.startsWith(`${pa} `);
  return !cb.includes('*') && bashMatches(ca, cb);
}

/** Outils concernés par un motif de chemin d'une règle Read ou Edit (comme dans Claude Code). */
const PATH_TOOLS: Record<string, string[]> = {
  Read: ['Read', 'Glob', 'Grep', 'LS'],
  Edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
};

/** Motif de chemin (syntaxe gitignore de Claude Code) en expression régulière sur un chemin absolu. */
function pathPattern(content: string, cwd: string): RegExp {
  let p = content;
  if (p.startsWith('//')) p = p.slice(1);
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  else p = join(cwd, p);
  const body = normalize(p)
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => (part === '**' || part === '**/' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeRe(part)))
    .join('');
  // Un motif sans joker désigne aussi le contenu d'un dossier.
  return new RegExp(/[*?]/.test(content) ? `^${body}$` : `^${body}(/.*)?$`);
}

/**
 * La règle correspond-elle à cet appel d'outil ? Approximation des règles de Claude Code, suffisante pour
 * savoir si une règle mémorisée sert encore : outil entier, serveur MCP, préfixe de commande Bash (sur
 * chaque commande d'une commande composée), motif de chemin pour Read/Edit, domaine pour WebFetch.
 */
export function ruleMatches(rule: ParsedRule, toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  if (rule.ruleContent === null) {
    if (rule.toolName === toolName) return true;
    // `mcp__serveur` et `mcp__serveur__*` couvrent tous les outils du serveur.
    const server = rule.toolName.replace(/__\*$/, '');
    return server.startsWith('mcp__') && server.split('__').length === 2 && toolName.startsWith(`${server}__`);
  }
  const content = canonicalContent(rule.toolName, rule.ruleContent)!;
  if (rule.toolName === 'Bash') {
    if (toolName !== 'Bash' || typeof input.command !== 'string') return false;
    return bashMatches(content, input.command) || splitShellCommand(input.command).some((c) => bashMatches(content, c));
  }
  if (PATH_TOOLS[rule.toolName]) {
    if (!PATH_TOOLS[rule.toolName].includes(toolName)) return false;
    const raw = [input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === 'string');
    if (!raw) return false;
    const file = isAbsolute(raw) ? normalize(raw) : join(cwd, raw);
    return pathPattern(content, cwd).test(file);
  }
  if (rule.toolName === 'WebFetch') {
    if (toolName !== 'WebFetch' || typeof input.url !== 'string' || !content.startsWith('domain:')) return false;
    const domain = content.slice('domain:'.length).toLowerCase();
    try {
      const host = new URL(input.url).hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  }
  return false;
}
