/**
 * Revue de code par un agent : une session Claude en lecture seule, lancée dans le dossier de travail d'une branche
 * (ou de la branche d'une PR suivie), relit le diff par rapport à la base et rend un rapport que Skipper publie.
 * La session porte sa revue dans `config.review` : le provider Claude y lit le mode lecture seule, la règle « une
 * seule session active par work session » l'ignore, et le guetteur de `service.ts` y range le rapport.
 * Module sans dépendance : importé par le service et le provider des sessions.
 */

export interface SessionReview {
  /** Branche relue (null : HEAD détaché). */
  branch: string | null;
  /** Branche de base comparée (« origin/main ») et point de divergence au lancement. */
  baseBranch: string;
  mergeBase: string;
  commits: number;
  /** PR suivie relue (dépôt du projet) : le rapport y est aussi posté en commentaire GitHub. */
  pullRequestId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** Tâche dont le fil reçoit le rapport. */
  taskId: string | null;
  /** Personne qui a demandé la revue (son compte GitHub poste le commentaire de PR). */
  requestedBy: string | null;
  /** Rapport publié (ou échec constaté) : posé une seule fois, au premier tour terminé. */
  reportedAt?: string | null;
  /** Rapport de l'agent (Markdown), tel que publié. */
  report?: string | null;
  /** La revue n'a pas abouti (session en erreur, rapport vide). */
  error?: string | null;
  taskCommentId?: string | null;
  githubCommentUrl?: string | null;
  /** Le commentaire GitHub n'a pas pu être posté (compte non connecté, PR fermée...). */
  githubError?: string | null;
}

/** La revue portée par une session, null pour une session ordinaire. */
export function reviewOf(session: { config?: Record<string, unknown> | null }): SessionReview | null {
  const review = session.config?.review;
  return review && typeof review === 'object' ? (review as SessionReview) : null;
}

/** Outils intégrés de Claude Code laissés à l'agent relecteur : lecture et recherche, rien qui écrive ni exécute. */
export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];

/** Outils pré-autorisés (mode dontAsk : tout le reste est refusé sans demander) ; le contexte du projet en lecture. */
export const REVIEW_ALLOWED_TOOLS = [...REVIEW_TOOLS, 'mcp__context__read', 'mcp__context__tree', 'mcp__context__search'];

/** Outils retirés quoi qu'il arrive (garde-fou si la liste des outils intégrés changeait). */
export const REVIEW_DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__context__write', 'mcp__context__create_folder', 'mcp__context__move', 'mcp__context__delete'];

/** Paragraphe ajouté au prompt système de l'agent relecteur. */
export const REVIEW_SYSTEM_PROMPT =
  "Tu es une session de relecture de code lancée par Skipper, en lecture seule : tu n'as que les outils Read, Grep et Glob, et la lecture de la bibliothèque de contexte du projet (outils `mcp__context__read`, `tree`, `search`). Tu ne peux ni modifier de fichier, ni lancer de commande, ni agir sur les tâches : ne le tente pas. Ta réponse finale est ton rapport : Skipper le publie tel quel dans le fil de la tâche et, s'il y a une pull request, en commentaire GitHub.";
