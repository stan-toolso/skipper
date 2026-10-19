/**
 * Brouillon en direct d'une session : le texte que l'agent est en train d'écrire, reconstitué à partir des
 * événements de streaming du SDK (`stream_event`, option `includePartialMessages`). Ces événements arrivent
 * par dizaines par seconde et ne sont jamais journalisés : le message `assistant` complet, lui, est persisté
 * comme avant. Le brouillon vit en mémoire, par session, et l'interface le lit avec les événements
 * (`Session.liveDraft`) pour afficher la réponse au fil de l'eau au lieu d'attendre la fin du message.
 */

export interface LiveDraft {
  /** Texte en cours d'écriture (blocs `text` du message assistant en cours, concaténés). */
  text: string;
  /** L'agent est dans un bloc de réflexion (texte non transmis : seule sa présence est signalée). */
  thinking: boolean;
  /** Dernière modification (ms). */
  updatedAt: number;
}

/**
 * Forme minimale d'un événement de streaming de l'API Messages, telle que le SDK la relaie. Les types du SDK
 * (`BetaRawMessageStreamEvent`) sont une union dont les `delta` n'ont pas de champ commun : on lit les champs
 * utiles sans contrainte structurelle, pour rester compatible avec les prochains sous-types.
 */
export interface StreamEventLike {
  type: string;
  index?: number;
  content_block?: { type?: string; text?: string };
  delta?: unknown;
}

function deltaOf(event: StreamEventLike): { type?: string; text?: string } {
  return event.delta && typeof event.delta === 'object' ? (event.delta as { type?: string; text?: string }) : {};
}

const drafts = new Map<string, LiveDraft>();

function draftOf(sessionId: string): LiveDraft {
  let d = drafts.get(sessionId);
  if (!d) {
    d = { text: '', thinking: false, updatedAt: Date.now() };
    drafts.set(sessionId, d);
  }
  return d;
}

export const liveDraftService = {
  /** Brouillon courant d'une session, null si l'agent n'écrit rien pour le moment. */
  get(sessionId: string): LiveDraft | null {
    const d = drafts.get(sessionId);
    return d && (d.text || d.thinking) ? d : null;
  },

  /**
   * Applique un événement de streaming. `parentToolUseId` non nul : message interne d'un sous-agent, ignoré
   * (le transcript ne montre pas non plus ses messages). Renvoie true si le brouillon a changé.
   */
  apply(sessionId: string, event: StreamEventLike, parentToolUseId: string | null = null): boolean {
    if (parentToolUseId) return false;
    switch (event.type) {
      case 'message_start': {
        // Nouveau message assistant : le texte du précédent a été (ou va être) persisté par l'événement `assistant`.
        drafts.set(sessionId, { text: '', thinking: false, updatedAt: Date.now() });
        return true;
      }
      case 'content_block_start': {
        const d = draftOf(sessionId);
        const type = event.content_block?.type;
        if (type === 'thinking' || type === 'redacted_thinking') d.thinking = true;
        else if (type === 'text' && event.content_block?.text) {
          d.text = joinBlocks(d.text, event.content_block.text);
        } else return false;
        d.updatedAt = Date.now();
        return true;
      }
      case 'content_block_delta': {
        const d = draftOf(sessionId);
        const delta = deltaOf(event);
        if (delta.type === 'text_delta' && delta.text) {
          d.text += delta.text;
          d.updatedAt = Date.now();
          return true;
        }
        if (delta.type === 'thinking_delta' && !d.thinking) {
          d.thinking = true;
          d.updatedAt = Date.now();
          return true;
        }
        return false;
      }
      case 'content_block_stop': {
        const d = drafts.get(sessionId);
        if (!d) return false;
        // Fin d'un bloc : la réflexion est terminée ; un bloc de texte suivant s'affichera à la ligne.
        const changed = d.thinking;
        d.thinking = false;
        if (d.text && !d.text.endsWith('\n')) d.text += '\n\n';
        d.updatedAt = Date.now();
        return changed || Boolean(d.text);
      }
      default:
        return false;
    }
  },

  /** Message assistant complet reçu (et persisté), ou fin de tour : le brouillon n'a plus lieu d'être. */
  clear(sessionId: string): void {
    drafts.delete(sessionId);
  },
};

function joinBlocks(current: string, next: string): string {
  if (!current) return next;
  return current.endsWith('\n') ? current + next : `${current}\n\n${next}`;
}
