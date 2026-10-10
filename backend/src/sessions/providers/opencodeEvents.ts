import { parseRule, ruleMatches } from '../../permissions/rules.js';

/**
 * Traductions pures de l'exécuteur OpenCode (ni processus ni réseau) : les outils, demandes d'autorisation
 * et questions d'OpenCode dans les formes que Skipper connaît déjà — noms et entrées des outils Claude Code
 * du transcript, règles d'autorisation des projets (format Claude Code) et demandes de question. Le
 * transcript d'une session OpenCode se lit donc comme celui d'une session Claude.
 */

type Input = Record<string, unknown>;

export interface ToolCall {
  name: string;
  input: Input;
}

/** Morceau de diff dans la forme `structuredPatch` que le transcript affiche. */
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** Suggestion d'autorisation, dans la forme `PermissionUpdate` du Agent SDK que Skipper mémorise. */
export type Suggestion = { type: 'addRules'; behavior: 'allow'; destination: 'session'; rules: { toolName: string; ruleContent?: string }[] } | { type: 'setMode'; mode: string; destination: 'session' };

const str = (o: Input, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined);

/** Outils intégrés d'OpenCode qui modifient des fichiers (le mode `acceptEdits` les autorise). */
export const OPENCODE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);

/** Outil MCP d'un serveur connu : OpenCode le nomme `<serveur>_<outil>`. Le nom de serveur le plus long gagne. */
export function mcpToolOf(tool: string, servers: string[]): { server: string; tool: string } | null {
  const server = [...servers].sort((a, b) => b.length - a.length).find((s) => tool.startsWith(`${s}_`) && tool.length > s.length + 1);
  return server ? { server, tool: tool.slice(server.length + 1) } : null;
}

/** Questions d'OpenCode → questions `AskUserQuestion` des demandes de Skipper. */
export function claudeQuestions(questions: unknown): { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[] {
  return (Array.isArray(questions) ? questions : []).map((q: Input) => ({
    question: String(q.question ?? ''),
    ...(typeof q.header === 'string' ? { header: q.header } : {}),
    ...(q.multiple ? { multiSelect: true } : {}),
    options: (Array.isArray(q.options) ? q.options : []).map((o: Input) => ({ label: String(o.label ?? ''), ...(typeof o.description === 'string' ? { description: o.description } : {}) })),
  }));
}

/**
 * Un appel d'outil OpenCode comme l'outil Claude Code équivalent (nom et entrée), pour que le transcript,
 * l'onglet « Modifications » et les règles d'autorisation le traitent pareil. Les outils MCP deviennent
 * `mcp__<serveur>__<outil>` ; les outils inconnus gardent leur nom.
 */
export function claudeTool(tool: string, input: Input, mcpServers: string[]): ToolCall {
  switch (tool) {
    case 'bash':
      return { name: 'Bash', input: { command: str(input, 'command') ?? '', ...(input.description ? { description: input.description } : {}) } };
    case 'read':
      return { name: 'Read', input: { file_path: str(input, 'filePath') ?? '', ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } };
    case 'write':
      return { name: 'Write', input: { file_path: str(input, 'filePath') ?? '', content: str(input, 'content') ?? '' } };
    case 'edit':
      return { name: 'Edit', input: { file_path: str(input, 'filePath') ?? '', old_string: str(input, 'oldString') ?? '', new_string: str(input, 'newString') ?? '', ...(input.replaceAll ? { replace_all: true } : {}) } };
    case 'glob':
      return { name: 'Glob', input: { pattern: str(input, 'pattern') ?? '', ...(input.path ? { path: input.path } : {}) } };
    case 'grep':
      return { name: 'Grep', input: { pattern: str(input, 'pattern') ?? '', ...(input.path ? { path: input.path } : {}), ...(input.include ? { glob: input.include } : {}) } };
    case 'list':
      return { name: 'LS', input: { path: str(input, 'path') ?? '' } };
    case 'webfetch':
      return { name: 'WebFetch', input: { url: str(input, 'url') ?? '', ...(input.format ? { format: input.format } : {}) } };
    case 'websearch':
      return { name: 'WebSearch', input: { query: str(input, 'query') ?? '' } };
    case 'task':
      return { name: 'Task', input: { description: str(input, 'description') ?? '', prompt: str(input, 'prompt') ?? '', subagent_type: str(input, 'subagent_type') ?? str(input, 'subagentType') ?? 'general' } };
    case 'todowrite':
      return { name: 'TodoWrite', input: { todos: Array.isArray(input.todos) ? input.todos : [] } };
    case 'skill':
      return { name: 'Skill', input: { skill: str(input, 'name') ?? '' } };
    case 'question':
      return { name: 'AskUserQuestion', input: { questions: claudeQuestions(input.questions) } };
    default: {
      const mcp = mcpToolOf(tool, mcpServers);
      return mcp ? { name: `mcp__${mcp.server}__${mcp.tool}`, input } : { name: tool, input };
    }
  }
}

/** Diff unifié (tel qu'OpenCode rapporte une modification) → les morceaux que le transcript affiche. */
export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) current.lines.push(line);
  }
  return hunks.filter((h) => h.lines.length);
}

/** Résultat structuré d'un outil terminé, dans la forme `tool_use_result` du Agent SDK que le transcript lit. */
export function toolResultData(tool: string, input: Input, output: string, metadata: Input): Input {
  switch (tool) {
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch': {
      const diff = typeof metadata.diff === 'string' ? metadata.diff : null;
      const hunks = diff ? parseUnifiedDiff(diff) : [];
      if (tool === 'write' && metadata.exists === false) return { type: 'create', content: str(input, 'content') ?? '' };
      return hunks.length ? { structuredPatch: hunks } : {};
    }
    case 'bash':
      return { stdout: typeof metadata.output === 'string' ? metadata.output : output, stderr: '' };
    case 'question': {
      const questions = Array.isArray(input.questions) ? (input.questions as Input[]) : [];
      const replies = Array.isArray(metadata.answers) ? (metadata.answers as unknown[]) : [];
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        const a = replies[i];
        if (Array.isArray(a) && a.length) answers[String(q.question ?? '')] = a.map(String).join(', ');
      });
      return { answers };
    }
    default:
      return {};
  }
}

/** Forme d'une demande d'autorisation d'OpenCode (événement `permission.asked`). */
export interface OpencodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Input;
  always: string[];
  tool?: { messageID: string; callID: string };
}

/** L'outil visé par une demande, comme outil Claude Code. `call` : la partie d'outil déjà connue (son entrée est la plus précise). */
export function permissionTool(req: OpencodePermissionRequest, call: { tool: string; input: Input } | null, mcpServers: string[]): ToolCall {
  if (req.permission === 'external_directory') return { name: 'Read', input: { file_path: req.patterns[0] ?? str(req.metadata, 'filepath') ?? '' } };
  if (call && Object.keys(call.input).length) {
    const mapped = claudeTool(call.tool, call.input, mcpServers);
    if (req.permission === 'edit' && typeof req.metadata.diff === 'string') return { ...mapped, input: { ...mapped.input, diff: req.metadata.diff } };
    return mapped;
  }
  switch (req.permission) {
    case 'bash':
      return { name: 'Bash', input: { command: str(req.metadata, 'command') ?? req.patterns.join(' && ') } };
    case 'edit':
      return { name: 'Edit', input: { file_path: str(req.metadata, 'filepath') ?? req.patterns[0] ?? '', ...(typeof req.metadata.diff === 'string' ? { diff: req.metadata.diff } : {}) } };
    case 'read':
      return { name: 'Read', input: { file_path: req.patterns[0] ?? '' } };
    case 'webfetch':
      return { name: 'WebFetch', input: { url: str(req.metadata, 'url') ?? req.patterns[0] ?? '' } };
    case 'websearch':
      return { name: 'WebSearch', input: { query: str(req.metadata, 'query') ?? req.patterns[0] ?? '' } };
    case 'task':
      return { name: 'Task', input: { subagent_type: req.patterns[0] ?? '', description: str(req.metadata, 'description') ?? '' } };
    case 'skill':
      return { name: 'Skill', input: { skill: req.patterns[0] ?? '' } };
    default:
      return claudeTool(req.permission, req.metadata, mcpServers);
  }
}

/** Titre de la demande présentée à l'humain, pour les cas que l'outil seul n'explique pas. */
export function permissionTitle(req: OpencodePermissionRequest): string | null {
  if (req.permission === 'external_directory') return `Accéder à un emplacement hors du dossier du projet : ${req.patterns.join(', ')}`;
  if (req.permission === 'doom_loop') return "L'agent répète le même appel d'outil : continuer ?";
  return null;
}

/** Règles suggérées pour mémoriser une demande acceptée (format Claude Code) : préfixes de commandes proposés par OpenCode pour Bash, mode acceptEdits pour les modifications de fichiers, tout l'outil sinon. */
export function permissionSuggestions(req: OpencodePermissionRequest, tool: ToolCall): Suggestion[] {
  if (req.permission === 'edit') return [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  if (req.permission === 'doom_loop' || req.permission === 'external_directory') return [];
  if (tool.name === 'Bash') {
    const patterns = req.always.filter((p) => p && p !== '*');
    return patterns.length ? [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: patterns.map((p) => ({ toolName: 'Bash', ruleContent: p })) }] : [];
  }
  if (tool.name === 'WebFetch' && typeof tool.input.url === 'string') {
    try {
      return [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'WebFetch', ruleContent: `domain:${new URL(tool.input.url).hostname}` }] }];
    } catch {
      return [];
    }
  }
  return [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: tool.name }] }];
}

/** Vrai quand l'une des règles (format Claude Code : `Bash(git *)`, `Edit`, `mcp__tasks__*`) autorise l'appel. */
export function allowedByRules(rules: string[], tool: ToolCall, cwd: string): boolean {
  return rules.some((text) => {
    const rule = parseRule(text);
    return rule !== null && ruleMatches(rule, tool.name, tool.input, cwd);
  });
}

/** Réponses d'une demande de question de Skipper (question → libellé choisi, plusieurs séparés par « , ») dans la forme d'OpenCode : une liste de libellés par question, dans l'ordre. */
export function opencodeAnswers(questions: unknown, answers: Record<string, unknown>): string[][] {
  return (Array.isArray(questions) ? questions : []).map((q: Input) => {
    const value = answers[String(q.question ?? '')];
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value.map(String);
    const text = String(value);
    const labels = new Set((Array.isArray(q.options) ? q.options : []).map((o: Input) => String(o.label ?? '')));
    if (labels.has(text)) return [text];
    const parts = text.split(', ');
    return q.multiple && parts.every((p) => labels.has(p)) ? parts : [text];
  });
}
