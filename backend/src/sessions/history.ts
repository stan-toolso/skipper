import { sessionRepository } from './repository.js';
import type { Session } from './types.js';

/** Taille maximale de la conversation reprise dans la consigne d'une relance (caractères). */
export const MAX_DIGEST_CHARS = 40_000;

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Tours de la conversation d'une session : instructions humaines et réponses textuelles de l'agent (sans les outils). */
export async function conversationTurns(sessionId: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  let after: string | undefined;
  for (;;) {
    const events = await sessionRepository.listEvents(sessionId, { after, limit: 2000 });
    if (!events.length) break;
    for (const e of events) {
      if (e.type === 'instruction' && typeof e.payload.text === 'string' && e.payload.text.trim()) turns.push({ role: 'user', text: e.payload.text.trim() });
      if (e.type === 'claude.assistant' && !e.payload.parent_tool_use_id) {
        const content = (e.payload.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
        const text = (Array.isArray(content) ? content : [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
          .map((b) => b.text!.trim())
          .join('\n');
        if (text) turns.push({ role: 'assistant', text });
      }
    }
    after = events[events.length - 1].id;
    if (events.length < 2000) break;
  }
  return turns;
}

/**
 * Consigne d'une nouvelle session qui reprend le travail d'une session archivée : sa conversation (les
 * derniers échanges jusqu'à 40 000 caractères) en contexte, puis l'instruction donnée ou « continue ».
 */
export async function relaunchPrompt(source: Session, instruction?: string | null): Promise<string> {
  let turns = await conversationTurns(source.id);
  if (source.prompt && !turns.some((t) => t.role === 'user')) turns = [{ role: 'user', text: source.prompt }, ...turns];
  const lines = turns.map((t) => `${t.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${t.text}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length && size + lines[i].length > MAX_DIGEST_CHARS) break;
    kept.unshift(lines[i]);
    size += lines[i].length;
  }
  const truncated = kept.length < lines.length;
  return [
    `Tu reprends le travail d'une session précédente (« ${source.name} »), qui a été archivée. Sa conversation${truncated ? ' (les échanges les plus anciens sont omis)' : ''} suit, pour contexte ; les fichiers de ton dossier de travail peuvent différer de ceux qu'elle a vus.`,
    '',
    '<previous_conversation>',
    kept.join('\n\n'),
    '</previous_conversation>',
    '',
    instruction?.trim() || 'Continue là où cette conversation s\'est arrêtée.',
  ].join('\n');
}
