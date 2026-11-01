import type { Project } from '../projects/types.js';
import { pullRequestRepository } from '../pullRequests/repository.js';
import type { TrackedPullRequest } from '../pullRequests/types.js';
import { projectRepository } from '../projects/repository.js';
import { requestRepository } from '../requests/repository.js';
import { scheduleRepository } from '../schedules/repository.js';
import type { SessionSchedule } from '../schedules/types.js';
import { sessionRepository } from '../sessions/repository.js';
import type { Session } from '../sessions/types.js';
import { taskRepository } from '../tasks/repository.js';
import type { Task } from '../tasks/types.js';
import { userRepository } from '../users/repository.js';
import type { User } from '../users/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import type { Worksession } from '../worksessions/types.js';

/**
 * Chargement groupé, le temps d'une requête GraphQL (« dataloader » minimal, sans dépendance).
 *
 * Les résolveurs de champ (`Session.owner`, `Session.worksession`, `Worksession.task`…) sont appelés une fois
 * par objet : la sidebar, qui liste une cinquantaine de sessions par projet toutes les quelques secondes,
 * déclenchait des centaines de requêtes SQL par relevé. Un lot rassemble les clés demandées dans le même
 * tour de boucle d'événements (les champs frères d'un niveau sont résolus ensemble par graphql-js), les
 * charge en une requête `WHERE id = ANY(...)`, et mémorise chaque réponse : une clé n'est jamais chargée deux
 * fois dans la même requête GraphQL. Les chargeurs vivent dans le contexte de la requête (`loadersOf(ctx)`
 * dans resolvers.ts) et disparaissent avec elle : aucune donnée n'est partagée entre deux requêtes.
 *
 * Une réponse mémorisée expire après `maxAgeMs` (1 s) : le contexte d'une subscription sert à tous ses
 * événements, parfois pendant des heures, et ne doit pas figer un compte de demandes ou un propriétaire.
 */
export function createBatcher<K, V>(
  load: (keys: K[]) => Promise<Map<string, V>>,
  keyOf: (key: K) => string = String,
  { maxAgeMs = 1000, now = () => Date.now() }: { maxAgeMs?: number; now?: () => number } = {},
): (key: K) => Promise<V | undefined> {
  const cache = new Map<string, { at: number; promise: Promise<V | undefined> }>();
  let pending: { key: K; id: string; resolve: (value: V | undefined) => void; reject: (error: unknown) => void }[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const batch = pending;
    pending = [];
    const keys = [...new Map(batch.map((b) => [b.id, b.key])).values()];
    load(keys).then(
      (found) => batch.forEach((b) => b.resolve(found.get(b.id))),
      (error: unknown) => batch.forEach((b) => b.reject(error)),
    );
  };

  return (key) => {
    const id = keyOf(key);
    const hit = cache.get(id);
    let promise = hit && now() - hit.at < maxAgeMs ? hit.promise : undefined;
    if (!promise) {
      promise = new Promise<V | undefined>((resolve, reject) => pending.push({ key, id, resolve, reject }));
      cache.set(id, { at: now(), promise });
      if (!scheduled) {
        scheduled = true;
        // Après les microtâches en cours (les résolveurs frères s'inscrivent), avant la suite de la boucle.
        void Promise.resolve().then(() => process.nextTick(flush));
      }
    }
    return promise;
  };
}

const byId = <T extends { id: string }>(rows: T[]): Map<string, T> => new Map(rows.map((r) => [r.id, r]));

/** Clé d'une tâche cherchée par branche : projet et branche (le caractère nul ne figure dans aucun des deux). */
export const branchKey = (k: { projectId: string; branch: string }): string => `${k.projectId}\u0000${k.branch}`;

/** Chargeurs d'une requête GraphQL : objets par identifiant, compte des demandes en attente, tâche d'une branche. */
export function createLoaders() {
  return {
    user: createBatcher<string, User>(async (ids) => byId(await userRepository.findByIds(ids))),
    project: createBatcher<string, Project>(async (ids) => byId(await projectRepository.findByIds(ids))),
    session: createBatcher<string, Session>(async (ids) => byId(await sessionRepository.findByIds(ids))),
    worksession: createBatcher<string, Worksession>(async (ids) => byId(await worksessionRepository.findByIds(ids))),
    task: createBatcher<string, Task>(async (ids) => byId(await taskRepository.findByIds(ids))),
    pendingRequestCount: createBatcher<string, number>((ids) => requestRepository.countPendingBySessions(ids)),
    /** Planification d'une session (absente : la session n'est pas planifiée). */
    sessionSchedule: createBatcher<string, SessionSchedule>((ids) => scheduleRepository.findBySessions(ids)),
    /** PR suivie d'une work session (en préparation comprise), voir `pullRequestRepository.findForWorksessions`. */
    trackedPullRequest: createBatcher<{ id: string; projectId: string; branch: string }, TrackedPullRequest>((keys) => pullRequestRepository.findForWorksessions(keys), (k) => k.id),
    taskForBranch: createBatcher<{ projectId: string; branch: string }, Task>((keys) => taskRepository.findForBranches(keys), branchKey),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
