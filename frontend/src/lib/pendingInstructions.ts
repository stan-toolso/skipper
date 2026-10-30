import type { SessionEvent } from '../graphql/operations';

/** Texte que le serveur donne à une instruction sans texte (aligné sur `backend/src/sessions/service.ts`). */
export const ATTACHMENTS_ONLY_TEXT = 'Voir les fichiers joints.';

/** Fichier joint d'une instruction pas encore confirmée : affiché depuis le navigateur, avant d'exister sur le serveur. */
export interface LocalAttachment {
  name: string;
  mediaType: string;
  size: number;
  previewUrl: string | null;
}

/**
 * Instruction envoyée depuis la page, affichée dans le transcript dès l'envoi, avant que le serveur ne la
 * journalise : l'aller-retour de la mutation puis le prochain relevé des événements prendraient jusqu'à deux
 * secondes, pendant lesquelles le message semblerait perdu.
 */
export interface PendingInstruction {
  id: string;
  text: string;
  attachments: LocalAttachment[];
  createdAt: string;
  /** Nombre d'événements connus à l'envoi : l'événement `instruction` du serveur arrivera après. */
  sentAfter: number;
}

let counter = 0;
export function newPendingInstruction(text: string, attachments: LocalAttachment[], sentAfter: number): PendingInstruction {
  return { id: `pending-${++counter}`, text: text.trim() || (attachments.length ? ATTACHMENTS_ONLY_TEXT : ''), attachments, createdAt: new Date().toISOString(), sentAfter };
}

/**
 * Instructions en attente que le serveur a déjà journalisées : un événement `instruction` de même texte, arrivé
 * après l'envoi, et pas déjà attribué à une autre instruction en attente.
 */
export function confirmedPending(events: SessionEvent[], pending: PendingInstruction[]): Set<string> {
  const confirmed = new Set<string>();
  const used = new Set<string>();
  for (const p of pending) {
    for (let i = p.sentAfter; i < events.length; i++) {
      const e = events[i];
      if (e.type !== 'instruction' || used.has(e.id)) continue;
      if (String((e.payload as { text?: unknown }).text ?? '').trim() !== p.text) continue;
      used.add(e.id);
      confirmed.add(p.id);
      break;
    }
  }
  return confirmed;
}

/** Événements à afficher : ceux du serveur, suivis des instructions en attente pas encore confirmées. */
export function withPendingInstructions(events: SessionEvent[], pending: PendingInstruction[]): SessionEvent[] {
  if (!pending.length) return events;
  const confirmed = confirmedPending(events, pending);
  const extra = pending.filter((p) => !confirmed.has(p.id));
  if (!extra.length) return events;
  return [
    ...events,
    ...extra.map<SessionEvent>((p) => ({ id: p.id, sessionId: '', type: 'instruction', payload: { text: p.text, pending: true, localAttachments: p.attachments }, createdAt: p.createdAt })),
  ];
}
