import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import type { Session } from './types.js';

/** Lien vers une session dans l'application. */
export const sessionLink = (id: string) => `${config.appUrl}/sessions/${id}`;

/**
 * Section du prompt système qui dit à l'agent qui il est : identifiant et lien de sa session, projet,
 * session parente. Placée en tête des sections d'intégration, juste après le prompt du projet.
 */
export function sessionIdentityPrompt(session: Pick<Session, 'id' | 'parentSessionId'>, project: Pick<Project, 'id' | 'name'>): string {
  return [
    "Tu tournes dans une session Skipper (Skipper pilote des sessions d'agents par projet).",
    `- Identifiant de la session : ${session.id}`,
    `- Lien vers cette session : ${sessionLink(session.id)}`,
    `- Projet : ${project.name} (identifiant ${project.id}, ${config.appUrl}/projects/${project.id})`,
    ...(session.parentSessionId ? [`- Lancée par la session ${session.parentSessionId} (${sessionLink(session.parentSessionId)})`] : []),
    'Donne ce lien quand tu renvoies quelqu\'un vers cette session (description de pull request, commentaire de tâche, message...).',
  ].join('\n');
}
