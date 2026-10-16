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

/** Derniers échanges d'une session (jusqu'à MAX_DIGEST_CHARS), et si des échanges plus anciens ont été omis. */
async function digest(source: Session): Promise<{ kept: string[]; truncated: boolean }> {
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
  return { kept, truncated: kept.length < lines.length };
}

/**
 * Résumé transmis au modèle avec la première instruction d'une conversation remise à zéro « en gardant un
 * résumé » : les derniers échanges de la conversation précédente, pour mémoire. Null si la session n'a rien dit.
 */
export async function resumeDigest(source: Session): Promise<string | null> {
  const { kept, truncated } = await digest(source);
  if (!kept.length) return null;
  return [
    `La conversation précédente de cette session (« ${source.name} ») a été remise à zéro pour alléger ton contexte. Ses derniers échanges${truncated ? ' (les plus anciens sont omis)' : ''} suivent, pour mémoire : tu peux t'y référer, mais l'instruction à traiter est celle qui vient après.`,
    '',
    '<previous_conversation>',
    kept.join('\n\n'),
    '</previous_conversation>',
  ].join('\n');
}

/**
 * Consigne d'une nouvelle session qui reprend le travail d'une session archivée : sa conversation (les
 * derniers échanges jusqu'à 40 000 caractères) en contexte, puis l'instruction donnée ou « continue ».
 */
export async function relaunchPrompt(source: Session, instruction?: string | null): Promise<string> {
  const { kept, truncated } = await digest(source);
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
