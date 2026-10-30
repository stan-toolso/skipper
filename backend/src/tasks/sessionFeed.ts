import { sessionService } from '../sessions/service.js';
import { getProvider } from '../sessions/providers/registry.js';
import type { AttachmentInput } from '../sessions/types.js';
import { asInstructionAttachments, fitInInstruction } from './attachments.js';
import { describeComment, describeTaskChanges, taskService } from './service.js';
import type { Task, TaskAttachment, TaskChange } from './types.js';

/** Message à transmettre à une session reliée à une tâche pour un changement fait par quelqu'un d'autre. */
export interface TaskFeed {
  sessionId: string;
  text: string;
  /** Le message relance une session terminée (il lui est adressé) ; sinon il n'est transmis qu'à une session en cours. */
  restart: boolean;
  attachments: TaskAttachment[];
}

/** La session est-elle en charge de la tâche (plusieurs peuvent l'être) ? */
const inCharge = (task: Task, sessionId: string) => task.sessionIds.includes(sessionId);
/** Lien d'une session avec la tâche, pour le lui rappeler : en charge, ou simplement reliée. */
const bond = (change: TaskChange, sessionId: string) => (inCharge(change.task, sessionId) ? 'dont cette session est en charge' : 'à laquelle cette session est reliée');

/**
 * Messages à transmettre aux sessions reliées à la tâche (toutes celles en charge, celles passées par la tâche ou
 * mentionnées dans son fil : `linked`) pour un changement fait par quelqu'un d'autre. Un message du fil relance les
 * sessions en charge et les sessions qu'il mentionne (il leur est adressé) ; les autres sessions reliées ne le
 * reçoivent que si elles tournent. Une modification n'est transmise qu'aux sessions en cours (une session terminée
 * relira la tâche à son prochain démarrage grâce à son prompt système), et pas à celle qui vient de prendre la charge
 * (elle a reçu la tâche entière). Une réaction n'est signalée qu'à la session autrice du message.
 */
export function feedsFor(change: TaskChange, linked: string[] = []): TaskFeed[] {
  const recipients = new Set<string>(linked);
  for (const id of change.task.sessionIds) recipients.add(id);
  if (change.kind === 'commented') {
    const c = change.comment;
    const mentioned = new Set(c.mentions.filter((m) => m.kind === 'session').map((m) => m.id));
    for (const id of mentioned) recipients.add(id);
    return [...recipients]
      .filter((sessionId) => sessionId !== c.authorSessionId)
      .map((sessionId) => ({
        sessionId,
        restart: inCharge(change.task, sessionId) || mentioned.has(sessionId),
        attachments: change.attachments,
        text: [
          `[Commentaire sur la tâche] Nouveau message dans le fil de la tâche ${change.task.id} (« ${change.task.title} ») ${bond(change, sessionId)}${mentioned.has(sessionId) ? ', qui mentionne cette session' : ''} :`,
          ...describeComment(c, change.attachments, 'instruction', { replyTo: change.parent }),
          '',
          `Réponds-y avec l'outil \`tasks.comment\` (reply_to : ${change.parent?.id ?? c.id} pour rester dans son fil) quand il appelle une réponse ; \`tasks.react\` pour un simple accusé.`,
        ].join('\n'),
      }));
  }
  if (change.kind === 'reacted') {
    const target = change.comment;
    if (!target?.authorSessionId || target.authorSessionId === change.reaction.sessionId) return [];
    const r = change.reaction;
    return [
      {
        sessionId: target.authorSessionId,
        restart: false,
        attachments: [],
        text: `[Réaction sur la tâche] ${r.actorName}${r.actorType === 'agent' ? ' (agent)' : ''} ${change.added ? 'a réagi' : 'a retiré sa réaction'} ${r.emoji} ${change.added ? 'à' : 'de'} ton message ${target.id} de la tâche ${change.task.id} (« ${change.task.title} »)${change.added ? ` : « ${target.body.slice(0, 120)}${target.body.length > 120 ? '…' : ''} »` : ''}. Rien à faire, sauf si cela appelle une suite.`,
      },
    ];
  }
  // Sans acteur (Skipper lui-même : lancement, fusion), rien à dire.
  if (!change.actor) return [];
  const lines = describeTaskChanges(change.before, change.task, change.addedAttachments);
  if (!lines.length) return [];
  const by = change.actor.type === 'agent' ? `la session d'agent « ${change.actor.name ?? 'inconnue'} » (${change.actor.sessionId ?? '?'})` : change.actor.name || 'une personne';
  return [...recipients]
    // Passation : la session qui vient de prendre la charge a reçu la tâche entière ; l'auteur du changement n'a rien à apprendre.
    .filter((sessionId) => sessionId !== change.actor?.sessionId && !(inCharge(change.task, sessionId) && !inCharge(change.before, sessionId)))
    .map((sessionId) => ({
      sessionId,
      restart: false,
      attachments: change.addedAttachments,
      text: [`[Mise à jour de la tâche] La tâche ${change.task.id} (« ${change.task.title} ») ${bond(change, sessionId)} a été modifiée par ${by} :`, ...lines, '', "Tiens-en compte dans ton travail (l'outil `tasks.get` montre la tâche complète)."].join('\n'),
    }));
}

/** Compatibilité : le message destiné à une session en charge (par défaut la plus récente), null s'il n'y en a pas. */
export function feedFor(change: TaskChange, sessionId: string | null = change.task.sessionId): TaskFeed | null {
  if (!sessionId) return null;
  return feedsFor(change).find((f) => f.sessionId === sessionId) ?? null;
}

/** Transmet un message à la session concernée si elle peut le recevoir. */
async function deliver(feed: TaskFeed): Promise<void> {
  const session = await sessionService.get(feed.sessionId).catch(() => null);
  if (!session || session.archivedAt || session.status === 'queued' || session.status === 'pending') return;
  // Un provider non interactif (commande shell) exécuterait le texte comme une commande.
  if (!getProvider(session.provider).describe().interactive) return;
  if (session.status !== 'running' && !feed.restart) return;
  try {
    // Les fichiers du commentaire (ou ajoutés à la tâche) accompagnent le message, autant qu'une instruction en porte.
    const files: AttachmentInput[] = feed.attachments.length ? await asInstructionAttachments(fitInInstruction(feed.attachments).kept) : [];
    await sessionService.sendMessage(session.id, feed.text, files.length ? files : null);
  } catch (err) {
    console.warn(`[tasks] message non transmis à la session ${session.id} : ${(err as Error).message}`);
  }
}

/** Transmet le changement à toutes les sessions reliées à la tâche qui peuvent le recevoir. */
export async function deliverTaskChange(change: TaskChange): Promise<void> {
  const linked = await taskService.sessionIds(change.task.id).catch(() => [] as string[]);
  await Promise.all(feedsFor(change, linked).map(deliver));
}

/** Branche l'écouteur sur le service des tâches (au démarrage du serveur). */
export function registerTaskSessionFeed(): void {
  taskService.onTaskChanged('session-feed', deliverTaskChange);
}
