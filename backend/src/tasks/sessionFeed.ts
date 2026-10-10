import { sessionService } from '../sessions/service.js';
import { getProvider } from '../sessions/providers/registry.js';
import { describeTaskChanges, taskService } from './service.js';
import type { TaskChange } from './types.js';

const fmtDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/**
 * Message à transmettre à la session en charge d'une tâche pour un changement fait par quelqu'un d'autre,
 * ou null s'il n'y a rien à lui dire. `restart` : un commentaire relance une session terminée (il lui est
 * adressé) ; une simple modification n'est transmise qu'à une session en cours (une session terminée relira
 * la tâche à son prochain démarrage grâce à son prompt système).
 */
export function feedFor(change: TaskChange): { sessionId: string; text: string; restart: boolean } | null {
  const sessionId = change.task.sessionId;
  if (!sessionId) return null;
  if (change.kind === 'commented') {
    const c = change.comment;
    if (c.authorSessionId === sessionId) return null;
    const body = c.body.split('\n').map((l) => `  ${l}`).join('\n');
    return {
      sessionId,
      restart: true,
      text: [
        `[Commentaire sur la tâche] Nouveau commentaire sur la tâche ${change.task.id} (« ${change.task.title} ») dont cette session est en charge :`,
        `- ${c.authorName}${c.authorType === 'agent' ? ' (agent)' : ''}, ${fmtDate(c.createdAt)} UTC :`,
        body,
        '',
        "Réponds-y avec l'outil `tasks.comment` quand il appelle une réponse.",
      ].join('\n'),
    };
  }
  // Passation à une autre session : la nouvelle a reçu la tâche entière ; sans acteur (Skipper lui-même), rien à dire.
  if (change.before.sessionId !== sessionId || !change.actor || change.actor.sessionId === sessionId) return null;
  const lines = describeTaskChanges(change.before, change.task);
  if (!lines.length) return null;
  const by = change.actor.type === 'agent' ? `la session d'agent « ${change.actor.name ?? 'inconnue'} » (${change.actor.sessionId ?? '?'})` : change.actor.name || 'une personne';
  return {
    sessionId,
    restart: false,
    text: [`[Mise à jour de la tâche] La tâche ${change.task.id} (« ${change.task.title} ») dont cette session est en charge a été modifiée par ${by} :`, ...lines, '', "Tiens-en compte dans ton travail (l'outil `tasks.get` montre la tâche complète)."].join('\n'),
  };
}

/** Transmet le message à la session concernée si elle peut le recevoir. */
export async function deliverTaskChange(change: TaskChange): Promise<void> {
  const feed = feedFor(change);
  if (!feed) return;
  const session = await sessionService.get(feed.sessionId);
  if (!session || session.archivedAt || session.status === 'queued' || session.status === 'pending') return;
  // Un provider non interactif (commande shell) exécuterait le texte comme une commande.
  if (!getProvider(session.provider).describe().interactive) return;
  if (session.status !== 'running' && !feed.restart) return;
  try {
    await sessionService.sendMessage(session.id, feed.text);
  } catch (err) {
    console.warn(`[tasks] message non transmis à la session ${session.id} : ${(err as Error).message}`);
  }
}

/** Branche l'écouteur sur le service des tâches (au démarrage du serveur). */
export function registerTaskSessionFeed(): void {
  taskService.onTaskChanged('session-feed', deliverTaskChange);
}
