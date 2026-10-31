import { AppError } from '../errors.js';
import type { WorkspaceRef } from '../files/service.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { gitService, type GitOperation, type GitStatus } from './service.js';

/**
 * Résolution des conflits git d'un dossier de travail confiée à un agent : quand une fusion (pull, fusion de la base,
 * merge, rebase, cherry-pick lancés dans un terminal ou par un agent) s'arrête sur des conflits, le panneau git
 * propose « Résoudre avec un agent ». La session du dossier reçoit la consigne ; s'il n'y en a plus, une session est
 * lancée dans le même dossier. L'agent termine l'opération sans pousser : la personne garde la main sur le push.
 * Module à part de `service.ts` pour ne pas y importer le service des sessions.
 */

/** Commande qui termine l'opération une fois les conflits résolus et indexés. */
const CONTINUE: Record<GitOperation, string> = {
  merge: 'git commit --no-edit',
  rebase: 'GIT_EDITOR=true git rebase --continue',
  'cherry-pick': 'GIT_EDITOR=true git cherry-pick --continue',
  revert: 'GIT_EDITOR=true git revert --continue',
};
const OPERATION_LABEL: Record<GitOperation, string> = { merge: 'une fusion (merge)', rebase: 'un rebase', 'cherry-pick': 'un cherry-pick', revert: 'un revert' };

/** Fichiers en conflit (non fusionnés) d'un état git. */
export const conflictedFiles = (status: Pick<GitStatus, 'changes'>) => status.changes.filter((c) => c.conflicted).map((c) => c.path);

/** La consigne envoyée à l'agent : résoudre, vérifier, terminer l'opération, ne pas pousser. */
export function gitConflictPrompt(status: Pick<GitStatus, 'branch' | 'operation' | 'changes'>): string {
  const files = conflictedFiles(status);
  const op = status.operation;
  const where = status.branch ? `sur la branche \`${status.branch}\`` : 'en HEAD détaché';
  return [
    `Ton dossier de travail (${where}) est au milieu d'${op ? OPERATION_LABEL[op] : 'une opération git'} arrêtée sur des conflits${files.length ? `, dans ${files.length} fichier(s) :` : '.'}`,
    ...(files.length ? [files.map((f) => `- \`${f}\``).join('\n')] : []),
    [
      'Résous-les :',
      '1. lis `git status` et, pour chaque fichier, comprends l\'intention des deux côtés (`git log --merge`, `git diff`) ; garde le travail des deux, ne supprime pas l\'un pour faire passer l\'autre ;',
      '2. retire tous les marqueurs de conflit (`<<<<<<<`, `=======`, `>>>>>>>`) et indexe chaque fichier résolu (`git add`) ;',
      '3. lance les vérifications du projet (typecheck, et les tests concernés) et corrige ce que la résolution a cassé ;',
      `4. termine l'opération${op ? ` (\`${CONTINUE[op]}\`)` : ''} et vérifie que \`git status\` ne signale plus de conflit ni d'opération en cours.`,
    ].join('\n'),
    "**Ne pousse pas** (ni `git push`, ni pull request) : la personne relit et pousse elle-même depuis le panneau git. N'abandonne pas l'opération (`--abort`) sans le lui demander. Rends compte brièvement des conflits rencontrés et de la façon dont tu les as résolus.",
  ].join('\n\n');
}

/**
 * Confie la résolution des conflits du dossier à un agent : la session active du dossier reçoit la consigne (relancée
 * si elle est terminée), sinon une nouvelle session Claude est lancée dans ce dossier. Renvoie la session.
 */
export async function requestGitConflictResolution(ref: WorkspaceRef, ownerId: string): Promise<Session> {
  if (!ref.worksessionId) throw new AppError("Aucune session ne travaille dans le dossier principal du projet : résolvez les conflits dans un terminal, ou depuis le dossier d'une session");
  const status = await gitService.status(ref);
  if (!conflictedFiles(status).length && !status.operation) throw new AppError('Aucun conflit à résoudre dans ce dossier');
  const prompt = gitConflictPrompt(status);
  const [active] = await sessionRepository.list({ projectId: ref.projectId, worksessionId: ref.worksessionId, archived: 'exclude', limit: 1 });
  if (active) return sessionService.sendMessage(active.id, prompt);
  return sessionService.create({
    projectId: ref.projectId,
    worksessionId: ref.worksessionId,
    name: `Conflits git${status.branch ? ` · ${status.branch}` : ''}`.slice(0, 80),
    provider: 'claude',
    prompt,
    ownerId,
    autoStart: true,
  });
}
