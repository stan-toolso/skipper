/**
 * Pull request suivie : l'objet qui matérialise une PR GitHub dans Skipper, rattaché à un projet et, le plus
 * souvent, à une tâche. Il vit en base (table pull_requests) ; la PR GitHub elle-même (`git/pullRequests.ts`)
 * est consultée pour le rafraîchir et pour agir (fusion).
 */

export type TrackedPullRequestStatus = 'open' | 'merged' | 'closed';
export const TRACKED_PR_STATUSES: TrackedPullRequestStatus[] = ['open', 'merged', 'closed'];

/**
 * Étape dérivée, celle qu'affichent les listes de suivi :
 * - `draft` : ouverte en brouillon ;
 * - `to_merge` : ouverte, à relire et fusionner ;
 * - `to_deploy` : fusionnée, pas encore mise en production ;
 * - `deployed` : fusionnée et déployée ;
 * - `cancelled` : fermée sans fusion.
 */
export type PullRequestStage = 'draft' | 'to_merge' | 'to_deploy' | 'deployed' | 'cancelled';
export const PR_STAGES: PullRequestStage[] = ['draft', 'to_merge', 'to_deploy', 'deployed', 'cancelled'];

export type PullRequestCreatorType = 'human' | 'agent' | 'system';

export interface TrackedPullRequest {
  id: string;
  projectId: string;
  taskId: string | null;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  status: TrackedPullRequestStatus;
  isDraft: boolean;
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
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch?: string | null;
  status?: TrackedPullRequestStatus | null;
  isDraft?: boolean | null;
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
  title?: string | null;
  status?: TrackedPullRequestStatus | null;
  isDraft?: boolean | null;
  baseBranch?: string | null;
  checksState?: string | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  syncedAt?: Date | null;
  mergeSha?: string | null;
  note?: string | null;
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
  headBranch?: string;
  limit?: number;
}

/** Étape d'une PR suivie, dérivée de son statut, de son brouillon et de son déploiement. */
export function stageOf(pr: Pick<TrackedPullRequest, 'status' | 'isDraft' | 'deployedAt'>): PullRequestStage {
  if (pr.status === 'closed') return 'cancelled';
  if (pr.status === 'merged') return pr.deployedAt ? 'deployed' : 'to_deploy';
  return pr.isDraft ? 'draft' : 'to_merge';
}

export const stageLabels: Record<PullRequestStage, string> = {
  draft: 'brouillon',
  to_merge: 'à fusionner',
  to_deploy: 'à déployer',
  deployed: 'déployée',
  cancelled: 'annulée',
};

export const statusLabels: Record<TrackedPullRequestStatus, string> = { open: 'ouverte', merged: 'fusionnée', closed: 'fermée' };

/** Détails lisibles de l'instantané GitHub d'une PR ouverte (checks, revue, conflits). */
export function describeSnapshot(pr: TrackedPullRequest): string[] {
  const hints: string[] = [];
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

/** Une PR suivie sur une ligne, pour les agents : « - <id> · PR #12 « titre » · à fusionner (checks réussis) · branche x → main · tâche <id> ». */
export function describePullRequest(pr: TrackedPullRequest): string {
  const stage = stageLabels[stageOf(pr)];
  const hints = describeSnapshot(pr);
  const parts = [`${pr.id} · PR #${pr.number} « ${pr.title} » · ${stage}${hints.length ? ` (${hints.join(', ')})` : ''}`, `${pr.headBranch}${pr.baseBranch ? ` → ${pr.baseBranch}` : ''}`];
  if (pr.taskId) parts.push(`tâche ${pr.taskId}`);
  if (pr.deployedAt) parts.push(`déployée le ${pr.deployedAt.toISOString().slice(0, 10)}${pr.deployNote ? ` (${pr.deployNote})` : ''}`);
  if (pr.note) parts.push(`note : ${pr.note}`);
  parts.push(pr.url);
  return `- ${parts.join(' · ')}`;
}
