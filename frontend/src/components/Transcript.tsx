import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent } from '../graphql/operations';
import { describeTool, formatCost, formatDuration, permissionModeLabels } from '../lib/humanize';
import Markdown from './Markdown';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ToolResult {
  text: string;
  isError: boolean;
  /** Résultat structuré fourni par le SDK (`tool_use_result`) : patch d'une modification, lignes lues, sorties... */
  data: Record<string, unknown>;
}

/** Portion de diff telle que la fournit Claude Code (`structuredPatch`) ; sans numéros si `oldStart` est absent. */
interface Hunk {
  oldStart?: number;
  newStart?: number;
  lines: string[];
}

type Input = Record<string, unknown>;

/** Lignes de sortie affichées avant « … +N lignes ». */
const OUTPUT_LINES = 3;
/** Lignes d'un fichier créé affichées avant « … +N lignes ». */
const PREVIEW_LINES = 10;
/** Lignes de diff affichées avant « … +N lignes ». */
const DIFF_LINES = 40;

const str = (o: Input, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined);
const num = (o: Input, key: string): number | undefined => (typeof o[key] === 'number' ? (o[key] as number) : undefined);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

/** Arguments d'un outil sans affichage dédié : `clé: "valeur", clé: 3`. */
function formatArgs(input: Input): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
}

/** Entête d'un appel d'outil, comme Claude Code : Bash(commande), Update(fichier), Search(pattern: "x")... */
function toolHeader(name: string, input: Input, rel: (path: string) => string): { name: string; args: string } {
  switch (name) {
    case 'Bash':
      return { name: 'Bash', args: str(input, 'command') ?? '' };
    case 'Read':
      return { name: 'Read', args: rel(str(input, 'file_path') ?? '') };
    case 'Write':
      return { name: 'Write', args: rel(str(input, 'file_path') ?? '') };
    case 'Edit':
    case 'NotebookEdit':
      return { name: 'Update', args: rel(str(input, 'file_path') ?? str(input, 'notebook_path') ?? '') };
    case 'Glob':
    case 'Grep': {
      const { path, ...rest } = input;
      return { name: 'Search', args: formatArgs(typeof path === 'string' ? { ...rest, path: rel(path) } : rest) };
    }
    case 'WebFetch':
      return { name: 'Fetch', args: str(input, 'url') ?? '' };
    case 'WebSearch':
      return { name: 'Web Search', args: JSON.stringify(str(input, 'query') ?? '') };
    case 'Task':
    case 'Agent': {
      const agent = str(input, 'subagent_type');
      return { name: agent && agent !== 'general-purpose' ? agent : 'Task', args: str(input, 'description') ?? '' };
    }
    case 'TodoWrite':
      return { name: 'Update Todos', args: '' };
    case 'Skill':
      return { name: 'Skill', args: str(input, 'skill') ?? '' };
    default: {
      // Outil MCP : « serveur - outil (MCP) », comme dans Claude Code.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return { name: mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : name, args: formatArgs(input) };
    }
  }
}

/** Texte tronqué à `limit` lignes, suivi de « … +N lignes » tant qu'il n'est pas déplié. */
function Output({ text, limit, expanded }: { text: string; limit: number; expanded: boolean }) {
  const lines = text.replace(/\n+$/, '').split('\n');
  const shown = expanded ? lines : lines.slice(0, limit);
  const hidden = lines.length - shown.length;
  return (
    <>
      {shown.join('\n')}
      {hidden > 0 && <span className="cc-more">{`\n… +${plural(hidden, 'ligne', 'lignes')} (cliquer pour déplier)`}</span>}
    </>
  );
}

/** Diff d'une modification, comme Claude Code : numéro de ligne, signe, fond vert ou rouge. */
function Patch({ hunks, expanded }: { hunks: Hunk[]; expanded: boolean }) {
  const rows: Array<{ n: number | null; sign: string; text: string }> = [];
  hunks.forEach((hunk, i) => {
    if (i > 0) rows.push({ n: null, sign: '', text: '…' });
    let oldLine = hunk.oldStart ?? NaN;
    let newLine = hunk.newStart ?? NaN;
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === '\\') continue; // « \ No newline at end of file »
      if (sign === '-') rows.push({ n: oldLine++, sign, text: line.slice(1) });
      else {
        rows.push({ n: newLine++, sign: sign === '+' ? '+' : ' ', text: line.slice(1) });
        if (sign !== '+') oldLine++;
      }
    }
  });
  const shown = expanded ? rows : rows.slice(0, DIFF_LINES);
  const hidden = rows.length - shown.length;
  const width = String(rows.reduce((max, r) => (r.n && r.n > max ? r.n : max), 0)).length;
  return (
    <div className="cc-diff">
      {shown.map((r, i) => (
        <div key={i} className={`cc-diff-line${r.sign === '+' ? ' add' : r.sign === '-' ? ' del' : ''}`}>
          <span className="cc-diff-num" style={{ width: `${width}ch` }}>
            {r.n || ''}
          </span>
          <span className="cc-diff-sign">{r.sign}</span>
          <span className="cc-diff-text">{r.text}</span>
        </div>
      ))}
      {hidden > 0 && <div className="cc-more">{`… +${plural(hidden, 'ligne', 'lignes')} (cliquer pour déplier)`}</div>}
    </div>
  );
}

function patchSummary(hunks: Hunk[]): string {
  const lines = hunks.flatMap((h) => h.lines);
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  const parts = [added ? plural(added, 'ligne ajoutée', 'lignes ajoutées') : '', removed ? plural(removed, 'ligne supprimée', 'lignes supprimées') : ''].filter(Boolean);
  return parts.join(', ') || 'Aucun changement';
}

function formatTokens(n: number): string {
  return n < 1000 ? `${n} tokens` : `${(n / 1000).toFixed(1).replace('.', ',')}k tokens`;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} Ko` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

/**
 * Corps d'un appel d'outil (sous le `⎿`), comme Claude Code : résumé pour les lectures et recherches,
 * diff pour les modifications, début de la sortie pour les commandes.
 */
function toolBody({ name, input, result, subCalls, expanded, rel }: { name: string; input: Input; result?: ToolResult; subCalls: number; expanded: boolean; rel: (path: string) => string }): React.ReactNode {
  if (name === 'TodoWrite') {
    const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<{ content?: string; status?: string }>;
    return (
      <>
        {todos.map((t, i) => (
          <div key={i} className={`cc-todo ${t.status ?? ''}`}>
            {t.status === 'completed' ? '☒' : '☐'} {t.content}
          </div>
        ))}
      </>
    );
  }
  if (!result) {
    // Modification pas encore appliquée (autorisation en attente, outil en cours) : le changement proposé.
    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      const lines = [...input.old_string.split('\n').map((l) => `-${l}`), ...input.new_string.split('\n').map((l) => `+${l}`)];
      return <Patch hunks={[{ lines }]} expanded={expanded} />;
    }
    if (name === 'AskUserQuestion') {
      const questions = (Array.isArray(input.questions) ? input.questions : []) as Array<{ question?: string }>;
      return <>{questions.map((q) => `· ${q.question ?? ''}`).join('\n')}</>;
    }
    if ((name === 'Task' || name === 'Agent') && subCalls > 0) return <>{`+${plural(subCalls, "appel d'outil", "appels d'outils")}`}</>;
    return null;
  }
  const { data } = result;
  if (result.isError) {
    const text = result.text.replace(/<\/?tool_use_error>/g, '').trim();
    return <Output text={text || 'Erreur'} limit={OUTPUT_LINES} expanded={expanded} />;
  }
  const hunks = Array.isArray(data.structuredPatch) ? (data.structuredPatch as Hunk[]) : [];
  switch (name) {
    case 'Edit':
    case 'NotebookEdit':
    case 'Write': {
      if (hunks.length) {
        return (
          <>
            {patchSummary(hunks)}
            <Patch hunks={hunks} expanded={expanded} />
          </>
        );
      }
      const content = str(data, 'content') ?? str(input, 'content');
      if (name === 'Write' && content !== undefined) {
        const lines = content.replace(/\n$/, '').split('\n');
        return (
          <>
            {`${plural(lines.length, 'ligne écrite', 'lignes écrites')} dans ${rel(str(input, 'file_path') ?? '')}`}
            <Patch hunks={[{ newStart: 1, lines: (expanded ? lines : lines.slice(0, PREVIEW_LINES)).map((l) => ` ${l}`) }]} expanded />
            {!expanded && lines.length > PREVIEW_LINES && <div className="cc-more">{`… +${plural(lines.length - PREVIEW_LINES, 'ligne', 'lignes')} (cliquer pour déplier)`}</div>}
          </>
        );
      }
      break;
    }
    case 'Read': {
      const lines = num((data.file ?? {}) as Input, 'numLines');
      if (lines !== undefined) return <>{plural(lines, 'ligne lue', 'lignes lues')}</>;
      break;
    }
    case 'Glob':
    case 'Grep': {
      const files = num(data, 'numFiles');
      const lines = num(data, 'numLines');
      if (str(data, 'mode') === 'content' && lines !== undefined) return <>{plural(lines, 'ligne trouvée', 'lignes trouvées')}</>;
      if (files !== undefined) return <>{plural(files, 'fichier trouvé', 'fichiers trouvés')}</>;
      break;
    }
    case 'Bash': {
      if (str(data, 'backgroundTaskId')) return <>Lancée en arrière-plan</>;
      const output = typeof data.stdout === 'string' ? [data.stdout, str(data, 'stderr')].filter(Boolean).join('\n') : result.text;
      return output.trim() ? <Output text={output} limit={OUTPUT_LINES} expanded={expanded} /> : <>(aucune sortie)</>;
    }
    case 'Task':
    case 'Agent': {
      const calls = num(data, 'totalToolUseCount');
      if (calls !== undefined) {
        const parts = [plural(calls, "appel d'outil", "appels d'outils"), formatTokens(num(data, 'totalTokens') ?? 0), formatDuration(num(data, 'totalDurationMs') ?? 0)];
        return <>{`Terminé (${parts.join(' · ')})`}</>;
      }
      if (data.isAsync) return <>Lancé en arrière-plan</>;
      break;
    }
    case 'WebFetch': {
      const bytes = num(data, 'bytes');
      if (bytes !== undefined) return <>{`${formatBytes(bytes)} reçus (${[data.code, data.codeText].filter(Boolean).join(' ')})`}</>;
      break;
    }
    case 'WebSearch': {
      const seconds = num(data, 'durationSeconds');
      if (seconds !== undefined) return <>{`Recherche effectuée en ${formatDuration(seconds * 1000)}`}</>;
      break;
    }
    case 'Skill':
      return <>Skill chargé</>;
    case 'AskUserQuestion': {
      const answers = Object.entries((data.answers ?? {}) as Record<string, unknown>);
      if (answers.length) return <>{answers.map(([question, answer]) => `· ${question} → ${String(answer)}`).join('\n')}</>;
      break;
    }
  }
  return result.text.trim() ? <Output text={result.text} limit={OUTPUT_LINES} expanded={expanded} /> : <>(aucune sortie)</>;
}

function ToolCall({ name, input, result, subCalls, rel }: { name: string; input: Input; result?: ToolResult; subCalls: number; rel: (path: string) => string }) {
  const [expanded, setExpanded] = useState(false);
  const header = name === 'AskUserQuestion' ? { name: result && !result.isError ? "Réponses aux questions de l'agent" : "Question de l'agent", args: '' } : toolHeader(name, input, rel);
  // Entête repliée : deux lignes de commande au plus.
  const argLines = header.args.split('\n');
  const long = argLines.length > 2 || header.args.length > 240;
  const args = expanded || !long ? header.args : `${argLines.slice(0, 2).join('\n').slice(0, 240)}…`;
  // Un clic déplie ou replie, sauf s'il termine une sélection de texte (copie d'une sortie).
  const toggle = () => {
    if (!window.getSelection()?.toString()) setExpanded((v) => !v);
  };
  const body = toolBody({ name, input, result, subCalls, expanded, rel });
  return (
    <div className="cc-tool">
      <div className={`cc-call${long ? ' foldable' : ''}`} onClick={long ? toggle : undefined}>
        <span className={`cc-dot ${!result ? 'pending' : result.isError ? 'error' : 'ok'}`}>⏺</span>
        <span>
          <span className="cc-name">{header.name}</span>
          {args && <span className="cc-args">({args})</span>}
        </span>
      </div>
      {body && (
        <div className={`cc-result${result?.isError ? ' error' : ''}`} onClick={toggle} title={expanded ? 'Replier' : 'Déplier'}>
          <span className="cc-elbow">⎿</span>
          <div className="cc-result-body">{body}</div>
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="cc-thinking" onClick={() => setExpanded((v) => !v)}>
      <div>∴ Réflexion…</div>
      <div className="cc-thinking-text">
        <Output text={text.trim()} limit={OUTPUT_LINES} expanded={expanded} />
      </div>
    </div>
  );
}

function describeResult(p: Record<string, unknown>, technical: boolean): string {
  const parts: string[] = [];
  if (typeof p.duration_ms === 'number') parts.push(formatDuration(p.duration_ms));
  if (typeof p.total_cost_usd === 'number') parts.push(formatCost(p.total_cost_usd));
  if (technical && typeof p.num_turns === 'number') parts.push(`${p.num_turns} échange${p.num_turns > 1 ? 's' : ''} avec le modèle`);
  return parts.join(' · ');
}

/** Marge sous laquelle le transcript est considéré comme « en bas » et suit les nouveaux événements. */
const STICK_MARGIN = 80;

/**
 * Transcript d'une session, calqué sur l'affichage de Claude Code : instructions préfixées par >, réponses ⏺,
 * appels d'outils `⏺ Outil(arguments)` suivis de leur résultat `⎿` (résumé, diff ou début de sortie). Les
 * demandes d'autorisation n'y laissent pas de trace : un refus apparaît comme l'erreur de l'outil.
 * `technical` ajoute les lignes de service (démarrage, autorisations, audit des connexions, erreurs brutes).
 */
export default function Transcript({ events, autoScroll = true, technical = false, loading = false }: { events: SessionEvent[]; autoScroll?: boolean; technical?: boolean; loading?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Par appel d'outil (tool_use_id) : son résultat (événement claude.user) et, pour un sous-agent, le nombre de
  // ses propres appels. `cwd` : dossier de travail annoncé par Claude Code, pour afficher des chemins relatifs.
  const { results, subCalls, cwd } = useMemo(() => {
    const results = new Map<string, ToolResult>();
    const subCalls = new Map<string, number>();
    let cwd = '';
    for (const e of events) {
      const p = e.payload as { subtype?: string; cwd?: string; parent_tool_use_id?: string | null; tool_use_result?: unknown; message?: { content?: unknown } };
      if (e.type === 'claude.system' && p.subtype === 'init' && typeof p.cwd === 'string') cwd = p.cwd;
      const content = p.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        if (e.type === 'claude.user' && block.type === 'tool_result' && block.tool_use_id) {
          const data = p.tool_use_result && typeof p.tool_use_result === 'object' && !Array.isArray(p.tool_use_result) ? (p.tool_use_result as Record<string, unknown>) : {};
          results.set(block.tool_use_id, { text: toolResultText(block.content), isError: Boolean(block.is_error), data });
        } else if (e.type === 'claude.assistant' && block.type === 'tool_use' && p.parent_tool_use_id) {
          subCalls.set(p.parent_tool_use_id, (subCalls.get(p.parent_tool_use_id) ?? 0) + 1);
        }
      }
    }
    return { results, subCalls, cwd };
  }, [events]);
  const rel = (path: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

  // Le transcript suit les nouveaux événements tant qu'on est en bas ; remonter pour relire suspend le suivi.
  useEffect(() => {
    const el = containerRef.current;
    if (autoScroll && el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, autoScroll]);

  const nodes: React.ReactNode[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    // Messages internes d'un sous-agent : Claude Code n'en montre que le décompte, sur l'appel qui l'a lancé.
    if (p.parent_tool_use_id && (e.type === 'claude.assistant' || e.type === 'claude.user')) continue;
    switch (e.type) {
      case 'instruction':
        nodes.push(
          <div key={e.id} className="cc-user">
            <span className="cc-user-text">{String(p.text ?? '')}</span>
          </div>,
        );
        break;
      case 'claude.assistant': {
        const content = ((p.message as { content?: ContentBlock[] } | undefined)?.content ?? []) as ContentBlock[];
        content.forEach((block, i) => {
          const key = `${e.id}-${i}`;
          if (block.type === 'text' && block.text?.trim()) {
            nodes.push(
              <div key={key} className="cc-assistant">
                <span className="cc-dot">⏺</span>
                <Markdown className="cc-body" text={block.text} />
              </div>,
            );
          } else if (block.type === 'tool_use') {
            nodes.push(<ToolCall key={key} name={block.name ?? 'outil'} input={block.input ?? {}} result={block.id ? results.get(block.id) : undefined} subCalls={block.id ? subCalls.get(block.id) ?? 0 : 0} rel={rel} />);
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            nodes.push(<Thinking key={key} text={block.thinking} />);
          }
        });
        break;
      }
      case 'claude.user': {
        // Seule l'interruption laisse une trace ; les résultats d'outils sont rattachés à leur appel.
        const content = (p.message as { content?: unknown } | undefined)?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as ContentBlock[]).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('') : '';
        if (text.startsWith('[Request interrupted by user')) {
          nodes.push(
            <div key={e.id} className="cc-result error">
              <span className="cc-elbow">⎿</span>
              <div className="cc-result-body">Interrompu · que doit faire l'agent à la place ?</div>
            </div>,
          );
        }
        break;
      }
      case 'claude.result':
        nodes.push(
          <div key={e.id} className={`cc-note${p.is_error ? ' error' : ''}`}>
            {p.is_error
              ? `✗ L'agent s'est arrêté sur une erreur${Array.isArray(p.errors) && p.errors.length ? ` : ${p.errors.join(' ; ')}` : technical ? ` (${String(p.subtype)})` : ''}`
              : `✻ Terminé${describeResult(p, technical) ? ` · ${describeResult(p, technical)}` : ''}`}
          </div>,
        );
        break;
      case 'claude.system':
        if (technical && p.subtype === 'init') {
          nodes.push(
            <div key={e.id} className="cc-note">
              ✻ Claude Code {String(p.claude_code_version ?? '')} · {String(p.model ?? '')} · {String(p.cwd ?? '')}
            </div>,
          );
        } else if (p.subtype === 'task_notification' && p.summary) {
          // Fin d'une commande ou d'un agent lancé en arrière-plan.
          nodes.push(
            <div key={e.id} className="cc-note">
              ⏺ {String(p.summary)}
            </div>,
          );
        }
        break;
      case 'config': {
        // Réglage modifié par un humain en cours de session (modèle, autorisations...).
        const changes = (p.changes ?? {}) as Record<string, unknown>;
        const applied = new Set(Array.isArray(p.applied) ? (p.applied as string[]) : []);
        const parts = Object.entries(changes).map(([key, value]) => {
          const label =
            key === 'permissionMode'
              ? `autorisations : ${permissionModeLabels[String(value ?? 'default')] ?? String(value)}`
              : key === 'model'
                ? `modèle : ${value ? String(value) : 'réglage général'}`
                : `${key} : ${value === null ? '(retiré)' : JSON.stringify(value)}`;
          return applied.has(key) ? label : `${label} (au prochain lancement)`;
        });
        nodes.push(
          <div key={e.id} className="cc-note">
            ⚙ Réglages modifiés · {parts.join(' · ')}
          </div>,
        );
        break;
      }
      case 'system':
        if (technical) {
          nodes.push(
            <div key={e.id} className="cc-note">
              · {String(p.message ?? JSON.stringify(p))}
            </div>,
          );
        }
        break;
      case 'stderr':
        if (technical) {
          nodes.push(
            <div key={e.id} className="cc-note error">
              {String(p.text ?? '')}
            </div>,
          );
        }
        break;
      case 'connection': {
        // Audit d'un accès à un système externe (outils MCP `connections` et `google`) : l'appel d'outil est
        // déjà affiché, la ligne d'audit relève du détail technique.
        if (!technical) break;
        const summary = String(p.summary ?? '');
        nodes.push(
          <div key={e.id} className={`cc-note${p.ok ? '' : ' error'}`} title={summary}>
            <i className={`bi ${p.kind === 'ssh' ? 'bi-hdd-network' : p.kind === 'gmail' ? 'bi-envelope' : p.kind === 'drive' ? 'bi-google' : 'bi-database'} me-1`} />
            {String(p.action)} · {String(p.connection)} · {summary.length > 100 ? `${summary.slice(0, 97)}…` : summary}
            {p.ok ? ` — ${p.note ? `${String(p.note)}, ` : ''}${String(p.durationMs)} ms` : ` — échec : ${String(p.error ?? '')}`}
          </div>,
        );
        break;
      }
      case 'stdout':
        nodes.push(
          <div key={e.id} className="cc-line">
            {String(p.text ?? '')}
          </div>,
        );
        break;
      case 'request': {
        // Autorisations et questions : l'appel d'outil concerné porte déjà l'information (résultat, refus, réponses).
        const known = p.type === 'permission' || p.type === 'question';
        if (known && !technical) break;
        const payload = (p.payload ?? {}) as { toolName?: string; input?: Record<string, unknown> };
        const text =
          p.type === 'permission' && payload.toolName
            ? `L'agent a demandé l'autorisation de ${describeTool(payload.toolName, payload.input ?? {}).action}`
            : p.type === 'question'
              ? `L'agent vous a posé une question : ${String(p.title)}`
              : `L'agent vous a demandé : ${String(p.title)}`;
        nodes.push(
          <div key={e.id} className={`cc-note${known ? '' : ' warn'}`}>
            ⏸ {text}
          </div>,
        );
        break;
      }
      case 'request.answered': {
        const known = p.type === 'permission' || p.type === 'question';
        if (known && !technical) break;
        const r = (p.response ?? {}) as Record<string, unknown>;
        const text =
          r.decision === 'allow' ? (r.always ? 'Autorisé pour toute la session' : 'Autorisé') : r.decision === 'deny' ? `Refusé${r.message ? ` : ${String(r.message)}` : ''}` : r.answers ? Object.values(r.answers as Record<string, string>).join(' ; ') : JSON.stringify(r);
        nodes.push(
          <div key={e.id} className="cc-note">
            ▶ Votre réponse : {text}
          </div>,
        );
        break;
      }
      case 'status': {
        const labels: Record<string, string> = { completed: 'Session terminée', failed: 'Session terminée avec une erreur', stopped: 'Session arrêtée', interrupted: 'Session interrompue' };
        nodes.push(
          <div key={e.id} className={`cc-note${p.status === 'failed' ? ' error' : ''}`}>
            ■ {labels[String(p.status)] ?? `Session ${String(p.status)}`}
            {p.error ? ` — ${String(p.error)}` : ''}
          </div>,
        );
        break;
      }
      default:
        // Événements techniques (rate limit, progression, consommation...) : non affichés.
        break;
    }
  }

  return (
    <div
      className="cc-transcript"
      ref={containerRef}
      onScroll={(ev) => {
        const el = ev.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_MARGIN;
      }}
    >
      {nodes.length === 0 && <div className="cc-dimmer">{loading ? 'Chargement du fil…' : 'Aucun échange pour le moment.'}</div>}
      {nodes}
    </div>
  );
}
