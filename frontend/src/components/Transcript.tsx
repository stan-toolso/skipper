import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent } from '../graphql/operations';
import { attachmentUrl, formatSize, isImageType, type AttachmentRef } from '../lib/attachments';
import { describeTool, formatCost, formatDuration } from '../lib/humanize';
import Markdown from './Markdown';

/** Fichiers joints à une instruction : vignettes pour les images, liens de téléchargement sinon. */
function InstructionAttachments({ sessionId, attachments }: { sessionId: string; attachments: AttachmentRef[] }) {
  return (
    <div className="cc-user-files">
      {attachments.map((a) => {
        const url = attachmentUrl(sessionId, a.id);
        const title = `${a.name} · ${a.mediaType} · ${formatSize(a.size)}`;
        return isImageType(a.mediaType) ? (
          <a key={a.id} href={url} target="_blank" rel="noreferrer" className="cc-user-image" title={title}>
            <img src={url} alt={a.name} crossOrigin="use-credentials" loading="lazy" />
          </a>
        ) : (
          <a key={a.id} href={url} target="_blank" rel="noreferrer" className="cc-chip" title={title}>
            <i className="bi bi-file-earmark" />
            <span className="cc-chip-name">{a.name}</span>
            <span className="cc-chip-size">{formatSize(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

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

function ToolCall({ name, input, result, technical }: { name: string; input: Record<string, unknown>; result?: ToolResult; technical: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const desc = describeTool(name, input);
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
          <span className="cc-name">{desc.label}</span>
          {desc.detail && desc.detail !== desc.label && <span className="cc-args"> — {desc.detail.length > 140 ? `${desc.detail.slice(0, 137)}…` : desc.detail}</span>}
          {technical && <span className="cc-raw">{name}({summarizeToolInput(name, input)})</span>}
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

function describeResult(p: Record<string, unknown>, technical: boolean): string {
  const parts: string[] = [];
  if (typeof p.duration_ms === 'number') parts.push(formatDuration(p.duration_ms));
  if (typeof p.total_cost_usd === 'number') parts.push(formatCost(p.total_cost_usd));
  if (technical && typeof p.num_turns === 'number') parts.push(`${p.num_turns} échange${p.num_turns > 1 ? 's' : ''} avec le modèle`);
  return parts.join(' · ');
}

/**
 * Transcript d'une session rendu à la manière de Claude Code :
 * instructions préfixées par >, réponses ⏺, appels d'outils avec résultat ⎿, notes en gris.
 */
/**
 * `technical` affiche en plus les lignes système (démarrage, erreurs brutes, noms d'outils).
 */
export default function Transcript({ events, autoScroll = true, technical = false }: { events: SessionEvent[]; autoScroll?: boolean; technical?: boolean }) {
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
      case 'instruction': {
        const attachments = Array.isArray(p.attachments) ? (p.attachments as AttachmentRef[]) : [];
        nodes.push(
          <div key={e.id} className="cc-user">
            <span className="cc-user-text">{String(p.text ?? '')}</span>
            {attachments.length > 0 && <InstructionAttachments sessionId={e.sessionId} attachments={attachments} />}
          </div>,
        );
        break;
      }
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
            nodes.push(<ToolCall key={key} name={block.name ?? 'outil'} input={block.input ?? {}} result={block.id ? results.get(block.id) : undefined} technical={technical} />);
          } else if (block.type === 'thinking' && block.thinking) {
            nodes.push(<Thinking key={key} text={block.thinking} />);
          }
        });
        break;
      }
      case 'claude.result':
        nodes.push(
          <div key={e.id} className={`cc-note${p.is_error ? ' error' : ''}`}>
            {p.is_error
              ? `✗ L'agent s'est arrêté sur une erreur${Array.isArray(p.errors) && p.errors.length ? ` : ${p.errors.join(' ; ')}` : technical ? ` (${String(p.subtype)})` : ''}`
              : `✓ Réponse terminée${describeResult(p, technical) ? ` · ${describeResult(p, technical)}` : ''}`}
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
        }
        break;
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
        // Audit d'un accès à un système externe (outil MCP `connections`).
        const summary = String(p.summary ?? '');
        nodes.push(
          <div key={e.id} className={`cc-note${p.ok ? '' : ' error'}`} title={summary}>
            <i className={`bi ${p.kind === 'ssh' ? 'bi-hdd-network' : 'bi-database'} me-1`} />
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
        const payload = (p.payload ?? {}) as { toolName?: string; input?: Record<string, unknown> };
        const text =
          p.type === 'permission' && payload.toolName
            ? `L'agent a demandé l'autorisation de ${describeTool(payload.toolName, payload.input ?? {}).action}`
            : p.type === 'question'
              ? `L'agent vous a posé une question : ${String(p.title)}`
              : `L'agent vous a demandé : ${String(p.title)}`;
        nodes.push(
          <div key={e.id} className="cc-note warn">
            ⏸ {text}
          </div>,
        );
        break;
      }
      case 'request.answered': {
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
