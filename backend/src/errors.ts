/**
 * Erreur métier destinée à être renvoyée telle quelle au client GraphQL
 * (les autres erreurs sont masquées en "Unexpected error." par graphql-yoga).
 */
export class AppError extends Error {
  constructor(message: string, readonly code: string = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') {
    super(message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}
