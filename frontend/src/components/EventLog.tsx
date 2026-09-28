import { useEffect, useRef } from 'react';
import type { SessionEvent } from '../graphql/operations';

function describe(event: SessionEvent): { tone: string; text: string } {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'stdout':
      return { tone: 'text-body', text: String(p.text ?? '') };
    case 'stderr':
      return { tone: 'text-danger', text: String(p.text ?? '') };
    case 'system':
      return { tone: 'text-info', text: String(p.message ?? JSON.stringify(p)) };
    case 'status':
      return { tone: 'text-warning', text: `→ ${String(p.status)}${p.error ? ` (${String(p.error)})` : ''}` };
    case 'request':
      return { tone: 'text-warning', text: `Demande (${String(p.type)}) : ${String(p.title)} — en attente d'une réponse humaine` };
    case 'request.answered':
      return { tone: 'text-info', text: `Réponse à « ${String(p.title)} » : ${JSON.stringify(p.response)}` };
    case 'claude.assistant': {
      // Message de l'assistant : concatène les blocs texte, résume les appels d'outils.
      const message = p.message as { content?: Array<Record<string, unknown>> } | undefined;
      const parts = (message?.content ?? []).map((block) => {
        if (block.type === 'text') return String(block.text ?? '');
        if (block.type === 'tool_use') return `[outil ${String(block.name)}] ${JSON.stringify(block.input)}`;
        return JSON.stringify(block);
      });
      return { tone: 'text-success', text: parts.join('\n') };
    }
    case 'claude.result': {
      const cost = typeof p.total_cost_usd === 'number' ? ` (${p.num_turns} tour(s), $${p.total_cost_usd.toFixed(4)})` : '';
      if (p.is_error) {
        const errors = Array.isArray(p.errors) ? p.errors.join(' ; ') : String(p.result ?? '');
        return { tone: 'text-danger', text: `Échec ${String(p.subtype)}${errors ? ` : ${errors}` : ''}${cost}` };
      }
      return { tone: 'text-warning', text: `Résultat : ${String(p.result ?? '')}${cost}` };
    }
    case 'claude.system':
      return { tone: 'text-info', text: `Claude ${String(p.subtype ?? '')} (session ${String(p.session_id ?? '?')})` };
    default:
      return { tone: 'text-secondary', text: JSON.stringify(p) };
  }
}

export default function EventLog({ events }: { events: SessionEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length]);

  return (
    <pre className="bg-dark text-light p-3 rounded small" style={{ maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
      {events.length === 0 && <span className="text-secondary">Aucun événement pour le moment.</span>}
      {events.map((event) => {
        const { tone, text } = describe(event);
        return (
          <div key={event.id} className={tone}>
            <span className="text-secondary">{new Date(event.createdAt).toLocaleTimeString()} </span>
            <span className="text-secondary">[{event.type}] </span>
            {text}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </pre>
  );
}
