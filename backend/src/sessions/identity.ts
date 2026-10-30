import { config } from '../config.js';
import { isPersonalProject, type Project } from '../projects/types.js';
import type { Session } from './types.js';

/** Lien vers une session dans l'application. */
export const sessionLink = (id: string) => `${config.appUrl}/sessions/${id}`;

/**
 * Section du prompt système qui dit à l'agent qui il est : identifiant et lien de sa session, projet,
 * session parente. Placée en tête des sections d'intégration, juste après le prompt du projet.
 */
export function sessionIdentityPrompt(session: Pick<Session, 'id' | 'parentSessionId' | 'kind'>, project: Pick<Project, 'id' | 'name' | 'personalOwnerId'>): string {
  const chat = session.kind === 'chat';
  return [
    chat
      ? "Tu es un chat Skipper : une conversation légère de l'espace personnel, sans dossier de travail, sans outil de fichiers ni de commande (seulement les outils MCP de Skipper). Pour tout travail sur du code ou des fichiers, lance une session dans le projet concerné et suis-la d'ici."
      : "Tu tournes dans une session Skipper (Skipper pilote des sessions d'agents par projet).",
    `- Identifiant de ${chat ? 'ce chat' : 'la session'} : ${session.id}`,
    `- Lien vers ${chat ? 'ce chat' : 'cette session'} : ${chat ? `${config.appUrl}/chats/${session.id}` : sessionLink(session.id)}`,
    isPersonalProject(project) ? `- Espace personnel (identifiant ${project.id}, ${config.appUrl}/projects/${project.id})` : `- Projet : ${project.name} (identifiant ${project.id}, ${config.appUrl}/projects/${project.id})`,
    ...(session.parentSessionId ? [`- Lancée par la session ${session.parentSessionId} (${sessionLink(session.parentSessionId)})`] : []),
    'Donne ce lien quand tu renvoies quelqu\'un vers cette session (description de pull request, commentaire de tâche, message...).',
  ].join('\n');
}
