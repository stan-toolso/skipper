/**
 * Renvoi des commentaires à la session qui a publié la page : désactivé, sur demande (bouton « Transmettre à
 * l'agent »), ou automatique (chaque commentaire ou réponse d'une personne lui est transmis aussitôt).
 */
export type AgentHandoff = 'off' | 'manual' | 'auto';
export const AGENT_HANDOFF_MODES: readonly AgentHandoff[] = ['off', 'manual', 'auto'];

/**
 * Type d'artefact : `page` (page HTML), `data` (page HTML alimentée par des sources de données que Skipper rafraîchit,
 * voir dataSources.ts). D'autres types viendront (diapositives…) : ajouter la valeur ici, dans la contrainte CHECK de la
 * migration, dans l'enum GraphQL `ArtifactKind` et dans `ARTIFACT_KINDS` du frontend.
 */
export type ArtifactKind = 'page' | 'data' | 'slides';
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['page', 'data', 'slides'];

/** Page HTML publiée par une personne ou un agent, servie à /shared/<id>, privée par défaut. */
export interface SharedPage {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  /** Visible par quiconque est connecté et a le lien. */
  linkAccess: boolean;
  /** Visible par tout le monde avec le lien, sans connexion (implique `linkAccess`). */
  publicAccess: boolean;
  /** Visible par tout membre du projet d'origine (sauf les invités) : nécessaire pour l'épingler dans un tableau de bord partagé. */
  projectAccess: boolean;
  /** Numéro de la dernière version. */
  version: number;
  projectId: string | null;
  sessionId: string | null;
  sourcePath: string | null;
  /** Réglé par le propriétaire ; sans effet tant que la page n'a pas de session d'origine. */
  agentHandoff: AgentHandoff;
  /** Anciennes versions consultables ; false = seule la dernière version est servie et listée. */
  historyEnabled: boolean;
  kind: ArtifactKind;
  /** Données : intervalle du rafraîchissement automatique en minutes ; null = à la demande. */
  refreshMinutes: number | null;
  /** Données : dernière tentative de rafraîchissement. */
  dataRefreshedAt: Date | null;
  viewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Définition d'une source de données gardée avec une version (sans ses données, qui restent vivantes). */
export interface VersionSource {
  name: string;
  kind: 'sql' | 'script' | 'graphql' | 'agent';
  config: Record<string, unknown>;
}

/** Définition d'une alerte gardée avec une version (sans son état). */
export interface VersionAlert {
  name: string;
  source: string;
  config: Record<string, unknown>;
}

export interface SharedPageVersion {
  pageId: string;
  version: number;
  size: number;
  createdById: string | null;
  sessionId: string | null;
  createdAt: Date;
  /** Type de l'artefact à cette version ; null : inconnu (publiée avant le versionnage complet), celui de l'artefact. */
  kind: ArtifactKind | null;
  /** Données : rafraîchissement à cette version. */
  refreshMinutes: number | null;
  /** Données : définition des sources à cette version ; null : inconnue (on retombe sur les sources actuelles). */
  sources: VersionSource[] | null;
  /** Données : définition des alertes à cette version ; null : inconnue (publiée avant les alertes). */
  alerts?: VersionAlert[] | null;
}

export interface SharedPageMember {
  pageId: string;
  userId: string;
  addedById: string | null;
  /** Message d'introduction de la personne qui a partagé. */
  message: string | null;
  createdAt: Date;
}

export interface PublishInput {
  ownerId: string;
  title: string;
  description?: string | null;
  html: Buffer;
  /** Nouvelle version d'une page existante. */
  pageId?: string | null;
  linkAccess?: boolean | null;
  /** Ouvre (true) ou ferme (false) l'artefact aux membres de son projet ; absent : inchangé (fermé à la création). */
  projectAccess?: boolean | null;
  projectId?: string | null;
  sessionId?: string | null;
  sourcePath?: string | null;
  /** Type de l'artefact à la création (défaut `page`) ; une nouvelle version peut passer une page en `data`. */
  kind?: ArtifactKind | null;
}

/** Élément de la page visé par un commentaire (choisi en cliquant dans la page). */
export interface CommentAnchor {
  /** Sélecteur CSS de l'élément, calculé par le script injecté dans la page. */
  selector: string;
  /** Extrait du texte de l'élément, pour le reconnaître dans la liste. */
  text: string | null;
  /** Balise de l'élément (en minuscules). */
  tag: string | null;
}

/**
 * Commentaire sur une page partagée : général ou ancré sur un élément. Un commentaire racine ouvre une
 * micro-conversation (réponses avec `parentId`) et porte l'état « traité » (`resolvedAt`).
 */
export interface SharedPageComment {
  id: string;
  pageId: string;
  parentId: string | null;
  authorId: string;
  /** Posté par une session d'agent. */
  sessionId: string | null;
  body: string;
  anchor: CommentAnchor | null;
  /** Version de la page au moment du commentaire. */
  version: number;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
