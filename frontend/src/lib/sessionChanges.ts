import type { SessionEvent } from '../graphql/operations';

/** Outils de Claude Code susceptibles de modifier des fichiers du dossier de travail. */
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string };

function blocksOf(event: SessionEvent): Block[] {
  const content = (event.payload as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

/**
 * Nombre d'appels terminés d'un outil qui modifie des fichiers (Edit, Write, Bash...) : l'onglet
 * « Modifications » se rafraîchit quand ce nombre change, c'est-à-dire après chaque résultat d'un tel outil.
 */
export function fileToolResultCount(events: SessionEvent[]): number {
  const fileCalls = new Set<string>();
  let count = 0;
  for (const e of events) {
    if (e.type === 'claude.assistant') {
      for (const b of blocksOf(e)) if (b.type === 'tool_use' && b.id && b.name && FILE_TOOLS.has(b.name)) fileCalls.add(b.id);
    } else if (e.type === 'claude.user') {
      for (const b of blocksOf(e)) if (b.type === 'tool_result' && b.tool_use_id && fileCalls.has(b.tool_use_id)) count++;
    }
  }
  return count;
}
