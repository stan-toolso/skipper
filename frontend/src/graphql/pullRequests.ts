import { gql } from '@apollo/client';
import type { TaskStatus } from './operations';

/**
 * Pull requests suivies : l'objet Skipper qui matérialise une PR GitHub (statut, étape, déploiement, note),
 * rattaché à un projet et le plus souvent à une tâche. La PR GitHub en direct reste `PullRequest` (operations.ts).
 */

export type TrackedPullRequestStatus = 'PENDING' | 'OPEN' | 'MERGED' | 'CLOSED';
export type PullRequestStage = 'PENDING' | 'DRAFT' | 'TO_MERGE' | 'TO_DEPLOY' | 'DEPLOYED' | 'CANCELLED';
export const PR_STAGES: PullRequestStage[] = ['PENDING', 'DRAFT', 'TO_MERGE', 'TO_DEPLOY', 'DEPLOYED', 'CANCELLED'];

export interface TrackedPullRequest {
  id: string;
  /** Dépôt GitHub « owner/name » (vide sans GitHub). */
  repo: string;
  /** La PR est dans un autre dépôt que celui du projet. */
  foreignRepo: boolean;
  /** Null tant que la PR est en préparation (pas encore ouverte sur GitHub). */
  number: number | null;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  status: TrackedPullRequestStatus;
  isDraft: boolean;
  stage: PullRequestStage;
  worksession: { id: string; name: string; branch: string } | null;
  localCommits: number | null;
  localChanges: number | null;
  checksState: string | null;
  reviewDecision: string | null;
  mergeable: string | null;
  syncedAt: string | null;
  mergeSha: string | null;
  deployedAt: string | null;
  deployedByType: 'human' | 'agent' | null;
  deployNote: string;
  note: string;
  createdByType: 'human' | 'agent' | 'system';
  openedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; name: string };
  task: { id: string; title: string; status: TaskStatus } | null;
  createdBy: { id: string; name: string } | null;
  createdBySession: { id: string; name: string } | null;
  deployedBy: { id: string; name: string } | null;
  deployedBySession: { id: string; name: string } | null;
}

/** Sous-ensemble porté par une tâche (listes, grille, carte). */
export type TrackedPullRequestSummary = Pick<TrackedPullRequest, 'id' | 'repo' | 'foreignRepo' | 'number' | 'url' | 'title' | 'status' | 'isDraft' | 'stage' | 'checksState' | 'reviewDecision' | 'mergeable' | 'headBranch' | 'baseBranch' | 'note' | 'deployedAt' | 'worksession' | 'localCommits' | 'localChanges'>;

/** Référence courte : « #42 », « owner/name#42 » dans un autre dépôt, la branche pour une PR en préparation. */
export function prRef(pr: Pick<TrackedPullRequest, 'number' | 'repo' | 'foreignRepo' | 'headBranch'>): string {
  if (pr.number == null) return pr.headBranch;
  return pr.foreignRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
}

/** Travail local d'une PR en préparation : « 3 commits, 2 fichiers non commités ». */
export function localWorkText(pr: Pick<TrackedPullRequest, 'localCommits' | 'localChanges'>): string {
  const parts: string[] = [];
  if (pr.localCommits) parts.push(`${pr.localCommits} commit${pr.localCommits > 1 ? 's' : ''}`);
  if (pr.localChanges) parts.push(`${pr.localChanges} fichier${pr.localChanges > 1 ? 's' : ''} non commité${pr.localChanges > 1 ? 's' : ''}`);
  return parts.join(', ');
}

export const TRACKED_PULL_REQUEST_FIELDS = gql`
  fragment TrackedPullRequestFields on TrackedPullRequest {
    id
    repo
    foreignRepo
    number
    url
    title
    headBranch
    baseBranch
    status
    isDraft
    stage
    worksession {
      id
      name
      branch
    }
    localCommits
    localChanges
    checksState
    reviewDecision
    mergeable
    syncedAt
    mergeSha
    deployedAt
    deployedByType
    deployNote
    note
    createdByType
    openedAt
    mergedAt
    closedAt
    createdAt
    updatedAt
    project {
      id
      name
    }
    task {
      id
      title
      status
    }
    createdBy {
      id
      name
    }
    createdBySession {
      id
      name
    }
    deployedBy {
      id
      name
    }
    deployedBySession {
      id
      name
    }
  }
`;

/** Champs d'une PR suivie sur une tâche (grille, carte, page de la tâche). */
export const TASK_PULL_REQUEST_FIELDS = gql`
  fragment TaskPullRequestFields on TrackedPullRequest {
    id
    repo
    foreignRepo
    number
    url
    title
    status
    isDraft
    stage
    worksession {
      id
      name
      branch
    }
    localCommits
    localChanges
    checksState
    reviewDecision
    mergeable
    headBranch
    baseBranch
    note
    deployedAt
  }
`;

export const PULL_REQUESTS = gql`
  ${TRACKED_PULL_REQUEST_FIELDS}
  query PullRequests($projectId: ID, $taskId: ID, $status: [TrackedPullRequestStatus!], $stage: [PullRequestStage!], $limit: Int) {
    pullRequests(projectId: $projectId, taskId: $taskId, status: $status, stage: $stage, limit: $limit) {
      ...TrackedPullRequestFields
    }
  }
`;

export const REGISTER_PULL_REQUEST = gql`
  ${TRACKED_PULL_REQUEST_FIELDS}
  mutation RegisterPullRequest($projectId: ID!, $url: String, $number: Int, $taskId: ID, $note: String) {
    registerPullRequest(projectId: $projectId, url: $url, number: $number, taskId: $taskId, note: $note) {
      ...TrackedPullRequestFields
    }
  }
`;

export const UPDATE_PULL_REQUEST = gql`
  ${TRACKED_PULL_REQUEST_FIELDS}
  mutation UpdatePullRequest($id: ID!, $input: UpdateTrackedPullRequestInput!) {
    updatePullRequest(id: $id, input: $input) {
      ...TrackedPullRequestFields
    }
  }
`;

export const DELETE_PULL_REQUEST = gql`
  mutation DeletePullRequest($id: ID!) {
    deletePullRequest(id: $id)
  }
`;

export const SYNC_PULL_REQUESTS = gql`
  ${TRACKED_PULL_REQUEST_FIELDS}
  mutation SyncPullRequests($projectId: ID!) {
    syncPullRequests(projectId: $projectId) {
      ...TrackedPullRequestFields
    }
  }
`;

/** Ce que la page des pull requests d'un projet doit savoir du projet (en-tête commun, dépôt). */
export const PULL_REQUESTS_PROJECT = gql`
  query PullRequestsProject($id: ID!) {
    project(id: $id) {
      id
      name
      description
      myRole
      isPersonal
      gitUrl
    }
  }
`;

/** Requêtes à rafraîchir après une action sur une PR suivie (page du projet, tâche, grille, tableau de bord). */
export const TRACKED_PR_REFETCH = ['PullRequests', 'TaskPage', 'Tasks', 'Dashboard'];

/** Ordre d'affichage des étapes : ce qui attend une action d'abord. */
export const STAGE_ORDER: PullRequestStage[] = ['TO_MERGE', 'DRAFT', 'PENDING', 'TO_DEPLOY', 'DEPLOYED', 'CANCELLED'];

export const STAGE_LABELS: Record<PullRequestStage, { label: string; plural: string; icon: string; cls: string; hint: string }> = {
  TO_MERGE: { label: 'à fusionner', plural: 'À fusionner', icon: 'bi-git', cls: 'pr-stage-to_merge', hint: 'Ouverte : à relire et fusionner' },
  DRAFT: { label: 'brouillon', plural: 'Brouillons', icon: 'bi-pencil', cls: 'pr-stage-draft', hint: 'Ouverte en brouillon sur GitHub' },
  PENDING: { label: 'en préparation', plural: 'En préparation', icon: 'bi-code-slash', cls: 'pr-stage-pending', hint: 'La branche porte des modifications, aucune pull request n’est ouverte' },
  TO_DEPLOY: { label: 'à déployer', plural: 'À déployer', icon: 'bi-box-arrow-up', cls: 'pr-stage-to_deploy', hint: 'Fusionnée, pas encore en production' },
  DEPLOYED: { label: 'déployée', plural: 'Déployées', icon: 'bi-check2-circle', cls: 'pr-stage-deployed', hint: 'Fusionnée et mise en production' },
  CANCELLED: { label: 'annulée', plural: 'Annulées', icon: 'bi-x-circle', cls: 'pr-stage-cancelled', hint: 'Fermée sans fusion' },
};
