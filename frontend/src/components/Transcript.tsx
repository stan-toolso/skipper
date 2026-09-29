import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent } from '../graphql/operations';

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
}

/** Résumé d'un appel d'outil, comme Claude Code : Bash(commande), Read(fichier)... */
function summarizeToolInput(name: string, input: Record<string, unknown> = {}): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (name) {
    case 'Bash':
      return str('command') ?? '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str('file_path') ?? '';
    case 'Glob':
    case 'Grep':
      return [str('pattern'), str('path')].filter(Boolean).join(' in ');
    case 'WebFetch':
    case 'WebSearch':
      return str('url') ?? str('query') ?? '';
    case 'Task':
    case 'Agent':
      return str('description') ?? '';
    case 'AskUserQuestion':
      return `${(input.questions as unknown[] | undefined)?.length ?? 0} question(s)`;
    default: {
      const json = JSON.stringify(input);
      return json.length > 120 ? `${json.slice(0, 117)}…` : json;
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

function ToolCall({ name, input, result }: { name: string; input: Record<string, unknown>; result?: ToolResult }) {
  const [expanded, setExpanded] = useState(false);
  const lines = (result?.text ?? '').split('\n');
  const limit = 3;
  const shown = expanded ? lines : lines.slice(0, limit);
  const hidden = lines.length - shown.length;
  const dotClass = !result ? 'pending' : result.isError ? 'error' : 'ok';
  return (
    <div className="cc-tool">
      <div className="cc-call">
        <span className={`cc-dot ${dotClass}`}>⏺</span>
        <span>
          <span className="cc-name">{name}</span>
          <span className="cc-args">({summarizeToolInput(name, input)})</span>
        </span>
      </div>
      {result && (
        <div className={`cc-result${result.isError ? ' error' : ''}`} onClick={() => setExpanded((v) => !v)} title={expanded ? 'Replier' : 'Déplier'}>
          {shown.join('\n') || '(aucune sortie)'}
          {hidden > 0 && <span className="cc-more">{`\n… +${hidden} ligne${hidden > 1 ? 's' : ''} (cliquer pour déplier)`}</span>}
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const first = text.split('\n')[0];
  return (
    <div className="cc-thinking" onClick={() => setExpanded((v) => !v)} style={{ cursor: 'pointer' }}>
      ✻ {expanded ? text : first.length > 100 ? `${first.slice(0, 100)}…` : first || 'Réflexion…'}
    </div>
  );
}

function formatCost(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof p.num_turns === 'number') parts.push(`${p.num_turns} tour${p.num_turns > 1 ? 's' : ''}`);
  if (typeof p.duration_ms === 'number') parts.push(`${(p.duration_ms / 1000).toFixed(1)}s`);
  if (typeof p.total_cost_usd === 'number') parts.push(`$${p.total_cost_usd.toFixed(4)}`);
  return parts.join(' · ');
}

/**
 * Transcript d'une session rendu à la manière de Claude Code :
 * instructions préfixées par >, réponses ⏺, appels d'outils avec résultat ⎿, notes en gris.
 */
export default function Transcript({ events, autoScroll = true }: { events: SessionEvent[]; autoScroll?: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Associe chaque résultat d'outil (événement claude.user) à son appel (tool_use_id).
  const results = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const e of events) {
      if (e.type !== 'claude.user') continue;
      const message = (e.payload as { message?: { content?: unknown } }).message;
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          map.set(block.tool_use_id, { text: toolResultText(block.content), isError: Boolean(block.is_error) });
        }
      }
    }
    return map;
  }, [events]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length, autoScroll]);

  const nodes: React.ReactNode[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
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
                <span className="cc-body">{block.text}</span>
              </div>,
            );
          } else if (block.type === 'tool_use') {
            nodes.push(<ToolCall key={key} name={block.name ?? 'outil'} input={block.input ?? {}} result={block.id ? results.get(block.id) : undefined} />);
          } else if (block.type === 'thinking' && block.thinking) {
            nodes.push(<Thinking key={key} text={block.thinking} />);
          }
        });
        break;
      }
      case 'claude.result':
        nodes.push(
          <div key={e.id} className={`cc-note${p.is_error ? ' error' : ''}`}>
            {p.is_error ? `✗ ${String(p.subtype)}${Array.isArray(p.errors) ? ` : ${p.errors.join(' ; ')}` : ''}` : `✻ Tour terminé · ${formatCost(p)}`}
          </div>,
        );
        break;
      case 'claude.system':
        if (p.subtype === 'init') {
          nodes.push(
            <div key={e.id} className="cc-note">
              ✻ Claude Code {String(p.claude_code_version ?? '')} · {String(p.model ?? '')} · {String(p.cwd ?? '')}
            </div>,
          );
        }
        break;
      case 'system':
        nodes.push(
          <div key={e.id} className="cc-note">
            · {String(p.message ?? JSON.stringify(p))}
          </div>,
        );
        break;
      case 'stderr':
        nodes.push(
          <div key={e.id} className="cc-note error">
            {String(p.text ?? '')}
          </div>,
        );
        break;
      case 'stdout':
        nodes.push(
          <div key={e.id} className="cc-line">
            {String(p.text ?? '')}
          </div>,
        );
        break;
      case 'request':
        nodes.push(
          <div key={e.id} className="cc-note warn">
            ⏸ {String(p.title)}
          </div>,
        );
        break;
      case 'request.answered':
        nodes.push(
          <div key={e.id} className="cc-note">
            ▶ Réponse : {JSON.stringify(p.response)}
          </div>,
        );
        break;
      case 'status':
        nodes.push(
          <div key={e.id} className={`cc-note${p.status === 'failed' ? ' error' : ''}`}>
            ■ Session {String(p.status)}
            {p.error ? ` — ${String(p.error)}` : ''}
          </div>,
        );
        break;
      default:
        // Événements techniques (rate limit, hooks, tool results déjà rattachés...) : non affichés.
        break;
    }
  }

  return (
    <div className="cc-transcript">
      {nodes.length === 0 && <div className="cc-dimmer">Aucun échange pour le moment.</div>}
      {nodes}
      <div ref={bottomRef} />
    </div>
  );
}
