/**
 * Pull request suivie : l'objet qui matérialise une PR dans Skipper, rattaché à un projet et, le plus souvent, à une
 * tâche. Il vit en base (table pull_requests) ; la PR GitHub elle-même (`git/pullRequests.ts`) est consultée pour le
 * rafraîchir et pour agir (fusion). Il existe avant GitHub : une PR « en préparation » suit une branche qui porte déjà
 * des modifications sans pull request ouverte. Il peut viser un autre dépôt GitHub que celui du projet (`repo`).
 */

export type TrackedPullRequestStatus = 'pending' | 'open' | 'merged' | 'closed';
export const TRACKED_PR_STATUSES: TrackedPullRequestStatus[] = ['pending', 'open', 'merged', 'closed'];
/** Statuts qu'un humain ou un agent peut poser directement (« pending » est posé par la synchronisation seulement). */
export const SETTABLE_PR_STATUSES: TrackedPullRequestStatus[] = ['open', 'merged', 'closed'];

/**
 * Étape dérivée, celle qu'affichent les listes de suivi :
 * - `pending` : en préparation, la branche porte des modifications mais aucune PR n'est ouverte ;
 * - `draft` : ouverte en brouillon ;
 * - `to_merge` : ouverte, à relire et fusionner ;
 * - `to_deploy` : fusionnée, pas encore mise en production ;
 * - `deployed` : fusionnée et déployée ;
 * - `cancelled` : fermée sans fusion.
 */
export type PullRequestStage = 'pending' | 'draft' | 'to_merge' | 'to_deploy' | 'deployed' | 'cancelled';
export const PR_STAGES: PullRequestStage[] = ['pending', 'draft', 'to_merge', 'to_deploy', 'deployed', 'cancelled'];

export type PullRequestCreatorType = 'human' | 'agent' | 'system';

export interface TrackedPullRequest {
  id: string;
  projectId: string;
  taskId: string | null;
  /** Dépôt GitHub « owner/name » de la PR : celui du projet le plus souvent, un autre si la session a travaillé ailleurs ; vide sans GitHub. */
  repo: string;
  /** Numéro GitHub ; null tant que la PR est en préparation. */
  number: number | null;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  status: TrackedPullRequestStatus;
  isDraft: boolean;
  /** Work session (branche) dont la PR suit le travail, quand elle est connue. */
  worksessionId: string | null;
  /** Travail local constaté à la dernière synchronisation (PR en préparation) : commits en avance sur la base. */
  localCommits: number | null;
  /** Fichiers modifiés non commités constatés à la dernière synchronisation. */
  localChanges: number | null;
  /** Instantané GitHub du dernier rafraîchissement : SUCCESS, FAILURE, PENDING, ERROR, EXPECTED. */
  checksState: string | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED. */
  reviewDecision: string | null;
  /** MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: string | null;
  syncedAt: Date | null;
  mergeSha: string | null;
  deployedAt: Date | null;
  deployedByType: 'human' | 'agent' | null;
  deployedByUserId: string | null;
  deployedBySessionId: string | null;
  deployNote: string;
  note: string;
  createdByType: PullRequestCreatorType;
  createdByUserId: string | null;
  createdBySessionId: string | null;
  /** Ouverture sur GitHub ; pour une PR en préparation, le début du suivi. */
  openedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Qui agit sur une PR suivie : personne (interface), session d'agent (outils MCP) ou Skipper lui-même (synchronisation). */
export interface PullRequestActor {
  type: PullRequestCreatorType;
  userId?: string | null;
  sessionId?: string | null;
}

export interface CreateTrackedPullRequestInput {
  taskId?: string | null;
  repo?: string | null;
  /** Null : PR en préparation (status `pending`). */
  number: number | null;
  url: string;
  title: string;
  headBranch: string;
  baseBranch?: string | null;
  status?: TrackedPullRequestStatus | null;
  isDraft?: boolean | null;
  worksessionId?: string | null;
  localCommits?: number | null;
  localChanges?: number | null;
  checksState?: string | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  note?: string | null;
  openedAt?: Date | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
}

export interface UpdateTrackedPullRequestInput {
  /** Absent : inchangée ; null : détachée de sa tâche. */
  taskId?: string | null;
  /** Numéro et URL reçus quand une PR en préparation est ouverte sur GitHub. */
  number?: number | null;
  url?: string | null;
  repo?: string | null;
  title?: string | null;
  status?: TrackedPullRequestStatus | null;
  isDraft?: boolean | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  worksessionId?: string | null;
  localCommits?: number | null;
  localChanges?: number | null;
  checksState?: string | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  syncedAt?: Date | null;
  mergeSha?: string | null;
  note?: string | null;
  openedAt?: Date | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  /** Marquée déployée (true, avec `deployedBy` et `deployNote`) ou plus déployée (false). */
  deployed?: boolean | null;
  deployedBy?: PullRequestActor | null;
  deployNote?: string | null;
}

export interface TrackedPullRequestFilter {
  projectId?: string;
  projectIds?: string[];
  taskId?: string;
  status?: TrackedPullRequestStatus[];
  stage?: PullRequestStage[];
  /** Numéro GitHub. */
  number?: number;
  /** Dépôt « owner/name » (comparé sans tenir compte de la casse). */
  repo?: string;
  headBranch?: string;
  worksessionId?: string;
  limit?: number;
}

/** Étape d'une PR suivie, dérivée de son statut, de son brouillon et de son déploiement. */
export function stageOf(pr: Pick<TrackedPullRequest, 'status' | 'isDraft' | 'deployedAt'>): PullRequestStage {
  if (pr.status === 'pending') return 'pending';
  if (pr.status === 'closed') return 'cancelled';
  if (pr.status === 'merged') return pr.deployedAt ? 'deployed' : 'to_deploy';
  return pr.isDraft ? 'draft' : 'to_merge';
}

export const stageLabels: Record<PullRequestStage, string> = {
  pending: 'en préparation',
  draft: 'brouillon',
  to_merge: 'à fusionner',
  to_deploy: 'à déployer',
  deployed: 'déployée',
  cancelled: 'annulée',
};

export const statusLabels: Record<TrackedPullRequestStatus, string> = { pending: 'en préparation', open: 'ouverte', merged: 'fusionnée', closed: 'fermée' };

/** Deux dépôts « owner/name » désignent-ils le même dépôt GitHub (casse ignorée) ? */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

/** Référence courte d'une PR : « #12 » dans le dépôt du projet, « owner/name#12 » dans un autre dépôt ; la branche pour une PR en préparation. */
export function pullRequestRef(pr: Pick<TrackedPullRequest, 'repo' | 'number' | 'headBranch'>, projectRepo?: string | null): string {
  if (pr.number == null) return `branche ${pr.headBranch}`;
  return pr.repo && !sameRepo(pr.repo, projectRepo) ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
}

/** Travail local d'une PR en préparation, lisible : « 3 commits, 2 fichiers non commités ». */
export function describeLocalWork(pr: Pick<TrackedPullRequest, 'localCommits' | 'localChanges'>): string {
  const parts: string[] = [];
  if (pr.localCommits) parts.push(`${pr.localCommits} commit${pr.localCommits > 1 ? 's' : ''}`);
  if (pr.localChanges) parts.push(`${pr.localChanges} fichier${pr.localChanges > 1 ? 's' : ''} non commité${pr.localChanges > 1 ? 's' : ''}`);
  return parts.join(', ');
}

/** Détails lisibles de l'instantané GitHub d'une PR ouverte (checks, revue, conflits), ou du travail local d'une PR en préparation. */
export function describeSnapshot(pr: TrackedPullRequest): string[] {
  const hints: string[] = [];
  if (pr.status === 'pending') {
    const work = describeLocalWork(pr);
    return work ? [work] : hints;
  }
  if (pr.status !== 'open') return hints;
  if (pr.mergeable === 'CONFLICTING') hints.push('conflits avec la base');
  if (pr.checksState === 'FAILURE' || pr.checksState === 'ERROR') hints.push('checks en échec');
  else if (pr.checksState === 'PENDING' || pr.checksState === 'EXPECTED') hints.push('checks en cours');
  else if (pr.checksState === 'SUCCESS') hints.push('checks réussis');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') hints.push('modifications demandées');
  else if (pr.reviewDecision === 'APPROVED') hints.push('approuvée');
  else if (pr.reviewDecision === 'REVIEW_REQUIRED') hints.push('revue requise');
  return hints;
}

/**
 * Une PR suivie sur une ligne, pour les agents : « - <id> · PR #12 « titre » · à fusionner (checks réussis) · branche x → main · tâche <id> ».
 * Une PR en préparation : « - <id> · branche task/x « titre » · en préparation (3 commits) · … · pas encore ouverte sur GitHub (pr_open) ».
 * `projectRepo` : dépôt du projet, pour ne nommer le dépôt que quand la PR est ailleurs.
 */
export function describePullRequest(pr: TrackedPullRequest, projectRepo?: string | null): string {
  const stage = stageLabels[stageOf(pr)];
  const hints = describeSnapshot(pr);
  const ref = pr.number == null ? pullRequestRef(pr, projectRepo) : `PR ${pullRequestRef(pr, projectRepo ?? pr.repo)}`;
  const parts = [`${pr.id} · ${ref} « ${pr.title} » · ${stage}${hints.length ? ` (${hints.join(', ')})` : ''}`, `${pr.headBranch}${pr.baseBranch ? ` → ${pr.baseBranch}` : ''}`];
  if (pr.taskId) parts.push(`tâche ${pr.taskId}`);
  if (pr.deployedAt) parts.push(`déployée le ${pr.deployedAt.toISOString().slice(0, 10)}${pr.deployNote ? ` (${pr.deployNote})` : ''}`);
  if (pr.note) parts.push(`note : ${pr.note}`);
  if (pr.number == null) parts.push('pas encore ouverte sur GitHub (pr_open, ou pr_register si elle l’a été autrement)');
  else parts.push(pr.url);
  return `- ${parts.join(' · ')}`;
}
