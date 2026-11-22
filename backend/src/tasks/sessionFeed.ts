import { agentFeedTargets } from '../agents/triggers.js';
import { sessionService } from '../sessions/service.js';
import { getProvider } from '../sessions/providers/registry.js';
import type { AttachmentInput } from '../sessions/types.js';
import { asInstructionAttachments, fitInInstruction } from './attachments.js';
import { describeComment, describeTaskChanges, taskService } from './service.js';
import type { Task, TaskAttachment, TaskChange } from './types.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import type { TaskStatusDefinition } from './statuses.js';

/** Message à transmettre à une session reliée à une tâche pour un changement fait par quelqu'un d'autre. */
export interface TaskFeed {
  sessionId: string;
  text: string;
  /** Le message relance une session terminée (il lui est adressé) ; sinon il n'est transmis qu'à une session en cours. */
  restart: boolean;
  /**
   * Note discrète : le changement ne s'adresse pas à la session. Il ne lui ouvre pas de tour (ce qui ferait répondre
   * l'agent « rien à faire » dans le fil de la session) : il lui est remis avec le résultat de ses prochains outils ou
   * avec sa prochaine instruction (`sessionService.notify`). Une note n'est jamais une relance.
   */
  quiet: boolean;
  attachments: TaskAttachment[];
  /** Fichiers déjà prêts pour l'instruction (base64), à la place de `attachments` : ceux d'un message de canal (conversations/feed.ts). */
  files?: AttachmentInput[];
}

/** La session est-elle en charge de la tâche (plusieurs peuvent l'être) ? */
const inCharge = (task: Task, sessionId: string) => task.sessionIds.includes(sessionId);
/** Lien d'une session avec la tâche, pour le lui rappeler : en charge, ou simplement reliée. */
const bond = (change: TaskChange, sessionId: string) => (inCharge(change.task, sessionId) ? 'dont cette session est en charge' : 'à laquelle cette session est reliée');
/** Fin d'une note discrète : l'agent n'a pas à en rendre compte (l'humain ne la voit qu'en détail dans la session). */
const QUIET_HINT = "Pour information : poursuis sans en parler, sauf si cela change ton travail (l'outil `tasks.get` montre la tâche complète).";

/**
 * Pertinence d'un changement pour une session, qui décide entre message (un tour de l'agent, visible dans la session)
 * et note discrète : un message du fil n'est adressé qu'aux sessions en charge et à celles qu'il mentionne ; une
 * modification ne l'est qu'aux sessions en charge, et seulement quand une personne l'a faite (un statut changé par une
 * autre session d'agent n'appelle rien) et pas quand elle ferme la tâche (ses sessions se terminent). Le reste (sessions seulement reliées, réactions) passe en note.
 *
 * Messages à transmettre aux sessions reliées à la tâche (toutes celles en charge, celles passées par la tâche ou
 * mentionnées dans son fil : `linked`) pour un changement fait par quelqu'un d'autre. Un message du fil relance les
 * sessions en charge et les sessions qu'il mentionne (il leur est adressé) ; les autres sessions reliées ne le
 * reçoivent que si elles tournent, en note discrète. Une modification n'est transmise qu'aux sessions en cours (une session terminée
 * relira la tâche à son prochain démarrage grâce à son prompt système), et pas à celle qui vient de prendre la charge
 * (elle a reçu la tâche entière). Une réaction n'est signalée qu'à la session autrice du message.
 */
export function feedsFor(change: TaskChange, linked: string[] = [], alsoAddressed: Set<string> = new Set(), statuses: TaskStatusDefinition[] | null = null): TaskFeed[] {
  const recipients = new Set<string>(linked);
  for (const id of change.task.sessionIds) recipients.add(id);
  if (change.kind === 'commented') {
    const c = change.comment;
    const mentioned = new Set(c.mentions.filter((m) => m.kind === 'session').map((m) => m.id));
    for (const id of mentioned) recipients.add(id);
    for (const id of alsoAddressed) recipients.add(id);
    return [...recipients]
      .filter((sessionId) => sessionId !== c.authorSessionId)
      .map((sessionId) => {
        // Une session d'agent qui suit le fil (ou dont l'agent est mentionné) reçoit le message comme une instruction (agents/triggers.ts).
        const addressed = inCharge(change.task, sessionId) || mentioned.has(sessionId) || alsoAddressed.has(sessionId);
        return {
          sessionId,
          restart: addressed,
          quiet: !addressed,
          attachments: change.attachments,
          text: [
            `[Commentaire sur la tâche] Nouveau message dans le fil de la tâche ${change.task.id} (« ${change.task.title} ») ${bond(change, sessionId)}${mentioned.has(sessionId) ? ', qui mentionne cette session' : ''} :`,
            ...describeComment(c, change.attachments, 'instruction', { replyTo: change.parent }),
            '',
            addressed
              ? `Réponds-y avec l'outil \`tasks.comment\` (reply_to : ${change.parent?.id ?? c.id} pour rester dans son fil) quand il appelle une réponse ; \`tasks.react\` pour un simple accusé.`
              : QUIET_HINT,
          ].join('\n'),
        };
      });
  }
  if (change.kind === 'reacted') {
    const target = change.comment;
    if (!target?.authorSessionId || target.authorSessionId === change.reaction.sessionId) return [];
    const r = change.reaction;
    return [
      {
        sessionId: target.authorSessionId,
        restart: false,
        quiet: true,
        attachments: [],
        text: `[Réaction sur la tâche] ${r.actorName}${r.actorType === 'agent' ? ' (agent)' : ''} ${change.added ? 'a réagi' : 'a retiré sa réaction'} ${r.emoji} ${change.added ? 'à' : 'de'} ton message ${target.id} de la tâche ${change.task.id} (« ${change.task.title} »)${change.added ? ` : « ${target.body.slice(0, 120)}${target.body.length > 120 ? '…' : ''} »` : ''}. Rien à faire, sauf si cela appelle une suite.`,
      },
    ];
  }
  // Sans acteur (Skipper lui-même : lancement, fusion), rien à dire.
  if (!change.actor) return [];
  const lines = describeTaskChanges(change.before, change.task, change.addedAttachments, statuses);
  if (!lines.length) return [];
  // Tâche fermée (terminée ou annulée) : ses sessions se terminent (tasks/endSessions.ts) ; un tour juste pour en
  // prendre acte serait facturé sans travail. Elles en reçoivent une note.
  const closing = change.before.status !== change.task.status && (change.task.status === 'done' || change.task.status === 'cancelled');
  const by = change.actor.type === 'agent' ? `la session d'agent « ${change.actor.name ?? 'inconnue'} » (${change.actor.sessionId ?? '?'})` : change.actor.name || 'une personne';
  return [...recipients]
    // Passation : la session qui vient de prendre la charge a reçu la tâche entière ; l'auteur du changement n'a rien à apprendre.
    .filter((sessionId) => sessionId !== change.actor?.sessionId && !(inCharge(change.task, sessionId) && !inCharge(change.before, sessionId)))
    .map((sessionId) => {
      const quiet = closing || !(inCharge(change.task, sessionId) && change.actor?.type !== 'agent');
      return {
        sessionId,
        restart: false,
        quiet,
        attachments: change.addedAttachments,
        text: [`[Mise à jour de la tâche] La tâche ${change.task.id} (« ${change.task.title} ») ${bond(change, sessionId)} a été modifiée par ${by} :`, ...lines, '', quiet ? QUIET_HINT : "Tiens-en compte dans ton travail (l'outil `tasks.get` montre la tâche complète)."].join('\n'),
      };
    });
}

/** Compatibilité : le message destiné à une session en charge (par défaut la plus récente), null s'il n'y en a pas. */
export function feedFor(change: TaskChange, sessionId: string | null = change.task.sessionId): TaskFeed | null {
  if (!sessionId) return null;
  return feedsFor(change).find((f) => f.sessionId === sessionId) ?? null;
}

/** Transmet un message à la session concernée si elle peut le recevoir (aussi utilisé par conversations/feed.ts). */
export async function deliverFeed(feed: TaskFeed): Promise<void> {
  const session = await sessionService.get(feed.sessionId).catch(() => null);
  if (!session || session.archivedAt || session.status === 'queued' || session.status === 'pending') return;
  // Un provider non interactif (commande shell) exécuterait le texte comme une commande.
  if (!getProvider(session.provider).describe().interactive) return;
  if (session.status !== 'running' && !feed.restart) return;
  try {
    // Note discrète : remise à l'agent sans lui ouvrir de tour (les fichiers ne l'accompagnent pas : tasks.get les liste).
    if (feed.quiet) {
      await sessionService.notify(session.id, feed.text);
      return;
    }
    // Les fichiers du commentaire (ou ajoutés à la tâche) accompagnent le message, autant qu'une instruction en porte.
    const files: AttachmentInput[] = feed.files ?? (feed.attachments.length ? await asInstructionAttachments(fitInInstruction(feed.attachments).kept) : []);
    await sessionService.sendMessage(session.id, feed.text, files.length ? files : null);
  } catch (err) {
    log.warn(`[tasks] message non transmis à la session ${session.id} : ${(err as Error).message}`);
  }
}

/** Transmet le changement à toutes les sessions reliées à la tâche qui peuvent le recevoir. */
export async function deliverTaskChange(change: TaskChange): Promise<void> {
  const linked = await taskService.sessionIds(change.task.id).catch(() => [] as string[]);
  const addressed = await agentFeedTargets(change, linked).catch(() => new Set<string>());
  const statuses = change.kind === 'updated' ? await projectService.get(change.task.projectId).then((p) => p.taskStatuses).catch(() => null) : null;
  await Promise.all(feedsFor(change, linked, addressed, statuses).map(deliverFeed));
}

/** Branche l'écouteur sur le service des tâches (au démarrage du serveur). */
export function registerTaskSessionFeed(): void {
  taskService.onTaskChanged('session-feed', deliverTaskChange);
}
