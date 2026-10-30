import { AppError } from '../errors.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { trackedPullRequestService } from './service.js';
import type { PullRequestActor, TrackedPullRequest } from './types.js';

/**
 * Session d'agent rattachée à une pull request suivie, et demande de résolution des conflits : quand GitHub signale
 * que la PR ne peut plus être fusionnée (conflits avec sa base), la personne demande d'un bouton à la session qui
 * travaille sur la branche de les résoudre. Module à part de `service.ts` pour ne pas y importer le service des
 * sessions (dont les providers importent déjà le service des PR suivies).
 */

/**
 * La session rattachée : la session non archivée la plus récente du dossier de travail dont la branche est celle de
 * la PR, sinon celle qui a ouvert la PR si elle n'est pas archivée. Null quand personne ne peut recevoir d'instruction.
 */
export async function pullRequestSession(pr: Pick<TrackedPullRequest, 'projectId' | 'headBranch' | 'createdBySessionId'>): Promise<Session | null> {
  const ws = pr.headBranch ? await worksessionRepository.findByBranch(pr.projectId, pr.headBranch) : null;
  if (ws) {
    const [session] = await sessionRepository.list({ projectId: pr.projectId, worksessionId: ws.id, limit: 1 });
    if (session) return session;
  }
  if (!pr.createdBySessionId) return null;
  const creator = await sessionRepository.findById(pr.createdBySessionId);
  return creator && !creator.archivedAt && creator.projectId === pr.projectId ? creator : null;
}

/** L'instruction envoyée à la session : fusionner la base dans la branche, résoudre, vérifier, pousser. */
export function conflictResolutionPrompt(pr: Pick<TrackedPullRequest, 'number' | 'title' | 'url' | 'headBranch' | 'baseBranch'>): string {
  const base = pr.baseBranch || 'la branche principale';
  const baseRef = pr.baseBranch ? `origin/${pr.baseBranch}` : 'la branche principale distante';
  return [
    `La pull request #${pr.number} « ${pr.title} » (${pr.url}) a des conflits avec sa branche de base \`${base}\` : GitHub ne peut plus la fusionner.`,
    `Résous-les dans ta branche \`${pr.headBranch}\` : récupère \`${baseRef}\` (git fetch origin), fusionne-la dans la branche (git merge ${baseRef}), résous chaque conflit en préservant l'intention des deux côtés (ne supprime pas le travail de la base ni celui de la branche), vérifie que le typecheck et les tests passent, puis commite la fusion et pousse la branche pour que la PR redevienne fusionnable.`,
    'Ne fusionne pas la PR toi-même, et rends compte brièvement des conflits rencontrés et de la façon dont tu les as résolus.',
  ].join('\n\n');
}

/**
 * Demande à la session rattachée de résoudre les conflits de la PR : l'instruction lui est envoyée (transmise à
 * l'agent si la session est en cours, relance de la session sinon). Renvoie la session.
 */
export async function requestConflictResolution(id: string, actor: PullRequestActor): Promise<Session> {
  const pr = await trackedPullRequestService.get(id);
  if (pr.status !== 'open') throw new AppError(`La pull request #${pr.number} n'est plus ouverte`);
  const session = await pullRequestSession(pr);
  if (!session) throw new AppError(`Aucune session d'agent n'est rattachée à la pull request #${pr.number} : lancez une session sur sa branche ${pr.headBranch}`);
  const prompt = conflictResolutionPrompt(pr);
  const sent = await sessionService.sendMessage(session.id, actor.type === 'human' ? prompt : `${prompt}\n\n(Demande transmise par une autre session d'agent.)`);
  return sent;
}
