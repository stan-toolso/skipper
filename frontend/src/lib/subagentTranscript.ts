import type { SessionEvent } from '../graphql/operations';

/** Ce que l'appel de l'outil Agent dit du sous-agent : description, type, consigne. */
export interface SubagentCall {
  description: string | null;
  agentType: string | null;
  prompt: string | null;
  background: boolean;
}

interface ToolUseBlock {
  type?: string;
  id?: string;
  input?: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * Fil d'un sous-agent du CLI lisible par le transcript, à partir des événements de `Session.events(toolUseId:)` :
 * l'appel de l'outil Agent qui l'a lancé devient l'instruction (sa consigne, signée de l'agent principal), et ses
 * propres messages perdent leur `parent_tool_use_id` (le transcript masque ceux des sous-agents). Les messages des
 * sous-agents qu'il a lui-même lancés restent masqués : l'appel qui les a lancés en montre le décompte.
 */
export function subagentTranscript(events: readonly SessionEvent[], toolUseId: string): { events: SessionEvent[]; call: SubagentCall | null } {
  let call: SubagentCall | null = null;
  const out: SessionEvent[] = [];
  for (const e of events) {
    const p = e.payload as { parent_tool_use_id?: string | null; message?: { content?: unknown } };
    if (p.parent_tool_use_id === toolUseId) {
      const { parent_tool_use_id: _parent, ...rest } = p;
      out.push({ ...e, payload: rest });
      continue;
    }
    const content = p.message?.content;
    const block = e.type === 'claude.assistant' && Array.isArray(content) ? (content as ToolUseBlock[]).find((b) => b?.type === 'tool_use' && b.id === toolUseId) : undefined;
    if (block) {
      const input = block.input ?? {};
      call = { description: str(input.description), agentType: str(input.subagent_type), prompt: str(input.prompt), background: input.run_in_background === true };
      out.push({ id: e.id, sessionId: e.sessionId, type: 'instruction', createdAt: e.createdAt, payload: { text: call.prompt ?? call.description ?? '', author: { type: 'system', name: 'Agent principal' } } });
      continue;
    }
    // Message d'un sous-agent imbriqué : gardé tel quel (masqué, compté sur l'appel qui l'a lancé).
    if (p.parent_tool_use_id) out.push(e);
  }
  return { events: out, call };
}
