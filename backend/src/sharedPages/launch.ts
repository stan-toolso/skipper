import type { Project } from '../projects/types.js';
import { userService } from '../users/service.js';
import type { SharedPage } from './types.js';

/** La session est-elle encore en train de travailler (ni terminée, ni archivée, ni au repos) ? */
export const sessionBusy = (s: { status: string; activity: string | null; archivedAt: Date | null } | null) =>
  Boolean(s && !s.archivedAt && (s.status === 'pending' || s.status === 'queued' || (s.status === 'running' && s.activity !== 'idle')));

/**
 * Lance une session pour un artefact de données (source agent, alerte) : l'agent du projet nommé (convoqué, archivée
 * d'office en fin de tour), sinon une session au nom du propriétaire de l'artefact dans une nouvelle work session.
 * Mêmes contrôles qu'une planification : identifiants et plafonds de qui joue la session, budget du projet (lèvent).
 * Renvoie l'identifiant de la session.
 */
export async function launchArtifactSession(page: Pick<SharedPage, 'id' | 'title' | 'ownerId'>, project: Project, opts: { agent: string | null; text: string; name: string }): Promise<string> {
  // Imports à la demande : sessions et agents dépendent eux-mêmes des pages partagées (outils MCP).
  const { sessionService } = await import('../sessions/service.js');
  const { agentService } = await import('../agents/service.js');
  const { autoArchiveConfig } = await import('../sessions/autoArchive.js');
  const { claudeSettings } = await import('../settings/claude.js');
  const { projectBudget } = await import('../projects/budget.js');
  const { systemAuthor } = await import('../sessions/instructionAuthor.js');
  const agent = opts.agent ? await agentService.resolve(project.id, opts.agent) : null;
  // Comptes de qui joue la session : pour un agent (ou une page d'agent), le compte Claude qu'une personne lui prête.
  const accounts = await agentService.accountsForOwner(agent ? agent.id : page.ownerId);
  const settings = await claudeSettings.forSession(accounts?.claudeUserId ?? null);
  settings.assertCredentials();
  await settings.assertBudgetAvailable();
  await projectBudget.assertAvailable(project.id);
  if (agent) {
    const owner = await userService.get(page.ownerId).catch(() => null);
    const session = await agentService.summon(agent.id, { text: opts.text, autoArchive: true, requestedById: owner && owner.kind !== 'agent' ? owner.id : null, actor: { type: 'human' } });
    return session.id;
  }
  const session = await sessionService.create({
    projectId: project.id,
    name: opts.name.slice(0, 80),
    provider: 'claude',
    config: autoArchiveConfig(),
    newWorksession: {},
    ownerId: page.ownerId,
    autoStart: false,
  });
  await sessionService.sendMessage(session.id, opts.text, null, { author: systemAuthor(`Artefact « ${page.title} »`) });
  return session.id;
}
