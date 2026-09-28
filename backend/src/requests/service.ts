import { AppError, NotFoundError } from '../errors.js';
import { pubSub } from '../pubsub.js';
import { requestRepository } from './repository.js';
import type { CreateRequestInput, HumanRequest, RequestStatus } from './types.js';

export class RequestCancelledError extends Error {
  constructor(readonly request: HumanRequest) {
    super(`Demande ${request.id} ${request.status}`);
    this.name = 'RequestCancelledError';
  }
}

interface Waiter {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/** Promesses en attente d'une réponse humaine, indexées par id de demande (mémoire du serveur). */
const waiters = new Map<string, Waiter>();

function settleWaiter(request: HumanRequest): void {
  const waiter = waiters.get(request.id);
  if (!waiter) return;
  waiters.delete(request.id);
  if (request.status === 'answered') waiter.resolve(request.response ?? {});
  else waiter.reject(new RequestCancelledError(request));
}

export const requestService = {
  list: (filter?: { sessionId?: string; status?: RequestStatus; limit?: number }) => requestRepository.list(filter),
  countPending: (sessionId: string) => requestRepository.countPending(sessionId),

  async get(id: string): Promise<HumanRequest> {
    const request = await requestRepository.findById(id);
    if (!request) throw new NotFoundError('Demande introuvable');
    return request;
  },

  /**
   * Crée une demande et attend la réponse humaine. Rejette avec RequestCancelledError
   * si la demande est annulée (arrêt de la session, abandon explicite) ou si `signal` est déclenché.
   */
  async ask(sessionId: string, input: CreateRequestInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const request = await requestRepository.create(sessionId, input);
    pubSub.publish('requestCreated', request);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(request.id, { resolve, reject });
      signal?.addEventListener('abort', () => void this.cancel(request.id).catch(() => undefined), { once: true });
    });
  },

  async answer(id: string, response: Record<string, unknown>): Promise<HumanRequest> {
    const request = await requestRepository.settle(id, 'answered', response);
    if (!request) {
      const existing = await this.get(id);
      throw new AppError(`La demande n'est plus en attente (statut : ${existing.status})`);
    }
    pubSub.publish('requestUpdated', request);
    settleWaiter(request);
    return request;
  },

  async cancel(id: string): Promise<HumanRequest> {
    const request = await requestRepository.settle(id, 'cancelled', null);
    if (!request) return this.get(id);
    pubSub.publish('requestUpdated', request);
    settleWaiter(request);
    return request;
  },

  /** Annule toutes les demandes en attente d'une session (arrêt, fin de processus). */
  async cancelAllForSession(sessionId: string, status: 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
    const requests = await requestRepository.settleAllPending(sessionId, status);
    for (const request of requests) {
      pubSub.publish('requestUpdated', request);
      settleWaiter(request);
    }
  },

  expireAllPending: () => requestRepository.expireAllPending(),
};
